/**
 * The three tools, independent of how they are called. The MCP server
 * (src/mcp/server.ts) and the REST API (src/api/rest.ts) both run them through
 * here, so input validation, the SSRF gate, the crawl and the site-text
 * defusing are written once.
 */

import { z } from "zod";
import { buildAudit } from "../analysis/audit";
import { buildEntityMap } from "../analysis/entities";
import { buildQueryUniverse, inferCategory } from "../analysis/queries";
import { renderAudit, renderEntityMap, renderQueries } from "../analysis/render";
import { stripInvisibleDeep } from "../analysis/siteText";
import { buildSiteModel, COUNTRIES, REGIONS } from "../analysis/site";
import { LIMITS } from "../config";
import { crawlSite, type CrawlResult } from "../crawl/crawler";
import { cachedResolver, createDohResolver, normaliseTargetUrl, TargetError, type TargetPolicy } from "../security/url";

export interface ToolDeps {
  /** Hostnames the auditor itself is served on (never audit yourself). */
  selfHostnames?: string[];
  /** Development only: allow loopback targets when the request itself came from loopback. */
  devAllowLoopbackTargets?: boolean;
  /** Override outbound fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Charges the per-site rate limit when a homepage redirects to another site (see CrawlOptions). */
  chargeRedirectTarget?: (hostname: string) => Promise<boolean>;
}

const urlField = z
  .string()
  .min(4)
  .max(2048)
  .describe("Public website URL to audit, e.g. https://example.com.au. Bare domains are accepted (https is assumed). Private, loopback, internal and IP-literal hosts are rejected.");

const maxPagesField = z
  .number()
  .int()
  .min(1)
  .max(LIMITS.hardMaxPages)
  .optional()
  .describe(`Maximum pages to sample, including the homepage. Default ${LIMITS.defaultMaxPages}, hard maximum ${LIMITS.hardMaxPages}. Pages are prioritised: homepage, about, services/products, pricing, locations, key informational pages.`);

export const auditInputSchema = z.object({ url: urlField, maxPages: maxPagesField });
export const entitiesInputSchema = z.object({ url: urlField, maxPages: maxPagesField });
export const queriesInputSchema = z.object({
  url: urlField,
  service: z.string().min(2).max(120).optional().describe("Optional service or category override, e.g. 'emergency plumbing' or 'family law'. Replaces the services detected from the site."),
  location: z.string().min(2).max(80).optional().describe("Optional location override, e.g. 'Perth' or 'Gold Coast'. Replaces the location detected from the site; pass 'none' to force non-local prompts."),
  count: z.number().int().min(10).max(LIMITS.maxQueryCount).optional().describe(`Number of prompts to return. Default ${LIMITS.defaultQueryCount}, max ${LIMITS.maxQueryCount}.`),
});

export type AuditInput = z.infer<typeof auditInputSchema>;
export type EntitiesInput = z.infer<typeof entitiesInputSchema>;
export type QueriesInput = z.infer<typeof queriesInputSchema>;

const ratingSchema = z.enum(["Strong", "Moderate", "Weak"]);
const confidenceSchema = z.enum(["high", "medium", "low"]);
const querySchema = z.object({
  query: z.string(),
  intent: z.string(),
  buyerStage: z.string(),
  idealPageType: z.string(),
  commercialPriority: z.enum(["high", "medium", "low"]),
});

export const auditOutputSchema = z.looseObject({
  target: z.string(),
  auditedAt: z.string(),
  methodology: z.string(),
  crawl: z.looseObject({ pagesFetched: z.number(), pagesRequested: z.number(), elapsedMs: z.number() }),
  executiveSummary: z.looseObject({ diagnosis: z.string(), ratings: z.record(z.string(), ratingSchema), headline: z.array(z.string()) }),
  entityClarity: z.looseObject({}),
  aiRetrievability: z.looseObject({ rating: ratingSchema }),
  informationGain: z.looseObject({ rating: ratingSchema }),
  trustSignals: z.looseObject({ rating: ratingSchema }),
  architecture: z.looseObject({ rating: ratingSchema }),
  structuredData: z.looseObject({ rating: ratingSchema }),
  commercialCoverage: z.looseObject({ inferredCategory: z.string(), gaps: z.array(z.string()) }),
  topActions: z.array(z.looseObject({ rank: z.number(), action: z.string(), why: z.string(), how: z.string().optional() })),
  fixes: z.looseObject({
    openings: z.array(z.looseObject({ url: z.string(), currentOpening: z.string(), suggested: z.string() })),
    answers: z.array(z.looseObject({ url: z.string(), question: z.string(), suggestedOpening: z.string() })),
    links: z.array(z.looseObject({ from: z.string(), to: z.string(), suggestedAnchor: z.string() })),
  }),
  monitoringPrompts: z.array(querySchema),
});

export const entityOutputSchema = z.looseObject({
  target: z.string(),
  pagesSampled: z.number(),
  primaryEntity: z.looseObject({ name: z.string(), type: z.string(), confidence: confidenceSchema }),
  relatedEntities: z.looseObject({}),
  relationships: z.array(z.looseObject({ subject: z.string(), predicate: z.string(), object: z.string(), confidence: confidenceSchema })),
  ambiguities: z.array(z.string()),
  missingSupport: z.array(z.string()),
  schemaTypesFound: z.array(z.looseObject({ type: z.string(), pages: z.number() })),
  suggestedSchemaTypes: z.array(z.looseObject({ type: z.string(), where: z.string(), why: z.string() })),
});

