import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueApiKey, verifyApiKey } from "../src/api/keys";
import { buildOpenApi } from "../src/api/openapi";
import worker from "../src/index";
import { runEntities } from "../src/tools/run";
import { createFakeFetch, DNS, ROUTES, SITE } from "./helpers/fakeSite";

/**
 * The REST API is called through the Worker with fake limiter bindings (as in
 * ratelimit.test.ts), so every limit and auth branch is deterministic, and the
 * outbound web is the in-memory fixture site.
 */

const PROD = "https://mcp.searchscope.com.au";
const API = `${PROD}/api/v1`;
const SECRET = "test-signing-secret-0123456789abcdef-0123456789";
const OTHER_SECRET = "another-signing-secret-0123456789abcdef-012345";
const RAPID_SECRET = "rapid-proxy-secret-for-tests";

interface FakeLimiter {
  keys: string[];
  deltas: number[];
  limit(options: { key: string; delta?: number }): Promise<{ success: boolean }>;
}

/** One shared budget of `allow` units, whatever the key (mirrors the binding's "allowed while under budget" rule). */
function limiter(allow = Infinity): FakeLimiter {
  const keys: string[] = [];
  const deltas: number[] = [];
  let spent = 0;
  return {
    keys,
    deltas,
    async limit({ key, delta = 1 }) {
      keys.push(key);
      deltas.push(delta);
      if (spent >= allow) return { success: false };
      spent += delta;
      return { success: true };
    },
  };
}

/** A separate budget of `allow` units per key, like the real binding. */
function keyedLimiter(allow: number): FakeLimiter {
  const keys: string[] = [];
  const deltas: number[] = [];
  const spent = new Map<string, number>();
  return {
    keys,
    deltas,
    async limit({ key, delta = 1 }) {
      keys.push(key);
      deltas.push(delta);
      const used = spent.get(key) ?? 0;
      if (used >= allow) return { success: false };
      spent.set(key, used + delta);
      return { success: true };
    },
  };
}

type Env = Record<string, FakeLimiter | string | undefined>;

function bindings(overrides: Env = {}): Env {
  return {
    MCP_RATE_LIMIT_PER_IP: limiter(),
    MCP_RATE_LIMIT_GLOBAL: limiter(),
    MCP_RATE_LIMIT_PER_TARGET: limiter(),
    ...overrides,
  };
}

const perIp = (env: Env) => env.MCP_RATE_LIMIT_PER_IP as FakeLimiter;
const perTarget = (env: Env) => env.MCP_RATE_LIMIT_PER_TARGET as FakeLimiter;
const globalLimiter = (env: Env) => env.MCP_RATE_LIMIT_GLOBAL as FakeLimiter;

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  ip?: string | null;
  headers?: Record<string, string>;
}

