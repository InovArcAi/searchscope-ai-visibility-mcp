import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildAudit } from "../analysis/audit";
import { buildEntityMap } from "../analysis/entities";
import { buildQueryUniverse, inferCategory } from "../analysis/queries";
import { renderAudit, renderEntityMap, renderQueries } from "../analysis/render";
import { buildSiteModel, COUNTRIES, REGIONS } from "../analysis/site";
import { LIMITS, SERVICE_NAME, SERVICE_VERSION } from "../config";
import { crawlSite, type CrawlResult } from "../crawl/crawler";
import { cachedResolver, createDohResolver, normaliseTargetUrl, TargetError, type TargetPolicy } from "../security/url";

export interface ServerDeps {
  /** Hostnames the auditor itself is served on (never audit yourself). */
  selfHostnames?: string[];
  /** Development only: allow loopback targets when the request itself came from loopback. */
  devAllowLoopbackTargets?: boolean;
  /** Override outbound fetch (tests). */
  fetchImpl?: typeof fetch;
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

const ratingSchema = z.enum(["Strong", "Moderate", "Weak"]);
const confidenceSchema = z.enum(["high", "medium", "low"]);
const querySchema = z.object({
  query: z.string(),
  intent: z.string(),
  buyerStage: z.string(),
  idealPageType: z.string(),
  commercialPriority: z.enum(["high", "medium", "low"]),
});

const auditOutputSchema = z.looseObject({
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

const entityOutputSchema = z.looseObject({
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

const queryOutputSchema = z.looseObject({
  target: z.string(),
  brand: z.string(),
  category: z.string(),
  location: z.string().optional(),
  servicesUsed: z.array(z.string()),
  count: z.number(),
  queries: z.array(querySchema),
  groups: z.record(z.string(), z.array(querySchema)),
});

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function describeError(e: unknown): string {
  if (e instanceof TargetError) return `Target rejected (${e.code}): ${e.message}`;
  if (e instanceof Error) return `Audit failed: ${e.message}`;
  return "Audit failed for an unknown reason.";
}

function makePolicy(deps: ServerDeps): TargetPolicy {
  return {
    resolve: cachedResolver(createDohResolver(deps.fetchImpl ?? fetch)),
    selfHostnames: deps.selfHostnames,
    devAllowLoopbackTargets: deps.devAllowLoopbackTargets,
  };
}

async function crawlFor(url: string, maxPages: number | undefined, deps: ServerDeps): Promise<CrawlResult> {
  const target = normaliseTargetUrl(url); // throws TargetError on bad input
  return crawlSite(target.toString(), {
    policy: makePolicy(deps),
    fetchImpl: deps.fetchImpl,
    maxPages: maxPages ?? LIMITS.defaultMaxPages,
  });
}

/**
 * Factory: one fresh McpServer per request (stateless). Tool descriptions are
 * written for the model: when to use, what it does, what it does not do.
 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });

  server.registerTool(
    "audit_ai_visibility",
    {
      title: "Audit AI search visibility (GEO readiness)",
      description: [
        "Audit a public website for AI search / GEO readiness by fetching and analysing a small prioritised sample of its pages (homepage, about, services or products, pricing, locations, key guides).",
        "Returns ten sections plus a page-by-page rewrite section: A executive summary, B entity clarity, C AI retrievability (are answers in clear self-contained passages), D information gain (first-party data, research, case studies actually present on the site), E trust and corroboration signals, F internal linking and architecture, G structured data found and relevant omissions, H commercial query coverage and gaps, I top 10 recommended actions ranked by commercial impact then visibility impact then ease, J 20 AI search prompts to monitor. Findings that can be acted on come with the offending text quoted verbatim and a prefilled replacement: rewritten opening paragraphs, opening sentences for question headings that do not answer, specific internal links to add with suggested anchor text, and a ready-to-paste JSON-LD block. Anything the crawl did not observe is left as a clearly marked [placeholder] rather than invented.",
        "Use it when a user asks how ready a site is for ChatGPT, Claude, Perplexity, Gemini or Google AI Overviews, wants a GEO or AI SEO audit, or wants prioritised on-site fixes.",
        "It does NOT measure real citations or rankings inside any AI assistant, does not use paid data sources, does not execute JavaScript, and never invents evidence: everything reported is observed on the fetched pages or explicitly labelled as an inferred gap. Ratings are qualitative (Strong / Moderate / Weak) with the rubric returned in the response.",
        `Parameters: url (required), maxPages (optional, default ${LIMITS.defaultMaxPages}, max ${LIMITS.hardMaxPages}). Only public http/https hosts are accepted. A full audit typically takes 5 to 25 seconds.`,
      ].join(" "),
      inputSchema: z.object({ url: urlField, maxPages: maxPagesField }),
      outputSchema: auditOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, maxPages }) => {
      try {
        const crawl = await crawlFor(url, maxPages, deps);
        if (!crawl.pages.some((p) => p.parsed)) {
          const home = crawl.pages[0];
          return errorResult(`The homepage could not be analysed: ${home?.fetch.errorDetail ?? home?.fetch.error ?? "no usable HTML"}. Nothing to audit.`);
        }
        const report = buildAudit(crawl);
        return { content: [{ type: "text", text: renderAudit(report) }], structuredContent: report as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(describeError(e));
      }
    },
  );

  server.registerTool(
    "extract_site_entities",
    {
      title: "Extract site entity map",
      description: [
        "Build a practical entity map for a public website from a small sample of its pages: the primary entity (brand or organisation), related entities grouped into people, organisation/brand, products, services, locations and topics, explicit relationships (Brand -> offers -> Service, Brand -> located in -> City, Person -> founder of -> Brand), ambiguities, missing entity support, schema.org types found and schema types worth adding.",
        "Use it when a user asks what entities a site establishes, whether the brand, people, services and locations are stated clearly enough for search engines and AI assistants, or which schema types fit the business.",
        "It does NOT query Google's Knowledge Graph, Wikidata or any external entity database, and it does not hallucinate: every entity carries a confidence level and the source it was detected from. Low-confidence items are pattern matches on visible copy that a human should verify.",
        `Parameters: url (required), maxPages (optional, default ${LIMITS.defaultMaxPages}, max ${LIMITS.hardMaxPages}). Faster and narrower than audit_ai_visibility; use the audit when you need recommendations beyond entities.`,
      ].join(" "),
      inputSchema: z.object({ url: urlField, maxPages: maxPagesField }),
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, maxPages }) => {
      try {
        const crawl = await crawlFor(url, maxPages, deps);
        if (!crawl.pages.some((p) => p.parsed)) {
          const home = crawl.pages[0];
          return errorResult(`The homepage could not be analysed: ${home?.fetch.errorDetail ?? home?.fetch.error ?? "no usable HTML"}.`);
        }
        const site = buildSiteModel(crawl);
        const map = buildEntityMap(site);
        const structured = { target: crawl.target, pagesSampled: site.pages.length, ...map };
        return { content: [{ type: "text", text: renderEntityMap(crawl.target, map) }], structuredContent: structured as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(describeError(e));
      }
    },
  );

  server.registerTool(
    "generate_geo_query_universe",
    {
      title: "Generate GEO query universe",
      description: [
        "Generate a commercially useful set of AI-search prompts to monitor for a website, grouped by intent: informational, problem-aware, commercial, recommendation, comparison, alternatives, brand, category, local and trust/validation. Each prompt includes intent, buyer stage, the ideal page type to answer it and a commercial priority (high / medium / low).",
        "The brand, services and location are detected from a small crawl of the site; pass service and/or location to override or narrow them (for example one service line, or a city the site does not mention yet).",
        "Use it when a user wants a monitoring list for ChatGPT, Claude, Perplexity, Gemini or Google AI Mode, a GEO keyword universe, or prompt ideas per funnel stage.",
        "It does NOT return search volumes, does not check which prompts the brand currently appears for, and avoids meaningless long-tail permutations in favour of prompts a real buyer would ask an assistant.",
        `Parameters: url (required), service (optional override), location (optional override), count (optional, default ${LIMITS.defaultQueryCount}, max ${LIMITS.maxQueryCount}).`,
      ].join(" "),
      inputSchema: z.object({
        url: urlField,
        service: z.string().min(2).max(120).optional().describe("Optional service or category override, e.g. 'emergency plumbing' or 'family law'. Replaces the services detected from the site."),
        location: z.string().min(2).max(80).optional().describe("Optional location override, e.g. 'Perth' or 'Gold Coast'. Replaces the location detected from the site; pass 'none' to force non-local prompts."),
        count: z.number().int().min(10).max(LIMITS.maxQueryCount).optional().describe(`Number of prompts to return. Default ${LIMITS.defaultQueryCount}, max ${LIMITS.maxQueryCount}.`),
      }),
      outputSchema: queryOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, service, location, count }) => {
      try {
        const crawl = await crawlFor(url, 5, deps);
        if (!crawl.pages.some((p) => p.parsed)) {
          const home = crawl.pages[0];
          return errorResult(`The homepage could not be analysed: ${home?.fetch.errorDetail ?? home?.fetch.error ?? "no usable HTML"}.`);
        }
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
        return { content: [{ type: "text", text: renderQueries(crawl.target, { brand: site.brand.value, category, location: loc, services }, queries) }], structuredContent: structured as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(describeError(e));
      }
    },
  );

  return server;
}
