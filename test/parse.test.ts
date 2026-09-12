import { describe, expect, it } from "vitest";
import { parsePage } from "../src/parse/html";
import { parseRobotsSitemaps, parseSitemapXml, robotsBlockedAgents, robotsDisallowsAll } from "../src/crawl/sitemap";
import { canonicalKey, classifyPath, dedupeUrls } from "../src/crawl/crawler";
import { ROUTES, SITE } from "./helpers/fakeSite";

describe("parsePage", () => {
  it("extracts metadata, headings, main copy, links and JSON-LD from the homepage", async () => {
    const p = await parsePage(`${SITE}/`, ROUTES[`${SITE}/`]!.body!);
    expect(p.title).toBe("Acme Plumbing | Perth Plumber");
    expect(p.metaDescription).toContain("description");
    expect(p.ogSiteName).toBe("Acme Plumbing");
    expect(p.lang).toBe("en-AU");
    expect(p.headings.h1).toEqual(["Perth plumbers for blocked drains and hot water"]);
    expect(p.headings.h2).toContain("How quickly can a plumber get to me in Perth?");
    expect(p.paragraphs[0]).toMatch(/^Acme Plumbing is a licensed plumbing company/);
    expect(p.paragraphs.join(" ")).not.toContain("window.x");
    expect(p.wordCount).toBeGreaterThan(80);
    expect(p.jsonLd.map((n) => n.type[0])).toEqual(expect.arrayContaining(["Plumber", "Person", "PostalAddress", "Service"]));
    expect(p.testimonialElements).toBe(1);
    expect(p.footerText).toContain("© 2026 Acme Plumbing");
  });

  it("extracts internal links with anchor text and nav/chrome flags, and resolves relative hrefs", async () => {
    const p = await parsePage(`${SITE}/`, ROUTES[`${SITE}/`]!.body!);
    const nav = p.links.filter((l) => l.nav);
    expect(nav.length).toBeGreaterThanOrEqual(8);
    expect(nav.every((l) => l.chrome)).toBe(true);
    const about = p.links.find((l) => l.href === `${SITE}/about/` && l.nav);
    expect(about?.text).toBe("About");
    const guide = p.links.filter((l) => l.href === `${SITE}/blog/how-to-fix-a-blocked-drain/` && !l.chrome);
    expect(guide.map((l) => l.text)).toEqual(["guide to fixing a blocked drain", "learn more"]);
    const external = p.links.filter((l) => !l.internal);
    expect(external.map((l) => new URL(l.href).hostname)).toEqual(expect.arrayContaining(["www.facebook.com", "www.instagram.com"]));
  });

  it("captures bylines, dates and article schema", async () => {
    const p = await parsePage(`${SITE}/blog/how-to-fix-a-blocked-drain/`, ROUTES[`${SITE}/blog/how-to-fix-a-blocked-drain/`]!.body!);
    expect(p.authorTexts.join(" ")).toContain("John Smith");
    expect(p.publishedTime).toBe("2026-03-03T09:00:00+08:00");
    expect(p.datesInText).toContain("3 March 2026");
    expect(p.jsonLd.some((n) => n.type.includes("Article"))).toBe(true);
    expect(p.links.some((l) => l.href.startsWith("https://www.watercorporation.com.au/") && !l.chrome)).toBe(true);
  });

  it("survives malformed HTML and a document without body", async () => {
    const p = await parsePage(`${SITE}/x`, "<p>unclosed<p>second<h2>Heading<div>text</div><script>evil()</script>");
    expect(p.paragraphs).toEqual(["unclosed", "second", "text"]);
    expect(p.headings.h2).toEqual(["Heading"]);
  });
});

describe("sitemap and robots parsing", () => {
  it("parses a sitemap index and a urlset, including CDATA and entities", () => {
    const idx = parseSitemapXml(ROUTES[`${SITE}/sitemap.xml`]!.body!);
    expect(idx.isIndex).toBe(true);
    expect(idx.urls).toEqual([`${SITE}/page-sitemap.xml`, `${SITE}/post-sitemap.xml`]);
    const set = parseSitemapXml(`<urlset><url><loc><![CDATA[https://a.com/x?a=1&amp;b=2]]></loc></url><url><loc>\n https://a.com/y \n</loc></url></urlset>`);
    expect(set.isIndex).toBe(false);
    expect(set.urls).toEqual(["https://a.com/x?a=1&b=2", "https://a.com/y"]);
  });
  it("reads sitemap hints and AI crawler blocks from robots.txt", () => {
    const robots = ROUTES[`${SITE}/robots.txt`]!.body!;
    expect(parseRobotsSitemaps(robots)).toEqual([`${SITE}/sitemap.xml`]);
    expect(robotsBlockedAgents(robots)).toEqual(["gptbot"]);
    expect(robotsDisallowsAll(robots)).toBe(false);
    expect(robotsDisallowsAll("User-agent: *\nDisallow: /\n")).toBe(true);
  });
});

describe("URL de-duplication and classification", () => {
  it("removes duplicates that differ only by tracking params, trailing slash, case or www", () => {
    const urls = ["https://www.a.com/x/", "https://a.com/x", "https://A.com/x/?utm_source=z", "https://a.com/x/index.html", "https://a.com/y"];
    expect(dedupeUrls(urls)).toEqual(["https://www.a.com/x/", "https://a.com/y"]);
    expect(canonicalKey("https://www.a.com/x/?utm_medium=q&b=1")).toBe("a.com/x?b=1");
  });
  it("classifies page roles from the path", () => {
    const home = "https://a.com/";
    expect(classifyPath("https://a.com/", home)).toBe("home");
    expect(classifyPath("https://a.com/about-us/", home)).toBe("about");
    expect(classifyPath("https://a.com/services/blocked-drains/", home)).toBe("service");
    expect(classifyPath("https://a.com/pricing/", home)).toBe("pricing");
    expect(classifyPath("https://a.com/blog/how-to/", home)).toBe("informational");
    expect(classifyPath("https://a.com/privacy-policy/", home)).toBe("legal");
    expect(classifyPath("https://a.com/case-studies/acme/", home)).toBe("case-study");
    expect(classifyPath("https://a.com/locations/perth/", home)).toBe("location");
  });
});