async function call(env: Env, url: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { host: new URL(url).host, ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] ??= "application/json";
  if (opts.ip !== null) headers["cf-connecting-ip"] = opts.ip ?? "203.0.113.7";
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers, body }), env as never, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return new Response(text, { status: res.status, headers: res.headers });
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("REST API: OpenAPI spec and docs", () => {
  it("serves an OpenAPI 3.1 document whose every $ref resolves", async () => {
    const res = await call(bindings(), `${API}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const spec = (await res.json()) as Record<string, any>;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe(API);
    expect(Object.keys(spec.paths).sort()).toEqual(["/audit", "/entities", "/keys", "/queries", "/status"]);
    // Every operation has a unique operationId and at least one success response.
    const ops = Object.values(spec.paths).flatMap((p: any) => Object.values(p)) as any[];
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    for (const o of ops) expect(o.responses["200"]).toBeDefined();
    // Every $ref points at something that exists.
    const refs: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          if (k === "$ref" && typeof child === "string") refs.push(child);
          else walk(child);
        }
      }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) {
      expect(r.startsWith("#/"), r).toBe(true);
      const target = r.slice(2).split("/").reduce<any>((node, part) => node?.[part], spec);
      expect(target, r).toBeDefined();
    }
    // No per-schema $schema dialect markers inside components (OpenAPI sets the dialect).
    expect(JSON.stringify(spec.components)).not.toContain('"$schema"');
    expect(spec.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
    // An empty requirement keeps every operation callable without a key.
    expect(spec.security).toEqual([{}, { apiKey: [] }]);
  });

  it("generates request and response schemas from the tools' own Zod schemas", () => {
    const s = buildOpenApi().components as Record<string, any>;
    const audit = s.schemas.AuditRequest;
    expect(audit.type).toBe("object");
    expect(audit.required).toEqual(["url"]);
    expect(audit.additionalProperties).toBe(false);
    expect(audit.properties.maxPages).toMatchObject({ type: "integer", minimum: 1, maximum: 15 });
    expect(audit.properties.url.description).toMatch(/Public website URL/);
    const queries = s.schemas.QueriesRequest;
    expect(Object.keys(queries.properties).sort()).toEqual(["count", "location", "service", "url"]);
    expect(queries.properties.count).toMatchObject({ minimum: 10, maximum: 100 });
    // looseObject output survives conversion: named fields kept, extra fields allowed.
    const data = s.schemas.AuditResponse.properties.data;
    expect(data.required).toEqual(expect.arrayContaining(["target", "executiveSummary", "topActions", "monitoringPrompts"]));
    expect(data.additionalProperties).not.toBe(false);
    expect(data.properties.topActions.type).toBe("array");
    expect(s.schemas.AuditResponse.required).toEqual(["data", "report"]);
    expect(s.schemas.Error.properties.error.properties.code.enum).toContain("rate_limited");
  });

  it("serves an indexable docs page with the key button, and keeps /api/ out of robots", async () => {
    const res = await call(bindings(), `${PROD}/docs/api`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`${API}`);
    expect(html).toContain('<meta name="robots" content="index, follow">');
    expect(html).toContain('action="/api/v1/keys"');
    expect(html).toContain("/api/v1/openapi.json");
    expect(html).toContain("https://searchscope.com.au/contact/");
    expect(html).toMatch(/Nothing is stored/);
    expect(html).not.toContain("\u2014"); // no em dashes in published copy
    // Under no-referrer a browser sends `Origin: null` with the key form's POST,
    // which the Origin policy refuses; same-origin sends the real origin.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect((await call(bindings(), `${PROD}/docs/api/`)).status).toBe(200);
    const robots = await (await call(bindings(), `${PROD}/robots.txt`)).text();
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Disallow: /mcp");
    expect(robots).not.toContain("/docs");
  });

  it("serves llms.txt and a Markdown version of the docs for AI agents", async () => {
    const llms = await call(bindings(), `${PROD}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const index = await llms.text();
    expect(index.startsWith("# ")).toBe(true);
    expect(index).toContain(`${PROD}/docs/api.md`);
    expect(index).toContain(`${API}/openapi.json`);

    const md = await call(bindings(), `${PROD}/docs/api.md`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const text = await md.text();
    expect(text).toContain("## Endpoints");
    expect(text).toContain("POST /audit");
    expect(text).not.toContain("<");
    expect(text).not.toContain("\u2014");

    const negotiated = await call(bindings(), `${PROD}/docs/api`, { headers: { accept: "text/markdown" } });
    expect(negotiated.headers.get("content-type")).toContain("text/markdown");
    expect(await negotiated.text()).toBe(text);

    const html = await (await call(bindings(), `${PROD}/docs/api`)).text();
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/docs/api.md">');
    const landing = await (await call(bindings(), `${PROD}/`)).text();
    expect(landing).toContain('href="/llms.txt"');
    const robots = await (await call(bindings(), `${PROD}/robots.txt`)).text();
    expect(robots).not.toContain("Disallow: /llms");
    expect(robots).toContain("Sitemap: https://mcp.searchscope.com.au/sitemap.xml");
    expect(text).toContain("[llms.txt](https://mcp.searchscope.com.au/llms.txt)");
    expect(text).toContain("Lost it? Get another.");
    const sitemap = await call(bindings(), `${PROD}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).toContain("<loc>https://mcp.searchscope.com.au/docs/api</loc>");
  });

  it("links the API from the landing page and its JSON form", async () => {
    const html = await (await call(bindings(), `${PROD}/`)).text();
    expect(html).toContain('href="https://mcp.searchscope.com.au/docs/api"');
    const json = (await (await call(bindings(), `${PROD}/`, { headers: { accept: "application/json" } })).json()) as { restApi: { baseUrl: string; openapi: string } };
    expect(json.restApi.baseUrl).toBe(API);
    expect(json.restApi.openapi).toBe(`${API}/openapi.json`);
  });

  it("serves a small JSON index at /api/v1 and 404s unknown API paths as JSON", async () => {
    const index = await call(bindings(), API);
    expect(index.status).toBe(200);
    expect(((await index.json()) as { docs: string }).docs).toBe(`${PROD}/docs/api`);
    const missing = await call(bindings(), `${API}/nope`);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not_found");
  });
});

describe("REST API: tools", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST /audit returns the structured audit and the branded report", async () => {
    const res = await call(bindings(), `${API}/audit`, { body: { url: SITE, maxPages: 8 } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data, report } = (await res.json()) as { data: Record<string, any>; report: string };
    expect(data.crawl.pagesFetched).toBe(8);
    expect(data.entityClarity.primaryEntity.name).toBe("Acme Plumbing");
    expect(data.monitoringPrompts.length).toBe(20);
    expect(report).toContain("## A. Executive summary");
    expect(report).toContain("## J. 20 AI search prompts");
    expect(report).toContain("## About this report");
  });

  it("POST /entities returns exactly what the shared runner (and so the MCP tool) returns", async () => {
    const res = await call(bindings(), `${API}/entities`, { body: { url: SITE } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, any>; report: string };
    expect(body.data.primaryEntity.name).toBe("Acme Plumbing");
    const direct = await runEntities({ url: SITE }, { selfHostnames: ["mcp.searchscope.com.au"] });
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(body.data).toEqual(JSON.parse(JSON.stringify(direct.data)));
      expect(body.report).toBe(direct.text);
    }
  });

  it("POST /queries honours service, location and count", async () => {
    const res = await call(bindings(), `${API}/queries`, { body: { url: SITE, service: "gas fitting", location: "Mandurah", count: 12 } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data.queries.length).toBe(12);
    expect(data.queries.some((q: { query: string }) => /Mandurah/.test(q.query))).toBe(true);
    expect(data.queries.some((q: { query: string }) => /gas fitting/.test(q.query))).toBe(true);
  });

  it("refuses bad JSON and bad fields with 400 before charging the tool weight or fetching", async () => {
    const env = bindings();
    const cases: Array<[unknown, string]> = [
      [undefined, "invalid_json"],
      [{}, "invalid_input"],
      [{ url: SITE, maxPages: 500 }, "invalid_input"],
      [{ url: SITE, maxPgaes: 3 }, "invalid_input"],
      [{ url: 42 }, "invalid_input"],
      [["https://example.com"], "invalid_input"],
    ];
    for (const [body, code] of cases) {
      const res = await call(env, `${API}/audit`, body === undefined ? { rawBody: "not json", headers: { "content-type": "application/json" } } : { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    const count = await call(env, `${API}/queries`, { body: { url: SITE, count: 5 } });
    expect(count.status).toBe(400);
    // Only the door charge (1 each), no tool weight, no site charge, no fetch.
    expect(perIp(env).deltas.every((d) => d === 1)).toBe(true);
    expect(perTarget(env).keys).toEqual([]);
    expect(log).toEqual([]);
  });

  it("names the bad field without echoing the body", async () => {
    const res = await call(bindings(), `${API}/audit`, { body: { url: SITE, maxPages: 500 } });
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error.message).toMatch(/^maxPages:/);
  });

  it("rejects unsafe targets with 400 target_rejected without fetching them", async () => {
    for (const url of ["http://localhost:8787/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "https://evil.rebind.net/", "ftp://example.com/", "https://user:pw@acmeplumbing.com.au/", "not a url"]) {
      const res = await call(bindings(), `${API}/audit`, { body: { url } });
      expect(res.status, url).toBe(400);
      expect(await errorCode(res), url).toBe("target_rejected");
    }
    expect(log.filter((u) => !u.includes("cloudflare-dns.com"))).toEqual([]);
  });

  it("refuses to audit its own hostname", async () => {
    const res = await call(bindings(), `${API}/audit`, { body: { url: PROD } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("target_rejected");
  });

  it("answers 422 when the homepage cannot be read", async () => {
    const res = await call(bindings(), `${API}/entities`, { body: { url: "https://public-v6.net/" } });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("site_unreadable");
  });

  it("charges the per-site limit again when the homepage redirects to another site", async () => {
    vi.stubGlobal("fetch", createFakeFetch({
      routes: { ...ROUTES, "https://redirector.example.net/": { status: 301, headers: { location: `${SITE}/` } } },
      dns: { ...DNS, "redirector.example.net": ["93.184.216.40"] },
    }));
    const env = bindings();
    expect((await call(env, `${API}/queries`, { body: { url: "https://redirector.example.net/", count: 10 } })).status).toBe(200);
    expect(perTarget(env).keys).toEqual(["redirector.example.net", "acmeplumbing.com.au"]);
  });
});

describe("REST API: request guards", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers only on its own hostnames and loopback", async () => {
    for (const origin of [PROD, "https://searchscope-ai-visibility-mcp.searchscope.workers.dev", "http://localhost:8787"]) {
      expect((await call(bindings(), `${origin}/api/v1/status`)).status, origin).toBe(200);
    }
    for (const origin of ["https://rebound.example.net", "https://mcp.searchscope.com.au.evil.net"]) {
      const res = await call(bindings(), `${origin}/api/v1/status`);
      expect(res.status, origin).toBe(403);
      expect(await errorCode(res)).toBe("host_not_allowed");
    }
  });

  it("applies the same Origin policy as /mcp, with CORS for well-formed origins", async () => {
    const ok = await call(bindings(), `${API}/status`, { headers: { origin: "https://app.example.com" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    for (const origin of ["null", "chrome-extension://abcdefghijklmnop", "https://claude.ai/some/path"]) {
      const res = await call(bindings(), `${API}/status`, { headers: { origin } });
      expect(res.status, origin).toBe(403);
      expect(await errorCode(res)).toBe("origin_not_allowed");
    }
  });

  it("accepts Search Scope's own browser add-on on the API, and no other extension", async () => {
    const EXT = "chrome-extension://kjdngodjcfbjnkclnkcchhebjnfncchl";
    const env = bindings();
    const pre = await call(env, `${API}/audit`, { method: "OPTIONS", headers: { origin: EXT, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.status).toBe(204);
    const res = await call(env, `${API}/audit`, { body: { url: SITE }, headers: { origin: EXT } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // The add-on pays the same budget as any other client.
    expect(perIp(env).deltas.reduce((a, b) => a + b, 0)).toBe(3);
    for (const origin of [
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      `${EXT}/`,
      "chrome-extension://KJDNGODJCFBJNKCLNKCCHHEBJNFNCCHL",
      "moz-extension://kjdngodjcfbjnkclnkcchhebjnfncchl",
    ]) {
      const bad = await call(bindings(), `${API}/status`, { headers: { origin } });
      expect(bad.status, origin).toBe(403);
      expect(await errorCode(bad)).toBe("origin_not_allowed");
    }
  });

  it("serves the browser extension's privacy page", async () => {
    const res = await call(bindings(), `${PROD}/extension/privacy`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Privacy: AI Visibility Audit browser extension");
    expect(html).toContain("activeTab");
    expect(html).toContain("https://searchscope.com.au/privacy-policy/");
    expect(html).not.toContain("\u2014");
    expect((await call(bindings(), `${PROD}/extension/privacy`, { method: "POST", rawBody: "x" })).status).toBe(405);
  });

  it("answers a CORS preflight without spending any budget", async () => {
    const env = bindings();
    const res = await call(env, `${API}/audit`, { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(perIp(env).keys).toEqual([]);
    expect(globalLimiter(env).keys).toEqual([]);
  });

  it("refuses the wrong method with 405", async () => {
    const get = await call(bindings(), `${API}/audit`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const post = await call(bindings(), `${API}/status`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("enforces the 32 KB body limit on the bytes received", async () => {
    const env = bindings();
    const declared = await call(env, `${API}/audit`, { rawBody: "{}", headers: { "content-type": "application/json", "content-length": "99999999" } });
    expect(declared.status).toBe(413);
    const bytes = new TextEncoder().encode(JSON.stringify({ url: SITE, pad: "x".repeat(40_000) }));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 1024));
        offset += 1024;
      },
    });
    const chunked = await call(env, `${API}/audit`, { rawBody: stream, headers: { "content-type": "application/json" } });
    expect(chunked.status).toBe(413);
    expect(await errorCode(chunked)).toBe("payload_too_large");
    expect(log).toEqual([]);
  });
});

describe("REST API: rate limits", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed with 503 when a limiter is missing or erroring, or the client IP is missing", async () => {
    for (const name of ["MCP_RATE_LIMIT_PER_IP", "MCP_RATE_LIMIT_GLOBAL", "MCP_RATE_LIMIT_PER_TARGET"]) {
      const res = await call(bindings({ [name]: undefined }), `${API}/status`);
      expect(res.status, name).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    }
    const broken = { keys: [], deltas: [], limit: () => Promise.reject(new Error("down")) } as unknown as FakeLimiter;
    expect((await call(bindings({ MCP_RATE_LIMIT_GLOBAL: broken }), `${API}/status`)).status).toBe(503);
    expect((await call(bindings({ MCP_RATE_LIMIT_PER_TARGET: broken }), `${API}/audit`, { body: { url: SITE } })).status).toBe(503);
    expect((await call(bindings(), `${API}/status`, { ip: null })).status).toBe(503);
    expect(log.filter((u) => !u.includes("cloudflare-dns.com"))).toEqual([]);
  });

  it("charges 1 for a status check and 3 for a tool call, on the same keys /mcp uses", async () => {
    const env = bindings();
    expect((await call(env, `${API}/status`)).status).toBe(200);
    expect((await call(env, `${API}/audit`, { body: { url: "acmeplumbing.com.au", maxPages: 3 } })).status).toBe(200);
    expect(perIp(env).keys).toEqual(["203.0.113.7", "203.0.113.7", "203.0.113.7"]);
    expect(perIp(env).deltas).toEqual([1, 1, 2]);
    expect(globalLimiter(env).keys).toEqual(["mcp", "mcp"]);
    expect(perTarget(env).keys).toEqual(["acmeplumbing.com.au"]);
  });

  it("shares one client budget between /mcp and the REST API: 20 tool calls a minute in total", async () => {
    const env = bindings({ MCP_RATE_LIMIT_PER_IP: limiter(60) });
    const rpc = (id: number, url: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "generate_geo_query_universe", arguments: { url, count: 10 } } });
    const mcpHeaders = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", "content-type": "application/json" };
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call(env, `${API}/queries`, { body: { url: `https://site${i}.example.com`, count: 10 } })).status);
    for (let i = 10; i < 20; i++) statuses.push((await call(env, `${PROD}/mcp`, { body: rpc(i, `https://site${i}.example.com`), headers: mcpHeaders })).status);
    expect(statuses.every((s) => s !== 429)).toBe(true);
    log.length = 0;
    const refused = await call(env, `${API}/queries`, { body: { url: SITE, count: 10 } });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await errorCode(refused)).toBe("rate_limited");
    expect(log).toEqual([]);
  });

  it("refuses a tool call once the client or the site budget is spent, before fetching", async () => {
    expect((await call(bindings({ MCP_RATE_LIMIT_PER_IP: limiter(1) }), `${API}/audit`, { body: { url: SITE } })).status).toBe(429);
    expect((await call(bindings({ MCP_RATE_LIMIT_PER_TARGET: limiter(0) }), `${API}/audit`, { body: { url: SITE } })).status).toBe(429);
    expect((await call(bindings({ MCP_RATE_LIMIT_GLOBAL: limiter(0) }), `${API}/status`)).status).toBe(429);
    expect(log).toEqual([]);
  });
});

describe("REST API: optional free keys", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", createFakeFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function newKey(env: Env): Promise<string> {
    const res = await call(env, `${API}/keys`, { method: "POST" });
    expect(res.status).toBe(200);
    return ((await res.json()) as { apiKey: string }).apiKey;
  }

  it("issues signed keys only when a long enough signing secret is set", async () => {
    expect(await errorCode(await call(bindings(), `${API}/keys`, { method: "POST" }))).toBe("keys_unavailable");
    expect(await errorCode(await call(bindings({ API_KEY_SIGNING_SECRET: "too-short" }), `${API}/keys`, { method: "POST" }))).toBe("keys_unavailable");
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET });
    const res = await call(env, `${API}/keys`, { method: "POST" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { apiKey: string; usage: string };
    expect(body.apiKey).toMatch(/^ssk_[0-9a-f]{64}$/);
    expect(body.usage).toBe("Authorization: Bearer <key>");
    expect(await newKey(env)).not.toBe(body.apiKey);
  });

  it("shows the key on a no-store, noindex page when the docs button posts the form", async () => {
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET });
    const res = await call(env, `${API}/keys`, { method: "POST", rawBody: "", headers: { accept: "text/html,application/xhtml+xml", "content-type": "application/x-www-form-urlencoded", origin: PROD } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    const key = /ssk_[0-9a-f]{64}/.exec(html)?.[0];
    expect(key).toBeDefined();
    expect(await verifyApiKey(SECRET, key!)).not.toBeNull();
  });

  it("accepts a valid key, charges its own budget as well as the client's, and reports it", async () => {
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET });
    const key = await newKey(env);
    const id = key.slice(4, 36);
    perIp(env).keys.length = 0;
    perIp(env).deltas.length = 0;
    const status = await call(env, `${API}/status`, { headers: { authorization: `Bearer ${key}` } });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { auth: string }).auth).toBe("api_key");
    expect((await call(env, `${API}/entities`, { body: { url: SITE }, headers: { authorization: `bearer ${key}` } })).status).toBe(200);
    expect(perIp(env).keys).toEqual(["203.0.113.7", `key:${id}`, "203.0.113.7", `key:${id}`, "203.0.113.7", `key:${id}`]);
    expect(perIp(env).deltas).toEqual([1, 1, 1, 1, 2, 2]);
    const none = await call(env, `${API}/status`);
    expect(((await none.json()) as { auth: string }).auth).toBe("none");
  });

  it("caps a shared key at one client's worth, whichever IPs use it", async () => {
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET, MCP_RATE_LIMIT_PER_IP: keyedLimiter(3) });
    const key = await newKey(env);
    const auth = { authorization: `Bearer ${key}` };
    expect((await call(env, `${API}/entities`, { body: { url: SITE }, headers: auth, ip: "198.51.100.1" })).status).toBe(200);
    // A fresh IP with an unspent budget is still refused: the key's own budget is spent.
    expect((await call(env, `${API}/status`, { headers: auth, ip: "198.51.100.2" })).status).toBe(429);
    expect((await call(env, `${API}/status`, { ip: "198.51.100.2" })).status).toBe(200);
  });

  it("refuses a wrong, tampered, foreign or malformed key with 401 and never echoes it", async () => {
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET });
    const good = await newKey(env);
    const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const foreign = await issueApiKey(OTHER_SECRET);
    for (const header of [`Bearer ${tampered}`, `Bearer ${foreign}`, `Bearer ${good.toUpperCase()}`, "Bearer ssk_123", `Basic ${good}`, "Bearer", `Bearer ${good} extra`]) {
      const res = await call(env, `${API}/status`, { headers: { authorization: header } });
      expect(res.status, header).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("invalid_api_key");
      expect(text).not.toContain(good.slice(4));
      expect(text).not.toContain(foreign.slice(4));
    }
    // A bad key does not get a tool run.
    const res = await call(env, `${API}/audit`, { body: { url: SITE }, headers: { authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
    expect(perTarget(env).keys).toEqual([]);
  });

  it("fails closed with 503 when a key is sent but no signing secret is set, and keyless calls still work", async () => {
    const key = await issueApiKey(SECRET);
    const res = await call(bindings(), `${API}/status`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("keys_unavailable");
    expect((await call(bindings(), `${API}/status`)).status).toBe(200);
  });

  it("verifies key signatures in isolation", async () => {
    const key = await issueApiKey(SECRET);
    expect(await verifyApiKey(SECRET, key)).toBe(key.slice(4, 36));
    expect(await verifyApiKey(OTHER_SECRET, key)).toBeNull();
    expect(await verifyApiKey(SECRET, `${key}0`)).toBeNull();
    expect(await verifyApiKey(SECRET, key.replace("ssk_", "sk_"))).toBeNull();
    expect(await verifyApiKey(SECRET, "")).toBeNull();
  });

  it("leaves /mcp unchanged: an Authorization header there is neither required nor checked", async () => {
    const env = bindings({ API_KEY_SIGNING_SECRET: SECRET });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const res = await call(env, `${PROD}/mcp`, { body: init, headers: { accept: "application/json, text/event-stream", authorization: "Bearer not-a-key" } });
    expect(res.status).toBe(200);
  });
});

