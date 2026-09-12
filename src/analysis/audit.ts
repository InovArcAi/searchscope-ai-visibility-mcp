import type { CrawlResult } from "../crawl/crawler";
import { canonicalKey } from "../crawl/crawler";
import { buildEntityMap, type EntityMap } from "./entities";
import { inferCategory, monitoringPrompts, type GeoQuery } from "./queries";
import { aggregateRating, analysePageRetrievability, type PageRetrievability } from "./retrievability";
import { buildSiteModel, COUNTRIES, EVIDENCE_RE, isAmbiguousAnchor, REGIONS, roleLabel, type Rating, type SiteModel } from "./site";

export interface AuditReport {
  target: string;
  auditedAt: string;
  methodology: string;
  crawl: {
    pagesFetched: number;
    pagesRequested: number;
    pagesFailed: { url: string; reason: string }[];
    skipped: { url: string; reason: string }[];
    sitemapFound: boolean;
    robotsBlocksAiCrawlers: string[];
    robotsDisallowsAll: boolean;
    elapsedMs: number;
    pages: { url: string; role: string; title: string; words: number; status: number; truncated: boolean; noindex: boolean; canonicalMismatch: boolean }[];
  };
  executiveSummary: { diagnosis: string; ratings: { entityClarity: Rating; retrievability: Rating; informationGain: Rating; trust: Rating; architecture: Rating; structuredData: Rating }; headline: string[] };
  entityClarity: { primaryEntity: EntityMap["primaryEntity"]; supportingEntities: EntityMap["relatedEntities"]; unclearRelationships: string[]; confidenceNotes: string[] };
  aiRetrievability: { rating: Rating; rubric: string; pages: PageRetrievability[]; siteWideIssues: string[] };
  informationGain: { rating: Rating; found: { signal: string; page: string; excerpt: string }[]; notFound: string[]; note: string };
  trustSignals: { rating: Rating; namedPeople: { name: string; role: string; source: string }[]; organisationIdentity: string[]; contact: { phones: string[]; emails: string[]; addresses: string[]; hasContactPage: boolean }; citations: { host: string; url: string; from: string }[]; credentials: string[]; thirdPartyEvidence: string[]; gaps: string[] };
  architecture: { rating: Rating; orphanLike: { url: string; role: string; reason: string }[]; hierarchyIssues: string[]; ambiguousAnchors: { text: string; count: number }[]; commercialToSupporting: string[] };
  structuredData: { rating: Rating; typesFound: { type: string; pages: number }[]; omissions: EntityMap["suggestedSchemaTypes"]; issues: string[]; note: string };
  commercialCoverage: { inferredOfferings: string[]; inferredCategory: string; inferredLocations: string[]; likelyIntents: { intent: string; coveredBy: string | null }[]; gaps: string[] };
  topActions: { rank: number; action: string; why: string; impact: "high" | "medium" | "low"; visibilityImpact: "high" | "medium" | "low"; effort: "low" | "medium" | "high"; evidence: string }[];
  monitoringPrompts: GeoQuery[];
}

const NOINDEX_RE = /\bnoindex\b/i;

interface Action {
  action: string;
  why: string;
  impact: 1 | 2 | 3;
  visibility: 1 | 2 | 3;
  ease: 1 | 2 | 3;
  evidence: string;
}

function lvl(n: number): "high" | "medium" | "low" {
  return n >= 3 ? "high" : n === 2 ? "medium" : "low";
}
function effort(ease: number): "low" | "medium" | "high" {
  return ease >= 3 ? "low" : ease === 2 ? "medium" : "high";
}

