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

describe("actionable fixes", () => {
  const weak = (url: string, html: string) => page(url, "service", html);

  it("quotes the current opening and hands back a prefilled replacement", async () => {
    const home = doc(
      "Weak Co",
      `<h1>Weak Co</h1><p>Fast. Friendly. Affordable.</p><p>Call today.</p>`,
      '<meta property="og:site_name" content="Weak Co"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Weak Co","areaServed":"Fremantle"}</script>',
    );
    const svc = doc("Drains", `<h1>Blocked Drain Clearing</h1><p>Book now.</p><p>We are the best.</p><p>Jobs from $220 and most are done in 2 days.</p>`);
    const report = buildAudit(crawl(await Promise.all([page(HOME, "home", home), weak("https://example-agency.com.au/blocked-drains/", svc)])));
    const fix = report.fixes.openings.find((o) => o.url.includes("blocked-drains"));
    expect(fix, "the weak service page should get an opening fix").toBeTruthy();
    expect(fix!.h1).toBe("Blocked Drain Clearing");
    expect(fix!.currentOpening).toBe("Book now.");
    // The replacement is prefilled with what was actually observed.
    expect(fix!.suggested).toContain("Blocked Drain Clearing is");
    expect(fix!.suggested).toContain("Weak Co provides it for");
    expect(fix!.suggested).toContain("Fremantle");
    expect(fix!.suggested).toContain("Pricing starts at $220.");
    // and leaves honest blanks for what was not
    expect(fix!.suggested).toMatch(/\[who it is for[^\]]*\]/);
  });

  it("turns a hedged answer into the opening sentence it should have", async () => {
    const svc = doc(
      "Drains",
      `<h1>Blocked Drain Clearing</h1>
       <p>We clear blocked drains for Perth households, usually the same day, with a camera inspection included.</p>
       <h2>How much does drain clearing cost?</h2><p>It depends on many factors, contact us to find out.</p>`,
    );
    const report = buildAudit(crawl(await Promise.all([
      page(HOME, "home", doc("Weak Co", "<h1>Weak Co</h1><p>We clear blocked drains across Perth for households and strata managers, usually within a day.</p>", '<meta property="og:site_name" content="Weak Co">')),
      weak("https://example-agency.com.au/blocked-drains/", svc),
    ])));
    const fix = report.fixes.answers.find((a) => /how much/i.test(a.question));
    expect(fix).toBeTruthy();
    expect(fix!.currentFirstSentence).toBe("It depends on many factors, contact us to find out.");
    expect(fix!.problem).toMatch(/hedges/i);
    expect(fix!.suggestedOpening).toBe("Drain clearing costs [range] ...");
  });

  it("shapes answer openings from the question", async () => {
    const { suggestedAnswerOpening } = await import("../src/analysis/retrievability");
    expect(suggestedAnswerOpening("How much does a rewire cost?")).toBe("A rewire costs [range] ...");
    expect(suggestedAnswerOpening("How long does conveyancing take?")).toBe("Conveyancing takes [timeframe] ...");
    expect(suggestedAnswerOpening("What is entity SEO?")).toBe("Entity SEO is [definition in one sentence] ...");
    // A section label is not a question and must not get a question-shaped answer.
    expect(suggestedAnswerOpening("What clients say.")).toMatch(/^\[Answer the heading/);
  });

  it("emits a paste-ready organisation block using detected values", async () => {
    const home = doc(
      "Weak Co",
      `<h1>Weak Co</h1><p>Short.</p><p>Call 08 9123 4567 or email hi@weak.co. We serve Fremantle.</p><p>Jane Fairweather is the founder.</p>`,
      '<meta property="og:site_name" content="Weak Co">',
    );
    const report = buildAudit(crawl([await page(HOME, "home", home)]));
    expect(report.structuredData.rating).toBe("Weak");
    const snippet = report.fixes.schemaSnippet;
    expect(snippet, "a site with no organisation schema should get a snippet").toBeTruthy();
    const parsed = JSON.parse(snippet!.jsonLd) as Record<string, unknown>;
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["name"]).toBe("Weak Co");
    expect(JSON.stringify(parsed)).toContain("Jane Fairweather");
    expect(JSON.stringify(parsed)).toContain("[Google Business Profile URL]");
  });

  it("ignores accessibility skip links when reading the opening passage", async () => {
    const p = await parsePage("https://a.com/x/", doc("X", `<a href="#main">Skip to main content</a><h1>Gutter Cleaning</h1><p>Book now.</p>`));
    expect(p.paragraphs).not.toContain("Skip to main content");
    expect(p.paragraphs[0]).toBe("Book now.");
  });

  it("suggests a different destination rather than the same page repeatedly", async () => {
    const svc = (n: string) => doc(n, `<h1>${n}</h1><p>We deliver ${n} for Perth businesses within four weeks from $2,400.</p>`);
    const guide = (n: string) => doc(n, `<h1>${n}</h1><p>${n} explained for Perth businesses, with the steps involved and what each one costs.</p>`);
    const pages = await Promise.all([
      page(HOME, "home", doc("Weak Co", "<h1>Weak Co</h1><p>We provide SEO for Perth businesses that need leads.</p>", '<meta property="og:site_name" content="Weak Co">')),
      page("https://example-agency.com.au/drain-clearing/", "service", svc("Drain Clearing")),
      page("https://example-agency.com.au/hot-water/", "service", svc("Hot Water Repairs")),
      page("https://example-agency.com.au/blog/drain-guide/", "informational", guide("Drain Guide")),
      page("https://example-agency.com.au/blog/hot-water-guide/", "informational", guide("Hot Water Guide")),
    ]);
    const links = buildAudit(crawl(pages)).fixes.links;
    const counts = new Map<string, number>();
    for (const l of links) counts.set(l.to, (counts.get(l.to) ?? 0) + 1);
    for (const [to, n] of counts) expect(n, `${to} suggested ${n} times`).toBeLessThanOrEqual(2);
    expect(links.every((l) => l.suggestedAnchor.split(/\s+/).length >= 2)).toBe(true);
  });
});
