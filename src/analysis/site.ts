import type { CrawlResult, CrawledPage, PageRole } from "../crawl/crawler";
import type { ParsedPage } from "../parse/types";
import { countWords } from "../parse/html";

export type Confidence = "high" | "medium" | "low";
export type Rating = "Strong" | "Moderate" | "Weak";

export interface Detected<T = string> {
  value: T;
  confidence: Confidence;
  source: string;
}

export interface PersonEntity {
  name: string;
  role: string;
  confidence: Confidence;
  source: string;
}

export interface SiteModel {
  crawl: CrawlResult;
  pages: (CrawledPage & { parsed: ParsedPage })[];
  home?: CrawledPage & { parsed: ParsedPage };
  hostname: string;
  brand: Detected;
  brandCandidates: Detected[];
  legalName?: Detected;
  businessIds: string[];
  locations: Detected[];
  areaServed: string[];
  offerings: Detected[];
  offeringKind: "services" | "products" | "mixed";
  people: PersonEntity[];
  topics: string[];
  phones: string[];
  emails: string[];
  addresses: string[];
  socialProfiles: string[];
  sameAs: string[];
  schemaTypes: Map<string, string[]>; // type -> page urls
  credentials: string[];
  thirdParty: string[];
  citations: { host: string; url: string; from: string }[];
  totalWords: number;
}

export const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|threads|snapchat|whatsapp|wa|t|telegram|vimeo)\.(com|me|org|co|be)$/i;
const UTILITY_HOSTS = /(^|\.)(google|goo|maps\.app\.goo|apple|amazon|calendly|typeform|hubspot|mailchimp|wixsite|squarespace|godaddy|cloudflare|wordpress|w3|gstatic|googleapis|jquery|bootstrapcdn|cdn|paypal|stripe|shopify)\./i;

const COUNTRY_CODES: Record<string, string> = { AU: "Australia", NZ: "New Zealand", GB: "United Kingdom", UK: "United Kingdom", US: "United States", USA: "United States", CA: "Canada", IE: "Ireland", SG: "Singapore" };
/**
 * Capitalised terms that read like proper nouns but are never places, people or
 * offerings. Without this, phrases like "across ChatGPT" or "GBP Reinstatement
 * Specialist" are promoted to locations and people. Matched case-insensitively
 * against whole candidate strings and against individual words.
 */
