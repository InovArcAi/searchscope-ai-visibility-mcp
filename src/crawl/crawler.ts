import { LIMITS } from "../config";
import { safeFetch, type SafeFetchResult } from "../fetch/safeFetch";
import { parsePage } from "../parse/html";
import type { ParsedPage } from "../parse/types";
import { isSameSite, normaliseTargetUrl, TargetError, type TargetPolicy } from "../security/url";
import { parseRobotsSitemaps, parseSitemapXml, robotsBlockedAgents, robotsDisallowsAll } from "./sitemap";

export type PageRole = "home" | "about" | "contact" | "service" | "product" | "category" | "location" | "pricing" | "informational" | "hub" | "case-study" | "faq" | "legal" | "other";

export interface CrawledPage {
  url: string;
  finalUrl: string;
  role: PageRole;
  discoveredVia: ("homepage" | "nav" | "sitemap" | "internal")[];
  fetch: Omit<SafeFetchResult, "body">;
  parsed?: ParsedPage;
}

export interface CrawlResult {
  target: string;
  origin: string;
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
  robots: { fetched: boolean; disallowsAll: boolean; blockedAiAgents: string[]; sitemaps: string[] };
  sitemap: { found: boolean; urlCount: number; sources: string[] };
  candidatesConsidered: number;
  maxPages: number;
  elapsedMs: number;
}

export interface CrawlOptions {
  policy: TargetPolicy;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  budgetMs?: number;
  concurrency?: number;
}

