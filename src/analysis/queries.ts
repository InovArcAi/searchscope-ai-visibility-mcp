import type { SiteModel } from "./site";

export type QueryIntent = "informational" | "problem-aware" | "commercial" | "recommendation" | "comparison" | "alternatives" | "brand" | "category" | "local" | "trust-validation";
export type BuyerStage = "awareness" | "consideration" | "decision" | "retention";
export type Priority = "high" | "medium" | "low";

export interface GeoQuery {
  query: string;
  intent: QueryIntent;
  buyerStage: BuyerStage;
  idealPageType: string;
  commercialPriority: Priority;
}

export interface QueryUniverseInput {
  brand: string;
  services: string[];
  category: string;
  location?: string;
  competitorsHint?: string[];
  isLocal: boolean;
  count: number;
}

const INTENT_ORDER: QueryIntent[] = ["commercial", "recommendation", "local", "comparison", "problem-aware", "informational", "alternatives", "category", "brand", "trust-validation"];

/**
 * Pluralise a category noun. "SEO agency" becomes "SEO agencies", not the
 * "seo agencys" that appeared in generated prompts.
 */
export function pluralise(noun: string): string {
  const words = noun.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  let plural: string;
  if (/[^aeiou]y$/i.test(last)) plural = `${last.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/i.test(last)) plural = `${last}es`;
  else if (/[^aeiou]o$/i.test(last)) plural = `${last}es`;
  else plural = `${last}s`;
  return [...words.slice(0, -1), plural].join(" ");
}

function lc(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Turn "Emergency Plumbing Services" into "emergency plumbing" for natural prompts. */
export function serviceToPhrase(service: string): string {
  return lc(service)
    .replace(/\b(services?|solutions?|specialists?|experts?|company|companies|providers?|australia|perth|sydney|melbourne|brisbane|adelaide)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Infer a category noun ("plumber", "SEO agency") from services and brand copy. */
export function inferCategory(site: SiteModel): string {
  const text = `${site.home?.parsed.title ?? ""} ${site.home?.parsed.metaDescription ?? ""} ${site.home?.parsed.headings.h1.join(" ") ?? ""} ${site.offerings.map((o) => o.value).join(" ")}`.toLowerCase();
  const pairs: [RegExp, string][] = [
    [/\bseo\b|search engine optimi/, "SEO agency"],
    [/digital marketing/, "digital marketing agency"],
    [/web design|website design/, "web design agency"],
    [/plumb/, "plumber"],
    [/electric/, "electrician"],
    [/roof/, "roofing contractor"],
    [/dentist|dental/, "dentist"],
    [/physio/, "physiotherapist"],
    [/chiro/, "chiropractor"],
    [/lawyer|solicitor|legal|law firm/, "law firm"],
    [/accountant|bookkeep|tax agent/, "accountant"],
    [/mortgage|home loan|broker/, "mortgage broker"],
    [/real estate|property management/, "real estate agency"],
    [/builder|renovation|construction/, "builder"],
    [/landscap/, "landscaper"],
    [/clean/, "cleaning company"],
    [/removal|movers|moving/, "removalist"],
    [/pest/, "pest control company"],
    [/air con|hvac|heating and cooling/, "air conditioning company"],
    [/solar/, "solar installer"],
    [/gym|fitness|personal train/, "gym"],
    [/cafe|restaurant|catering/, "restaurant"],
    [/clinic|medical|doctor|gp\b/, "medical clinic"],
    [/therap|counsell|psycholog/, "therapist"],
    [/camper|caravan|4wd|hire/, "hire company"],
    [/software|saas|platform|app\b/, "software company"],
    [/shop|store|buy|products/, "online store"],
  ];
  for (const [re, cat] of pairs) if (re.test(text)) return cat;
  const first = site.offerings[0]?.value;
  return first ? `${serviceToPhrase(first)} provider` : "business";
}

export function buildQueryUniverse(input: QueryUniverseInput): GeoQuery[] {
  const brand = input.brand;
  const cat = lc(input.category);
  const cats = pluralise(cat);
  const loc = input.location?.trim();
  const services = [...new Set(input.services.map(serviceToPhrase).filter((s) => s.length > 2))].slice(0, 6);
  const primary = services[0] ?? cat;
  const out: GeoQuery[] = [];
  const add = (query: string, intent: QueryIntent, buyerStage: BuyerStage, idealPageType: string, commercialPriority: Priority) => {
    const q = query.replace(/\s{2,}/g, " ").trim();
    if (!q || out.some((x) => lc(x.query) === lc(q))) return;
    out.push({ query: q, intent, buyerStage, idealPageType, commercialPriority });
  };
  const inLoc = loc ? ` in ${loc}` : "";

  // Commercial (high priority)
  for (const s of services.slice(0, 4)) {
    add(`Who offers ${s}${inLoc}?`, "commercial", "decision", "service page", "high");
    add(`How much does ${s} cost${inLoc}?`, "commercial", "consideration", "pricing page or service page with pricing section", "high");
  }
  add(`I need a ${cat}${inLoc}, who should I contact?`, "commercial", "decision", "homepage or contact page", "high");
  add(`What should I look for when hiring a ${cat}?`, "commercial", "consideration", "buyer's guide", "medium");

  // Recommendation
  add(`Recommend a ${cat}${inLoc}`, "recommendation", "decision", "homepage with reviews and proof", "high");
  add(`Best ${cat}${inLoc}`, "recommendation", "decision", "homepage, case studies, reviews page", "high");
  for (const s of services.slice(0, 2)) add(`Who is the best provider of ${s}${inLoc}?`, "recommendation", "decision", "service page with proof", "high");
  add(`Which ${cat}${inLoc} has the best reviews?`, "recommendation", "decision", "reviews or testimonials page", "medium");

  // Local
  if (input.isLocal && loc) {
    add(`${cat} near ${loc}`, "local", "decision", "location page", "high");
    add(`${primary} ${loc} same-day or emergency options`, "local", "decision", "service page with availability", "medium");
    add(`Does ${brand} service areas around ${loc}?`, "local", "decision", "service area page", "medium");
    add(`${cat} open now near ${loc}`, "local", "decision", "Google Business Profile plus contact page", "medium");
  }

  // Comparison
  add(`${brand} vs other ${cats}${inLoc}`, "comparison", "consideration", "comparison page", "medium");
  if (services.length >= 2) add(`${services[0]} vs ${services[1]}: which do I need?`, "comparison", "consideration", "comparison guide", "medium");
  add(`How does ${brand} compare on price and turnaround?`, "comparison", "consideration", "pricing page", "medium");
  add(`Is it better to use a local ${cat} or a national one?`, "comparison", "consideration", "buyer's guide", "low");

  // Problem-aware
  add(`How do I know if I need ${primary}?`, "problem-aware", "awareness", "diagnostic guide", "medium");
  add(`What happens if I delay ${primary}?`, "problem-aware", "awareness", "explainer article", "low");
  add(`Common problems that require a ${cat}`, "problem-aware", "awareness", "symptoms or problems guide", "medium");
  for (const s of services.slice(1, 3)) add(`Signs I need ${s}`, "problem-aware", "awareness", "diagnostic article", "low");

  // Informational
  add(`What is ${primary} and how does it work?`, "informational", "awareness", "definition article", "medium");
  add(`How long does ${primary} take?`, "informational", "consideration", "process page", "medium");
  add(`What is included in ${primary}?`, "informational", "consideration", "service page with scope section", "medium");
  add(`Step-by-step: what does the ${primary} process look like?`, "informational", "consideration", "process or how-it-works page", "low");
  for (const s of services.slice(1, 3)) add(`Explain ${s} in simple terms`, "informational", "awareness", "explainer article", "low");

  // Alternatives
  add(`Alternatives to ${brand}`, "alternatives", "consideration", "comparison page or strong brand page", "medium");
  add(`Cheaper alternatives to ${primary}`, "alternatives", "consideration", "pricing FAQ", "low");
  add(`Can I do ${primary} myself instead of hiring a ${cat}?`, "alternatives", "awareness", "DIY vs professional guide", "medium");

  // Category
  add(`Top ${cats}${inLoc} for ${primary}`, "category", "consideration", "homepage and category page", "medium");
  add(`List of ${cats}${inLoc} that specialise in ${primary}`, "category", "consideration", "service page", "medium");
  add(`What types of ${cat} are there?`, "category", "awareness", "category explainer", "low");

  // Brand
  add(`What does ${brand} do?`, "brand", "awareness", "homepage and About page", "high");
  add(`Who is behind ${brand}?`, "brand", "consideration", "About or team page", "medium");
  add(`Where is ${brand} located?`, "brand", "decision", "contact page", "medium");
  add(`What services does ${brand} offer?`, "brand", "consideration", "services overview", "high");
  add(`How do I contact ${brand}?`, "brand", "decision", "contact page", "medium");

  // Trust and validation
  add(`Is ${brand} legitimate and reputable?`, "trust-validation", "decision", "About page with credentials and reviews", "high");
  add(`${brand} reviews and complaints`, "trust-validation", "decision", "reviews page and third-party profiles", "high");
  add(`What qualifications or licences does ${brand} hold?`, "trust-validation", "decision", "About page with credentials", "medium");
  add(`Has ${brand} published any results or case studies?`, "trust-validation", "consideration", "case studies page", "medium");
  add(`How long has ${brand} been in business?`, "trust-validation", "decision", "About page", "low");

  // Extra depth so large counts stay meaningful rather than permutational.
  for (const s of services.slice(0, 6)) {
    add(`Is ${s} worth paying a professional for?`, "commercial", "consideration", "service page with outcomes", "medium");
    add(`What questions should I ask before booking ${s}?`, "commercial", "consideration", "buyer's checklist", "medium");
    add(`${brand} ${s} reviews`, "trust-validation", "decision", "service page with reviews", "medium");
    add(`What is included in a ${s} quote?`, "commercial", "decision", "pricing or quote page", "high");
    add(`How long does ${s} usually take?`, "informational", "consideration", "process section on service page", "medium");
    add(`Common mistakes people make with ${s}`, "problem-aware", "awareness", "guide", "low");
    add(`${s} for small businesses${inLoc}`, "commercial", "consideration", "audience-specific service page", "medium");
    add(`Who offers ${s} with a guarantee or warranty?`, "trust-validation", "decision", "service page with guarantee terms", "medium");
    add(`What does a good ${s} provider look like?`, "recommendation", "consideration", "About page and case studies", "medium");
    add(`${s} vs doing nothing: what are the risks?`, "problem-aware", "awareness", "explainer article", "low");
  }
  add(`Which ${cats}${inLoc} offer fixed pricing?`, "commercial", "decision", "pricing page", "high");
  add(`Which ${cats}${inLoc} have same-day availability?`, "commercial", "decision", "service page with availability", "medium");
  add(`${cat} that specialises in ${primary}`, "category", "decision", "service page", "high");
  add(`Most experienced ${cat}${inLoc}`, "recommendation", "decision", "About page with credentials", "medium");
  add(`Family-owned or independent ${cat}${inLoc}`, "recommendation", "decision", "About page", "low");
  add(`${cat} with the best customer service${inLoc}`, "recommendation", "decision", "reviews page", "medium");
  add(`What licences or accreditations should a ${cat} have?`, "trust-validation", "consideration", "credentials section", "medium");
  add(`Red flags when choosing a ${cat}`, "trust-validation", "consideration", "buyer's guide", "medium");
  add(`How do I verify a ${cat} is legitimate${inLoc}?`, "trust-validation", "decision", "About page with ABN and licences", "medium");
  add(`Does ${brand} have case studies or examples of past work?`, "brand", "consideration", "case studies page", "medium");
  add(`What makes ${brand} different from other ${cats}?`, "brand", "consideration", "homepage positioning", "medium");
  add(`Is ${brand} good for ${primary}?`, "brand", "decision", "service page", "high");
  add(`${brand} pricing`, "brand", "decision", "pricing page", "high");
  add(`${brand} opening hours and availability`, "brand", "decision", "contact page", "low");
  add(`Who founded ${brand} and when?`, "brand", "awareness", "About page", "low");
  add(`${brand} vs a cheaper ${cat}: is the difference worth it?`, "comparison", "consideration", "pricing page with value explanation", "medium");
  add(`Independent ${cat} vs franchise${inLoc}`, "comparison", "consideration", "buyer's guide", "low");
  add(`Should I choose the cheapest ${cat} quote?`, "comparison", "consideration", "pricing FAQ", "medium");
  add(`What are the alternatives to hiring a ${cat}?`, "alternatives", "awareness", "DIY vs professional guide", "low");
  add(`Other ${cats} similar to ${brand}`, "alternatives", "consideration", "strong brand and About pages", "low");
  add(`Is there a better option than ${brand} for ${primary}?`, "alternatives", "decision", "service page with proof", "medium");
  add(`How much should ${primary} cost${inLoc} in 2026?`, "informational", "consideration", "pricing guide", "high");
  add(`Beginner's guide to ${primary}`, "informational", "awareness", "pillar guide", "medium");
  add(`Glossary of ${primary} terms`, "informational", "awareness", "glossary page", "low");
  add(`What to expect on the day of ${primary}`, "informational", "decision", "process page", "medium");
  add(`How do I prepare for ${primary}?`, "informational", "decision", "preparation checklist", "low");
  add(`Warning signs that ${primary} is overdue`, "problem-aware", "awareness", "symptoms guide", "medium");
  add(`Can ${primary} be done in stages to spread the cost?`, "problem-aware", "consideration", "pricing FAQ", "low");
  add(`Types of ${primary} explained`, "category", "awareness", "category explainer", "medium");
  add(`${cat} categories: what is the difference between them?`, "category", "awareness", "category explainer", "low");
  add(`Best-rated ${cats}${inLoc} for ${primary}`, "category", "decision", "service page with reviews", "high");
  if (input.isLocal && loc) {
    add(`${primary} ${loc} reviews`, "local", "decision", "location page with reviews", "high");
    add(`Local ${cat} in ${loc} with good reviews`, "local", "decision", "location page", "high");
    add(`How far does ${brand} travel from ${loc}?`, "local", "decision", "service area page", "low");
    add(`${cat} ${loc} price guide`, "local", "consideration", "location page with pricing", "medium");
    add(`${primary} suburbs near ${loc}`, "local", "decision", "service area page", "medium");
    add(`Emergency ${cat} ${loc} after hours`, "local", "decision", "service page with availability", "medium");
  }

  // Balance: keep intents represented in rotation until count is reached.
  const byIntent = new Map<QueryIntent, GeoQuery[]>();
  for (const q of out) byIntent.set(q.intent, [...(byIntent.get(q.intent) ?? []), q]);
  const balanced: GeoQuery[] = [];
  let round = 0;
  while (balanced.length < input.count && round < 20) {
    let addedAny = false;
    for (const intent of INTENT_ORDER) {
      const list = byIntent.get(intent) ?? [];
      const item = list[round];
      if (item && balanced.length < input.count) {
        balanced.push(item);
        addedAny = true;
      }
    }
    if (!addedAny) break;
    round++;
  }
  return balanced;
}

/** 20 monitoring prompts for the audit tool: a fixed, balanced subset. */
export function monitoringPrompts(input: Omit<QueryUniverseInput, "count">): GeoQuery[] {
  return buildQueryUniverse({ ...input, count: 20 });
}
