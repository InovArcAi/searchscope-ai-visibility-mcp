/**
 * OpenAPI 3.1 document for the REST API, served at /api/v1/openapi.json. Every
 * schema is generated from the Zod objects the Worker validates with (JSON
 * Schema draft 2020-12, the dialect OpenAPI 3.1 uses), so Make, RapidAPI and
 * Postman import exactly what the server accepts.
 */

import { z } from "zod";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_URL, SERVICE_NAME, SERVICE_ORIGIN, SERVICE_VERSION } from "../config";
import { auditRequest, auditResponse, entitiesRequest, entitiesResponse, errorResponse, keyResponse, queriesRequest, queriesResponse, statusResponse } from "./schemas";

export const API_BASE_PATH = "/api/v1";
export const API_DOCS_URL = `${SERVICE_ORIGIN}/docs/api`;

function schemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ $ref: `#/components/responses/${name}` });
const retryAfter = { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", examples: [60] } } };
const errorBody = (description: string, headers?: Record<string, unknown>) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { "application/json": { schema: ref("Error") } },
});

const toolErrors = {
  "400": response("BadRequest"),
  "401": response("Unauthorized"),
  "403": response("Forbidden"),
  "413": response("PayloadTooLarge"),
  "422": response("SiteUnreadable"),
  "429": response("RateLimited"),
  "500": response("ServerError"),
  "503": response("Unavailable"),
};

const toolNote = `Crawls up to ${LIMITS.hardMaxPages} pages of the site; how long it takes depends on the site, and the crawl stops after ${LIMITS.crawlBudgetMs / 1000} seconds at most. Costs ${LIMITS.toolCallWeight} units of the per-client budget (60 a minute, shared with the MCP endpoint) and 1 of the audited site's budget (10 a minute).`;

function toolOperation(operationId: string, summary: string, description: string, requestName: string, responseName: string, example: Record<string, unknown>) {
  return {
    post: {
      operationId,
      tags: ["Audits"],
      summary,
      description: `${description} ${toolNote}`,
      requestBody: { required: true, content: { "application/json": { schema: ref(requestName), example } } },
      responses: {
        "200": { description: "The structured result and the readable report.", content: { "application/json": { schema: ref(responseName) } } },
        ...toolErrors,
      },
    },
  };
}

let cached: string | undefined;

/** The serialised document. Built once per isolate: it only changes on deploy. */
export function openApiJson(): string {
  cached ??= JSON.stringify(buildOpenApi(), null, 2);
  return cached;
}