const NON_ENTITY_TERMS = new Set([
  // AI assistants, search products and crawlers
  "ai", "ai overviews", "ai overview", "ai mode", "ai search", "ai-assisted", "aeo", "geo", "llm", "llms",
  "chatgpt", "gpt", "gptbot", "openai", "claude", "claudebot", "anthropic", "perplexity", "perplexitybot",
  "gemini", "bard", "copilot", "bing", "bing ai", "copilot and bing ai", "grok", "deepseek", "meta ai",
  "google", "google ai", "google ai overviews", "google ai mode", "google maps", "google search",
  "google business profile", "google merchant center", "google merchant centre", "google ads",
  "maps", "search", "shopping", "merchant center", "merchant centre", "business profile",
  // industry shorthand
  "seo", "sem", "ppc", "cro", "gbp", "gmb", "gmc", "serp", "serps", "ctr", "roi", "kpi", "cms", "crm",
  "e-e-a-t", "eeat", "schema", "json-ld", "html", "css", "url", "urls", "api", "saas", "b2b", "b2c",
  "mba", "phd", "ceo", "cfo", "coo", "cto",
  // generic words that start extracted phrases
  "most", "many", "some", "all", "every", "our", "your", "their", "the", "this", "that", "these", "those",
  "more", "best", "top", "free", "new", "full", "other", "both", "each", "any", "we", "you", "us", "it",
  "done", "post", "posts", "page", "pages", "service", "services", "client", "clients", "customer",
  // demonyms, which are not places
  "australian", "australians", "american", "americans", "british", "european", "canadian", "kiwi",
  // months and weekdays: capitalised, frequent in dated copy, never a service area
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/** Single words that name a pricing tier rather than an offering. */
const TIER_WORDS = new Set([
  "essentials", "essential", "starter", "start", "basic", "basics", "core", "growth", "grow", "scale",
  "pro", "professional", "premium", "plus", "lite", "light", "standard", "advanced", "enterprise",
  "dominator", "ultimate", "elite", "platinum", "gold", "silver", "bronze", "free", "trial", "custom",
  "monthly", "annual", "package", "packages", "plan", "plans", "tier", "tiers", "bundle",
]);

/** Words that mean a candidate names a business or a thing, never a human. */
const NON_PERSON_WORDS = /\b(pty|ltd|limited|llc|inc|incorporated|corp|co|group|team|agency|agencies|scope|solutions?|services?|service|consulting|consultancy|marketing|media|digital|studio|studios|clinic|centre|center|partners|holdings|labs|works|reinstatement|suspension|recovery|removal|audit|audits|optimisation|optimization|management|profile|specialists?|experts?|australia|australian|perth|sydney|melbourne|brisbane|adelaide|canberra|hobart|darwin)\b/i;

export const COUNTRIES = new Set(["australia", "new zealand", "united kingdom", "uk", "united states", "usa", "canada", "ireland", "singapore"]);
export const REGIONS = new Set(["nsw", "vic", "qld", "wa", "sa", "tas", "act", "nt", "new south wales", "victoria", "queensland", "western australia", "south australia", "tasmania", "northern territory"]);
const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT", "New South Wales", "Victoria", "Queensland", "Western Australia", "South Australia", "Tasmania", "Northern Territory"];
const KNOWN_PLACES = [
  "Perth", "Sydney", "Melbourne", "Brisbane", "Adelaide", "Gold Coast", "Sunshine Coast", "Canberra", "Hobart", "Darwin", "Newcastle", "Wollongong", "Geelong", "Townsville", "Cairns", "Toowoomba", "Ballarat", "Bendigo", "Mandurah", "Rockingham", "Joondalup", "Fremantle", "Bunbury", "Busselton", "Albany", "Geraldton", "Kalgoorlie", "Gladstone", "Mackay", "Rockhampton", "Launceston", "Parramatta", "Penrith", "Ipswich", "Logan",
  "Auckland", "Wellington", "Christchurch", "Queenstown", "Hamilton", "Tauranga", "Dunedin",
  "London", "Manchester", "Birmingham", "Leeds", "Glasgow", "Edinburgh", "Bristol", "Liverpool", "Dublin",
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Dallas", "Austin", "Miami", "Seattle", "Denver", "Boston", "Atlanta", "San Francisco", "San Diego", "Toronto", "Vancouver", "Montreal", "Calgary",
  "Singapore", "Hong Kong", "Dubai", "Paris", "Berlin", "Amsterdam", "Madrid", "Barcelona",
  "Australia", "New Zealand", "United Kingdom", "UK", "United States", "USA", "Canada", "Ireland",
];
const PLACE_RE = new RegExp(`\\b(${[...KNOWN_PLACES, ...AU_STATES].map((p) => p.replace(/\s/g, "\\s")).join("|")})\\b`, "g");
const PLACE_CONTEXT_RE = /\b(?:based in|located in|servicing|serving|across|throughout|in and around|near|suburbs of|areas? (?:around|near|of))\s+((?:[A-Z][a-zA-Z'-]+)(?:\s(?:[A-Z][a-zA-Z'-]+|and|&)){0,3})/g;
const AU_ADDRESS_RE = /\b\d{1,5}[A-Za-z]?(?:\/\d{1,5})?\s+[A-Z][A-Za-z'-]+(?:\s[A-Z][A-Za-z'-]+)?\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Highway|Hwy|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Terrace|Tce|Parade|Pde|Crescent|Cres|Circuit|Cct|Close|Cl)\b[^.\n]{0,60}?\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/g;
const PHONE_RE = /(?:\+?61|0)\s?(?:\(0\)\s?)?[2-9](?:[\s-]?\d){8}\b|\b(?:1300|1800|13)(?:[\s-]?\d){6,8}\b|\+\d{1,3}(?:[\s-]?\(?\d\)?){8,14}\b/g;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const ABN_RE = /\b(ABN|ACN)\s*:?\s*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3}|\d{3}\s?\d{3}\s?\d{3})\b/g;
const LEGAL_SUFFIX_RE = /\b([A-Z][A-Za-z0-9&'.-]{0,40}(?:\s+[A-Z][A-Za-z0-9&'.-]{0,40}){0,5})\s+(Pty\.?\s+Ltd\.?|Pty\s+Limited|Ltd\.?|Limited|LLC|Inc\.?|Incorporated|GmbH|LLP|PLC|Corp\.?|Co\.?)\b/g;
const CREDENTIAL_RE = /\b(licen[cs]ed|licen[cs]e (?:no|number)|accredited|accreditation|certified|certification|registered (?:builder|plumber|electrician|agent|migration agent|tax agent|nurse|psychologist|architect|practitioner|provider|nDIS provider)|member of|members? of the|award[- ]winning|awarded|winner of|finalist|years?['’]? (?:of )?experience|since (?:19|20)\d{2}|established (?:in )?(?:19|20)\d{2}|founded (?:in )?(?:19|20)\d{2}|qualified|fellow of|ISO ?\d{4,5}|Google (?:Partner|Premier Partner)|Meta Business Partner|Master (?:Builder|Plumber|Electrician)|bachelor of|master of|phd|\bMBA\b|\bCPA\b|\bCA\b\s*\(|chartered|AHPRA|NDIS|HIA|MBA member|RACGP|\bAPRA\b)\b/gi;
const THIRD_PARTY_RE = /\b(as seen (?:in|on)|featured (?:in|on|by)|as featured|recommended by|trusted by|partnered with|in partnership with|Google reviews?|Google rating|rated \d(?:\.\d)?(?:\/5| stars?| out of 5)|\d(?:\.\d)? ?stars? (?:on|from|across)|Trustpilot|ProductReview|Yelp|Word of Mouth|hipages|Oneflare|Clutch|Facebook reviews?|\d{2,5}\+? (?:five|5)[- ]star reviews?|\d{2,5}\+? reviews)\b/gi;
export const EVIDENCE_RE = /\b(case stud(?:y|ies)|our (?:own )?(?:data|research|study|survey|analysis|experiment|test(?:ing)?|benchmark)|we (?:analy[sz]ed|surveyed|tested|measured|tracked|studied|reviewed|audited|compared|collected|found that|observed)|according to our|original research|proprietary (?:data|research|method|framework)|first[- ]hand|in our experience|(?:n|sample size)\s?=\s?\d+|\d[\d,]* (?:respondents|participants|clients|customers|projects|sites|websites|businesses|patients|homes|jobs|installations|audits|campaigns)|benchmark(?:s|ing)?|results? (?:we|from|of our)|before and after|increase[ds]? (?:by|of) \d|decrease[ds]? (?:by|of) \d|\d+(?:\.\d+)?% (?:increase|decrease|lift|growth|improvement|reduction|more|fewer|of))\b/gi;
const AMBIGUOUS_ANCHOR_RE = /^(click here|here|learn more|read more|more|more info|find out more|view more|see more|this page|link|details|continue reading|discover more|get started|go)$/i;

/** True when every word looks like part of a human name (not an acronym or a stopword). */
function looksLikePersonName(name: string): boolean {
  const tokens = name.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (NON_PERSON_WORDS.test(name)) return false;
  if (NON_ENTITY_TERMS.has(name.toLowerCase())) return false;
  const particles = new Set(["van", "von", "de", "del", "della", "der", "den", "da", "di", "du", "la", "le", "bin", "al", "mac", "mc"]);
  return tokens.every((tok, i) => {
    const bare = tok.replace(/[.,]$/, "");
    if (i > 0 && particles.has(bare.toLowerCase())) return true;
    if (/^(Dr|Mr|Mrs|Ms|Miss|Prof|Professor)\.?$/i.test(bare)) return i === 0;
    if (NON_ENTITY_TERMS.has(bare.toLowerCase())) return false;
    // Rejects acronyms (GBP, SEO, MBA) and lowercase fragments alike.
    return /^[A-Z][a-z'’-]{1,}$/.test(bare);
  });
}

/** True when a capitalised phrase is plausibly a place rather than a product or a brand. */
function looksLikePlace(value: string): boolean {
  const v = value.trim();
  if (!v || v.length < 3 || v.length > 50) return false;
  if (NON_ENTITY_TERMS.has(v.toLowerCase())) return false;
  if (/\d/.test(v)) return false;
  const tokens = v.split(/\s+/);
  if (tokens.length > 3) return false;
  return tokens.every((tok) => {
    const bare = tok.replace(/[.,]$/, "");
    if (NON_ENTITY_TERMS.has(bare.toLowerCase())) return false;
    // Allow small joining words inside a place name ("Port of Spain").
    if (/^(of|the|upon|on|and|&)$/i.test(bare)) return true;
    if (/^[A-Z]{2,}$/.test(bare)) return AU_STATES.includes(bare);
    return /^[A-Z][a-zA-Z'’-]+$/.test(bare);
  });
}

export function withParsed(pages: CrawledPage[]): (CrawledPage & { parsed: ParsedPage })[] {
  return pages.filter((p): p is CrawledPage & { parsed: ParsedPage } => Boolean(p.parsed));
}

export function stripBrandSuffix(title: string, brand: string): string {
  let t = title.trim();
  const parts = t.split(/\s*[|\-–—:»·]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const filtered = parts.filter((p) => !brand || p.toLowerCase() !== brand.toLowerCase());
    t = (filtered[0] ?? parts[0]) as string;
  }
  return t;
}

function titleSegments(title: string): string[] {
  return title.split(/\s*[|\-–—:»·]\s*/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 60);
}

function hostBrand(hostname: string): string {
  const core = hostname.replace(/^www\./, "").split(".")[0] ?? hostname;
  return core.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function ldString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"].trim();
    if (typeof o["@id"] === "string") return "";
  }
  return "";
}

function ldStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(ldString).filter(Boolean);
  const s = ldString(v);
  return s ? [s] : [];
}

export const EDU_TYPES = /^(EducationalOrganization|CollegeOrUniversity|School|HighSchool|Preschool|ElementarySchool|MiddleSchool)$/;

export const ORG_TYPES = /(Organization|LocalBusiness|Corporation|Store|Restaurant|Dentist|Physician|MedicalBusiness|LegalService|Attorney|HomeAndConstructionBusiness|Plumber|Electrician|RoofingContractor|HVACBusiness|AutoRepair|RealEstateAgent|ProfessionalService|FinancialService|AccountingService|InsuranceAgency|TravelAgency|EducationalOrganization|SportsActivityLocation|HealthAndBeautyBusiness|BeautySalon|DaySpa|HairSalon|Hotel|LodgingBusiness|FoodEstablishment|ChildCare|Dentist|Optician|Pharmacy|VeterinaryCare|GeneralContractor|Locksmith|MovingCompany|Florist|Bakery|Winery|Brewery|GolfCourse|Gym|ExerciseGym|SelfStorage|Library|Museum|School|CollegeOrUniversity|GovernmentOrganization|NGO|MedicalClinic|Hospital|ShoppingCenter|AutoDealer|MotorcycleDealer|ArtGallery|NightClub|Casino|BarOrPub|CafeOrCoffeeShop|TattooParlor|Church|Airline|Consortium|MedicalOrganization|SportsOrganization|WorkersUnion|OnlineStore|OnlineBusiness)$/;

export function buildSiteModel(crawl: CrawlResult): SiteModel {
  const pages = withParsed(crawl.pages);
  const home = pages.find((p) => p.role === "home");
  const hostname = new URL(crawl.origin).hostname;

  const schemaTypes = new Map<string, string[]>();
  const orgNodes: { node: Record<string, unknown>; page: string; types: string[] }[] = [];
  const personNodes: { node: Record<string, unknown>; page: string }[] = [];
  const offerNodes: string[] = [];
  const sameAs = new Set<string>();
  for (const p of pages) {
    for (const ld of p.parsed.jsonLd) {
      for (const t of ld.type) {
        const list = schemaTypes.get(t) ?? [];
        if (!list.includes(p.finalUrl)) list.push(p.finalUrl);
        schemaTypes.set(t, list);
        if (ORG_TYPES.test(t)) orgNodes.push({ node: ld.raw, page: p.finalUrl, types: ld.type });
        if (t === "Person") personNodes.push({ node: ld.raw, page: p.finalUrl });
        if (t === "Service" || t === "Product" || t === "Offer") {
          const n = ldString(ld.raw["name"]) || ldString(ld.raw["itemOffered"]);
          if (n) offerNodes.push(n);
        }
      }
      for (const s of ldStrings(ld.raw["sameAs"])) sameAs.add(s);
      const catalog = ld.raw["hasOfferCatalog"] as Record<string, unknown> | undefined;
      const items = catalog?.["itemListElement"];
      if (Array.isArray(items)) {
        for (const it of items) {
          const o = it as Record<string, unknown>;
          const n = ldString(o["itemOffered"]) || ldString(o["name"]);
          if (n) offerNodes.push(n);
        }
      }
    }
  }

  // Brand name candidates
  const brandCandidates: Detected[] = [];
  const pushBrand = (value: string, confidence: Confidence, source: string) => {
    const v = value.trim();
    if (!v || v.length > 80) return;
    // "MBA, International Business (France & Japan)" is a qualification, not a brand.
    if (/,/.test(v) && /\(|\)/.test(v)) return;
    if (brandCandidates.some((b) => b.value.toLowerCase() === v.toLowerCase())) return;
    brandCandidates.push({ value: v, confidence, source });
  };
  // An EducationalOrganization in the graph is almost always someone's alma
  // mater hanging off a Person, not the business. Treating it as a brand
  // candidate produced a false "brand name is stated inconsistently" finding.
  const brandOrgNodes = orgNodes.filter((o) => !o.types.some((t) => EDU_TYPES.test(t)));
  for (const o of brandOrgNodes) pushBrand(ldString(o.node["name"]), "high", `JSON-LD ${o.types[0] ?? "Organization"} on ${o.page}`);
  for (const p of pages) if (p.parsed.ogSiteName) pushBrand(p.parsed.ogSiteName, "high", `og:site_name on ${p.finalUrl}`);
  const segCounts = new Map<string, number>();
  for (const p of pages) for (const seg of new Set(titleSegments(p.parsed.title))) segCounts.set(seg, (segCounts.get(seg) ?? 0) + 1);
  const repeated = [...segCounts.entries()].filter(([, n]) => n >= 2 && pages.length >= 2).sort((a, b) => b[1] - a[1]);
  if (repeated[0]) pushBrand(repeated[0][0], "medium", `repeated title segment across ${repeated[0][1]} pages`);
  else if (home) {
    const segs = titleSegments(home.parsed.title);
    if (segs.length > 1) pushBrand(segs[segs.length - 1] as string, "low", "homepage title suffix");
  }
  const copyright = /©\s*(?:copyright\s*)?(?:\d{4}\s*(?:-|–|to)?\s*(?:\d{4})?\s*)?([A-Z][^.|•·]{1,60}?)(?:\.|\s+All\s+rights|\s*\||$)/i;
  for (const p of pages) {
    const m = copyright.exec(p.parsed.footerText);
    if (m?.[1]) {
      pushBrand(m[1].replace(/\s+(Pty|Ltd|Limited|LLC|Inc).*$/i, "").trim(), "medium", "footer copyright line");
      break;
    }
  }
  if (brandCandidates.length === 0) pushBrand(hostBrand(hostname), "low", "domain name");
  const brand = brandCandidates[0] ?? { value: hostBrand(hostname), confidence: "low", source: "domain name" };

  // Legal name and business identifiers
  let legalName: Detected | undefined;
  const businessIds = new Set<string>();
  for (const o of orgNodes) {
    const ln = ldString(o.node["legalName"]);
    if (ln && !legalName) legalName = { value: ln, confidence: "high", source: "JSON-LD legalName" };
    for (const k of ["taxID", "vatID", "duns", "leiCode", "identifier"]) {
      const v = ldString(o.node[k]);
      if (v) businessIds.add(`${k}: ${v}`);
    }
  }
  for (const p of pages) {
    const text = `${p.parsed.footerText} ${p.parsed.paragraphs.join(" ")}`;
    for (const m of text.matchAll(ABN_RE)) businessIds.add(`${m[1]} ${m[2]}`);
    if (!legalName) {
      const m = LEGAL_SUFFIX_RE.exec(text);
      LEGAL_SUFFIX_RE.lastIndex = 0;
      if (m?.[1] && m[2]) legalName = { value: `${m[1]} ${m[2]}`, confidence: "medium", source: `text on ${p.finalUrl}` };
    }
  }

  // Locations
  const locations: Detected[] = [];
  const pushLoc = (value: string, confidence: Confidence, source: string) => {
    let v = value.replace(/\s+/g, " ").trim();
    v = COUNTRY_CODES[v.toUpperCase()] ?? v;
    if (!v || v.length < 2 || v.length > 50) return;
    if (NON_ENTITY_TERMS.has(v.toLowerCase())) return;
    const existing = locations.find((l) => l.value.toLowerCase() === v.toLowerCase());
    if (existing) {
      if (rank(confidence) > rank(existing.confidence)) Object.assign(existing, { confidence, source });
      return;
    }
    locations.push({ value: v, confidence, source });
  };
  const areaServed = new Set<string>();
  for (const o of orgNodes) {
    const addr = o.node["address"];
    const addrs = Array.isArray(addr) ? addr : addr ? [addr] : [];
    for (const a of addrs) {
      if (!a || typeof a !== "object") continue;
      const ao = a as Record<string, unknown>;
      for (const k of ["addressLocality", "addressRegion", "addressCountry"]) {
        const v = ldString(ao[k]);
        if (v) pushLoc(v, "high", `JSON-LD address.${k}`);
      }
    }
    for (const s of ldStrings(o.node["areaServed"])) {
      areaServed.add(s);
      pushLoc(s, "high", "JSON-LD areaServed");
    }
  }
  const textCorpus = pages.map((p) => `${p.parsed.title} ${p.parsed.metaDescription} ${p.parsed.headings.h1.join(" ")} ${p.parsed.paragraphs.join(" ")} ${p.parsed.footerText}`).join("\n");
  const placeCounts = new Map<string, number>();
  for (const m of textCorpus.matchAll(PLACE_RE)) placeCounts.set(m[1] as string, (placeCounts.get(m[1] as string) ?? 0) + 1);
  for (const [place, n] of [...placeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    if (!looksLikePlace(place)) continue;
    pushLoc(place, n >= 3 ? "medium" : "low", `mentioned ${n}x in visible copy`);
  }
  for (const m of textCorpus.matchAll(PLACE_CONTEXT_RE)) {
    // "servicing clients across ChatGPT and Google AI Overviews" is a sentence
    // about AI platforms, not a service area. Free-text capture is only trusted
    // when the phrase actually looks like a place name.
    let phrase = (m[1] ?? "").replace(/\s(?:and|&)$/, "").trim();
    // The capture can run past a sentence boundary and pick up the next word.
    phrase = phrase.replace(/\s+(We|You|Our|Your|They|It|This|That|The)$/, "").trim();
    if (looksLikePlace(phrase)) pushLoc(phrase, "medium", `"${m[0].slice(0, 40)}" in copy`);
  }
  // A repeated slug prefix across several pages ("handyman-belconnen",
  // "handyman-curtin", "handyman-gungahlin") is a suburb landing-page network.
  // The trailing segment is a place, and without this it was read as a service.
  const suburbNames = new Set<string>();
  const prefixCounts = new Map<string, string[]>();
  for (const p of pages) {
    const slug = new URL(p.finalUrl).pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
    const dash = slug.indexOf("-");
    if (dash < 2) continue;
    const prefix = slug.slice(0, dash);
    const rest = slug.slice(dash + 1);
    if (!rest || /^\d+$/.test(rest)) continue;
    prefixCounts.set(prefix, [...(prefixCounts.get(prefix) ?? []), rest]);
  }
  for (const [, rests] of prefixCounts) {
    if (rests.length < 3) continue;
    for (const rest of rests) {
      // "handyman-prices-canberra" shares the prefix but is a pricing page, not
      // a suburb. Commercial modifiers give those away.
      if (/\b(price|prices|pricing|cost|costs|quote|quotes|rates|service|services|near|me|reviews|guide|faq|cheap|best|emergency|24|hour|hours)\b/i.test(rest.replace(/-/g, " "))) continue;
      const name = rest.replace(/-/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
      if (!looksLikePlace(name)) continue;
      suburbNames.add(name.toLowerCase());
      pushLoc(name, "medium", "suburb landing page");
    }
  }

  const addresses = new Set<string>();
  for (const m of textCorpus.matchAll(AU_ADDRESS_RE)) addresses.add(m[0].replace(/\s+/g, " ").trim());
  for (const a of addresses) {
    const st = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/.exec(a);
    if (st?.[1]) pushLoc(st[1], "high", "postal address in copy");
  }
  // "Victoria" matched inside "Victoria Park": drop a place that only occurs as the prefix of a longer detected place.
  for (let i = locations.length - 1; i >= 0; i--) {
    const short = locations[i] as Detected;
    const longer = locations.find((l) => l !== short && l.value.toLowerCase().startsWith(`${short.value.toLowerCase()} `));
    if (longer && rank(short.confidence) <= rank(longer.confidence)) locations.splice(i, 1);
  }

  // Offerings
  const offerings: Detected[] = [];
  const locationNames = [...locations.map((l) => l.value), ...KNOWN_PLACES, ...AU_STATES].map((x) => x.toLowerCase());
  const stripLocationSuffix = (v: string): string => {
    // Offerings are short labels. The lazy patterns below are quadratic on long
    // strings, and this text comes from the audited site, so skip anything long.
    if (v.length > 160) return v;
    const m = /^(.*?)(?:\s+(?:in|near|across|throughout|for|around)\s+([A-Z][\w'’-]+(?:\s[A-Z][\w'’-]+){0,2}))$/.exec(v);
    if (m?.[1] && m[2] && locationNames.includes(m[2].toLowerCase())) return m[1];
    const tail = /^(.*?)\s+([A-Z][\w'’-]+(?:\s[A-Z][\w'’-]+)?)$/.exec(v);
    if (tail?.[1] && tail[2] && locationNames.includes(tail[2].toLowerCase()) && tail[1].split(" ").length >= 2) return tail[1];
    return v;
  };
  const offerKey = (v: string): string[] =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !/^(the|and|for|with|our|your|services?|solutions?)$/.test(w))
      .map((w) => w.replace(/(ing|ers?|s)$/, ""));
  const pushOffer = (value: string, confidence: Confidence, source: string) => {
    let v = value.replace(/\s+/g, " ").trim().replace(/[.!,;:]+$/, "");
    // "HOME REPAIRS" is a real service name shouted in a heading, so title-case
    // it rather than discarding it.
    if (v.length > 3 && v === v.toUpperCase() && /[A-Z]/.test(v)) {
      v = v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    }
    v = stripLocationSuffix(stripBrandSuffix(v, brand.value)).replace(/[.!,;:]+$/, "").trim();
    if (!v || v.length < 3 || /^((our|all|the|more|view all|other)\s+)?(home|about|contact|blog|news|faq|faqs|services?|products?|shop|login|menu|search|more|get a quote|book now|call us|reviews|gallery|pricing|careers|team|work|jobs)$/i.test(v)) return;
    // A suburb is a place the work happens, not the work. Suburb landing pages
    // are titled with the suburb, and their nav labels are the suburb alone.
    if (locations.some((l) => l.value.toLowerCase() === v.toLowerCase())) return;
    if (suburbNames.has(v.toLowerCase())) return;
    // A marketing sentence is not an offering name. Previously these were cut at
    // 70 characters, which shipped names truncated mid-word.
    if (v.length > 70) return;
    if (/[.!?]\s+[A-Z]/.test(v)) return;
    // "AI SEO, high" and "AI SEO, Local service business" are table cells, not names.
    if (/,\s/.test(v)) return;
    // "Advanced GBP risk and account architecture (agencies and multi" — an
    // opening bracket with no closing one means the source text was cut off.
    if ((v.match(/\(/g)?.length ?? 0) !== (v.match(/\)/g)?.length ?? 0)) return;
    // "Find the real reason your site is underperforming" is a headline written
    // as a command, not the name of a service.
    if (/^(find|get|book|learn|discover|see|start|stop|fix|grow|boost|claim|request|talk|call|read|download|try|join|save|take|make|turn|stay|meet|watch|explore|check|compare|choose|why|how|what|when|where|who|ready|need|want|let)\b/i.test(v)) return;
    const words = v.split(/\s+/);
    // "Manual 25" is a table cell, not an offering.
    if (words.some((w) => /^\d+$/.test(w))) return;
    // Single generic words are pricing tiers ("Essentials", "Growth", "Dominator").
    if (words.length === 1 && (TIER_WORDS.has(v.toLowerCase()) || NON_ENTITY_TERMS.has(v.toLowerCase()) || v.length < 6)) return;
    if (words.length <= 2 && words.every((w) => TIER_WORDS.has(w.toLowerCase()))) return;
    const key = offerKey(v);
    const overlaps = (a: string[], b: string[]) => a.length > 0 && b.length > 0 && a.every((t) => b.includes(t));
    const dupe = offerings.find((o) => {
      const k = offerKey(o.value);
      return o.value.toLowerCase() === v.toLowerCase() || overlaps(key, k) || overlaps(k, key);
    });
    if (dupe) {
      // keep the more specific name at the higher confidence
      if (rank(confidence) > rank(dupe.confidence) || (rank(confidence) === rank(dupe.confidence) && v.length > dupe.value.length)) Object.assign(dupe, { value: v, confidence, source });
      return;
    }
    offerings.push({ value: v, confidence, source });
  };
  for (const n of offerNodes) pushOffer(n, "high", "JSON-LD Service/Product/Offer");
  for (const p of pages) {
    if (p.role === "service" || p.role === "product") {
      const h1 = p.parsed.headings.h1[0];
      if (h1) pushOffer(h1, "high", `H1 of ${p.finalUrl}`);
      else if (p.parsed.title) pushOffer(p.parsed.title, "medium", `title of ${p.finalUrl}`);
    }
  }
  if (home) {
    for (const l of home.parsed.links) {
      if (!l.internal || !l.nav || !l.text) continue;
      const role = crawl.pages.find((cp) => cp.url === l.href)?.role;
      if (role === "service" || role === "product" || /\/(services?|products?|solutions|treatments?)\//i.test(l.href)) pushOffer(l.text, "medium", "homepage navigation");
    }
  }
  const productPages = pages.filter((p) => p.role === "product" || p.role === "category").length;
  const servicePages = pages.filter((p) => p.role === "service").length;
  const hasProductSchema = schemaTypes.has("Product");
  const offeringKind: SiteModel["offeringKind"] = hasProductSchema || productPages > servicePages ? (servicePages > 0 ? "mixed" : "products") : "services";

  // People
  const people: PersonEntity[] = [];
  const brandWords = new Set(brand.value.toLowerCase().split(/\s+/));
  const pushPerson = (name: string, role: string, confidence: Confidence, source: string) => {
    const n = name.replace(/^by\s+/i, "").replace(/\s+/g, " ").trim();
    if (!looksLikePersonName(n)) return;
    // "Search Scope Specialist" is a job title, not a person called Search Scope.
    if (n.toLowerCase().split(/\s+/).every((w) => brandWords.has(w))) return;
    const existing = people.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      if (!existing.role && role) existing.role = role;
      if (rank(confidence) > rank(existing.confidence)) Object.assign(existing, { confidence, source });
      return;
    }
    people.push({ name: n, role: role.trim(), confidence, source });
  };
  for (const pn of personNodes) pushPerson(ldString(pn.node["name"]), ldString(pn.node["jobTitle"]), "high", `JSON-LD Person on ${pn.page}`);
  for (const o of orgNodes) for (const f of ldStrings(o.node["founder"])) pushPerson(f, "Founder", "high", "JSON-LD founder");
  for (const p of pages) {
    for (const a of p.parsed.authorTexts) pushPerson(a.replace(/^(written|posted|published)?\s*by\s+/i, "").split(/[,|·•]/)[0] ?? "", "Author", "medium", `byline on ${p.finalUrl}`);
    if (p.parsed.metaAuthor) pushPerson(p.parsed.metaAuthor, "Author", "medium", `meta author on ${p.finalUrl}`);
    const text = p.parsed.paragraphs.join(" ");
    const roleWords = "founder|co-founder|owner|director|managing director|ceo|principal|head|lead|senior consultant|consultant|specialist|manager|partner|dentist|physiotherapist|solicitor|lawyer|accountant|electrician|plumber|builder";
    // Name first, then the role: "Dorian Menard is the founder", "Jane Lee, director".
    // The reverse order ("specialist Jane Lee") is not how English names people,
    // and matching it case-insensitively is what previously turned "GBP
    // Reinstatement Specialist" and "Most SEO Specialist" into staff members.
    const fwd = new RegExp(`\\b((?:Dr\\.?\\s)?[A-Z][a-z'’-]+\\s[A-Z][a-z'’-]+(?:\\s[A-Z][a-z'’-]+)?),?\\s+(?:is\\s+|was\\s+)?(?:the\\s+|our\\s+|a\\s+|an\\s+)?(${roleWords})\\b`, "g");
    // Honorifics are the one title that genuinely precedes a name.
    const honorific = /\b(Dr|Doctor|Prof|Professor)\.?\s+([A-Z][a-z'’-]+\s[A-Z][a-z'’-]+)\b/g;
    for (const m of text.matchAll(fwd)) pushPerson(m[1] as string, capitalise(m[2] as string), "medium", `copy on ${p.finalUrl}`);
    for (const m of text.matchAll(honorific)) pushPerson(`${m[1]} ${m[2]}`, "", "medium", `copy on ${p.finalUrl}`);
  }

  // Contact details
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const p of pages) {
    const text = `${p.parsed.paragraphs.join(" ")} ${p.parsed.footerText} ${p.parsed.blocks.filter((b) => b.chrome).map((b) => b.text).join(" ")}`;
    for (const m of text.matchAll(PHONE_RE)) if (phones.size < 5) phones.add(m[0].replace(/\s+/g, " ").trim());
    for (const m of text.matchAll(EMAIL_RE)) if (emails.size < 5) emails.add(m[0].toLowerCase());
    for (const l of p.parsed.links) {
      const tel = /^tel:(.+)$/i.exec(l.href);
      if (tel?.[1] && phones.size < 5) phones.add(decodeURIComponent(tel[1]));
    }
    for (const ld of p.parsed.jsonLd) {
      const t = ldString(ld.raw["telephone"]);
      if (t && phones.size < 5) phones.add(t);
      const e = ldString(ld.raw["email"]);
      if (e && emails.size < 5) emails.add(e.toLowerCase());
    }
  }

  // Outbound citations and social profiles
  const socialProfiles = new Set<string>();
  const citations: SiteModel["citations"] = [];
  const seenCit = new Set<string>();
  for (const p of pages) {
    for (const l of p.parsed.links) {
      if (l.internal) continue;
      let h: string;
      try {
        h = new URL(l.href).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (SOCIAL_HOSTS.test(h)) {
        socialProfiles.add(l.href);
        continue;
      }
      if (UTILITY_HOSTS.test(h) || l.chrome) continue;
      const key = `${h}${new URL(l.href).pathname}`;
      if (seenCit.has(key)) continue;
      seenCit.add(key);
      citations.push({ host: h, url: l.href, from: p.finalUrl });
    }
  }

  // Credentials, third-party evidence, topics
  const credentials = new Set<string>();
  const thirdParty = new Set<string>();
  for (const p of pages) {
    const text = `${p.parsed.paragraphs.join(" ")} ${p.parsed.footerText}`;
    for (const m of text.matchAll(CREDENTIAL_RE)) if (credentials.size < 12) credentials.add(m[0]);
    for (const m of text.matchAll(THIRD_PARTY_RE)) if (thirdParty.size < 12) thirdParty.add(m[0]);
  }
  const topics = [...new Set(pages.filter((p) => p.role === "informational" || p.role === "faq" || p.role === "case-study").map((p) => stripBrandSuffix(p.parsed.headings.h1[0] ?? p.parsed.title, brand.value)).filter(Boolean))].slice(0, 12);

  return {
    crawl,
    pages,
    home,
    hostname,
    brand,
    brandCandidates,
    legalName,
    businessIds: [...businessIds],
    locations,
    areaServed: [...areaServed],
    offerings: offerings.slice(0, 20),
    offeringKind,
    people: people.slice(0, 12),
    topics,
    phones: [...phones],
    emails: [...emails],
    addresses: [...addresses].slice(0, 3),
    socialProfiles: [...socialProfiles].slice(0, 10),
    sameAs: [...sameAs],
    schemaTypes,
    credentials: [...credentials],
    thirdParty: [...thirdParty],
    citations: citations.slice(0, 30),
    totalWords: pages.reduce((n, p) => n + p.parsed.wordCount, 0),
  };
}

export function rank(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function isAmbiguousAnchor(text: string): boolean {
  return AMBIGUOUS_ANCHOR_RE.test(text.trim());
}

export function roleLabel(role: PageRole): string {
  return role === "case-study" ? "case study" : role;
}

export function pageWords(p: ParsedPage): number {
  return p.wordCount || p.paragraphs.reduce((n, x) => n + countWords(x), 0);
}
