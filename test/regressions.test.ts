import { afterEach, describe, expect, it, vi } from "vitest";
import { runEntities } from "../src/tools/run";
import { createFakeFetch, ROUTES, SITE, type Route } from "./helpers/fakeSite";
import { classifyPath } from "../src/crawl/crawler";
import { buildSiteModel } from "../src/analysis/site";
import { buildAudit } from "../src/analysis/audit";
import { inferCategory, pluralise } from "../src/analysis/queries";
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
    expect(pluralise("handyman")).toBe("handymen");
    expect(pluralise("salesperson")).toBe("salespeople");
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

describe("trade sites", () => {
  it("names the category from the business, not from the job list", async () => {
    // A handyman who lists gutter cleaning and pressure washing was being
    // called a cleaning company, which then wrote every monitoring prompt wrong.
    const home = doc(
      "Handyman Canberra | Bright Spark Handy Man Services",
      `<h1>Bright Spark Handy Man Services</h1><p>We take on home repairs and maintenance for households across Canberra, usually within 3 days.</p>`,
      '<meta property="og:site_name" content="Bright Spark Handy Man Services"><meta name="description" content="Handyman in Canberra for repairs and maintenance.">',
    );
    const svc = (n: string) => doc(n, `<h1>${n}</h1><p>We provide ${n.toLowerCase()} for Canberra homes, booked within 3 days and quoted up front.</p>`);
    const site = buildSiteModel(crawl(await Promise.all([
      page(HOME, "home", home),
      page("https://example-agency.com.au/gutter-cleaning/", "service", svc("Gutter Cleaning")),
      page("https://example-agency.com.au/pressure-washing/", "service", svc("Pressure Washing")),
    ])));
    expect(inferCategory(site)).toBe("handyman");
  });

  it("reads a suburb landing-page network as places, not as services", async () => {
    const suburb = (n: string) => doc(`Handyman ${n}`, `<h1>HANDYMAN IN ${n.toUpperCase()}, EVERY SUBURB.</h1><p>We cover ${n} for repairs, assembly and maintenance, usually within 3 days.</p>`);
    const pages = await Promise.all([
      page(HOME, "home", doc("Handy Co", "<h1>Handy Co</h1><p>Home repairs and maintenance across Canberra for households and renters.</p>", '<meta property="og:site_name" content="Handy Co">')),
      page("https://example-agency.com.au/handyman-belconnen/", "service", suburb("Belconnen")),
      page("https://example-agency.com.au/handyman-gungahlin/", "service", suburb("Gungahlin")),
      page("https://example-agency.com.au/handyman-woden-valley/", "service", suburb("Woden Valley")),
      page("https://example-agency.com.au/handyman-prices-canberra/", "pricing", doc("Prices", "<h1>Handyman Prices</h1><p>Our call-out is $89 and most jobs are quoted up front before we start.</p>")),
    ]);
    const site = buildSiteModel(crawl(pages));
    const locs = site.locations.map((l) => l.value);
    const offers = site.offerings.map((o) => o.value);
    expect(locs).toEqual(expect.arrayContaining(["Belconnen", "Gungahlin"]));
    for (const suburbName of ["Belconnen", "Gungahlin", "Woden Valley"]) {
      expect(offers, `${suburbName} is a place, not a service`).not.toContain(suburbName);
    }
    // The pricing page shares the slug prefix but is not a suburb.
    expect(locs).not.toContain("Prices Canberra");
  });

  it("drops trailing punctuation and shouty caps from offering names", async () => {
    const pages = await Promise.all([
      page(HOME, "home", doc("Handy Co", "<h1>Handy Co</h1><p>Home repairs and maintenance across Canberra for households and renters.</p>", '<meta property="og:site_name" content="Handy Co">')),
      page("https://example-agency.com.au/repairs/", "service", doc("R", "<h1>HOME REPAIRS</h1><p>We repair doors, windows and walls for Canberra homes within 3 days.</p>")),
      page("https://example-agency.com.au/handyman/", "service", doc("H", "<h1>Handyman Services, Canberra</h1><p>General handyman work for Canberra households, quoted up front.</p>")),
    ]);
    const offers = buildSiteModel(crawl(pages)).offerings.map((o) => o.value);
    expect(offers).toContain("Home Repairs");
    expect(offers.some((o) => /[.,;:]$/.test(o)), "no trailing punctuation").toBe(false);
    expect(offers.some((o) => o === o.toUpperCase() && o.length > 3), "no shouting").toBe(false);
  });
});

