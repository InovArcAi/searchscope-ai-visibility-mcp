import type { CrawledPage } from "../crawl/crawler";
import { classifyPath } from "../crawl/crawler";
import type { ParsedPage } from "../parse/types";
import type { PageRetrievability } from "./retrievability";
import { stripBrandSuffix, type SiteModel } from "./site";

/**
 * Turns findings into things a writer can act on without thinking.
 *
 * The rule throughout: never invent a fact. Anything not observed on the page is
 * left as a clearly marked `[placeholder]` for a human to fill. A prefilled
 * template with honest blanks is useful; a fabricated claim is a liability.
 */

export interface OpeningFix {
  url: string;
  h1: string;
  currentOpening: string;
  problem: string;
  suggested: string;
}

export interface AnswerFix {
  url: string;
  question: string;
  currentFirstSentence: string;
  problem: string;
  suggestedOpening: string;
}

export interface LinkFix {
  from: string;
  to: string;
  suggestedAnchor: string;
  why: string;
}

/**
 * A fact is only reusable if the sentence built around it stays true. A price
 * and a turnaround slot into a sentence safely; a bare percentage does not
 * ("Typical projects run 98%" is nonsense), so those are left as a blank.
 */
// Excludes "$402.8 billion", which is a market statistic, not a price list.
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:per|\/)\s?\w+)?(?!\s*(?:billion|million|trillion|bn|tn|b\b|m\b))/;
const DURATION_RE = /\b\d+(?:\.\d+)?\s(?:business\s)?(?:days?|weeks?|months?)\b/i;

function proofSentence(parsed: ParsedPage): string {
  for (const para of parsed.paragraphs) {
    if (/\b(billion|million|trillion|market|revenue|worldwide|globally)\b/i.test(para)) continue;
    const price = PRICE_RE.exec(para);
    if (price?.[0]) return `Pricing starts at ${price[0].replace(/\s+/g, "")}.`;
  }
  for (const para of parsed.paragraphs) {
    const dur = DURATION_RE.exec(para);
    if (dur?.[0]) return `Typical turnaround is ${dur[0].trim()}.`;
  }
  return "[One concrete fact you can stand behind: a price range, a turnaround, or a measured result.]";
}

