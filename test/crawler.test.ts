import { describe, expect, it } from "vitest";
import { crawlSite } from "../src/crawl/crawler";
import { cachedResolver, createDohResolver } from "../src/security/url";
import { createFakeFetch, DNS, ROUTES, SITE } from "./helpers/fakeSite";

function setup(overrides: Parameters<typeof createFakeFetch>[0] = {}) {
  const log: string[] = [];
  const fetchImpl = createFakeFetch({ log, ...overrides });
  return { fetchImpl, log, policy: { resolve: cachedResolver(createDohResolver(fetchImpl)) } };
}

describe("crawlSite", () => {
  it("fetches the homepage first, discovers pages from nav and sitemap, and prioritises commercial pages", async () => {
    const { fetchImpl, policy } = setup();
    const r = await crawlSite(SITE, { policy, fetchImpl, maxPages: 8 });
    expect(r.pages[0]?.role).toBe("home");
    expect(r.pages.filter((p) => p.parsed).length).toBe(8);
    expect(r.robots.fetched).toBe(true);
    expect(r.robots.blockedAiAgents).toEqual(["gptbot"]);
    expect(r.sitemap.found).toBe(true);
    expect(r.sitemap.urlCount).toBeGreaterThanOrEqual(7);
    const urls = r.pages.map((p) => p.finalUrl);
    expect(urls).toContain(`${SITE}/about/`);
    expect(urls).toContain(`${SITE}/services/blocked-drains/`);
    expect(urls).toContain(`${SITE}/pricing/`);
    expect(urls).not.toContain(`${SITE}/privacy/`);
    expect(urls).not.toContain(`${SITE}/brochure.pdf`);
    expect(r.pages.every((p) => p.finalUrl.startsWith(SITE))).toBe(true);
  });

  it("enforces maxPages, the hard cap, and de-duplicates sitemap variants", async () => {
    const { fetchImpl, policy, log } = setup();
    const three = await crawlSite(SITE, { policy, fetchImpl, maxPages: 3 });
    expect(three.pages.length).toBe(3);
    const htmlFetches = log.filter((u) => u.startsWith(SITE) && !/sitemap|robots|dns/.test(u));
    expect(htmlFetches.length).toBe(3);
    const capped = await crawlSite(SITE, { policy, fetchImpl, maxPages: 99 });
    expect(capped.maxPages).toBe(15);
    expect(capped.pages.length).toBeLessThanOrEqual(15);
    const orphanFetches = capped.pages.filter((p) => p.finalUrl.startsWith(`${SITE}/blog/orphan-guide/`));
    expect(orphanFetches.length).toBe(1);
  });

  it("only fetches the homepage when maxPages is 1", async () => {
    const { fetchImpl, policy, log } = setup();
    const r = await crawlSite(SITE, { policy, fetchImpl, maxPages: 1 });
    expect(r.pages.length).toBe(1);
    expect(log.filter((u) => u.startsWith(SITE)).length).toBe(1);
  });

  it("rejects blocked targets before any fetch", async () => {
    const { fetchImpl, policy, log } = setup();
    await expect(crawlSite("http://localhost/", { policy, fetchImpl })).rejects.toThrow();
    await expect(crawlSite("https://evil.rebind.net/", { policy, fetchImpl })).rejects.toThrow(/non-public/);
    expect(log.filter((u) => !u.includes("cloudflare-dns.com"))).toEqual([]);
  });

  it("reports non-HTML and failed pages instead of aborting the crawl", async () => {
    const routes = { ...ROUTES, [`${SITE}/`]: { body: ROUTES[`${SITE}/`]!.body!.replace('<a href="/pricing/">Pricing</a>', '<a href="/pricing/">Pricing</a><a href="/huge/">Huge</a><a href="/slow/">Slow</a>') } };
    const { fetchImpl, policy } = setup({ routes, dns: DNS });
    const r = await crawlSite(SITE, { policy, fetchImpl, maxPages: 15, budgetMs: 6_000 });
    const huge = r.pages.find((p) => p.url === `${SITE}/huge/`);
    expect(huge?.fetch.error).toBe("too_large");
    expect(huge?.parsed).toBeUndefined();
    expect(r.pages.filter((p) => p.parsed).length).toBeGreaterThan(5);
  }, 20_000);
});
