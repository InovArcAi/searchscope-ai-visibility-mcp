import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFetch, SITE } from "./helpers/fakeSite";

// /mcp only answers on the hostnames in SERVICE_HOSTNAMES, so tests use the real workers.dev one.
const BASE = "https://searchscope-ai-visibility-mcp.searchscope.workers.dev";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "guard-test", version: "1.0.0" } } });

// /mcp fails closed without a client IP, which Cloudflare always sets in production.
// Each connection gets its own address so per-client limits never couple tests.
let clientNumber = 0;
const nextClientIp = () => `198.51.100.${++clientNumber}`;

/** A raw POST to /mcp, for checks that need headers or bodies the MCP client would never send. */
function post(url: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  // Service-binding requests carry no Host header; production requests always do.
  return SELF.fetch(new Request(url, { method: "POST", headers: { ...MCP_HEADERS, host: new URL(url).host, "cf-connecting-ip": nextClientIp(), ...headers }, body }));
}

/** A body with no Content-Length header, delivered in 1 KB chunks. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 1024));
      offset += 1024;
    },
  });
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const clientIp = nextClientIp();
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    // Service-binding requests carry no Host header; production requests always do, so add it here.
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("host", new URL(req.url).host);
      headers.set("cf-connecting-ip", clientIp);
      return SELF.fetch(new Request(req, { headers }));
    }) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

describe("HTTP surface", () => {
  it("serves /health", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "Search Scope AI Visibility Auditor" });
  });
  it("serves a landing page at / as HTML and JSON", async () => {
    const html = await SELF.fetch(`${BASE}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const text = await html.text();
    expect(text).toContain("/mcp");
    // Privacy promise must stay visible on the page, and the Search Scope
    // branding (logo, publisher name, contact call to action) must survive edits.
    expect(text).toMatch(/Nothing is stored/i);
    expect(text).toContain("Search Scope AI Visibility Auditor");
    expect(text).toContain('src="/logo.png"');
    expect(text).toContain("https://searchscope.com.au/contact/");
    expect(text).toContain("Perth, Western Australia");
    const json = await SELF.fetch(`${BASE}/`, { headers: { accept: "application/json" } });
    const body = (await json.json()) as { mcpEndpoint: string; tools: { name: string }[]; publisher: string; privacy: string; logoUrl: string };
    expect(body.mcpEndpoint).toBe(`${BASE}/mcp`);
    expect(body.tools.map((t) => t.name)).toEqual(["audit_ai_visibility", "extract_site_entities", "generate_geo_query_universe"]);
    expect(body.publisher).toBe("Search Scope");
    expect(body.privacy).toMatch(/not stored/);
    expect(body.logoUrl).toBe(`${BASE}/logo.png`);
  });
  it("serves its own brand assets rather than hotlinking them", async () => {
    const logo = await SELF.fetch(`${BASE}/logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await logo.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(2000);
    // PNG magic number, so a corrupted base64 payload fails here.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const icon = await SELF.fetch(`${BASE}/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(await icon.text()).toContain("<svg");
  });

  it("404s unknown paths and rejects oversized MCP bodies", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
    const big = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", "content-length": "99999999" }, body: "{}" });
    expect(big.status).toBe(413);
  });
});

describe("request guards on /mcp", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers only on its own hostnames and loopback", async () => {
    for (const origin of ["https://mcp.searchscope.com.au", BASE, "http://localhost:8787", "http://127.0.0.1:8787"]) {
      expect((await post(`${origin}/mcp`, INITIALIZE)).status, origin).toBe(200);
    }
    for (const origin of ["https://rebound.example.net", "https://someone-else.workers.dev", "https://mcp.searchscope.com.au.evil.net"]) {
      const res = await post(`${origin}/mcp`, INITIALIZE);
      expect(res.status, origin).toBe(403);
      expect(await res.text()).toContain("Host not allowed");
    }
    // Static pages are not protocol endpoints and stay reachable.
    expect((await SELF.fetch("https://rebound.example.net/health")).status).toBe(200);
  });

  it("accepts no Origin or any well-formed web origin, and refuses malformed or opaque ones", async () => {
    expect((await post(`${BASE}/mcp`, INITIALIZE)).status).toBe(200);
    for (const origin of ["https://claude.ai", "http://localhost:6274", "https://inspector.example.com:8443", "https://claude.ai/"]) {
      expect((await post(`${BASE}/mcp`, INITIALIZE, { origin })).status, origin).toBe(200);
    }
    for (const origin of ["null", "not a url", "chrome-extension://abcdefghijklmnop", "chrome-extension://kjdngodjcfbjnkclnkcchhebjnfncchl", "file://", "https://claude.ai/some/path", "https://user@claude.ai", "https://claude.ai?x=1", "ftp://example.com"]) {
      const res = await post(`${BASE}/mcp`, INITIALIZE, { origin });
      expect(res.status, origin).toBe(403);
      expect(await res.text()).toContain("Origin not allowed");
    }
  });

  it("enforces the body limit on the bytes received, not on Content-Length", async () => {
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "audit_ai_visibility", arguments: { url: SITE } } };
    // A valid tool call padded past 32 KB, sent chunked with no Content-Length.
    const padded = JSON.stringify(call).replace(/}$/, `,"pad":"${"x".repeat(40_000)}"}`);
    const req = new Request(`${BASE}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, host: new URL(BASE).host, "cf-connecting-ip": nextClientIp() }, body: streamOf(padded) });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await SELF.fetch(req);
    expect(res.status).toBe(413);
    expect(log).toEqual([]);
    // The same route still accepts a small chunked body.
    expect((await SELF.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, host: new URL(BASE).host, "cf-connecting-ip": nextClientIp() }, body: streamOf(INITIALIZE) }))).status).toBe(200);
  });

  it("refuses tool arguments with more elements than any real input has", async () => {
    // A different site from the fixture, so this call does not spend the fixture's per-target budget.
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "audit_ai_visibility", arguments: { url: "https://elements.example.org/", junk: Array.from({ length: 100 }, (_, i) => i) } } };
    const res = await post(`${BASE}/mcp`, JSON.stringify(call), { "mcp-protocol-version": "2025-11-25" });
    expect(await res.text()).toMatch(/more than the maximum of 32 elements/);
    expect(log).toEqual([]);
  });
});

describe("MCP tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", createFakeFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the three tools with clear descriptions and schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["audit_ai_visibility", "extract_site_entities", "generate_geo_query_universe"]);
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(200);
      expect(t.description).toMatch(/does NOT/);
      expect(t.inputSchema.properties).toHaveProperty("url");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
  });

  it("audit_ai_visibility returns the ten sections with structured content", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "audit_ai_visibility", arguments: { url: SITE, maxPages: 8 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    for (const h of ["## A. Executive summary", "## B. Entity clarity", "## C. AI retrievability", "## D. Information gain", "## E. Trust and corroboration", "## F. Internal linking", "## G. Structured data", "## H. Commercial query coverage", "## I. Top recommended actions", "## J. 20 AI search prompts"]) {
      expect(text).toContain(h);
    }
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.crawl.pagesFetched).toBe(8);
    expect(sc.executiveSummary.ratings.entityClarity).toMatch(/Strong|Moderate|Weak/);
    expect(sc.entityClarity.primaryEntity.name).toBe("Acme Plumbing");
    expect(sc.entityClarity.primaryEntity.confidence).toBe("high");
    expect(sc.trustSignals.namedPeople.map((p: { name: string }) => p.name)).toContain("John Smith");
    expect(sc.trustSignals.contact.phones.length).toBeGreaterThan(0);
    expect(sc.trustSignals.credentials.join(" ")).toMatch(/licensed|Master Plumber|since 2009/i);
    expect(sc.informationGain.found.some((f: { signal: string }) => /our data/i.test(f.signal))).toBe(true);
    expect(sc.structuredData.typesFound.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(["Plumber", "Article", "Person"]));
    expect(sc.crawl.robotsBlocksAiCrawlers).toEqual(["gptbot"]);
    const retr = sc.aiRetrievability.pages.find((p: { url: string }) => p.url === `${SITE}/services/blocked-drains/`);
    expect(retr.qa.map((q: { verdict: string }) => q.verdict)).toEqual(["vague", "missing", "direct"]);
    expect(sc.topActions.length).toBeLessThanOrEqual(10);
    expect(sc.topActions.length).toBeGreaterThan(3);
    expect(sc.topActions[0].rank).toBe(1);
    expect(sc.topActions.some((a: { action: string }) => /GPTBot|gptbot/i.test(a.action))).toBe(true);
    expect(sc.monitoringPrompts.length).toBe(20);
    expect(new Set(sc.monitoringPrompts.map((q: { intent: string }) => q.intent)).size).toBeGreaterThanOrEqual(8);
    expect(sc.commercialCoverage.inferredCategory).toBe("plumber");
    expect(sc.commercialCoverage.inferredLocations).toContain("Perth");
    expect(sc.architecture.ambiguousAnchors.map((a: { text: string }) => a.text)).toEqual(expect.arrayContaining(["learn more", "click here"]));
    expect(sc.methodology).toMatch(/does not measure actual citations/);
    // Every report carries the Search Scope attribution and call to action.
    expect(text).toContain("## About this report");
    expect(text).toContain("https://searchscope.com.au/contact/");
    await client.close();
  });

  it("audit_ai_visibility honours maxPages and reports orphan-like sitemap-only pages", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "audit_ai_visibility", arguments: { url: "acmeplumbing.com.au", maxPages: 3 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.crawl.pagesFetched).toBeLessThanOrEqual(3);
    const full = await client.callTool({ name: "audit_ai_visibility", arguments: { url: SITE, maxPages: 15 } });
    const fsc = full.structuredContent as Record<string, any>;
    expect(fsc.architecture.orphanLike.some((o: { url: string }) => o.url.includes("orphan-guide"))).toBe(true);
    await client.close();
  });

  it("extract_site_entities returns a grounded entity map with relationships and confidence", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "extract_site_entities", arguments: { url: SITE } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.primaryEntity.name).toBe("Acme Plumbing");
    expect(sc.primaryEntity.type).toBe("Plumber");
    expect(sc.relatedEntities.people.map((p: { name: string }) => p.name)).toContain("John Smith");
    expect(sc.relatedEntities.locations.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(["Victoria Park", "WA", "Perth"]));
    expect(sc.relatedEntities.services.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(["Blocked drain clearing"]));
    const rels = sc.relationships.map((r: { subject: string; predicate: string; object: string }) => `${r.subject} -> ${r.predicate} -> ${r.object}`);
    expect(rels).toContain("Acme Plumbing -> offers -> Blocked drain clearing");
    expect(rels.some((r: string) => /John Smith -> founder.* of -> Acme Plumbing/i.test(r))).toBe(true);
    expect(rels.some((r: string) => /Acme Plumbing -> (located in|serves) -> Perth/.test(r))).toBe(true);
    expect(sc.schemaTypesFound.map((t: { type: string }) => t.type)).toContain("Plumber");
    expect(sc.suggestedSchemaTypes.map((t: { type: string }) => t.type).join(" ")).not.toMatch(/FAQPage|HowTo|AggregateRating/);
    expect(sc.relationships.every((r: { confidence: string }) => ["high", "medium", "low"].includes(r.confidence))).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("## Entity relationships");
    expect(text).toContain("## About this report");
    await client.close();
  });

  it("generate_geo_query_universe returns grouped prompts and honours overrides and count", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "generate_geo_query_universe", arguments: { url: SITE, count: 50 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.queries.length).toBe(50);
    expect(sc.brand).toBe("Acme Plumbing");
    expect(sc.location).toBe("Perth");
    expect(Object.keys(sc.groups).length).toBeGreaterThanOrEqual(8);
    for (const q of sc.queries) {
      expect(["high", "medium", "low"]).toContain(q.commercialPriority);
      expect(q.idealPageType.length).toBeGreaterThan(3);
      expect(q.buyerStage.length).toBeGreaterThan(3);
    }
    expect(new Set(sc.queries.map((q: { query: string }) => q.query.toLowerCase())).size).toBe(50);
    const over = await client.callTool({ name: "generate_geo_query_universe", arguments: { url: SITE, service: "gas fitting", location: "Mandurah", count: 12 } });
    const osc = over.structuredContent as Record<string, any>;
    expect(osc.queries.length).toBe(12);
    expect(osc.queries.some((q: { query: string }) => /Mandurah/.test(q.query))).toBe(true);
    expect(osc.queries.some((q: { query: string }) => /gas fitting/.test(q.query))).toBe(true);
    const nonLocal = await client.callTool({ name: "generate_geo_query_universe", arguments: { url: SITE, location: "none" } });
    const nsc = nonLocal.structuredContent as Record<string, any>;
    expect(nsc.queries.length).toBe(40);
    expect(nsc.queries.some((q: { intent: string }) => q.intent === "local")).toBe(false);
    await client.close();
  });

  it("rejects unsafe or invalid targets with a tool error, without fetching them", async () => {
    const log: string[] = [];
    vi.stubGlobal("fetch", createFakeFetch({ log }));
    const client = await connect();
    for (const url of ["http://localhost:8787/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "https://evil.rebind.net/", "ftp://example.com/", "https://user:pw@acmeplumbing.com.au/", "not a url"]) {
      const res = await client.callTool({ name: "audit_ai_visibility", arguments: { url } });
      expect(res.isError, url).toBe(true);
      expect((res.content as { text: string }[])[0]?.text).toMatch(/rejected|not a valid|Only http|credentials/i);
    }
    expect(log.filter((u) => !u.includes("cloudflare-dns.com"))).toEqual([]);
    const badArgs = await client.callTool({ name: "audit_ai_visibility", arguments: { url: SITE, maxPages: 500 } }).catch((e: Error) => e);
    expect(badArgs instanceof Error || (badArgs as { isError?: boolean }).isError).toBeTruthy();
    await client.close();
  });
});
