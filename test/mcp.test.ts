import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFetch, SITE } from "./helpers/fakeSite";

const BASE = "https://auditor.example.workers.dev";

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    // Service-binding requests carry no Host header; production requests always do, so add it here.
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("host", new URL(req.url).host);
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
    expect(text).toContain("https://searchscope.com.au/logo-horizontal.png");
    expect(text).toContain("https://searchscope.com.au/contact/");
    expect(text).toContain("Perth, Western Australia");
    const json = await SELF.fetch(`${BASE}/`, { headers: { accept: "application/json" } });
    const body = (await json.json()) as { mcpEndpoint: string; tools: { name: string }[]; publisher: string };
    expect(body.mcpEndpoint).toBe(`${BASE}/mcp`);
    expect(body.tools.map((t) => t.name)).toEqual(["audit_ai_visibility", "extract_site_entities", "generate_geo_query_universe"]);
    expect(body.publisher).toBe("Search Scope");
    expect(body.privacy).toMatch(/not stored/);
  });
  it("404s unknown paths and rejects oversized MCP bodies", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
    const big = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", "content-length": "99999999" }, body: "{}" });
    expect(big.status).toBe(413);
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
