/**
 * The REST API under /api/v1: the three MCP tools as plain JSON endpoints, for
 * platforms that speak HTTP rather than MCP (RapidAPI, Make, Zapier, Postman).
 *
 * It applies the same guards as /mcp, in the same order: Host allow-list,
 * Origin policy, body cap on the bytes received, then the same rate limiters
 * under the same keys (per client, global, then per audited site for a tool
 * call), failing closed if any limiter is missing or erroring.
 */

import type { z } from "zod";
import { LIMITS, SERVICE_HOSTNAMES, SERVICE_NAME, SERVICE_VERSION } from "../config";
import type { Env } from "../env";
import { checkLimits, clientIpKey, isLoopbackHost, redirectCharger, type LimitVerdict } from "../security/limits";
import { isAcceptableApiOrigin, readBodyCapped, targetKey } from "../security/request";
import { runAudit, runEntities, runQueries, type ToolDeps, type ToolOutcome } from "../tools/run";
import { apiKeyHtml } from "./docs";
import { checkApiKey, issueApiKey, keysEnabled, verifiedRapidApiUser } from "./keys";
import { API_BASE_PATH, API_DOCS_URL, openApiJson } from "./openapi";
import { auditRequest, entitiesRequest, queriesRequest, type ErrorCode } from "./schemas";

const BASE_HEADERS = {
  // No cookies or credentials exist, so any web page may call the API; browser
  // traffic pays the same rate limits as everything else (see isAcceptableOrigin).
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const RETRY = { "retry-after": "60" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...extra } });
}

function apiError(status: number, code: ErrorCode, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, extra);
}

function limitResponse(verdict: LimitVerdict): Response | undefined {
  if (verdict === "limited") return apiError(429, "rate_limited", "Rate limit exceeded. Please wait a minute and try again.", RETRY);
  if (verdict === "unavailable") return unavailable();
  return undefined;
}

const unavailable = () => apiError(503, "unavailable", "Service temporarily unavailable. Please try again shortly.", RETRY);
const tooLarge = () => apiError(413, "payload_too_large", `Request body too large (limit ${LIMITS.maxRequestBodyBytes / 1024} KB).`);
const methodNotAllowed = (allow: string) => apiError(405, "method_not_allowed", `Use ${allow} on this endpoint.`, { allow });

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    },
  });
}