describe("REST API: RapidAPI proxy", () => {
  const rapid = (secret: string, user = "alice") => ({ "x-rapidapi-proxy-secret": secret, "x-rapidapi-user": user });

  it("limits verified RapidAPI subscribers per user instead of per proxy IP", async () => {
    const env = bindings({ RAPIDAPI_PROXY_SECRET: RAPID_SECRET });
    const res = await call(env, `${API}/status`, { headers: rapid(RAPID_SECRET) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { auth: string }).auth).toBe("rapidapi");
    expect(perIp(env).keys).toEqual(["rapidapi:alice"]);
  });

  it("ignores RapidAPI headers when the secret is wrong, too long a user, or no secret is configured", async () => {
    for (const [env, headers] of [
      [bindings({ RAPIDAPI_PROXY_SECRET: RAPID_SECRET }), rapid("wrong-secret")],
      [bindings({ RAPIDAPI_PROXY_SECRET: RAPID_SECRET }), rapid(RAPID_SECRET, "x".repeat(200))],
      [bindings({ RAPIDAPI_PROXY_SECRET: RAPID_SECRET }), { "x-rapidapi-user": "alice" }],
      [bindings(), rapid(RAPID_SECRET)],
    ] as Array<[Env, Record<string, string>]>) {
      const res = await call(env, `${API}/status`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { auth: string }).auth).toBe("none");
      expect(perIp(env).keys).toEqual(["203.0.113.7"]);
    }
  });
});
