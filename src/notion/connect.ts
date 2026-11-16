/**
 * "Save to Notion": the public Notion connection (OAuth 2.0), with nothing
 * stored on our side.
 *
 * 1. GET  /notion           a page with one field, the website to audit.
 * 2. POST /notion/start     signs the URL into the OAuth `state`, sets a
 *                           10-minute cookie holding a random nonce, and
 *                           sends the person to Notion's consent screen.
 * 3. GET  /notion/callback  checks the state signature, its expiry and the
 *                           cookie, exchanges the one-time code for an access
 *                           token, runs the audit, writes it as a new Notion
 *                           page under the page the person shared, and links
 *                           to it. The token lives only in this request: it
 *                           is never stored, logged or returned.
 *
 * The cookie ties the callback to the browser that started the flow, so a
 * third party cannot send someone a callback link that drops an audit of a
 * site they chose into that person's Notion. The state is an HMAC-SHA256 keyed
 * with NOTION_CLIENT_SECRET over a fixed context string plus the payload, so no
 * extra secret is needed.
 *
 * The callback runs a full audit, so it pays exactly what a REST audit pays:
 * Host allow-list, the per-client and global limiters, the tool-call weight
 * and the per-site limiter, failing closed.
 */

import { page } from "../api/docs";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, SERVICE_HOSTNAMES, SERVICE_NAME, SERVICE_ORIGIN } from "../config";
import type { Env } from "../env";
import { checkLimits, clientIpKey, isLoopbackHost, redirectCharger, type LimitVerdict } from "../security/limits";
import { readBodyCapped, targetKey } from "../security/request";
import { runAudit, type ToolDeps } from "../tools/run";
import { assertPublicHostSyntax, normaliseTargetUrl } from "../security/url";
import { PRIVACY_PATH } from "../legal/pages";

export const NOTION_PATH = "/notion";
export const NOTION_START_PATH = "/notion/start";
export const NOTION_CALLBACK_PATH = "/notion/callback";

const NOTION_API = "https://api.notion.com/v1";
/** Current at the time of writing (developers.notion.com, November 2026). */
export const NOTION_VERSION = "2026-03-11";
const COOKIE = "__Host-ss_notion";
const STATE_TTL_SECONDS = 600;
const STATE_CONTEXT = "searchscope-notion-state-v1:";
const MAX_FORM_BYTES = 4_096;
/** Longest wait honoured on a Notion 429 before giving up. */
const MAX_RETRY_WAIT_MS = 10_000;

const encoder = new TextEncoder();

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // The callback URL carries the one-time code, so nothing passes it on.
  "referrer-policy": "no-referrer",
};
/** The form page only: same-origin, so its post carries a real Origin header (see the /docs/api note in index.ts). */
const FORM_HEADERS = { "referrer-policy": "same-origin" };