export function buildAudit(crawl: CrawlResult): AuditReport {
  const site = buildSiteModel(crawl);
  const entities = buildEntityMap(site);
  const actions: Action[] = [];

  // Crawl summary
  const pagesFailed = crawl.pages.filter((p) => !p.parsed).map((p) => ({ url: p.url, reason: p.fetch.errorDetail ?? p.fetch.error ?? `HTTP ${p.fetch.status}` }));
  const pageRows = site.pages.map((p) => ({
    url: p.finalUrl,
    role: roleLabel(p.role),
    title: p.parsed.title,
    words: p.parsed.wordCount,
    status: p.fetch.status,
    truncated: p.parsed.truncated,
    noindex: NOINDEX_RE.test(p.parsed.metaRobots) || NOINDEX_RE.test(p.fetch.xRobotsTag),
    canonicalMismatch: Boolean(p.parsed.canonical) && canonicalKey(p.parsed.canonical) !== canonicalKey(p.finalUrl),
  }));

  // Retrievability
  // Listing hubs (/blog/) are navigational; they are not judged as answer passages.
  const retr = site.pages.filter((p) => p.role !== "hub").map((p) => analysePageRetrievability(p.parsed));
  const retrRating = aggregateRating(retr.map((r) => r.rating));
  const siteWideIssues: string[] = [];
  const noDef = retr.filter((r) => !r.hasDefinition);
  if (noDef.length >= Math.ceil(retr.length / 2)) siteWideIssues.push(`${noDef.length} of ${retr.length} pages open without a definition or positioning paragraph under the H1.`);
  const qaPages = retr.filter((r) => r.questionHeadings > 0);
  const weakQa = qaPages.reduce((n, r) => n + (r.questionHeadings - r.directAnswers), 0);
  if (weakQa > 0) siteWideIssues.push(`${weakQa} question-style headings across the sample are followed by thin, vague, split or missing answers.`);
  if (qaPages.length === 0 && retr.length > 2) siteWideIssues.push("No question-phrased headings anywhere in the sample. Nothing on the site is structured as an answer to a prompt.");
  const lowSpec = retr.filter((r) => r.words >= 120 && r.specificityPer100 < 0.6);
  if (lowSpec.length >= 2) siteWideIssues.push(`${lowSpec.length} pages have almost no concrete facts (prices, timeframes, numbers, named entities). Generic claims are not quotable.`);
  const thin = retr.filter((r) => r.words < 120);
  if (thin.length > 0) siteWideIssues.push(`${thin.length} page(s) carry under 120 words of main copy: ${thin.map((t) => t.url).slice(0, 3).join(", ")}.`);
  const noindexPages = pageRows.filter((r) => r.noindex);
  if (noindexPages.length) siteWideIssues.push(`${noindexPages.length} sampled page(s) are noindex: ${noindexPages.map((r) => r.url).slice(0, 3).join(", ")}.`);
  const canonMis = pageRows.filter((r) => r.canonicalMismatch);
  if (canonMis.length) siteWideIssues.push(`${canonMis.length} page(s) canonicalise elsewhere: ${canonMis.map((r) => r.url).slice(0, 3).join(", ")}.`);
  if (crawl.robots.blockedAiAgents.length) siteWideIssues.push(`robots.txt blocks AI crawlers: ${crawl.robots.blockedAiAgents.join(", ")}. Those systems cannot fetch the site at all.`);
  if (crawl.robots.disallowsAll) siteWideIssues.push("robots.txt disallows all crawling for every user agent.");

  if (noDef.length > 0) actions.push({ action: `Rewrite the opening paragraph on ${noDef.length} page(s) so the first 40 to 60 words state exactly what the page offers, for whom, and where.`, why: "Answer engines extract the first self-contained passage. A slogan or a hero image caption gives them nothing to quote.", impact: 3, visibility: 3, ease: 3, evidence: noDef.slice(0, 3).map((r) => r.url).join(", ") });
  if (weakQa > 0) actions.push({ action: `Fix ${weakQa} question headings whose answers are thin, hedged or split: answer in the first sentence, then add the specifics.`, why: "Question heading plus direct answer is the most reliably lifted passage shape across ChatGPT, Perplexity and AI Overviews.", impact: 2, visibility: 3, ease: 3, evidence: qaPages.flatMap((r) => r.qa.filter((q) => q.verdict !== "direct").map((q) => `${r.url}: "${q.question}"`)).slice(0, 3).join("; ") });
  if (lowSpec.length >= 2) actions.push({ action: "Add concrete facts to service copy: price ranges, turnaround times, what is included, quantities, years, named locations.", why: "Specific, verifiable statements are what get cited; generic benefit language is skipped.", impact: 3, visibility: 3, ease: 2, evidence: lowSpec.slice(0, 3).map((r) => r.url).join(", ") });
  if (crawl.robots.blockedAiAgents.length) actions.push({ action: `Allow ${crawl.robots.blockedAiAgents.join(", ")} in robots.txt unless blocking them is a deliberate policy.`, why: "A blocked crawler cannot cite the site, full stop.", impact: 3, visibility: 3, ease: 3, evidence: "robots.txt" });

  // Information gain
  const found: AuditReport["informationGain"]["found"] = [];
  const seenSignal = new Set<string>();
  for (const p of site.pages) {
    for (const para of p.parsed.paragraphs) {
      for (const m of para.matchAll(EVIDENCE_RE)) {
        const key = `${p.finalUrl}|${(m[0] ?? "").toLowerCase()}`;
        if (seenSignal.has(key) || found.length >= 15) continue;
        seenSignal.add(key);
        found.push({ signal: m[0] ?? "", page: p.finalUrl, excerpt: para.length > 180 ? `${para.slice(0, 177)}...` : para });
      }
    }
  }
  const hasCaseStudies = site.pages.some((p) => p.role === "case-study") || found.some((f) => /case stud/i.test(f.signal));
  const hasData = found.some((f) => /data|research|survey|analy|study|respondents|participants|sample|n\s?=/i.test(f.signal));
  const hasExperiments = found.some((f) => /experiment|tested|benchmark|before and after|measured|tracked/i.test(f.signal));
  const hasResults = found.some((f) => /increase|decrease|lift|growth|improvement|reduction|results/i.test(f.signal));
  const quoteCount = site.pages.reduce((n, p) => n + p.parsed.blocks.filter((b) => b.kind === "quote" && !b.chrome).length, 0);
  const notFound: string[] = [];
  if (!hasData) notFound.push("original data, proprietary research or survey results");
  if (!hasExperiments) notFound.push("experiments, tests or benchmarks");
  if (!hasCaseStudies) notFound.push("original case studies");
  if (!hasResults) notFound.push("quantified results (before/after, percentage change)");
  if (quoteCount === 0 && site.people.length === 0) notFound.push("expert quotes attributed to named people");
  const igScore = [hasData, hasExperiments, hasCaseStudies, hasResults, quoteCount > 0].filter(Boolean).length;
  const igRating: Rating = igScore >= 3 ? "Strong" : igScore >= 1 ? "Moderate" : "Weak";
  if (igRating !== "Strong") actions.push({ action: hasCaseStudies ? "Add numbers to existing case studies: starting point, what was done, measured outcome, timeframe." : "Publish two or three case studies with a measured outcome each (numbers, timeframe, location).", why: "First-party evidence is the only content competitors cannot copy and the strongest citation magnet.", impact: 3, visibility: 2, ease: 2, evidence: hasCaseStudies ? "case study pages found without quantified outcomes" : "no case study page or quantified result detected" });

  // Trust
  const hasContactPage = crawl.pages.some((p) => p.role === "contact");
  const identity: string[] = [];
  identity.push(`Brand: ${site.brand.value} (${site.brand.confidence} confidence, ${site.brand.source})`);
  if (site.legalName) identity.push(`Legal name: ${site.legalName.value} (${site.legalName.source})`);
  for (const id of site.businessIds) identity.push(id);
  if (site.sameAs.length) identity.push(`sameAs profiles in schema: ${site.sameAs.length}`);
  if (site.socialProfiles.length) identity.push(`Social profiles linked: ${site.socialProfiles.map((s) => new URL(s).hostname.replace(/^www\./, "")).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`);
  const trustGaps: string[] = [];
  if (site.people.length === 0) trustGaps.push("No named people anywhere in the sample.");
  if (site.phones.length === 0) trustGaps.push("No phone number detected.");
  if (site.emails.length === 0 && !hasContactPage) trustGaps.push("No email address or contact page detected.");
  if (site.addresses.length === 0 && site.locations.some((l) => l.confidence !== "low")) trustGaps.push("Location is claimed in copy but no full address is published.");
  if (site.citations.length === 0) trustGaps.push("No outbound references or citations to external sources on any sampled page.");
  if (site.credentials.length === 0) trustGaps.push("No credentials, licences, memberships, awards or years-in-business statements detected.");
  if (site.thirdParty.length === 0) trustGaps.push("No third-party evidence mentioned (review platforms, media mentions, partners).");
  const informational = site.pages.filter((p) => p.role === "informational");
  const undated = informational.filter((p) => !p.parsed.publishedTime && !p.parsed.modifiedTime && p.parsed.datesInText.length === 0);
  if (undated.length) trustGaps.push(`${undated.length} informational page(s) show no publication or update date.`);
  const unauthored = informational.filter((p) => p.parsed.authorTexts.length === 0 && !p.parsed.metaAuthor && !p.parsed.jsonLd.some((n) => n.raw["author"]));
  if (unauthored.length) trustGaps.push(`${unauthored.length} informational page(s) have no visible author.`);
  const trustPoints = [site.people.length > 0, site.phones.length > 0, site.emails.length > 0 || hasContactPage, site.addresses.length > 0, site.citations.length > 0, site.credentials.length > 0, site.thirdParty.length > 0, site.legalName !== undefined || site.businessIds.length > 0].filter(Boolean).length;
  const trustRating: Rating = trustPoints >= 6 ? "Strong" : trustPoints >= 3 ? "Moderate" : "Weak";
  if (site.people.length === 0) actions.push({ action: "Name the owner or lead practitioner on the homepage and About page with a role, a photo and a two-sentence bio; add Person schema.", why: "Assistants weigh named accountability heavily when recommending a business; an anonymous site is a risk signal.", impact: 3, visibility: 2, ease: 3, evidence: "no named people detected in sample" });
  if (site.credentials.length === 0) actions.push({ action: "State licences, accreditations, memberships, awards and years in business with the issuing body, in the footer and on the About page.", why: "Verifiable credentials are trust-validation answers assistants look for when a user asks \"is X reputable\".", impact: 2, visibility: 2, ease: 3, evidence: "no credential phrases detected" });
  if (unauthored.length || undated.length) actions.push({ action: "Add visible author bylines and published/updated dates to every informational page, backed by Article schema.", why: "Unattributed, undated content is treated as low-provenance by both search and AI systems.", impact: 1, visibility: 2, ease: 3, evidence: `${unauthored.length} unauthored, ${undated.length} undated informational pages` });
  if (site.citations.length === 0 && informational.length > 0) actions.push({ action: "Cite primary sources (regulators, standards bodies, manufacturers, research) inside informational pages.", why: "Content that cites is more often cited; it also signals the claims are checkable.", impact: 1, visibility: 2, ease: 3, evidence: "zero outbound references in sample" });

  // Architecture
  const inbound = new Map<string, Set<string>>();
  const anchorCounts = new Map<string, number>();
  for (const p of site.pages) {
    for (const l of p.parsed.links) {
      if (!l.internal) continue;
      const key = canonicalKey(l.href);
      if (key === canonicalKey(p.finalUrl)) continue;
      const set = inbound.get(key) ?? new Set<string>();
      set.add(p.finalUrl);
      inbound.set(key, set);
      if (!l.chrome && isAmbiguousAnchor(l.text)) anchorCounts.set(l.text.toLowerCase(), (anchorCounts.get(l.text.toLowerCase()) ?? 0) + 1);
    }
  }
  const orphanLike: AuditReport["architecture"]["orphanLike"] = [];
  const hierarchyIssues: string[] = [];
  const commercialToSupporting: string[] = [];
  const commercialRoles = new Set(["service", "product", "category", "pricing", "location"]);
  const supportingRoles = new Set(["informational", "faq", "case-study"]);
  const homeNavKeys = new Set((site.home?.parsed.links ?? []).filter((l) => l.internal && l.nav).map((l) => canonicalKey(l.href)));
  for (const p of site.pages) {
    if (p.role === "home") continue;
    const key = canonicalKey(p.finalUrl);
    const links = inbound.get(key) ?? new Set<string>();
    if (links.size === 0) orphanLike.push({ url: p.finalUrl, role: roleLabel(p.role), reason: p.discoveredVia.includes("sitemap") && p.discoveredVia.length === 1 ? "found only in the sitemap; no sampled page links to it" : "no sampled page links to it" });
    if (commercialRoles.has(p.role) && !homeNavKeys.has(key) && site.home) hierarchyIssues.push(`${roleLabel(p.role)} page ${p.finalUrl} is not in the homepage navigation.`);
    const outRoles = new Set<string>();
    for (const l of p.parsed.links) {
      if (!l.internal || l.chrome) continue;
      const t = crawl.pages.find((cp) => canonicalKey(cp.finalUrl) === canonicalKey(l.href) || canonicalKey(cp.url) === canonicalKey(l.href));
      if (t) outRoles.add(t.role);
    }
    if (commercialRoles.has(p.role) && ![...outRoles].some((r) => supportingRoles.has(r)) && informational.length > 0) commercialToSupporting.push(`${p.finalUrl} (${roleLabel(p.role)}) links to no supporting guide, FAQ or case study from its body copy.`);
    if (supportingRoles.has(p.role) && ![...outRoles].some((r) => commercialRoles.has(r))) commercialToSupporting.push(`${p.finalUrl} (${roleLabel(p.role)}) never links to a service or product page from its body copy.`);
  }
  const deep = site.pages.filter((p) => new URL(p.finalUrl).pathname.split("/").filter(Boolean).length >= 3 && commercialRoles.has(p.role));
  if (deep.length) hierarchyIssues.push(`${deep.length} commercial page(s) sit three or more levels deep: ${deep.slice(0, 3).map((p) => p.finalUrl).join(", ")}.`);
  const ambiguousAnchors = [...anchorCounts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  const archIssues = orphanLike.length + hierarchyIssues.length + commercialToSupporting.length + (ambiguousAnchors.reduce((n, a) => n + a.count, 0) >= 5 ? 1 : 0);
  const archRating: Rating = archIssues === 0 ? "Strong" : archIssues <= 3 ? "Moderate" : "Weak";
  if (commercialToSupporting.length) actions.push({ action: "Link every service page to its supporting guides and case studies from body copy, and every guide back to the service it supports, using descriptive anchors.", why: "Commercial and supporting pages that reference each other read as one topic cluster; isolated pages read as thin.", impact: 2, visibility: 2, ease: 3, evidence: commercialToSupporting.slice(0, 2).join(" | ") });
  if (orphanLike.length) actions.push({ action: `Add contextual internal links to ${orphanLike.length} orphan-like page(s).`, why: "Pages reachable only via the sitemap get crawled but carry no relevance signal from the rest of the site.", impact: 2, visibility: 2, ease: 3, evidence: orphanLike.slice(0, 3).map((o) => o.url).join(", ") });
  if (ambiguousAnchors.reduce((n, a) => n + a.count, 0) >= 5) actions.push({ action: "Replace generic anchors (\"learn more\", \"click here\") with the destination page's topic.", why: "Anchor text is how systems infer what a linked page is about; generic anchors waste that signal.", impact: 1, visibility: 2, ease: 3, evidence: ambiguousAnchors.map((a) => `"${a.text}" x${a.count}`).join(", ") });

  // Structured data
  const sdIssues: string[] = [];
  const homeTypes = site.home ? site.home.parsed.jsonLd.flatMap((n) => n.type) : [];
  if (site.home && homeTypes.length === 0) sdIssues.push("Homepage has no JSON-LD at all.");
  const orgWithoutSameAs = site.home && homeTypes.some((t) => /Organization|Business/.test(t)) && site.sameAs.length === 0;
  if (orgWithoutSameAs) sdIssues.push("Organisation schema exists but has no sameAs profiles.");
  for (const p of site.pages) {
    if ((p.role === "service" || p.role === "product") && !p.parsed.jsonLd.some((n) => n.type.some((t) => /Service|Product|Offer/.test(t)))) sdIssues.push(`${p.finalUrl} has no Service/Product entity.`);
    if (p.role === "informational" && !p.parsed.jsonLd.some((n) => n.type.some((t) => /Article|BlogPosting|NewsArticle/.test(t)))) sdIssues.push(`${p.finalUrl} has no Article schema.`);
  }
  if (site.schemaTypes.has("FAQPage")) sdIssues.push("FAQPage schema is present. It no longer produces anything in Google Search (removed 2026); keep the visible Q&A, the markup is dead weight.");
  if (site.schemaTypes.has("AggregateRating") || site.schemaTypes.has("Review")) sdIssues.push("Review/AggregateRating markup found. Self-serving ratings on your own organisation are ineligible for rich results; make sure this is not marking up your own business.");
  const sdRating: Rating = homeTypes.some((t) => /Organization|Business/.test(t)) && sdIssues.length <= 2 ? "Strong" : homeTypes.length > 0 ? "Moderate" : "Weak";
  if (sdRating === "Weak") actions.push({ action: `Add ${entities.primaryEntity.type.replace(" (inferred)", "")} and WebSite JSON-LD to the homepage with name, url, logo, telephone, address, areaServed, founder and sameAs.`, why: "Structured data is not a ranking factor, but it is the cheapest way to declare the entity unambiguously to every system that parses the page.", impact: 2, visibility: 2, ease: 3, evidence: "no organisation entity on homepage" });
  else if (orgWithoutSameAs) actions.push({ action: "Add sameAs links (Google Business Profile, LinkedIn, Facebook, directories, associations) to the organisation schema.", why: "sameAs is how the on-site entity is reconciled with the off-site profiles assistants already trust.", impact: 2, visibility: 2, ease: 3, evidence: "Organization schema without sameAs" });

  // Commercial coverage
  const offerings = site.offerings.map((o) => o.value);
  const category = inferCategory(site);
  const strongLocs = site.locations.filter((l) => l.confidence !== "low").map((l) => l.value);
  const isLocal = strongLocs.length > 0;
  // City/suburb-level places only: countries and states are too broad for service-area pages or local prompts.
  const localLocs = strongLocs.filter((l) => !COUNTRIES.has(l.toLowerCase()) && !REGIONS.has(l.toLowerCase()));
  const primaryLoc = site.areaServed.find((a) => !COUNTRIES.has(a.toLowerCase()) && !REGIONS.has(a.toLowerCase())) ?? localLocs[0] ?? strongLocs[0];
  const has = (role: string) => crawl.pages.some((p) => p.role === role && p.parsed);
  const homeText = `${site.home?.parsed.paragraphs.join(" ") ?? ""} ${site.home?.parsed.headings.h2.join(" ") ?? ""}`.toLowerCase();
  const navText = (site.home?.parsed.links ?? []).filter((l) => l.nav).map((l) => l.text.toLowerCase()).join(" ");
  const pricingVisible = has("pricing") || /\b(pricing|price list|packages|from \$|\$\d)/i.test(homeText + navText) || site.pages.some((p) => /\$\s?\d/.test(p.parsed.paragraphs.join(" ")));
  const intents: AuditReport["commercialCoverage"]["likelyIntents"] = [];
  const coveredBy = (pred: (p: SiteModel["pages"][number]) => boolean): string | null => site.pages.find(pred)?.finalUrl ?? null;
  for (const o of offerings.slice(0, 5)) {
    intents.push({ intent: `${o}${primaryLoc ? ` in ${primaryLoc}` : ""} (commercial)`, coveredBy: coveredBy((p) => (p.role === "service" || p.role === "product") && new RegExp(o.split(" ")[0] ?? o, "i").test(p.parsed.title)) });
    intents.push({ intent: `${o} cost / pricing`, coveredBy: coveredBy((p) => /\$\s?\d|pricing|price/i.test(p.parsed.paragraphs.join(" ")) && new RegExp(o.split(" ")[0] ?? o, "i").test(p.parsed.title)) });
  }
  intents.push({ intent: `best ${category}${primaryLoc ? ` ${primaryLoc}` : ""} (recommendation)`, coveredBy: coveredBy((p) => p.role === "case-study") ?? coveredBy((p) => p.parsed.testimonialElements > 0) });
  intents.push({ intent: `${site.brand.value} reviews (trust)`, coveredBy: coveredBy((p) => p.parsed.testimonialElements > 0 || /review|testimonial/i.test(p.parsed.title)) });
  intents.push({ intent: `how to choose a ${category} (consideration)`, coveredBy: coveredBy((p) => p.role === "informational" && /choose|guide|what to look for|questions to ask/i.test(p.parsed.title)) });
  intents.push({ intent: `${category} near me (local)`, coveredBy: isLocal ? coveredBy((p) => p.role === "location" || p.role === "contact") : null });
  const gaps: string[] = [];
  if (!pricingVisible) gaps.push("No pricing, price ranges or packages visible anywhere in the sample. \"How much does X cost\" is the highest-intent question in most categories and the site cannot be cited for it.");
  if (!has("case-study") && !hasCaseStudies) gaps.push("No case studies or results pages. Recommendation prompts (\"best X\") favour providers with demonstrated outcomes.");
  if (!site.pages.some((p) => p.role === "informational" && /choose|guide|vs|compare|what to look for|questions to ask|checklist/i.test(p.parsed.title))) gaps.push("No comparison or buyer's-guide content, so comparison and alternatives prompts have nothing to draw on.");
  if (isLocal && !has("location") && localLocs.length > 1) gaps.push(`Multiple locations are mentioned (${localLocs.slice(0, 4).join(", ")}) but there are no dedicated location or service-area pages.`);
  if (!has("faq") && qaPages.length === 0) gaps.push("No FAQ page and no question-phrased headings; objections and pre-sale questions are unanswered on-site.");
  if (!has("about")) gaps.push("No About page in the sample; brand and trust-validation prompts have no landing page.");
  if (offerings.length > 5 && site.pages.filter((p) => p.role === "service" || p.role === "product").length < 3) gaps.push(`${offerings.length} offerings are listed but fewer than three have their own page.`);
  if (!pricingVisible) actions.push({ action: "Publish indicative pricing or price ranges (a pricing page, or a pricing section on each service page).", why: "Cost questions dominate commercial prompts; a site with no price signal is skipped in favour of one that states a range.", impact: 3, visibility: 3, ease: 2, evidence: "no pricing signals in sample" });
  if (isLocal && !has("location") && localLocs.length > 1) actions.push({ action: `Create service-area pages for the main locations (${localLocs.slice(0, 3).join(", ")}) with local proof, not boilerplate.`, why: "Local prompts (\"X near me\", \"X in Suburb\") are answered from pages that name the place and show evidence of work there.", impact: 3, visibility: 2, ease: 2, evidence: `locations detected: ${localLocs.slice(0, 5).join(", ")}` });
  if (!has("about")) actions.push({ action: "Add an About page that names the people, the founding year, the location and the specific customer the business serves.", why: "It is the single page brand and trust prompts resolve to.", impact: 2, visibility: 2, ease: 3, evidence: "no about page found" });

  // Entity clarity rating
  const ecPoints = [site.brand.confidence === "high", site.brandCandidates.filter((b) => b.confidence !== "low").length <= 1, offerings.length > 0, !isLocal || strongLocs.length <= 6, site.people.length > 0, entities.schemaTypesFound.some((t) => /Organization|Business/.test(t.type))].filter(Boolean).length;
  const ecRating: Rating = ecPoints >= 5 ? "Strong" : ecPoints >= 3 ? "Moderate" : "Weak";
  if (entities.ambiguities.some((a) => a.startsWith("Brand name is stated inconsistently"))) actions.push({ action: "Standardise the brand name across schema, og:site_name, title suffix and footer.", why: "Conflicting names split the entity across sources; assistants may treat them as different businesses.", impact: 2, visibility: 3, ease: 3, evidence: site.brandCandidates.filter((b) => b.confidence !== "low").map((b) => b.value).join(" vs ") });

  // Rank actions: commercial impact, then visibility impact, then ease
  const ranked = actions
    .sort((a, b) => b.impact - a.impact || b.visibility - a.visibility || b.ease - a.ease)
    .slice(0, 10)
    .map((a, i) => ({ rank: i + 1, action: a.action, why: a.why, impact: lvl(a.impact), visibilityImpact: lvl(a.visibility), effort: effort(a.ease), evidence: a.evidence }));

  // Executive summary
  const ratings = { entityClarity: ecRating, retrievability: retrRating, informationGain: igRating, trust: trustRating, architecture: archRating, structuredData: sdRating };
  const weakest = Object.entries(ratings).filter(([, r]) => r === "Weak").map(([k]) => k);
  const strong = Object.entries(ratings).filter(([, r]) => r === "Strong").map(([k]) => k);
  const label = (k: string) => k.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  const diagnosis = `${site.brand.value} (${category}${primaryLoc ? `, ${primaryLoc}` : ""}) was sampled across ${site.pages.length} page(s). ` +
    (weakest.length ? `Weakest areas: ${weakest.map(label).join(", ")}. ` : "No area rated Weak. ") +
    (strong.length ? `Strongest: ${strong.map(label).join(", ")}. ` : "Nothing rated Strong yet. ") +
    (ranked[0] ? `First move: ${ranked[0].action}` : "");
  const headline: string[] = [];
  if (!site.home) headline.push("Homepage could not be parsed; results are partial.");
  if (crawl.robots.blockedAiAgents.length) headline.push(`AI crawlers blocked in robots.txt: ${crawl.robots.blockedAiAgents.join(", ")}.`);
  headline.push(`Primary entity: ${site.brand.value} (${site.brand.confidence} confidence).`);
  headline.push(`${offerings.length} offering(s) identified; ${strongLocs.length} location(s) with medium or high confidence.`);
  headline.push(`${found.length} first-party evidence signal(s) found; ${site.people.length} named people; ${site.citations.length} outbound references.`);
  if (!pricingVisible) headline.push("No pricing signals anywhere in the sample.");

  const prompts = monitoringPrompts({ brand: site.brand.value, services: offerings, category, location: primaryLoc, isLocal });

  return {
    target: crawl.target,
    auditedAt: new Date().toISOString(),
    methodology: "Deterministic on-site analysis of a prioritised sample of pages. Ratings (Strong/Moderate/Weak) follow explicit rubrics documented in the README. This tool observes site signals; it does not measure actual citations or visibility inside ChatGPT, Claude, Gemini or Google AI Overviews. Items marked as gaps or opportunities are inferred from what the sample lacks, not from external visibility data.",
    crawl: {
      pagesFetched: site.pages.length,
      pagesRequested: crawl.maxPages,
      pagesFailed,
      skipped: crawl.skipped,
      sitemapFound: crawl.sitemap.found,
      robotsBlocksAiCrawlers: crawl.robots.blockedAiAgents,
      robotsDisallowsAll: crawl.robots.disallowsAll,
      elapsedMs: crawl.elapsedMs,
      pages: pageRows,
    },
    executiveSummary: { diagnosis, ratings, headline },
    entityClarity: { primaryEntity: entities.primaryEntity, supportingEntities: entities.relatedEntities, unclearRelationships: entities.ambiguities, confidenceNotes: [
      `Brand from ${site.brand.source}.`,
      ...(site.locations.length ? [`Locations: ${site.locations.slice(0, 5).map((l) => `${l.value} (${l.confidence})`).join(", ")}.`] : ["No locations detected."]),
      ...(site.offerings.length ? [`Offerings from: ${[...new Set(site.offerings.map((o) => o.source.replace(/ of .*$/, "")))].join(", ")}.`] : []),
      "Low-confidence items are pattern matches on visible copy and should be verified by a human.",
    ] },
    aiRetrievability: { rating: retrRating, rubric: "Strong: definition under H1, specificity >= 1.5 facts per 100 words, < 45% fragment passages, question headings answered directly. Weak: < 120 words, or no definition plus low specificity or > 65% fragments. Otherwise Moderate. Site rating is the average of page ratings.", pages: retr, siteWideIssues },
    informationGain: { rating: igRating, found, notFound, note: found.length ? "Signals are phrases matched in visible copy; check that each is genuinely first-party rather than a generic claim." : "No first-party evidence phrases were detected in the sample. That is an observation about the sampled pages, not proof that none exists elsewhere on the site." },
    trustSignals: { rating: trustRating, namedPeople: site.people.map((p) => ({ name: p.name, role: p.role || "unknown", source: p.source })), organisationIdentity: identity, contact: { phones: site.phones, emails: site.emails, addresses: site.addresses, hasContactPage }, citations: site.citations.slice(0, 15), credentials: site.credentials, thirdPartyEvidence: site.thirdParty, gaps: trustGaps },
    architecture: { rating: archRating, orphanLike, hierarchyIssues, ambiguousAnchors, commercialToSupporting: commercialToSupporting.slice(0, 10) },
    structuredData: { rating: sdRating, typesFound: entities.schemaTypesFound, omissions: entities.suggestedSchemaTypes, issues: sdIssues.slice(0, 12), note: "Structured data is not a direct ranking factor. It removes ambiguity about what the entities on a page are; it does not create visibility on its own. FAQPage and HowTo are not recommended (no longer rendered in Google Search)." },
    commercialCoverage: { inferredOfferings: offerings, inferredCategory: category, inferredLocations: strongLocs, likelyIntents: intents, gaps },
    topActions: ranked,
    monitoringPrompts: prompts,
  };
}

export { buildSiteModel, buildEntityMap, inferCategory };
