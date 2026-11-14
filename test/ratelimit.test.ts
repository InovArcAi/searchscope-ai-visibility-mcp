import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { targetKey, toolCallsIn } from "../src/security/request";
import { createFakeFetch, DNS, ROUTES, SITE } from "./helpers/fakeSite";

/**
 * The Worker is called directly with fake limiter bindings, so each branch
 * (allowed, limited, missing binding, limiter error) is deterministic and does
 * not depend on the local rate limiter's state.
 */

const PROD = "https://mcp.searchscope.com.au";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "rl-test", version: "1.0.0" } } };
const toolCall = (id: number, url: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "generate_geo_query_universe", arguments: { url, count: 10 } } });

interface FakeLimiter {
  keys: string[];
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Allows the first `allow` calls, then refuses. Records every key it was asked about. */
function limiter(allow = Infinity): FakeLimiter {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: keys.length <= allow };
    },
  };
}

function bindings(overrides: Partial<Record<string, FakeLimiter | undefined>> = {}) {
  return {
    MCP_RATE_LIMIT_PER_IP: limiter(),
    MCP_RATE_LIMIT_GLOBAL: limiter(),
    MCP_RATE_LIMIT_TOOL_CALLS_PER_IP: limiter(),
    MCP_RATE_LIMIT_PER_TARGET: limiter(),
    ...overrides,
  };
}

async function call(env: ReturnType<typeof bindings>, body: unknown, opts: { origin?: string; ip?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
  const origin = opts.origin ?? PROD;
  const headers: Record<string, string> = { ...HEADERS, host: new URL(origin).host, ...opts.headers };
  if (opts.ip !== null) headers["cf-connecting-ip"] = opts.ip ?? "203.0.113.7";
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }), env as never, ctx);
  // Drain the (possibly streamed) body so no exchange is left open when the test ends.
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return new Response(text, { status: res.status, headers: res.headers });
}