function subjectOf(page: CrawledPage & { parsed: ParsedPage }, site: SiteModel): string {
  const h1 = page.parsed.headings.h1[0];
  // Only a <title> carries a "Page | Brand" suffix worth stripping. Running an
  // H1 through the same splitter cut "Multi-location SEO" down to "Multi".
  const raw = (h1 ?? stripBrandSuffix(page.parsed.title ?? "", site.brand.value)).trim();
  const cleaned = raw
    .replace(new RegExp(`\\s*[|\\-–—:]\\s*${site.brand.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "")
    .replace(/[.!]+$/, "")
    .trim();
  // A headline written as a full sentence does not slot into "X is ...".
  if (/[.!?]\s/.test(cleaned) || cleaned.split(/\s+/).length > 10) return "[the offer in two or three words]";
  return cleaned || "[what this page is about]";
}

/**
 * A replacement opening paragraph, prefilled with everything the crawl actually
 * observed and with honest blanks for the rest. Around 40 to 60 words, which is
 * the length that survives extraction intact.
 */
export function buildOpeningFixes(site: SiteModel, retr: PageRetrievability[], limit = 6): OpeningFix[] {
  const out: OpeningFix[] = [];
  const primaryLocation = site.areaServed[0] ?? site.locations.find((l) => l.confidence !== "low")?.value;
  for (const r of retr) {
    if (r.hasDefinition || out.length >= limit) continue;
    // With no H1 there is no anchor for "the passage under the heading", and
    // whatever sits first in the main region (a phone number, a CTA) is not an
    // opening paragraph. That is a separate finding, reported in section C.
    if (!r.h1) continue;
    const page = site.pages.find((p) => p.parsed.url === r.url || p.finalUrl === r.url);
    if (!page) continue;
    const subject = subjectOf(page, site);
    const where = primaryLocation ? ` in ${primaryLocation}` : "";
    const proof = proofSentence(page.parsed);
    const suggested =
      `${subject} is [one plain sentence saying what it actually is]. ` +
      `${site.brand.value} provides it for [who it is for: the kind of business and the stage they are at]${where}. ` +
      `${proof}`;
    out.push({
      url: r.url,
      h1: r.h1 || "[no H1 on this page]",
      currentOpening: r.openingText || "[no main-copy paragraph found under the H1]",
      problem: r.openingText
        ? "The first passage under the H1 does not say what the page is or what is being offered, so there is nothing self-contained to lift."
        : "There is no paragraph under the H1 at all, only headings, links or fragments.",
      suggested,
    });
  }
  return out;
}

/** Every question heading whose answer does not open with the answer. */
export function buildAnswerFixes(retr: PageRetrievability[], limit = 10): AnswerFix[] {
  const out: AnswerFix[] = [];
  for (const r of retr) {
    for (const q of r.qa) {
      if (q.verdict === "direct" || out.length >= limit) continue;
      out.push({
        url: r.url,
        question: q.question,
        currentFirstSentence: q.firstSentence || "[nothing follows this heading]",
        problem: q.reason,
        suggestedOpening: q.suggestedOpening,
      });
    }
  }
  return out;
}

/**
 * Concrete link pairs rather than "improve internal linking": which page should
 * link to which, and what the anchor should say. Anchor text is taken from the
 * destination's own H1, which is the house rule of naming the destination's
 * topic rather than its format.
 */
export function buildLinkFixes(site: SiteModel, limit = 10): LinkFix[] {
  const out: LinkFix[] = [];
  const commercial = new Set(["service", "product", "category", "pricing", "location"]);
  const supporting = new Set(["informational", "faq", "case-study"]);
  const anchorFor = (p: CrawledPage & { parsed: ParsedPage }) => {
    const raw = (p.parsed.headings.h1[0] ?? stripBrandSuffix(p.parsed.title, site.brand.value)).trim();
    const cleaned = raw
      .replace(new RegExp(`\\s*[|\\-–—:]\\s*${site.brand.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "")
      .replace(/[.!?]+$/, "")
      .trim();
    // Fall back to the slug rather than shipping a one-word fragment.
    if (cleaned.split(/\s+/).length < 2 || cleaned.length < 6) {
      const slug = new URL(p.finalUrl).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
      return slug ? slug.replace(/-/g, " ") : cleaned || p.finalUrl;
    }
    return cleaned;
  };

  const suggestedCounts = new Map<string, number>();

  const linksOut = (p: CrawledPage & { parsed: ParsedPage }) =>
    new Set(p.parsed.links.filter((l) => l.internal && !l.chrome).map((l) => new URL(l.href).pathname.replace(/\/+$/, "")));

  for (const from of site.pages) {
    if (out.length >= limit) continue;
    const already = linksOut(from);
    const fromRole = classifyPath(from.finalUrl, site.crawl.target);
    const wanted = commercial.has(fromRole) ? supporting : supporting.has(fromRole) ? commercial : null;
    if (!wanted) continue;
    const targets = site.pages.filter((t) => t !== from && wanted.has(classifyPath(t.finalUrl, site.crawl.target)));
    if (targets.length === 0) continue;
    const missing = targets
      .filter((t) => !already.has(new URL(t.finalUrl).pathname.replace(/\/+$/, "")))
      // One supporting page proposed as the answer for every service page is
      // noise, not advice. Two mentions is enough to make the point.
      .filter((t) => (suggestedCounts.get(t.finalUrl) ?? 0) < 2);
    if (missing.length === 0) continue;
    // Rank by shared vocabulary with the source page first, so the suggestion is
    // topically sensible, then by how often that destination has already been
    // suggested, so one popular page is not proposed as the answer to everything.
    const sourceTerms = new Set(
      `${from.parsed.headings.h1[0] ?? ""} ${from.parsed.title}`
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    const overlap = (t: CrawledPage & { parsed: ParsedPage }) =>
      `${t.parsed.headings.h1[0] ?? ""} ${t.parsed.title}`
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && sourceTerms.has(w)).length;
    const best = missing.sort((a, b) => {
      const used = (suggestedCounts.get(a.finalUrl) ?? 0) - (suggestedCounts.get(b.finalUrl) ?? 0);
      if (used !== 0) return used;
      const byOverlap = overlap(b) - overlap(a);
      if (byOverlap !== 0) return byOverlap;
      return b.parsed.wordCount - a.parsed.wordCount;
    })[0];
    if (!best) continue;
    suggestedCounts.set(best.finalUrl, (suggestedCounts.get(best.finalUrl) ?? 0) + 1);
    out.push({
      from: from.finalUrl,
      to: best.finalUrl,
      suggestedAnchor: anchorFor(best),
      why: commercial.has(fromRole)
        ? "A commercial page with no route to your supporting content reads as an isolated sales page."
        : "Supporting content that never points at the service it supports cannot pass its relevance to anything that earns money.",
    });
  }
  return out;
}

/**
 * A ready-to-paste organisation block, prefilled only with values observed on
 * the site. Emitted when the homepage has no organisation entity, which is the
 * one structured-data gap that is genuinely worth closing.
 */
export function buildSchemaSnippet(site: SiteModel, primaryType: string): string {
  const cleanType = primaryType.replace(" (inferred)", "");
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": cleanType,
    name: site.brand.value,
    url: `https://${site.hostname}/`,
  };
  if (site.legalName) node["legalName"] = site.legalName.value;
  if (site.phones[0]) node["telephone"] = site.phones[0];
  if (site.emails[0]) node["email"] = site.emails[0];
  if (site.addresses[0]) node["address"] = { "@type": "PostalAddress", streetAddress: site.addresses[0] };
  else node["address"] = { "@type": "PostalAddress", streetAddress: "[street]", addressLocality: "[suburb]", addressRegion: "[state]", postalCode: "[postcode]", addressCountry: "AU" };
  const served = site.areaServed.length ? site.areaServed : site.locations.filter((l) => l.confidence !== "low").map((l) => l.value).slice(0, 4);
  if (served.length) node["areaServed"] = served;
  if (site.people[0]) node["founder"] = { "@type": "Person", name: site.people[0].name, jobTitle: site.people[0].role || "[role]" };
  node["sameAs"] = site.sameAs.length ? site.sameAs : ["[Google Business Profile URL]", "[LinkedIn URL]", "[any directory or association profile]"];
  return JSON.stringify(node, null, 2);
}