/** Normalise for de-duplication: lowercase host, drop hash, tracking params, trailing "index.html", trailing slash. */
export function canonicalKey(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) u.searchParams.delete(k);
  }
  let path = u.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.hostname}${path}${u.search}`;
}

export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const key = canonicalKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

const NON_PAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif|ico|pdf|docx?|xlsx?|pptx?|zip|gz|rar|mp[34]|m4a|mov|avi|webm|css|js|json|xml|txt|woff2?|ttf|eot)(\?.*)?$/i;
const NOISE_PATH = /(\/wp-json|\/wp-admin|\/wp-login|\/feed\/?$|\/xmlrpc|\/cart|\/checkout|\/my-account|\/account|\/login|\/signin|\/sign-in|\/register|\/logout|\/search|\/tag\/|\/tags\/|\/author\/|\/page\/\d+|\/category\/.*\/page|\/attachment|\/comments|\/cdn-cgi|\/#)/i;
const LEGAL_PATH = /(privacy|terms|conditions|cookie|disclaimer|refund|shipping-policy|legal|sitemap|accessibility)/i;

export function classifyPath(url: string, homepage: string): PageRole {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const path = u.pathname.toLowerCase().replace(/\/+$/, "");
  if (!path || path === "" || canonicalKey(url) === canonicalKey(homepage)) return "home";
  if (LEGAL_PATH.test(path)) return "legal";
  // Boundaries allow hyphens, so "faqs-seo" and "seo-glossary" are recognised.
  // Without this, any one-segment slug fell through to the depth-1 "service"
  // fallback, and editorial pages were counted as things the business sells.
  const B = (words: string) => new RegExp(`(^|\\/|-)(${words})(\\/|$|-)`);
  if (B("about|about-us|our-story|team|our-team|who-we-are|meet-the-team|company").test(path)) return "about";
  if (B("contact|contact-us|get-in-touch|enquire|enquiry|quote|get-a-quote|book|booking").test(path)) return "contact";
  if (B("pricing|prices|price-list|plans|packages|rates|costs?").test(path)) return "pricing";
  if (B("faq|faqs|frequently-asked-questions|help|support").test(path)) return "faq";
  if (B("case-stud(y|ies)|results|success-stories|portfolio|projects|our-work|work").test(path)) return "case-study";
  if (B("locations?|areas?-we-serve|service-areas?|suburbs|near-me").test(path)) return "location";
  // Social proof and utility pages: not commercial, not informational articles.
  if (B("testimonials?|reviews?|client-reviews|feedback|tools?|calculators?|templates?|downloads?|checklists?").test(path)) return "other";
  if (/^\/(blog|news|articles?|guides?|resources|insights|learn|knowledge|academy|library|posts)$/.test(path)) return "hub";
  if (B("blog|news|articles?|guides?|resources|insights|learn|knowledge|academy|glossary|glossaries|library|instructions|guidelines|explained|faqs?").test(path)) return "informational";
  if (B("products?|shop|store|collections?|catalog(ue)?").test(path)) return "product";
  if (B("categor(y|ies)|ranges?|brands?").test(path)) return "category";
  if (/(^|\/)(services?|solutions|what-we-do|treatments?|practice-areas?|specialt(y|ies)|programs?|courses?|repairs?|installation|removal|cleaning|seo|marketing|design|consulting|lawyer|dentist|plumb|electric|roof|landscap|physio|accounting|bookkeeping)(\/|$|-)/.test(path)) return "service";
  const depth = path.split("/").filter(Boolean).length;
  if (depth === 1) return "service"; // top-level slugs on business sites are usually offerings
  return "other";
}

const ROLE_PRIORITY: Record<PageRole, number> = {
  home: 100,
  about: 60,
  service: 55,
  product: 50,
  pricing: 48,
  category: 44,
  location: 42,
  "case-study": 40,
  faq: 38,
  contact: 30,
  informational: 25,
  hub: 15,
  other: 10,
  legal: -50,
} as Record<PageRole, number>;

interface Candidate {
  url: string;
  score: number;
  via: Set<"homepage" | "nav" | "sitemap" | "internal">;
}

function scoreCandidate(url: string, homepage: string, via: Set<string>, anchorText: string): number {
  const role = classifyPath(url, homepage);
  let score = ROLE_PRIORITY[role] ?? 10;
  const depth = new URL(url).pathname.split("/").filter(Boolean).length;
  score += depth === 1 ? 15 : depth === 2 ? 6 : -4 * depth;
  if (via.has("nav")) score += 20;
  if (via.has("homepage")) score += 10;
  if (via.has("sitemap")) score += 3;
  if (new URL(url).search) score -= 30;
  if (/\b(learn more|read more|click here)\b/i.test(anchorText)) score -= 2;
  return score;
}

/**
 * Crawl a small, prioritised sample of a site: homepage first, then the most
 * important same-site pages discovered from navigation and the sitemap.
 */
export async function crawlSite(inputUrl: string, opts: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const target = normaliseTargetUrl(inputUrl);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? LIMITS.defaultMaxPages, LIMITS.hardMaxPages));
  const budgetMs = opts.budgetMs ?? LIMITS.crawlBudgetMs;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? LIMITS.crawlConcurrency, 8));
  const fetchOpts = { policy: opts.policy, fetchImpl: opts.fetchImpl } as const;
  const deadline = started + budgetMs;
  const timeLeft = () => Math.max(1_000, deadline - Date.now());

  const result: CrawlResult = {
    target: target.toString(),
    origin: target.origin,
    pages: [],
    skipped: [],
    robots: { fetched: false, disallowsAll: false, blockedAiAgents: [], sitemaps: [] },
    sitemap: { found: false, urlCount: 0, sources: [] },
    candidatesConsidered: 0,
    maxPages,
    elapsedMs: 0,
  };

  // 1. Homepage (mandatory). A blocked or failed homepage ends the audit with a clear reason.
  const homeFetch = await safeFetch(target.toString(), { ...fetchOpts, kind: "html", timeoutMs: Math.min(LIMITS.fetchTimeoutMs, timeLeft()) });
  if (!homeFetch.ok) {
    if (homeFetch.error === "blocked") throw new TargetError("blocked_host", homeFetch.errorDetail ?? "Target rejected.");
    const { body: _b, ...meta } = homeFetch;
    result.pages.push({ url: target.toString(), finalUrl: homeFetch.finalUrl, role: "home", discoveredVia: ["homepage"], fetch: meta });
    result.elapsedMs = Date.now() - started;
    return result;
  }
  const homeUrl = new URL(homeFetch.finalUrl);
  if (!isSameSite(homeUrl, target)) {
    // The site redirected to a different registrable domain; audit that one instead
    // (it passed validation on the way) but keep the crawl pinned to it.
    result.origin = homeUrl.origin;
  }
  const homePage = await parsePage(homeFetch.finalUrl, homeFetch.body, homeFetch.truncated);
  {
    const { body: _b, ...meta } = homeFetch;
    result.pages.push({ url: target.toString(), finalUrl: homeFetch.finalUrl, role: "home", discoveredVia: ["homepage"], fetch: meta, parsed: homePage });
  }
  const homeKey = homeFetch.finalUrl;

  if (maxPages === 1) {
    result.elapsedMs = Date.now() - started;
    return result;
  }

  // 2. robots.txt + sitemap discovery (best effort, small, same origin only).
  const candidates = new Map<string, Candidate>();
  const addCandidate = (raw: string, via: "homepage" | "nav" | "sitemap" | "internal", anchor = ""): void => {
    let u: URL;
    try {
      u = new URL(raw, homeUrl);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    if (!isSameSite(u, homeUrl)) return;
    if (NON_PAGE_EXT.test(u.pathname) || NOISE_PATH.test(u.pathname + u.search)) return;
    u.hash = "";
    // keep the site's own scheme/host so redirects are not needed for www/non-www variants
    u.protocol = homeUrl.protocol;
    u.hostname = homeUrl.hostname;
    const key = canonicalKey(u.toString());
    if (key === canonicalKey(homeKey)) return;
    const existing = candidates.get(key);
    if (existing) {
      existing.via.add(via);
      existing.score = Math.max(existing.score, scoreCandidate(existing.url, homeKey, existing.via, anchor));
      return;
    }
    const via_ = new Set<"homepage" | "nav" | "sitemap" | "internal">([via]);
    candidates.set(key, { url: u.toString(), score: scoreCandidate(u.toString(), homeKey, via_, anchor), via: via_ });
  };

  for (const link of homePage.links) {
    if (!link.internal) continue;
    addCandidate(link.href, link.nav ? "nav" : "homepage", link.text);
  }

  const robotsUrl = new URL("/robots.txt", homeUrl).toString();
  const robotsRes = await safeFetch(robotsUrl, { ...fetchOpts, kind: "text", timeoutMs: 4_000, maxBytes: 200_000 });
  const sitemapSources: string[] = [];
  if (robotsRes.ok && robotsRes.status === 200) {
    result.robots.fetched = true;
    result.robots.disallowsAll = robotsDisallowsAll(robotsRes.body);
    result.robots.blockedAiAgents = robotsBlockedAgents(robotsRes.body);
    result.robots.sitemaps = parseRobotsSitemaps(robotsRes.body).slice(0, 5);
    sitemapSources.push(...result.robots.sitemaps);
  }
  sitemapSources.push(new URL("/sitemap.xml", homeUrl).toString(), new URL("/sitemap_index.xml", homeUrl).toString());

  const seenSitemaps = new Set<string>();
  let childBudget = LIMITS.maxChildSitemaps;
  let sitemapUrls: string[] = [];
  for (const sm of dedupeUrls(sitemapSources)) {
    if (sitemapUrls.length >= LIMITS.maxSitemapUrls || Date.now() > deadline) break;
    let smUrl: URL;
    try {
      smUrl = new URL(sm, homeUrl);
    } catch {
      continue;
    }
    if (!isSameSite(smUrl, homeUrl) || seenSitemaps.has(smUrl.toString())) continue;
    seenSitemaps.add(smUrl.toString());
    const res = await safeFetch(smUrl.toString(), { ...fetchOpts, kind: "xml", timeoutMs: 5_000 });
    if (!res.ok || res.status !== 200 || !/<(urlset|sitemapindex)[\s>]/i.test(res.body)) continue;
    result.sitemap.found = true;
    result.sitemap.sources.push(smUrl.toString());
    const parsed = parseSitemapXml(res.body, LIMITS.maxSitemapUrls);
    if (parsed.isIndex) {
      // Prefer page/post sitemaps over image, tag, author or product-variant maps.
      const children = parsed.urls
        .filter((c) => !/(image|video|tag|author|categor|attachment|product_cat|news)/i.test(c))
        .sort((a, b) => Number(/post|page/i.test(b)) - Number(/post|page/i.test(a)));
      for (const child of children) {
        if (childBudget <= 0 || Date.now() > deadline) break;
        let cu: URL;
        try {
          cu = new URL(child, homeUrl);
        } catch {
          continue;
        }
        if (!isSameSite(cu, homeUrl) || seenSitemaps.has(cu.toString())) continue;
        seenSitemaps.add(cu.toString());
        childBudget--;
        const cres = await safeFetch(cu.toString(), { ...fetchOpts, kind: "xml", timeoutMs: 5_000 });
        if (!cres.ok || cres.status !== 200) continue;
        result.sitemap.sources.push(cu.toString());
        sitemapUrls.push(...parseSitemapXml(cres.body, LIMITS.maxSitemapUrls).urls);
        if (sitemapUrls.length >= LIMITS.maxSitemapUrls) break;
      }
    } else {
      sitemapUrls.push(...parsed.urls);
    }
    if (sitemapUrls.length > 0) break; // one good sitemap source is enough for a sample
  }
  sitemapUrls = dedupeUrls(sitemapUrls).slice(0, LIMITS.maxSitemapUrls);
  result.sitemap.urlCount = sitemapUrls.length;
  for (const u of sitemapUrls) addCandidate(u, "sitemap");

  // 3. Prioritise and fetch up to maxPages - 1 additional pages, with diversity across roles.
  result.candidatesConsidered = candidates.size;
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  const perRole = new Map<PageRole, number>();
  const roleCap = (role: PageRole): number => (role === "service" || role === "product" ? 5 : role === "informational" ? 3 : 2);
  for (const c of ranked) {
    if (chosen.length >= maxPages - 1) break;
    const role = classifyPath(c.url, homeKey);
    if (role === "legal") continue;
    const n = perRole.get(role) ?? 0;
    if (n >= roleCap(role)) continue;
    perRole.set(role, n + 1);
    chosen.push(c);
  }
  // Fill any remaining slots ignoring role caps (small sites).
  if (chosen.length < maxPages - 1) {
    for (const c of ranked) {
      if (chosen.length >= maxPages - 1) break;
      if (chosen.includes(c) || classifyPath(c.url, homeKey) === "legal") continue;
      chosen.push(c);
    }
  }

  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < chosen.length) {
      const c = chosen[index++];
      if (!c) return;
      if (Date.now() > deadline) {
        result.skipped.push({ url: c.url, reason: "crawl time budget exhausted" });
        continue;
      }
      const res = await safeFetch(c.url, { ...fetchOpts, kind: "html", timeoutMs: Math.min(LIMITS.fetchTimeoutMs, timeLeft()) });
      const { body, ...meta } = res;
      const page: CrawledPage = {
        url: c.url,
        finalUrl: res.finalUrl,
        role: classifyPath(c.url, homeKey),
        discoveredVia: [...c.via],
        fetch: meta,
      };
      if (res.ok) {
        if (!isSameSite(new URL(res.finalUrl), homeUrl)) {
          page.fetch = { ...meta, ok: false, error: "blocked", errorDetail: "Redirected off-site; not followed." };
        } else {
          page.parsed = await parsePage(res.finalUrl, body, res.truncated);
        }
      }
      result.pages.push(page);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chosen.length) }, () => worker()));

  // Deterministic order: homepage, then by score
  const order = new Map(chosen.map((c, i) => [canonicalKey(c.url), i]));
  result.pages.sort((a, b) => (a.role === "home" ? -1 : b.role === "home" ? 1 : (order.get(canonicalKey(a.url)) ?? 0) - (order.get(canonicalKey(b.url)) ?? 0)));
  result.elapsedMs = Date.now() - started;
  return result;
}