export function notionConfigured(env: Env): env is Env & { NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string } {
  return Boolean(env.NOTION_CLIENT_ID?.trim() && env.NOTION_CLIENT_SECRET && env.NOTION_CLIENT_SECRET.length >= 16);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function htmlPage(status: number, title: string, body: string, extraHeaders: Record<string, string> = {}, robots = "noindex, nofollow"): Response {
  const html = page({ title: `${title}: ${SERVICE_NAME}`, description: `Save a free ${SERVICE_NAME} report from ${PUBLISHER} straight into a Notion page.`, robots, badge: "Notion", body });
  return new Response(html, { status, headers: { ...HTML_HEADERS, ...extraHeaders } });
}

const clearCookie = { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };

function problem(status: number, heading: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  return htmlPage(
    status,
    heading,
    `<h1>${escapeHtml(heading)}</h1>
<p class="lede">${escapeHtml(message)}</p>
<p><a class="btn" href="${NOTION_PATH}">Start again</a></p>`,
    extraHeaders,
  );
}

function limitProblem(verdict: LimitVerdict): Response | undefined {
  if (verdict === "limited") return problem(429, "Too many requests", "Too many audits from your connection in the last minute. Wait a minute and try again.", { "retry-after": "60" });
  if (verdict === "unavailable") return problem(503, "Temporarily unavailable", "The service is temporarily unavailable. Please try again shortly.", { "retry-after": "60" });
  return undefined;
}

// ---------------------------------------------------------------- state

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function mac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(STATE_CONTEXT + payload)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

interface StatePayload {
  /** Website to audit. */
  u: string;
  /** Nonce, also held in the cookie. */
  n: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

export async function signState(secret: string, payload: StatePayload): Promise<string> {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hex(await mac(secret, body))}`;
}

/** The payload when the signature checks out and it has not expired, otherwise null. */
export async function verifyState(secret: string, state: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<StatePayload | null> {
  const m = /^([A-Za-z0-9_-]{1,3000})\.([0-9a-f]{64})$/.exec(state);
  if (!m) return null;
  const expected = await mac(secret, m[1]!);
  const sent = Uint8Array.from(m[2]!.match(/../g)!, (h) => parseInt(h, 16));
  if (!sameBytes(expected, sent)) return null;
  try {
    const p = JSON.parse(fromBase64url(m[1]!)) as StatePayload;
    if (typeof p.u !== "string" || typeof p.n !== "string" || typeof p.e !== "number") return null;
    return p.e >= nowSeconds ? p : null;
  } catch {
    return null;
  }
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

// ---------------------------------------------------------------- markdown

/**
 * The report quotes text from the audited site, and some site values (brand
 * names, URLs, schema snippets) reach it unescaped for Markdown. Notion-flavored
 * Markdown turns some tags into real workspace objects (<page> creates a
 * subpage, <mention> pings a person), `$...$` into maths and `[label](url)` or
 * `![](url)` into links and images, so outside fenced code every one of those
 * characters is escaped and site text stays plain text. Fences follow
 * CommonMark: up to 3 spaces of indent, and a fence only closes on the same
 * character repeated at least as many times as it opened with.
 */
export function toNotionMarkdown(report: string): string {
  let open: { char: string; length: number } | null = null;
  return report
    .split("\n")
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && line.trim() === fence[1]) open = null;
        return line;
      }
      if (fence && !(fence[1]![0] === "`" && line.slice(fence[0].length).includes("`"))) {
        open = { char: fence[1]![0]!, length: fence[1]!.length };
        return line;
      }
      return line.replace(/[\\<$[\]!]/g, (c) => `\\${c}`);
    })
    .join("\n");
}

// ---------------------------------------------------------------- Notion API

export interface NotionDeps {
  /** Outbound fetch for Notion API calls (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Tool dependencies for the audit itself. */
  tool?: Partial<ToolDeps>;
  /** Wait function for Retry-After (tests). */
  sleep?: (ms: number) => Promise<void>;
}

class NotionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function notionCall(deps: NotionDeps, path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    // Workers only accept "follow" or "manual" (redirect: "error" throws before
    // the request is sent), so redirects are refused by hand: the token must
    // never be re-sent to another host.
    const res = await doFetch(`${NOTION_API}${path}`, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new NotionError(res.status, "Notion answered with a redirect.");
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") * 1000 || 1000, MAX_RETRY_WAIT_MS);
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      // Only Notion's own short error text is kept: never the request, which carries the token or code.
      const msg = (body as { message?: unknown; error_description?: unknown; error?: unknown } | undefined) ?? {};
      const detail = [msg.message, msg.error_description, msg.error].find((v) => typeof v === "string") as string | undefined;
      throw new NotionError(res.status, (detail ?? `HTTP ${res.status}`).slice(0, 300));
    }
    return body;
  }
}

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" };
}

interface TokenGrant {
  access_token: string;
  duplicated_template_id?: string | null;
}

async function exchangeCode(env: { NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string }, code: string, deps: NotionDeps): Promise<TokenGrant> {
  // Trimmed: a value pasted into the dashboard can carry a stray space or newline.
  const basic = btoa(`${env.NOTION_CLIENT_ID.trim()}:${env.NOTION_CLIENT_SECRET.trim()}`);
  const body = await notionCall(deps, "/oauth/token", {
    method: "POST",
    // Notion-Version is required on the token endpoint too (API reference, create-a-token).
    headers: { authorization: `Basic ${basic}`, "notion-version": NOTION_VERSION, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: `${SERVICE_ORIGIN}${NOTION_CALLBACK_PATH}` }),
  });
  const grant = body as Partial<TokenGrant> | undefined;
  if (!grant || typeof grant.access_token !== "string" || grant.access_token === "") throw new NotionError(502, "Notion did not return an access token.");
  return { access_token: grant.access_token, duplicated_template_id: grant.duplicated_template_id ?? null };
}

/** The page the report goes under: the template copy if the person chose it, else the first page they shared. */
async function parentPageId(token: string, grant: TokenGrant, deps: NotionDeps): Promise<string | null> {
  if (grant.duplicated_template_id) return grant.duplicated_template_id;
  const body = (await notionCall(deps, "/search", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({ filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 10 }),
  })) as { results?: Array<{ object?: string; id?: string; in_trash?: boolean; archived?: boolean }> } | undefined;
  const hit = body?.results?.find((r) => r.object === "page" && typeof r.id === "string" && !r.in_trash && !r.archived);
  return hit?.id ?? null;
}

async function createReportPage(token: string, parentId: string, title: string, markdown: string, deps: NotionDeps): Promise<string | undefined> {
  const body = (await notionCall(deps, "/pages", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: { title: { title: [{ type: "text", text: { content: title.slice(0, 200) } }] } },
      markdown,
      markdown_version: "v2",
    }),
  })) as { url?: unknown } | undefined;
  return typeof body?.url === "string" && body.url.startsWith("https://") ? body.url : undefined;
}

// ---------------------------------------------------------------- routes

function formHtml(): string {
  return `<h1>Save an AI visibility audit to Notion</h1>
<p class="lede">Enter a website. You will be asked to connect Notion and pick a page, then the audit runs and is saved as a new page inside the one you picked. It takes about 30 seconds.</p>
<form method="post" action="${NOTION_START_PATH}">
<p><label for="url"><strong>Website to audit</strong></label><br>
<input id="url" name="url" type="text" inputmode="url" required minlength="4" maxlength="2048" placeholder="example.com.au" style="width:100%;max-width:28rem;padding:.6rem;font:inherit"></p>
<p><button class="btn" type="submit">Connect Notion and run the audit</button></p>
</form>
<h2>What happens</h2>
<ol>
<li>Notion asks you to allow the connection and choose which page it may add to. It can only see the pages you choose.</li>
<li>The service reads a small sample of the website's public pages (at most ${LIMITS.hardMaxPages}) and builds the report.</li>
<li>The report is saved as a new page under the page you chose, and you get a link to it.</li>
</ol>
<p class="note">The Notion access is used for that one save and then discarded: it is never stored, so nothing is read or changed in your Notion afterwards. To run another audit, come back here. To remove the connection, open Notion's Settings, then Connections. Details in the <a href="${PRIVACY_PATH}">privacy policy</a>. Questions: <a href="${PUBLISHER_CONTACT_URL}">contact ${PUBLISHER}</a>.</p>`;
}

function isOwnHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || SERVICE_HOSTNAMES.includes(hostname);
}