export const queryOutputSchema = z.looseObject({
  target: z.string(),
  brand: z.string(),
  category: z.string(),
  location: z.string().optional(),
  servicesUsed: z.array(z.string()),
  count: z.number(),
  queries: z.array(querySchema),
  groups: z.record(z.string(), z.array(querySchema)),
});

/**
 * What a tool run produced. `text` is the readable report (site text defused,
 * footer included); `data` is the structured result with invisible characters
 * removed. On failure, `message` is the exact text the MCP tools return.
 */
export type ToolOutcome =
  | { ok: true; text: string; data: Record<string, unknown> }
  | { ok: false; reason: "target_rejected" | "site_unreadable" | "failed"; message: string };

function failure(e: unknown): ToolOutcome {
  if (e instanceof TargetError) return { ok: false, reason: "target_rejected", message: `Target rejected (${e.code}): ${e.message}` };
  if (e instanceof Error) return { ok: false, reason: "failed", message: `Audit failed: ${e.message}` };
  return { ok: false, reason: "failed", message: "Audit failed for an unknown reason." };
}

function unreadable(crawl: CrawlResult, suffix = ""): ToolOutcome | undefined {
  if (crawl.pages.some((p) => p.parsed)) return undefined;
  const home = crawl.pages[0];
  return { ok: false, reason: "site_unreadable", message: `The homepage could not be analysed: ${home?.fetch.errorDetail ?? home?.fetch.error ?? "no usable HTML"}.${suffix}` };
}

function makePolicy(deps: ToolDeps): TargetPolicy {
  return {
    resolve: cachedResolver(createDohResolver(deps.fetchImpl ?? fetch)),
    selfHostnames: deps.selfHostnames,
    devAllowLoopbackTargets: deps.devAllowLoopbackTargets,
  };
}

async function crawlFor(url: string, maxPages: number | undefined, deps: ToolDeps): Promise<CrawlResult> {
  const target = normaliseTargetUrl(url); // throws TargetError on bad input
  return crawlSite(target.toString(), {
    policy: makePolicy(deps),
    fetchImpl: deps.fetchImpl,
    maxPages: maxPages ?? LIMITS.defaultMaxPages,
    chargeRedirectTarget: deps.chargeRedirectTarget,
  });
}

export async function runAudit({ url, maxPages }: AuditInput, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const crawl = await crawlFor(url, maxPages, deps);
    const bad = unreadable(crawl, " Nothing to audit.");
    if (bad) return bad;
    const report = buildAudit(crawl);
    return { ok: true, text: renderAudit(report), data: stripInvisibleDeep(report) as unknown as Record<string, unknown> };
  } catch (e) {
    return failure(e);
  }
}

export async function runEntities({ url, maxPages }: EntitiesInput, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const crawl = await crawlFor(url, maxPages, deps);
    const bad = unreadable(crawl);
    if (bad) return bad;
    const site = buildSiteModel(crawl);
    const map = buildEntityMap(site);
    const structured = { target: crawl.target, pagesSampled: site.pages.length, ...map };
    return { ok: true, text: renderEntityMap(crawl.target, map), data: stripInvisibleDeep(structured) as unknown as Record<string, unknown> };
  } catch (e) {
    return failure(e);
  }
}

export async function runQueries({ url, service, location, count }: QueriesInput, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const crawl = await crawlFor(url, 5, deps);
    const bad = unreadable(crawl);
    if (bad) return bad;
    const site = buildSiteModel(crawl);
    const broad = (v: string) => COUNTRIES.has(v.toLowerCase()) || REGIONS.has(v.toLowerCase());
    const detectedLoc = site.areaServed.find((a) => !broad(a)) ?? site.locations.find((l) => l.confidence !== "low" && !broad(l.value))?.value ?? site.locations.find((l) => l.confidence !== "low")?.value;
    const loc = location?.trim().toLowerCase() === "none" ? undefined : (location?.trim() || detectedLoc);
    const services = service?.trim() ? [service.trim()] : site.offerings.map((o) => o.value);
    const category = service?.trim() ? service.trim() : inferCategory(site);
    const n = Math.min(count ?? LIMITS.defaultQueryCount, LIMITS.maxQueryCount);
    const queries = buildQueryUniverse({ brand: site.brand.value, services, category, location: loc, isLocal: Boolean(loc), count: n });
    const groups: Record<string, typeof queries> = {};
    for (const q of queries) (groups[q.intent] ??= []).push(q);
    const structured = { target: crawl.target, brand: site.brand.value, category, location: loc, servicesUsed: services.slice(0, 6), count: queries.length, queries, groups };
    return { ok: true, text: renderQueries(crawl.target, { brand: site.brand.value, category, location: loc, services }, queries), data: stripInvisibleDeep(structured) as unknown as Record<string, unknown> };
  } catch (e) {
    return failure(e);
  }
}
