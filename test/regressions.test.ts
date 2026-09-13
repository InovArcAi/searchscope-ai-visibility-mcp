import { describe, expect, it } from "vitest";
import { classifyPath } from "../src/crawl/crawler";
import { buildSiteModel } from "../src/analysis/site";
import { buildAudit } from "../src/analysis/audit";
import { pluralise } from "../src/analysis/queries";
import { parsePage } from "../src/parse/html";
import type { CrawlResult, CrawledPage, PageRole } from "../src/crawl/crawler";

/**
 * Regressions from the first run against a real consultancy site. Each block
 * reproduces something the auditor got visibly wrong in front of a client.
 */

const HOME = "https://example-agency.com.au/";

function page(url: string, role: PageRole, html: string): Promise<CrawledPage> {
  return parsePage(url, html).then((parsed) => ({
    url,
    finalUrl: url,
    role,
    discoveredVia: ["sitemap"] as CrawledPage["discoveredVia"],
    fetch: { ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", bytes: html.length, truncated: false, redirects: 0, fetchMs: 1, xRobotsTag: "" },
    parsed,
  }));
}

function crawl(pages: CrawledPage[]): CrawlResult {
  return {
    target: HOME,
    origin: "https://example-agency.com.au",
    pages,
    skipped: [],
    robots: { fetched: true, disallowsAll: false, blockedAiAgents: [], sitemaps: [] },
    sitemap: { found: true, urlCount: pages.length, sources: [] },
    candidatesConsidered: pages.length,
    maxPages: 12,
    elapsedMs: 10,
  };
}

const doc = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`;

describe("page role classification", () => {
  it("reads hyphenated editorial slugs as editorial, not as things the business sells", () => {
    // Every one of these was previously classified "service" by the depth-1
    // fallback, which made editorial pages look like commercial pages.
    expect(classifyPath("https://a.com/faqs-seo/", HOME)).toBe("faq");
    expect(classifyPath("https://a.com/seo-glossary/", HOME)).toBe("informational");
    expect(classifyPath("https://a.com/ai-instructions/", HOME)).toBe("informational");
    expect(classifyPath("https://a.com/testimonials-and-reviews/", HOME)).toBe("other");
    expect(classifyPath("https://a.com/tools/", HOME)).toBe("other");
    expect(classifyPath("https://a.com/sitemap/", HOME)).toBe("legal");
    expect(classifyPath("https://a.com/terms-and-services/", HOME)).toBe("legal");
  });

  it("still recognises genuine commercial slugs", () => {
    expect(classifyPath("https://a.com/google-maps-seo/", HOME)).toBe("service");
    expect(classifyPath("https://a.com/seo-audit/", HOME)).toBe("service");
    expect(classifyPath("https://a.com/pricing/", HOME)).toBe("pricing");
    expect(classifyPath("https://a.com/multi-location-seo/", HOME)).toBe("location");
    expect(classifyPath("https://a.com/shop/widgets/", HOME)).toBe("product");
  });
});

describe("person detection", () => {
  it("does not turn job titles and acronyms into staff members", async () => {
    const body = `<h1>About</h1>
      <p>Jane Fairweather is the founder and lead consultant, and has run the practice since 2014.</p>
      <p>Our Example Agency Specialist handles the day to day. Ask any GBP Reinstatement Specialist and they will tell you the same. Most SEO Specialist roles are junior.</p>
      <p>Dr Alan Whitfield reviews the technical work.</p>`;
    const site = buildSiteModel(crawl([await page(HOME, "home", doc("Example Agency", body, '<meta property="og:site_name" content="Example Agency">'))]));
    const names = site.people.map((p) => p.name);
    expect(names).toContain("Jane Fairweather");
    expect(names).toContain("Dr Alan Whitfield");
    for (const junk of ["Example Agency", "GBP Reinstatement", "Most SEO"]) {
      expect(names, `"${junk}" is not a person`).not.toContain(junk);
    }
  });
});

describe("brand detection", () => {
  it("ignores a founder's alma mater in the schema graph", async () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Example Agency", url: HOME },
        { "@type": "Person", name: "Jane Fairweather", alumniOf: { "@type": "EducationalOrganization", name: "MBA, International Business (France & Japan)" } },
      ],
    });
    const site = buildSiteModel(crawl([await page(HOME, "home", doc("Example Agency", "<h1>Example Agency</h1><p>We do things.</p>", `<script type="application/ld+json">${ld}</script>`))]));
    expect(site.brand.value).toBe("Example Agency");
    expect(site.brandCandidates.map((b) => b.value).join(" ")).not.toMatch(/MBA/);
  });
});

describe("location detection", () => {
  it("does not treat AI products and industry acronyms as service areas", async () => {
    const body = `<h1>AI search</h1>
      <p>We track visibility across ChatGPT, Google AI Overviews, Copilot and Bing AI, and we monitor GPTBot and GBP signals throughout Shopping and Maps.</p>
      <p>Search Scope style agencies operate in Perth and servicing Fremantle as well.</p>
      <p>Updated in February and reviewed every Monday across Australia.</p>`;
    const site = buildSiteModel(crawl([await page(HOME, "home", doc("Example Agency", body, '<meta property="og:site_name" content="Example Agency">'))]));
    const locs = site.locations.map((l) => l.value);
    expect(locs).toContain("Perth");
    for (const junk of ["ChatGPT", "Google AI Overviews", "Copilot and Bing AI", "GPTBot", "GBP", "Shopping", "Maps", "AI", "February", "Monday"]) {
      expect(locs, `"${junk}" is not a place`).not.toContain(junk);
    }
  });
});

describe("offering detection", () => {
  it("rejects pricing tiers, table cells, headlines and truncated names", async () => {
    const svc = (h1: string) => doc(h1, `<h1>${h1}</h1><p>We deliver ${h1.toLowerCase()} for Australian businesses, typically within four weeks and from $2,400.</p>`);
    const pages = await Promise.all([
      page(HOME, "home", doc("Example Agency", "<h1>Example Agency</h1><p>We are an SEO consultancy.</p>", '<meta property="og:site_name" content="Example Agency">')),
      page("https://example-agency.com.au/google-maps-seo/", "service", svc("Google Maps SEO Services")),
      page("https://example-agency.com.au/essentials/", "service", svc("Essentials")),
      page("https://example-agency.com.au/growth/", "service", svc("Growth")),
      page("https://example-agency.com.au/manual/", "service", svc("Manual 25")),
      page("https://example-agency.com.au/find/", "service", svc("Find the real reason your site is underperforming")),
      page("https://example-agency.com.au/tiers/", "service", svc("AI SEO, Local service business")),
      page("https://example-agency.com.au/cut/", "service", svc("Advanced GBP risk and account architecture (agencies and multi")),
      page("https://example-agency.com.au/two/", "service", svc("The Map Pack is your best lead channel. We get you in it")),
    ]);
    const offerings = buildSiteModel(crawl(pages)).offerings.map((o) => o.value);
    expect(offerings).toContain("Google Maps SEO Services");
    for (const junk of ["Essentials", "Growth", "Manual 25", "Find the real reason your site is underperforming", "AI SEO, Local service business"]) {
      expect(offerings, `"${junk}" is not an offering`).not.toContain(junk);
    }
    expect(offerings.some((o) => o.includes("(") && !o.includes(")")), "no unbalanced brackets").toBe(false);
    expect(offerings.some((o) => /[.!?]\s+[A-Z]/.test(o)), "no multi-sentence names").toBe(false);
  });
});

describe("architecture", () => {
  it("flags a homepage that links to nothing the business sells", async () => {
    const homeBody = `<h1>Example Agency</h1><p>We are an SEO consultancy in Perth helping Australian businesses get found.</p>
      <p>Read the <a href="/blog/">blog</a>, the <a href="/seo-glossary/">glossary</a>, our <a href="/faqs-seo/">FAQs</a> and <a href="/testimonials-and-reviews/">reviews</a>, or <a href="/contact/">contact us</a>.</p>`;
    const pages = await Promise.all([
      page(HOME, "home", doc("Example Agency", homeBody, '<meta property="og:site_name" content="Example Agency">')),
      page("https://example-agency.com.au/google-maps-seo/", "service", doc("Maps", "<h1>Google Maps SEO Services</h1><p>We deliver local map visibility for Australian businesses from $2,400 within four weeks.</p>")),
    ]);
    const report = buildAudit(crawl(pages));
    expect(report.architecture.rating).toBe("Weak");
    expect(report.architecture.hierarchyIssues.join(" ")).toMatch(/homepage links to no service, product, category, pricing or location page/i);
    expect(report.topActions.some((a) => /Link the homepage directly to every core service/i.test(a.action))).toBe(true);
  });

  it("does not fire when the homepage does link to a service page", async () => {
    const homeBody = `<h1>Example Agency</h1><p>We are an SEO consultancy in Perth helping Australian businesses get found.</p>
      <p>See our <a href="/google-maps-seo/">Google Maps SEO service</a>.</p>`;
    const pages = await Promise.all([
      page(HOME, "home", doc("Example Agency", homeBody, '<meta property="og:site_name" content="Example Agency">')),
      page("https://example-agency.com.au/google-maps-seo/", "service", doc("Maps", "<h1>Google Maps SEO Services</h1><p>We deliver local map visibility for Australian businesses from $2,400 within four weeks.</p>")),
    ]);
    const report = buildAudit(crawl(pages));
    expect(report.architecture.hierarchyIssues.join(" ")).not.toMatch(/links to no service/i);
  });
});

describe("query wording", () => {
  it("pluralises category nouns correctly", () => {
    expect(pluralise("SEO agency")).toBe("SEO agencies");
    expect(pluralise("law firm")).toBe("law firms");
    expect(pluralise("cleaning company")).toBe("cleaning companies");
    expect(pluralise("dentist")).toBe("dentists");
    expect(pluralise("bus")).toBe("buses");
    expect(pluralise("coach")).toBe("coaches");
  });
});