/** A browser form post from our own pages only (or no Origin at all). Loopback origins count only when the request itself is local (wrangler dev). */
function isOwnOrigin(origin: string | null, requestHost: string): boolean {
  if (origin === null) return true;
  try {
    const o = new URL(origin);
    if (isLoopbackHost(o.hostname)) return isLoopbackHost(requestHost) && o.origin === origin;
    return o.protocol === "https:" && SERVICE_HOSTNAMES.includes(o.hostname) && o.origin === origin;
  } catch {
    return false;
  }
}

/** Cheap syntax check before sending anyone to Notion; the audit repeats the full check, DNS included. */
function looksPublic(site: string): boolean {
  if (!site || site.length > 2048) return false;
  try {
    assertPublicHostSyntax(normaliseTargetUrl(site));
    return true;
  } catch {
    return false;
  }
}

async function start(request: Request, env: Env & { NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string }, url: URL): Promise<Response> {
  if (!isOwnOrigin(request.headers.get("origin"), url.hostname)) return problem(403, "Not allowed", "This form can only be sent from this site.");
  const { MCP_RATE_LIMIT_PER_IP: perIp, MCP_RATE_LIMIT_GLOBAL: global } = env;
  const client = clientIpKey(request, url.hostname);
  if (!client || !perIp || !global) return limitProblem("unavailable")!;
  const door = limitProblem(await checkLimits([() => perIp.limit({ key: client }), () => global.limit({ key: "mcp" })]));
  if (door) return door;

  const bytes = request.body ? await readBodyCapped(request.body, MAX_FORM_BYTES) : new Uint8Array();
  if (!bytes) return problem(413, "Too long", "That request was too large.");
  const site = (new URLSearchParams(new TextDecoder().decode(bytes)).get("url") ?? "").trim();
  if (!looksPublic(site)) {
    return problem(400, "Check the website address", "Enter a public website address, such as example.com.au. Private, internal and IP addresses cannot be audited.");
  }

  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const state = await signState(env.NOTION_CLIENT_SECRET, { u: site, n: nonce, e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS });
  const authorize = new URL(`${NOTION_API}/oauth/authorize`);
  authorize.searchParams.set("client_id", env.NOTION_CLIENT_ID.trim());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("owner", "user");
  authorize.searchParams.set("redirect_uri", `${SERVICE_ORIGIN}${NOTION_CALLBACK_PATH}`);
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 303,
    headers: {
      location: authorize.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${COOKIE}=${nonce}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function callback(request: Request, env: Env & { NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string }, url: URL, deps: NotionDeps): Promise<Response> {
  const params = url.searchParams;
  if (params.get("error")) {
    const cancelled = params.get("error") === "access_denied";
    return problem(cancelled ? 200 : 400, cancelled ? "Notion was not connected" : "Notion sign-in failed", cancelled ? "You cancelled in Notion, so nothing was audited or saved." : "Notion did not complete the sign-in, so nothing was audited or saved.", clearCookie);
  }

  const state = await verifyState(env.NOTION_CLIENT_SECRET, params.get("state") ?? "");
  const nonce = cookieValue(request);
  if (!state || !nonce || !sameBytes(encoder.encode(nonce), encoder.encode(state.n))) {
    return problem(400, "This link has expired", "The sign-in link is out of date or was opened in a different browser. Start again from this browser.", clearCookie);
  }
  const code = params.get("code") ?? "";
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(code)) return problem(400, "Notion sign-in failed", "Notion did not send a valid sign-in code. Start again.", clearCookie);

  // Same charges as a REST audit (src/api/rest.ts).
  const { MCP_RATE_LIMIT_PER_IP: perIp, MCP_RATE_LIMIT_GLOBAL: global, MCP_RATE_LIMIT_PER_TARGET: perTarget } = env;
  const client = clientIpKey(request, url.hostname);
  if (!client || !perIp || !global || !perTarget) return limitProblem("unavailable")!;
  const door = limitProblem(await checkLimits([() => perIp.limit({ key: client }), () => global.limit({ key: "mcp" })]));
  if (door) return door;
  const target = targetKey(state.u);
  const checks = [() => perIp.limit({ key: client, delta: LIMITS.toolCallWeight - 1 })];
  if (target) checks.push(() => perTarget.limit({ key: target }));
  const charged = limitProblem(await checkLimits(checks));
  if (charged) return charged;

  let grant: TokenGrant;
  try {
    grant = await exchangeCode(env, code, deps);
  } catch (e) {
    // Notion's own short error text only (never the code, secret or token), so a failed exchange can be diagnosed from the logs.
    console.warn("notion token exchange failed", e instanceof NotionError ? `${e.status} ${e.message}` : "network error");
    return problem(502, "Notion sign-in failed", "Notion did not accept the sign-in. Start again, and choose at least one page to share.", clearCookie);
  }

  const outcome = await runAudit(
    { url: state.u },
    {
      selfHostnames: [url.hostname],
      devAllowLoopbackTargets: env.DEV_ALLOW_LOOPBACK_TARGETS === "1" && isLoopbackHost(url.hostname),
      chargeRedirectTarget: redirectCharger(perTarget),
      ...deps.tool,
    },
  );
  if (!outcome.ok) return problem(422, "The audit could not run", outcome.message, clearCookie);

  try {
    const parent = await parentPageId(grant.access_token, grant, deps);
    if (!parent) {
      return problem(409, "No Notion page was shared", "The connection could not see any page to save into. Start again and, in Notion, choose at least one page for it to use.", clearCookie);
    }
    const host = target ?? state.u;
    const date = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Perth" });
    const link = await createReportPage(grant.access_token, parent, `AI visibility audit: ${host} (${date})`, toNotionMarkdown(outcome.text), deps);
    const open = link ? `<p><a class="btn" href="${escapeHtml(link)}">Open the report in Notion</a></p>` : `<p class="lede">Open the page you shared in Notion to find it.</p>`;
    return htmlPage(
      200,
      "Saved to Notion",
      `<h1>Saved to Notion</h1>
<p class="lede">The AI visibility audit of <strong>${escapeHtml(host)}</strong> is now a page in your Notion workspace.</p>
${open}
<p class="note">The Notion access used for this save has been discarded. <a href="${NOTION_PATH}">Audit another website</a>.</p>`,
      clearCookie,
    );
  } catch (e) {
    const status = e instanceof NotionError ? e.status : 0;
    console.warn("notion save failed", e instanceof NotionError ? `${e.status} ${e.message}` : "network error");
    const why = status === 403 || status === 404 ? "Notion did not allow the connection to add a page there. Start again and choose a page you can edit." : "Notion did not accept the report. Please try again in a minute.";
    return problem(502, "Could not save to Notion", why, clearCookie);
  }
}

export async function handleNotion(request: Request, env: Env, url: URL, deps: NotionDeps = {}): Promise<Response> {
  if (!isOwnHost(url.hostname)) return new Response("Host not allowed.", { status: 403, headers: { "x-content-type-options": "nosniff" } });
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path !== NOTION_PATH && path !== NOTION_START_PATH && path !== NOTION_CALLBACK_PATH) {
    return new Response("Not Found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  }
  // The flow only completes on the canonical host: the cookie is per host and Notion returns to SERVICE_ORIGIN.
  const canonical = new URL(SERVICE_ORIGIN);
  if (!isLoopbackHost(url.hostname) && url.host !== canonical.host) {
    if (path === NOTION_PATH && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(null, { status: 308, headers: { location: `${SERVICE_ORIGIN}${NOTION_PATH}`, "cache-control": "no-store" } });
    }
    return new Response("Use https://mcp.searchscope.com.au/notion.", { status: 403, headers: { "x-content-type-options": "nosniff" } });
  }
  const want = path === NOTION_START_PATH ? "POST" : "GET";
  // HEAD only on the form page: on the callback it would run the whole flow.
  if (request.method !== want && !(path === NOTION_PATH && request.method === "HEAD")) {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: want, "x-content-type-options": "nosniff" } });
  }
  if (!notionConfigured(env)) {
    return problem(503, "Notion saving is not available yet", "Saving reports to Notion is not switched on yet. Every audit is still free at the REST API and the MCP server.");
  }
  if (path === NOTION_PATH) return htmlPage(200, "Save to Notion", formHtml(), FORM_HEADERS, "index, follow");
  if (path === NOTION_START_PATH) return start(request, env, url);
  return callback(request, env, url, deps);
}
