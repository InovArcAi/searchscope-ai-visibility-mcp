import { createMcpHandler } from "agents/mcp/server";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_LOCATION, PUBLISHER_LOGO_URL, PUBLISHER_URL, SERVICE_NAME, SERVICE_VERSION } from "./config";
import { createServer } from "./mcp/server";

interface Env {
  /** Development only (wrangler dev --var DEV_ALLOW_LOOPBACK_TARGETS:1). Inert unless the request host is loopback. */
  DEV_ALLOW_LOOPBACK_TARGETS?: string;
}

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

function getHandler(): ReturnType<typeof createMcpHandler> {
  mcpHandler ??= createMcpHandler(
    (ctx) => {
      const reqUrl = ctx.requestInfo ? new URL(ctx.requestInfo.url) : undefined;
      return createServer({
        selfHostnames: reqUrl ? [reqUrl.hostname] : undefined,
        devAllowLoopbackTargets: devLoopback && Boolean(reqUrl && isLoopbackHost(reqUrl.hostname)),
      });
    },
    {
      route: "/mcp",
      // The SDK's default Origin allow-list only covers localhost and the
      // endpoint's own workers.dev hostname, so a browser-based MCP client, or
      // any client at all once this runs on a custom domain, can be rejected
      // before it reaches a tool. Origin locking is a defence against a web page
      // driving a *local* server that holds credentials or private data. This
      // server has neither: it is public, unauthenticated by design, read-only,
      // and stores nothing between requests, so there is nothing an origin could
      // steal. Accept any origin and let the SSRF rules do the real work.
      allowedOriginHostnames: "*",
    },
  );
  return mcpHandler;
}

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
<link rel="icon" href="https://searchscope.com.au/favicon.svg" type="image/svg+xml">
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
<a href="${PUBLISHER_URL}"><img src="${PUBLISHER_LOGO_URL}" alt="${PUBLISHER}" width="180" height="34"></a>
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
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const len = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(len) && len > LIMITS.maxRequestBodyBytes) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "Request body too large." }, id: null }, { status: 413 });
      }
      return getHandler()(request, env, ctx);
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

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /mcp\n", { headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
  },
} satisfies ExportedHandler<Env>;
