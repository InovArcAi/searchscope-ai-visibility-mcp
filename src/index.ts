import { createMcpHandler } from "agents/mcp/server";
import { LIMITS, PUBLISHER, PUBLISHER_URL, SERVICE_NAME, SERVICE_VERSION } from "./config";
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
  const tools = TOOLS.map((t) => `<li><code>${t.name}</code>: ${t.summary}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${SERVICE_NAME}</title><style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}h1{font-size:1.6rem}li{margin:.4rem 0}</style></head><body><h1>${SERVICE_NAME}</h1><p>A remote MCP server published by <a href="${PUBLISHER_URL}">${PUBLISHER}</a>. It lets Claude and other MCP-compatible assistants audit a public website for AI search visibility, entity clarity, retrieval readiness, information gain and GEO opportunities.</p><h2>MCP endpoint</h2><p><code>${origin}/mcp</code> (Streamable HTTP, no authentication for v1, read-only tools).</p><h2>Tools</h2><ul>${tools}</ul><h2>Privacy</h2><p>Public website content is fetched and analysed transiently for the duration of one request and is not stored. No accounts, no database, no cookies. The crawler identifies itself as <code>SearchScopeAIVisibilityAuditor</code>, fetches at most ${LIMITS.hardMaxPages} pages per request, follows robots.txt sitemap hints, never submits forms or executes scripts, and refuses private, internal or loopback targets.</p><h2>Health</h2><p><code>${origin}/health</code></p><p>Version ${SERVICE_VERSION}.</p></body></html>`;
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
