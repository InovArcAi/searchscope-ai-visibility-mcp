import { createMcpHandler } from "agents/mcp/server";
import { decodeBase64, FAVICON_SVG, ICON_512_PNG_BASE64, LOGO_PNG_BASE64 } from "./brand/assets";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_LOCATION, PUBLISHER_URL, SERVICE_DESCRIPTION, SERVICE_HOSTNAMES, SERVICE_NAME, SERVICE_ORIGIN, SERVICE_TITLE, SERVICE_VERSION } from "./config";
import { createServer } from "./mcp/server";
import { isAcceptableOrigin, readBodyCapped, targetKey, toolCallsIn } from "./security/request";

interface Env {
  /** Development only (wrangler dev --var DEV_ALLOW_LOOPBACK_TARGETS:1). Inert unless the request host is loopback. */
  DEV_ALLOW_LOOPBACK_TARGETS?: string;
  /** Per-client limit on /mcp requests (see wrangler.jsonc `ratelimits`). */
  MCP_RATE_LIMIT_PER_IP?: RateLimit;
  /** Ceiling on all /mcp traffic, so a crawler or loop cannot exhaust the account's Workers quota. */
  MCP_RATE_LIMIT_GLOBAL?: RateLimit;
  /** Per-client limit on tools/call, the only requests that crawl a site. */
  MCP_RATE_LIMIT_TOOL_CALLS_PER_IP?: RateLimit;
  /** Per audited hostname, so the Worker cannot be used to hammer one website from many clients. */
  MCP_RATE_LIMIT_PER_TARGET?: RateLimit;
}

function rateLimited(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded. Please wait a minute and try again." }, id: null },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function unavailable(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Service temporarily unavailable. Please try again shortly." }, id: null },
    { status: 503, headers: { "retry-after": "60" } },
  );
}

/** True when every limiter allowed the request; otherwise the response to send. A limiter that errors fails closed. */
async function withinLimits(checks: Array<() => Promise<RateLimitOutcome>>): Promise<true | Response> {
  try {
    const outcomes = await Promise.all(checks.map((check) => check()));
    return outcomes.every((o) => o.success) ? true : rateLimited();
  } catch {
    return unavailable();
  }
}

const bodyTooLarge = (): Response => rpcError(413, -32600, "Request body too large.");

const TOOLS = [
  { name: "audit_ai_visibility", summary: "Full AI search / GEO readiness audit of a public website: entity clarity, retrievability, information gain, trust, architecture, structured data, commercial coverage, top 10 actions and 20 prompts to monitor." },
  { name: "extract_site_entities", summary: "Entity map of a public website: primary entity, people, services, products, locations, relationships, ambiguities and schema suggestions." },
  { name: "generate_geo_query_universe", summary: "Balanced set of AI-search prompts to monitor for a site, grouped by intent with buyer stage, ideal page type and priority." },
] as const;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

let mcpHandler: ReturnType<typeof createMcpHandler> | undefined;
let devLoopback = false;
/** The per-site limiter, for sites reached by a cross-site homepage redirect. Bindings are the same object for every request in an isolate. */
let perTargetLimiter: RateLimit | undefined;

function getHandler(): ReturnType<typeof createMcpHandler> {
  mcpHandler ??= createMcpHandler(
    (ctx) => {
      const reqUrl = ctx.requestInfo ? new URL(ctx.requestInfo.url) : undefined;
      const limiter = perTargetLimiter;
      return createServer({
        selfHostnames: reqUrl ? [reqUrl.hostname] : undefined,
        devAllowLoopbackTargets: devLoopback && Boolean(reqUrl && isLoopbackHost(reqUrl.hostname)),
        chargeRedirectTarget: async (hostname) => {
          const key = targetKey(hostname);
          if (!limiter || !key) return false;
          try {
            return (await limiter.limit({ key })).success;
          } catch {
            return false; // fail closed, as at the front door
          }
        },
      });
    },
    {
      route: "/mcp",
      // The SDK's default Origin allow-list only covers localhost and the
      // endpoint's own workers.dev hostname, which would reject browser-based
      // MCP clients and every browser on the custom domain. Origin and Host are
      // validated in the Worker before this handler runs (see
      // isAcceptableOrigin and SERVICE_HOSTNAMES), which is the condition the
      // SDK documents for passing "*" here.
      allowedOriginHostnames: "*",
      // Second layer only: the Worker already enforces the limit on the bytes
      // received, and the agents wrapper does not pass this option to its
      // legacy lane.
      maxRequestBodySize: LIMITS.maxRequestBodyBytes,
    },
  );
  return mcpHandler;
}