describe("rate limits on /mcp", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed with 503 when any limiter binding is missing", async () => {
    for (const name of ["MCP_RATE_LIMIT_PER_IP", "MCP_RATE_LIMIT_GLOBAL", "MCP_RATE_LIMIT_TOOL_CALLS_PER_IP", "MCP_RATE_LIMIT_PER_TARGET"]) {
      const res = await call(bindings({ [name]: undefined }), INITIALIZE);
      expect(res.status, name).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    }
  });

  it("fails closed with 503 when the client IP is missing on a public hostname", async () => {
    expect((await call(bindings(), INITIALIZE, { ip: null })).status).toBe(503);
  });

  it("still rate limits wrangler dev on loopback, under a shared local key", async () => {
    const env = bindings();
    const res = await call(env, INITIALIZE, { origin: "http://localhost:8787", ip: null });
    expect(res.status).toBe(200);
    expect(env.MCP_RATE_LIMIT_PER_IP!.keys).toEqual(["loopback"]);
  });

  it("fails closed with 503 when a limiter throws", async () => {
    const broken = { keys: [], limit: () => Promise.reject(new Error("limiter down")) };
    expect((await call(bindings({ MCP_RATE_LIMIT_GLOBAL: broken }), INITIALIZE)).status).toBe(503);
    const throwsSync = { keys: [], limit: () => { throw new Error("bad options"); } } as unknown as FakeLimiter;
    expect((await call(bindings({ MCP_RATE_LIMIT_PER_IP: throwsSync }), INITIALIZE)).status).toBe(503);
  });

  it("returns 429 when the per-IP or the global limit is spent", async () => {
    const perIp = await call(bindings({ MCP_RATE_LIMIT_PER_IP: limiter(0) }), INITIALIZE);
    expect(perIp.status).toBe(429);
    expect(perIp.headers.get("retry-after")).toBe("60");
    expect((await call(bindings({ MCP_RATE_LIMIT_GLOBAL: limiter(0) }), INITIALIZE)).status).toBe(429);
  });

  it("charges tool calls to the client and to the audited site, and nothing else", async () => {
    const env = bindings();
    expect((await call(env, INITIALIZE)).status).toBe(200);
    expect((await call(env, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(200);
    expect(env.MCP_RATE_LIMIT_TOOL_CALLS_PER_IP!.keys).toEqual([]);
    expect(env.MCP_RATE_LIMIT_PER_TARGET!.keys).toEqual([]);
    expect((await call(env, toolCall(3, SITE))).status).toBe(200);
    expect((await call(env, toolCall(4, "acmeplumbing.com.au"))).status).toBe(200);
    expect(env.MCP_RATE_LIMIT_TOOL_CALLS_PER_IP!.keys).toEqual(["203.0.113.7", "203.0.113.7"]);
    // www and bare domain share one per-target budget.
    expect(env.MCP_RATE_LIMIT_PER_TARGET!.keys).toEqual(["acmeplumbing.com.au", "acmeplumbing.com.au"]);
    expect(env.MCP_RATE_LIMIT_PER_IP!.keys.length).toBe(4);
  });

  it("refuses a tool call with 429 once the client or the site budget is spent, before fetching anything", async () => {
    const perClient = await call(bindings({ MCP_RATE_LIMIT_TOOL_CALLS_PER_IP: limiter(0) }), toolCall(5, SITE));
    expect(perClient.status).toBe(429);
    const perSite = await call(bindings({ MCP_RATE_LIMIT_PER_TARGET: limiter(0) }), toolCall(6, SITE));
    expect(perSite.status).toBe(429);
    expect(log).toEqual([]);
  });

  it("charges a 2026-07-28 envelope tool call the same way, and serves it", async () => {
    // Modern requests carry their envelope in params._meta; method stays at the top level.
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1.0.0" },
    };
    const env = bindings();
    const modern = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "generate_geo_query_universe", arguments: { url: SITE, count: 10 }, _meta: envelope } };
    const res = await call(env, modern, { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "generate_geo_query_universe" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("GEO query universe");
    expect(env.MCP_RATE_LIMIT_TOOL_CALLS_PER_IP!.keys).toEqual(["203.0.113.7"]);
    expect(env.MCP_RATE_LIMIT_PER_TARGET!.keys).toEqual(["acmeplumbing.com.au"]);
  });

  it("charges the per-site limit again when the homepage redirects to another site", async () => {
    const log: string[] = [];
    vi.stubGlobal("fetch", createFakeFetch({
      log,
      routes: { ...ROUTES, "https://redirector.example.net/": { status: 301, headers: { location: `${SITE}/` } } },
      dns: { ...DNS, "redirector.example.net": ["93.184.216.40"] },
    }));
    // Allowed: both the redirecting domain and the site it lands on are charged.
    const env = bindings();
    expect((await call(env, toolCall(10, "https://redirector.example.net/"))).status).toBe(200);
    expect(env.MCP_RATE_LIMIT_PER_TARGET!.keys).toEqual(["redirector.example.net", "acmeplumbing.com.au"]);
    // Refused: the landing site's budget is spent, so nothing past its homepage is fetched.
    log.length = 0;
    const spent = bindings({ MCP_RATE_LIMIT_PER_TARGET: limiter(1) });
    const res = await call(spent, toolCall(11, "https://redirector.example.net/"));
    expect(await res.text()).toMatch(/rate limit reached for www\.acmeplumbing\.com\.au/);
    const pagesFetched = log.filter((u) => !u.includes("cloudflare-dns.com"));
    expect(pagesFetched).toEqual(["https://redirector.example.net/", `${SITE}/`]);
  });

  it("refuses a JSON-RPC batch carrying more than one tool call", async () => {
    const env = bindings();
    const res = await call(env, [toolCall(7, SITE), toolCall(8, SITE)]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("one tools/call per request");
    expect(env.MCP_RATE_LIMIT_TOOL_CALLS_PER_IP!.keys).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("tool call classification", () => {
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
  it("finds tools/call in single messages and batches, ignoring other methods and non-JSON", () => {
    expect(toolCallsIn(enc(toolCall(1, "https://WWW.Example.com.au/page")))).toEqual([{ target: "example.com.au" }]);
    expect(toolCallsIn(enc([INITIALIZE, toolCall(2, "example.org"), { jsonrpc: "2.0", method: "notifications/initialized" }]))).toEqual([{ target: "example.org" }]);
    expect(toolCallsIn(enc({ jsonrpc: "2.0", id: 3, method: "tools/list" }))).toEqual([]);
    expect(toolCallsIn(enc("not json"))).toEqual([]);
    expect(toolCallsIn(enc([null, 1, "x"]))).toEqual([]);
  });
  it("still counts a tool call whose URL is unusable, without a target key", () => {
    expect(toolCallsIn(enc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "audit_ai_visibility", arguments: { url: "ftp://example.com" } } }))).toEqual([{ target: undefined }]);
    expect(toolCallsIn(enc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "audit_ai_visibility" } }))).toEqual([{ target: undefined }]);
  });
  it("normalises target keys the way the crawler normalises hosts", () => {
    expect(targetKey("https://www.example.com.au./x")).toBe("example.com.au");
    expect(targetKey("Example.COM")).toBe("example.com");
    expect(targetKey("not a url")).toBeUndefined();
  });
});