describe("trade site copy conventions", () => {
  it("accepts a contraction as a positioning sentence", async () => {
    const about = doc("About", `<h1>About Us</h1><p>We're a Canberra-based handyman and property maintenance team. Locally operated, fully insured, and straight about what things cost.</p>`);
    const site = buildSiteModel(crawl(await Promise.all([
      page(HOME, "home", doc("Handy Co", "<h1>Handy Co</h1><p>Home repairs and maintenance across Canberra for households and renters, usually within three days.</p>", '<meta property="og:site_name" content="Handy Co">')),
      page("https://example-agency.com.au/about/", "about", about),
    ])));
    const { analysePageRetrievability } = await import("../src/analysis/retrievability");
    const about_ = site.pages.find((p) => p.finalUrl.includes("/about/"))!;
    expect(analysePageRetrievability(about_.parsed).hasDefinition).toBe(true);
  });

  it("does not treat a call-to-action band as an unanswered question", async () => {
    const { analysePageRetrievability } = await import("../src/analysis/retrievability");
    const parsed = await parsePage(
      "https://a.com/prices/",
      doc("Prices", `<h1>Handyman Prices</h1><p>Our call-out is $89 and most jobs are quoted up front before any work starts.</p><h2>NEED IT SORTED?</h2><h2>What does a call-out cost?</h2><p>A call-out is $89, which covers the first half hour on site.</p>`),
    );
    const r = analysePageRetrievability(parsed);
    expect(r.qa.map((q) => q.question)).not.toContain("NEED IT SORTED?");
    expect(r.qa.map((q) => q.question)).toContain("What does a call-out cost?");
  });

  it("does not shout the subject back in a suggested rewrite", async () => {
    const pages = await Promise.all([
      page(HOME, "home", doc("Handy Co", "<h1>Handy Co</h1><p>Home repairs and maintenance across Canberra for households and renters, usually within three days.</p>", '<meta property="og:site_name" content="Handy Co">')),
      page("https://example-agency.com.au/services/", "service", doc("S", `<h1>HOME SERVICES.</h1><p>Book now.</p>`)),
    ]);
    const fix = buildAudit(crawl(pages)).fixes.openings.find((o) => o.url.includes("/services/"));
    expect(fix).toBeTruthy();
    expect(fix!.suggested).toContain("Home Services is");
    expect(fix!.suggested).not.toContain("HOME SERVICES is");
  });
});

describe("scraped offerings are never used as raw regular expressions", () => {
  it("escapes regex metacharacters before matching page titles", async () => {
    const { escapeRegExp } = await import("../src/analysis/audit");
    expect(() => new RegExp(escapeRegExp("[x"), "i")).not.toThrow();
    expect(new RegExp(escapeRegExp("(a+)+$x"), "i").test("(a+)+$x services")).toBe(true);
  });
});

describe("Legal name detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function routesWith(edit: (url: string, body: string) => string): Record<string, Route> {
    const out: Record<string, Route> = {};
    for (const [url, route] of Object.entries(ROUTES)) {
      const body = (route.body ?? "").replace("Acme Plumbing Pty Ltd, ABN", "Acme Plumbing, ABN");
      out[url] = { ...route, body: edit(url, body) };
    }
    return out;
  }

  it("ignores company names in running copy and quotes on other pages (an example is not the site's legal name)", async () => {
    const routes = routesWith((url, body) =>
      url.includes("/services/blocked-drains/")
        ? body.replace("</h1>", '</h1><p>If your ASIC registration shows "Smith Electrical Services Pty Ltd" and your profile shows Smith Electrical, that is a mismatch. Our client Jones Building Pty Ltd had the same issue.</p>')
        : body,
    );
    vi.stubGlobal("fetch", createFakeFetch({ routes }));
    const out = await runEntities({ url: SITE }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const orgs = (out.data as any).relatedEntities.organisation.map((o: { name: string }) => o.name);
    expect(orgs).toEqual(["Acme Plumbing"]);
  });

  it("still reads a legal name from the footer or the About page", async () => {
    vi.stubGlobal("fetch", createFakeFetch());
    const footer = await runEntities({ url: SITE }, {});
    expect(footer.ok && (footer.data as any).relatedEntities.organisation.map((o: { name: string }) => o.name)).toContain("Acme Plumbing Pty Ltd");

    const routes = routesWith((url, body) => (url === `${SITE}/about/` ? body.replace("</h1>", "</h1><p>Acme Plumbing is a trading name of Acme Holdings Pty Ltd.</p>") : body));
    vi.stubGlobal("fetch", createFakeFetch({ routes }));
    const about = await runEntities({ url: SITE }, {});
    expect(about.ok && (about.data as any).relatedEntities.organisation.map((o: { name: string }) => o.name)).toContain("Acme Holdings Pty Ltd");
  });
});
