import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { LIMITS, PUBLISHER_URL, SERVER_INSTRUCTIONS, SERVICE_DESCRIPTION, SERVICE_NAME, SERVICE_ORIGIN, SERVICE_TITLE, SERVICE_VERSION } from "../config";
import {
  auditInputSchema,
  auditOutputSchema,
  entitiesInputSchema,
  entityOutputSchema,
  queriesInputSchema,
  queryOutputSchema,
  runAudit,
  runEntities,
  runQueries,
  type ToolDeps,
  type ToolOutcome,
} from "../tools/run";

/** Same shape as the shared tool dependencies (src/tools/run.ts). */
export type ServerDeps = ToolDeps;

function toResult(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) return { isError: true, content: [{ type: "text", text: outcome.message }] };
  return { content: [{ type: "text", text: outcome.text }], structuredContent: outcome.data };
}

/**
 * Factory: one fresh McpServer per request (stateless). Tool descriptions are
 * written for the model: when to use, what it does, what it does not do.
 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      title: SERVICE_TITLE,
      version: SERVICE_VERSION,
      description: SERVICE_DESCRIPTION,
      websiteUrl: PUBLISHER_URL,
      icons: [
        { src: `${SERVICE_ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
        { src: `${SERVICE_ORIGIN}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    },
    // Every tool takes at most four scalar fields; a payload with hundreds of
    // nested elements is refused before schema validation spends time on it.
    { instructions: SERVER_INSTRUCTIONS, maxToolInputElements: LIMITS.maxToolInputElements },
  );

  server.registerTool(
    "audit_ai_visibility",
    {
      title: "Audit AI search visibility (GEO readiness)",
      description: [
        "Audit a public website for AI search / GEO readiness by fetching and analysing a small prioritised sample of its pages (homepage, about, services or products, pricing, locations, key guides).",
        "Returns ten sections plus a page-by-page rewrite section: A executive summary, B entity clarity, C AI retrievability (are answers in clear self-contained passages), D information gain (first-party data, research, case studies actually present on the site), E trust and corroboration signals, F internal linking and architecture, G structured data found and relevant omissions, H commercial query coverage and gaps, I top 10 recommended actions ranked by commercial impact then visibility impact then ease, J 20 AI search prompts to monitor. Findings that can be acted on come with the offending text quoted from the page and a prefilled replacement: rewritten opening paragraphs, opening sentences for question headings that do not answer, specific internal links to add with suggested anchor text, and a ready-to-paste JSON-LD block. Anything the crawl did not observe is left as a clearly marked [placeholder] rather than invented.",
        "Use it when a user asks how ready a site is for ChatGPT, Claude, Perplexity, Gemini or Google AI Overviews, wants a GEO or AI SEO audit, or wants prioritised on-site fixes.",
        "It does NOT measure real citations or rankings inside any AI assistant, does not use paid data sources, does not execute JavaScript, and never invents evidence: everything reported is observed on the fetched pages or explicitly labelled as an inferred gap. Ratings are qualitative (Strong / Moderate / Weak) with the rubric returned in the response.",
        `Parameters: url (required), maxPages (optional, default ${LIMITS.defaultMaxPages}, max ${LIMITS.hardMaxPages}). Only public http/https hosts are accepted. A full audit typically takes 5 to 25 seconds.`,
      ].join(" "),
      inputSchema: auditInputSchema,
      outputSchema: auditOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, maxPages }) => toResult(await runAudit({ url, maxPages }, deps)),
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
      inputSchema: entitiesInputSchema,
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, maxPages }) => toResult(await runEntities({ url, maxPages }, deps)),
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
      inputSchema: queriesInputSchema,
      outputSchema: queryOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, service, location, count }) => toResult(await runQueries({ url, service, location, count }, deps)),
  );

  return server;
}