export function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: `${SERVICE_NAME} API`,
      version: SERVICE_VERSION,
      summary: "Free REST API that audits any public website for AI search visibility.",
      description: [
        `Free, read-only REST API from ${PUBLISHER}, an SEO consultancy in Perth, Western Australia. It runs the same engine as the MCP server at ${SERVICE_ORIGIN}/mcp: it fetches a small prioritised sample of a public website and reports entity clarity, AI retrievability, trust signals, internal linking, structured data, ranked fixes and AI search prompts to monitor.`,
        "No sign-up and no key needed. An optional free API key is available for platforms whose connection screen asks for one; it gives no extra allowance. Send it as 'Authorization: Bearer <key>'.",
        "It does not measure real citations inside any AI assistant, does not run JavaScript and never invents evidence. Nothing is stored.",
      ].join("\n\n"),
      contact: { name: PUBLISHER, url: PUBLISHER_CONTACT_URL, email: "seo@searchscope.com.au" },
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: `${SERVICE_ORIGIN}${API_BASE_PATH}`, description: "Production" }],
    externalDocs: { description: "API documentation", url: API_DOCS_URL },
    // An empty requirement first: every operation works without a key.
    security: [{}, { apiKey: [] }],
    tags: [
      { name: "Audits", description: "Run an audit on a public website." },
      { name: "Account", description: "Connection checks and free API keys." },
    ],
    paths: {
      "/audit": toolOperation(
        "auditWebsite",
        "Audit a website for AI search visibility",
        "Full AI search (GEO) readiness audit: executive summary with six qualitative ratings, entity clarity, AI retrievability, information gain, trust signals, internal linking, structured data, commercial coverage, the top 10 actions, page-by-page rewrites and 20 AI search prompts to monitor.",
        "AuditRequest",
        "AuditResponse",
        { url: "https://example.com.au", maxPages: LIMITS.defaultMaxPages },
      ),
      "/entities": toolOperation(
        "extractEntities",
        "Extract a website's entity map",
        "Primary entity, people, services, products, locations and topics, relationships between them, ambiguities, missing entity support, schema types found and schema types worth adding. Every entity carries a confidence level.",
        "EntitiesRequest",
        "EntitiesResponse",
        { url: "https://example.com.au" },
      ),
      "/queries": toolOperation(
        "generateQueries",
        "Generate AI search prompts to monitor",
        "A balanced set of prompts a buyer would ask an AI assistant about the site's category, grouped by intent, each with buyer stage, the ideal page type to answer it and a commercial priority.",
        "QueriesRequest",
        "QueriesResponse",
        { url: "https://example.com.au", location: "Perth", count: LIMITS.defaultQueryCount },
      ),
      "/status": {
        get: {
          operationId: "getStatus",
          tags: ["Account"],
          summary: "Check the connection",
          description: "Cheap connection test for automation platforms: confirms the API is up and whether the API key sent (if any) is valid. Costs 1 unit of the per-client budget and crawls nothing.",
          responses: {
            "200": { description: "The API is reachable and the request was accepted.", content: { "application/json": { schema: ref("Status") } } },
            "401": response("Unauthorized"),
            "403": response("Forbidden"),
            "429": response("RateLimited"),
            "503": response("Unavailable"),
          },
        },
      },
      "/keys": {
        post: {
          operationId: "createApiKey",
          tags: ["Account"],
          summary: "Get a free API key",
          description: "Issues a free API key instantly. No sign-up, no email and nothing stored: the key is signed, not saved, so keep a copy. A key is optional and gives no extra allowance.",
          security: [{}],
          responses: {
            "200": { description: "A new API key.", content: { "application/json": { schema: ref("ApiKey") } } },
            "403": response("Forbidden"),
            "429": response("RateLimited"),
            "503": response("Unavailable"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: `Optional. Get a free key at ${API_DOCS_URL} or from POST ${API_BASE_PATH}/keys. Never put it in a URL.`,
        },
      },
      schemas: {
        AuditRequest: schemaOf(auditRequest, "input"),
        EntitiesRequest: schemaOf(entitiesRequest, "input"),
        QueriesRequest: schemaOf(queriesRequest, "input"),
        AuditResponse: schemaOf(auditResponse, "output"),
        EntitiesResponse: schemaOf(entitiesResponse, "output"),
        QueriesResponse: schemaOf(queriesResponse, "output"),
        Status: schemaOf(statusResponse, "output"),
        ApiKey: schemaOf(keyResponse, "output"),
        Error: schemaOf(errorResponse, "output"),
      },
      responses: {
        BadRequest: errorBody("The body is not valid JSON, a field is missing or invalid (invalid_json, invalid_input), or the URL is not a public website (target_rejected)."),
        Unauthorized: errorBody("An Authorization header was sent but does not hold a valid API key (invalid_api_key). Leave the header out to call without a key."),
        Forbidden: errorBody("Request came through a hostname or browser origin the API does not serve (host_not_allowed, origin_not_allowed)."),
        PayloadTooLarge: errorBody(`The request body is over ${LIMITS.maxRequestBodyBytes / 1024} KB (payload_too_large).`),
        SiteUnreadable: errorBody("The site's homepage could not be fetched or held no usable HTML (site_unreadable)."),
        RateLimited: errorBody("A rate limit is spent: the per-client budget, the per-key budget, the audited site's budget or the service-wide ceiling (rate_limited).", retryAfter),
        ServerError: errorBody("The audit failed unexpectedly (audit_failed)."),
        Unavailable: errorBody("The service, or API keys, are briefly unavailable (unavailable, keys_unavailable). Retry later, or call without a key.", retryAfter),
      },
    },
    "x-publisher": { name: PUBLISHER, url: PUBLISHER_URL },
  };
}