/**
 * MCP Server Card (SEP-2127, io.modelcontextprotocol/server-card): static,
 * pre-connection metadata served at `<mcp-url>/server-card` and referenced from
 * the domain AI Catalog. `name` matches the official MCP registry entry.
 */
const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "au.com.searchscope/ai-visibility-auditor",
  version: SERVICE_VERSION,
  title: SERVICE_TITLE,
  // Server Card descriptions are capped at 100 characters; same wording as server.json.
  description: "Free AI search visibility audit for any website, by Search Scope, an SEO consultancy in Perth.",
  websiteUrl: PUBLISHER_URL,
  icons: [
    { src: `${SERVICE_ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
    { src: `${SERVICE_ORIGIN}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
  ],
  repository: { url: "https://github.com/InovArcAi/searchscope-ai-visibility-mcp", source: "github" },
  remotes: [{ type: "streamable-http", url: `${SERVICE_ORIGIN}/mcp` }],
};

const AI_CATALOG = {
  specVersion: "1.0",
  entries: [
    {
      identifier: "urn:air:searchscope.com.au:mcp:ai-visibility-auditor",
      type: "application/mcp-server-card+json",
      url: `${SERVICE_ORIGIN}/mcp/server-card`,
    },
  ],
};

const DISCOVERY_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
  "x-content-type-options": "nosniff",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "public, max-age=300",
};

