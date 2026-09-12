import { describe, expect, it } from "vitest";
import { safeFetch } from "../src/fetch/safeFetch";
import { cachedResolver, createDohResolver } from "../src/security/url";
import { createFakeFetch, SITE } from "./helpers/fakeSite";

function policyWith(fetchImpl: typeof fetch) {
  return { resolve: cachedResolver(createDohResolver(fetchImpl)) };
}

describe("safeFetch", () => {
  const fetchImpl = createFakeFetch();
  const policy = policyWith(fetchImpl);

  it("fetches a valid public HTML page", async () => {
    const r = await safeFetch(`${SITE}/`, { policy, fetchImpl, kind: "html" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toContain("<h1>");
    expect(r.truncated).toBe(false);
  });

  it("rejects non-HTML responses without reading them", async () => {
    const r = await safeFetch(`${SITE}/brochure.pdf`, { policy, fetchImpl, kind: "html" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("non_html");
    expect(r.body).toBe("");
  });

  it("rejects an oversized declared body and truncates an oversized streamed body", async () => {
    const declared = await safeFetch(`${SITE}/huge/`, { policy, fetchImpl, kind: "html" });
    expect(declared.error).toBe("too_large");
    const streamed = await safeFetch(`${SITE}/huge-stream/`, { policy, fetchImpl, kind: "html", maxBytes: 100_000 });
    expect(streamed.ok).toBe(true);
    expect(streamed.truncated).toBe(true);
    expect(streamed.bytes).toBe(100_000);
  });

  it("times out slow responses", async () => {
    const r = await safeFetch(`${SITE}/slow/`, { policy, fetchImpl, kind: "html", timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
  });

  it("follows a safe redirect and re-validates every hop", async () => {
    const r = await safeFetch(`${SITE}/redirect-ok/`, { policy, fetchImpl, kind: "html" });
    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe(`${SITE}/pricing/`);
    expect(r.redirects).toBe(1);
  });

  it("blocks redirects into private IP space and metadata endpoints", async () => {
    const priv = await safeFetch(`${SITE}/redirect-private/`, { policy, fetchImpl, kind: "html" });
    expect(priv.error).toBe("blocked");
    expect(priv.errorDetail).toMatch(/private|reserved|non-public|IP address/i);
    const meta = await safeFetch(`${SITE}/redirect-metadata/`, { policy, fetchImpl, kind: "html" });
    expect(meta.error).toBe("blocked");
  });

  it("blocks redirects to a hostname that resolves to a private address", async () => {
    const r = await safeFetch(`${SITE}/redirect-rebind/`, { policy, fetchImpl, kind: "html" });
    expect(r.error).toBe("blocked");
    expect(r.errorDetail).toMatch(/non-public/);
  });

  it("stops redirect loops", async () => {
    const r = await safeFetch(`${SITE}/redirect-loop/`, { policy, fetchImpl, kind: "html", maxRedirects: 3 });
    expect(r.error).toBe("too_many_redirects");
  });

  it("never fetches a blocked initial target", async () => {
    const log: string[] = [];
    const f = createFakeFetch({ log });
    const r = await safeFetch("http://127.0.0.1/", { policy: policyWith(f), fetchImpl: f, kind: "html" });
    expect(r.error).toBe("blocked");
    expect(log).toEqual([]);
    const r2 = await safeFetch("https://ipv6-internal.net/", { policy: policyWith(f), fetchImpl: f, kind: "html" });
    expect(r2.error).toBe("blocked");
    expect(log.filter((u) => u.startsWith("https://ipv6-internal.net"))).toEqual([]);
  });

  it("identifies itself with the Search Scope user agent", async () => {
    let ua = "";
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      ua = new Headers(init?.headers).get("user-agent") ?? "";
      return createFakeFetch()(input, init);
    }) as typeof fetch;
    await safeFetch(`${SITE}/`, { policy: policyWith(f), fetchImpl: f, kind: "html" });
    expect(ua).toContain("SearchScopeAIVisibilityAuditor");
  });
});