type Prepared = { ok: true; target?: string; run: (deps: ToolDeps) => Promise<ToolOutcome> } | { ok: false; message: string };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`.slice(0, 200))
    .join("; ");
}

/** Validates a body against a tool's strict schema and binds it to that tool. */
function toolRoute<T extends { url: string }>(schema: z.ZodType<T>, run: (input: T, deps: ToolDeps) => Promise<ToolOutcome>): (body: unknown) => Prepared {
  return (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { ok: false, message: describeIssues(parsed.error) };
    const input = parsed.data;
    return { ok: true, target: targetKey(input.url), run: (deps) => run(input, deps) };
  };
}

const TOOL_ROUTES: Record<string, (body: unknown) => Prepared> = {
  [`${API_BASE_PATH}/audit`]: toolRoute(auditRequest, runAudit),
  [`${API_BASE_PATH}/entities`]: toolRoute(entitiesRequest, runEntities),
  [`${API_BASE_PATH}/queries`]: toolRoute(queriesRequest, runQueries),
};

const STATUS_PATH = `${API_BASE_PATH}/status`;
const KEYS_PATH = `${API_BASE_PATH}/keys`;
const OPENAPI_PATH = `${API_BASE_PATH}/openapi.json`;

function toolResponse(outcome: ToolOutcome): Response {
  if (outcome.ok) return json({ data: outcome.data, report: outcome.text });
  if (outcome.reason === "target_rejected") return apiError(400, "target_rejected", outcome.message);
  if (outcome.reason === "site_unreadable") return apiError(422, "site_unreadable", outcome.message);
  return apiError(500, "audit_failed", outcome.message);
}

async function issueKey(request: Request, env: Env): Promise<Response> {
  const secret = env.API_KEY_SIGNING_SECRET;
  if (!keysEnabled(secret)) return apiError(503, "keys_unavailable", "Free API keys are temporarily unavailable. Every endpoint works without a key.", RETRY);
  const apiKey = await issueApiKey(secret);
  // The docs page's button is a plain form post, so a browser gets a page back.
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(apiKeyHtml(apiKey), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }
  return json({
    apiKey,
    usage: "Authorization: Bearer <key>",
    note: "Optional: every endpoint also works without a key, and a key gives no extra allowance. It is not stored, so keep a copy.",
    docs: API_DOCS_URL,
  });
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  // Static, cacheable and free, like the landing page.
  if (path === OPENAPI_PATH || path === API_BASE_PATH) {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    const body =
      path === OPENAPI_PATH
        ? openApiJson()
        : JSON.stringify({ name: `${SERVICE_NAME} API`, version: SERVICE_VERSION, baseUrl: `${url.origin}${API_BASE_PATH}`, docs: API_DOCS_URL, openapi: `${url.origin}${OPENAPI_PATH}`, endpoints: ["POST /audit", "POST /entities", "POST /queries", "GET /status", "POST /keys"] }, null, 2);
    return new Response(request.method === "HEAD" ? null : body, { headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }

  const prepare = TOOL_ROUTES[path];
  if (!prepare && path !== STATUS_PATH && path !== KEYS_PATH) return apiError(404, "not_found", `No such endpoint. See ${API_DOCS_URL}.`);

  // Same Host rule as /mcp: only our own hostnames serve the API. Same Origin
  // rule too, plus Search Scope's own browser add-on (ALLOWED_EXTENSION_ORIGINS).
  if (!isLoopbackHost(url.hostname) && !SERVICE_HOSTNAMES.includes(url.hostname)) return apiError(403, "host_not_allowed", "Host not allowed.");
  if (!isAcceptableApiOrigin(request.headers.get("origin"))) return apiError(403, "origin_not_allowed", "Origin not allowed.");
  if (request.method === "OPTIONS") return preflight();
  const method = path === STATUS_PATH ? "GET" : "POST";
  if (request.method !== method) return methodNotAllowed(method);

  const len = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > LIMITS.maxRequestBodyBytes) return tooLarge();

  // Who pays: a verified RapidAPI subscriber (all RapidAPI traffic shares its
  // proxy's IPs), otherwise the client IP, under the same key /mcp uses.
  const { MCP_RATE_LIMIT_PER_IP: perIp, MCP_RATE_LIMIT_GLOBAL: global, MCP_RATE_LIMIT_PER_TARGET: perTarget } = env;
  const rapidUser = await verifiedRapidApiUser(request, env.RAPIDAPI_PROXY_SECRET);
  const client = rapidUser ? `rapidapi:${rapidUser}` : clientIpKey(request, url.hostname);
  if (!client || !perIp || !global || !perTarget) return unavailable();
  const door = limitResponse(await checkLimits([() => perIp.limit({ key: client }), () => global.limit({ key: "mcp" })]));
  if (door) return door;

  // The optional key, checked after the door charge so a stream of bad keys is metered too.
  const key = await checkApiKey(request, env.API_KEY_SIGNING_SECRET);
  if (key.kind === "invalid") return apiError(401, "invalid_api_key", key.message, { "www-authenticate": 'Bearer realm="api"' });
  if (key.kind === "unavailable") return apiError(503, "keys_unavailable", "API keys are temporarily unavailable. Call without the Authorization header: a key is optional.", RETRY);
  // A key has its own budget on the per-client namespace, on top of the client's.
  const keyBudget = key.kind === "valid" ? `key:${key.id}` : undefined;
  if (keyBudget) {
    const spent = limitResponse(await checkLimits([() => perIp.limit({ key: keyBudget })]));
    if (spent) return spent;
  }

  if (path === STATUS_PATH) {
    return json({ status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION, auth: rapidUser ? "rapidapi" : keyBudget ? "api_key" : "none", docs: API_DOCS_URL });
  }
  if (path === KEYS_PATH) return issueKey(request, env);
  if (!prepare) return apiError(404, "not_found", `No such endpoint. See ${API_DOCS_URL}.`);

  const bytes = request.body ? await readBodyCapped(request.body, LIMITS.maxRequestBodyBytes) : new Uint8Array();
  if (!bytes) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return apiError(400, "invalid_json", 'The request body must be JSON, for example {"url": "https://example.com.au"}.');
  }
  const prepared = prepare(body);
  if (!prepared.ok) return apiError(400, "invalid_input", prepared.message);

  // A tool call crawls up to 15 pages: it weighs LIMITS.toolCallWeight in the
  // client's budget (and the key's), and is charged to the audited site.
  const extra = LIMITS.toolCallWeight - 1;
  const target = prepared.target;
  const checks = [() => perIp.limit({ key: client, delta: extra })];
  if (keyBudget) checks.push(() => perIp.limit({ key: keyBudget, delta: extra }));
  if (target) checks.push(() => perTarget.limit({ key: target }));
  const charged = limitResponse(await checkLimits(checks));
  if (charged) return charged;

  const deps: ToolDeps = {
    selfHostnames: [url.hostname],
    devAllowLoopbackTargets: env.DEV_ALLOW_LOOPBACK_TARGETS === "1" && isLoopbackHost(url.hostname),
    chargeRedirectTarget: redirectCharger(perTarget),
  };
  return toolResponse(await prepared.run(deps));
}