function landingHtml(origin: string): string {
  const tools = TOOLS.map(
    (t) => `<li><h3>${t.name}</h3><p>${t.summary}</p></li>`,
  ).join("");
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVICE_NAME} by ${PUBLISHER}</title>
<meta name="description" content="Free MCP server from ${PUBLISHER}. Audit any public website for AI search visibility, entity clarity, retrieval readiness, information gain and GEO opportunities from inside Claude or any MCP client.">
<meta name="robots" content="index, follow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap">
<style>
:root{--navy:#293057;--navy-deep:#1d2342;--teal:#2BD4C2;--teal-ink:#0C7268;--muted:#666C9E;--line:#E5E7EB;--paper:#F8F8FB;--ink:#1d2342;--card:#FFFFFF}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "Outfit",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--teal-ink);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--navy)}
.wrap{max-width:820px;margin:0 auto;padding:0 20px}
header{background:var(--navy);color:#fff;padding-block:28px}
header img{height:34px;width:auto;display:block}
header .wrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header .badge{margin-left:auto;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);border:1px solid rgba(43,212,194,.45);border-radius:999px;padding:5px 12px;white-space:nowrap}
h1{font-size:clamp(1.6rem,4.2vw,2.3rem);line-height:1.2;margin:36px 0 10px;color:var(--navy)}
.lede{font-size:1.08rem;color:#444a70;margin:0 0 28px}
h2{font-size:1.15rem;margin:34px 0 12px;color:var(--navy)}
h3{font-size:.97rem;margin:0 0 6px;color:var(--navy);font-family:ui-monospace,Menlo,Consolas,monospace}
.endpoint{background:var(--navy-deep);color:#fff;border-radius:12px;padding:18px 20px;margin:0 0 6px}
.endpoint span{display:block;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:var(--teal);margin-bottom:8px}
.endpoint code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:clamp(.82rem,2.6vw,1rem);word-break:break-all;color:#fff}
.note{font-size:.88rem;color:var(--muted);margin:0 0 24px}
ul.tools{list-style:none;padding:0;margin:0;display:grid;gap:12px}
ul.tools li{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--teal);border-radius:10px;padding:14px 16px}
ul.tools p{margin:0;font-size:.93rem;color:#4a5070}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin:30px 0}
.cta p{margin:0 0 14px}
.btn{display:inline-block;background:var(--navy);color:#fff;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:8px}
.btn:hover{background:var(--navy-deep);color:#fff}
.btn.ghost{background:transparent;color:var(--navy);border:1px solid var(--navy);margin-left:8px}
.btn.ghost:hover{background:var(--navy);color:#fff}
footer{border-top:1px solid var(--line);margin-top:40px;padding-block:26px 40px;font-size:.88rem;color:var(--muted)}
footer a{color:var(--muted)}
@media (max-width:430px){.btn.ghost{margin:10px 0 0;display:block;text-align:center}}
@media (prefers-color-scheme:dark){
:root{--paper:#14172b;--ink:#e8e9f3;--card:#1c2038;--line:#2b3052;--muted:#9aa0c8}
h1,h2,h3{color:#fff}.lede{color:#b9bede}ul.tools p{color:#b9bede}
a{color:var(--teal)}a:hover{color:#fff}
.btn{background:var(--teal);color:#10233f}.btn:hover{background:#4fe0d1;color:#10233f}
.btn.ghost{color:#fff;border-color:#4b5280}
}
</style></head>
<body>
<header><div class="wrap">
<a href="${PUBLISHER_URL}"><img src="/logo.png" alt="${PUBLISHER}" width="330" height="51"></a>
<span class="badge">MCP Server</span>
</div></header>
<main class="wrap">
<h1>${SERVICE_NAME}</h1>
<p class="lede">Audit any public website for AI search visibility, entity clarity, retrieval readiness, information gain and GEO opportunities, from inside Claude or any MCP-compatible assistant. Free to use, no sign-up.</p>

<div class="endpoint"><span>MCP endpoint</span><code>${origin}/mcp</code></div>
<p class="note">Streamable HTTP. No authentication. Add it as a custom connector in Claude, or in any MCP client, and ask it to audit a site.</p>

<h2>What it does</h2>
<ul class="tools">${tools}</ul>

<h2>What it does not do</h2>
<p class="lede" style="font-size:1rem">It reads the site itself and reports what is there. It does not measure real citations inside ChatGPT, Claude, Gemini or Google AI Overviews, it does not run JavaScript, and it never invents evidence. Findings are either observed on the pages it fetched or clearly labelled as an inferred gap. Ratings are qualitative, Strong, Moderate or Weak, with the rubric returned alongside the report. There is no invented single score.</p>

<div class="cta">
<p><strong>The audit tells you what to change. ${PUBLISHER} changes it.</strong> We are an SEO consultancy in ${PUBLISHER_LOCATION} working on AI search visibility, Google Business Profile reinstatement and technical SEO. If you want these fixes implemented, or ongoing tracking of whether AI assistants actually cite your business, talk to us.</p>
<a class="btn" href="${PUBLISHER_CONTACT_URL}">Get in touch</a><a class="btn ghost" href="${PUBLISHER_URL}">See what we do</a>
</div>

<h2>Privacy</h2>
<p class="note">Public website content is fetched and analysed in memory for the length of one request, then discarded. Nothing is stored. No accounts, no database, no cookies, no tracking. The crawler identifies itself as <code>SearchScopeAIVisibilityAuditor</code>, reads at most ${LIMITS.hardMaxPages} pages per request, honours sitemap hints in robots.txt, never submits forms, never runs scripts and refuses private, internal or loopback addresses.</p>
</main>
<footer class="wrap">
Published by <a href="${PUBLISHER_URL}">${PUBLISHER}</a>, ${PUBLISHER_LOCATION}. Version ${SERVICE_VERSION}. Status at <a href="${origin}/health">/health</a>.
</footer>
</body></html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    devLoopback = env.DEV_ALLOW_LOOPBACK_TARGETS === "1";
    perTargetLimiter = env.MCP_RATE_LIMIT_PER_TARGET;
    const url = new URL(request.url);

    if (url.pathname === "/mcp/server-card" || url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), { headers: { ...DISCOVERY_HEADERS, "content-type": "application/mcp-server-card+json" } });
    }

    if (url.pathname === "/.well-known/ai-catalog.json") {
      return new Response(JSON.stringify(AI_CATALOG, null, 2), { headers: { ...DISCOVERY_HEADERS, "content-type": "application/ai-catalog+json" } });
    }

    // A person (or a directory checker) opening the MCP URL in a browser gets the
    // setup page instead of a bare 405. MCP clients never send a GET that accepts
    // text/html without text/event-stream, so the protocol path is untouched.
    if (url.pathname === "/mcp" && (request.method === "GET" || request.method === "HEAD")) {
      const accept = request.headers.get("accept") ?? "";
      if (!accept.includes("text/event-stream")) {
        return new Response(request.method === "HEAD" ? null : landingHtml(url.origin), { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
      }
    }

    if (url.pathname === "/mcp") {
      // Only our own hostnames serve the protocol, so a DNS name rebound to
      // this Worker (or to wrangler dev on localhost) cannot reach a tool.
      if (!isLoopbackHost(url.hostname) && !SERVICE_HOSTNAMES.includes(url.hostname)) {
        return rpcError(403, -32000, "Host not allowed.");
      }
      if (!isAcceptableOrigin(request.headers.get("origin"))) {
        return rpcError(403, -32000, "Origin not allowed.");
      }
      // Fast path for an honest Content-Length; the real cap is applied to the
      // bytes read below.
      const len = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(len) && len > LIMITS.maxRequestBodyBytes) return bodyTooLarge();
      // The endpoint is public and unauthenticated, and one audit can fan out to
      // about 20 outbound fetches, so it fails closed: no limiter, no service.
      // Cloudflare always sets cf-connecting-ip in production; only a loopback
      // request (wrangler dev) may fall back to a shared local key.
      const clientIp = request.headers.get("cf-connecting-ip") ?? (isLoopbackHost(url.hostname) ? "loopback" : null);
      const { MCP_RATE_LIMIT_PER_IP: perIp, MCP_RATE_LIMIT_GLOBAL: global, MCP_RATE_LIMIT_TOOL_CALLS_PER_IP: toolsPerIp, MCP_RATE_LIMIT_PER_TARGET: perTarget } = env;
      if (!clientIp || !perIp || !global || !toolsPerIp || !perTarget) return unavailable();
      const allowed = await withinLimits([() => perIp.limit({ key: clientIp }), () => global.limit({ key: "mcp" })]);
      if (allowed !== true) return allowed;

      let forward = request;
      if (request.body && request.method !== "GET" && request.method !== "HEAD") {
        const bytes = await readBodyCapped(request.body, LIMITS.maxRequestBodyBytes);
        if (!bytes) return bodyTooLarge();
        // Tool calls are what cost outbound fetches, so they carry their own
        // limits: per client, and per audited site so the Worker cannot be
        // pointed at one website as a load generator. JSON-RPC batches would
        // let one request start many crawls, so a batch may hold one call.
        const calls = toolCallsIn(bytes);
        if (calls.length > 1) return rpcError(400, -32600, "Send one tools/call per request.");
        const call = calls[0];
        if (call) {
          const checks = [() => toolsPerIp.limit({ key: clientIp })];
          const target = call.target;
          if (target) checks.push(() => perTarget.limit({ key: target }));
          const toolAllowed = await withinLimits(checks);
          if (toolAllowed !== true) return toolAllowed;
        }
        // The handler gets the exact bytes received, now with a known length.
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        forward = new Request(request.url, { method: request.method, headers, body: bytes, signal: request.signal });
      }
      return getHandler()(forward, env, ctx);
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: SERVICE_NAME }, { headers: { ...SECURITY_HEADERS, "cache-control": "no-store" } });
    }

    if (url.pathname === "/" || url.pathname === "") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: SECURITY_HEADERS });
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/json") && !accept.includes("text/html")) {
        return Response.json(
          {
            name: SERVICE_NAME,
            publisher: PUBLISHER,
            publisherUrl: PUBLISHER_URL,
            logoUrl: `${url.origin}/logo.png`,
            version: SERVICE_VERSION,
            description: "Audit websites for AI search visibility, entity clarity, retrieval readiness, information gain and GEO opportunities.",
            mcpEndpoint: `${url.origin}/mcp`,
            transport: "streamable-http",
            authentication: "none",
            tools: TOOLS,
            privacy: "Public website content is analysed transiently for one request and is not stored.",
            contact: PUBLISHER_CONTACT_URL,
          },
          { headers: SECURITY_HEADERS },
        );
      }
      return new Response(landingHtml(url.origin), { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
    }

    // Brand assets are served from the Worker itself rather than hotlinked, so
    // the landing page does not depend on another site staying up. Cached hard:
    // the bytes only change when the Worker is redeployed.
    if (url.pathname === "/logo.png") {
      return new Response(decodeBase64(LOGO_PNG_BASE64), {
        headers: { ...SECURITY_HEADERS, "content-type": "image/png", "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
      });
    }

    if (url.pathname === "/icon.png") {
      return new Response(decodeBase64(ICON_512_PNG_BASE64), {
        headers: { ...SECURITY_HEADERS, "content-type": "image/png", "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
      });
    }

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        headers: { ...SECURITY_HEADERS, "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
      });
    }

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /mcp\n", { headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
  },
} satisfies ExportedHandler<Env>;
