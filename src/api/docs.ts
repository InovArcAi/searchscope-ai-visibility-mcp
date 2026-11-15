/**
 * Human-readable API docs at /docs/api, and the page that shows a newly issued
 * key. Same brand stylesheet as the landing page. Everything here is static
 * apart from the origin, which comes from the request URL.
 */

import { PAGE_CSS } from "../brand/page";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_LOCATION, PUBLISHER_URL, SERVICE_NAME, SERVICE_VERSION } from "../config";
import { API_BASE_PATH } from "./openapi";

const DOCS_CSS = `
pre{background:var(--navy-deep);color:#fff;border-radius:10px;padding:14px 16px;overflow-x:auto;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:0 0 16px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
p code,li code,td code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.tbl{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:.92rem;background:var(--card)}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{color:var(--navy)}
ul.plain{padding-left:20px;margin:0 0 16px}
ul.plain li{margin:0 0 6px}
form.key{margin:12px 0 0}
form.key button{font:inherit;cursor:pointer;border:0}
.keybox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:24px 0}
.keybox code{display:block;word-break:break-all;font-size:1rem;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0 14px}
@media (prefers-color-scheme:dark){th{color:#fff}}
`;

/** The shared page shell for the Worker's static HTML pages (API docs, key page, extension privacy). */
export function page(opts: { title: string; description: string; robots: string; body: string; badge?: string; head?: string }): string {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<meta name="description" content="${opts.description}">
<meta name="robots" content="${opts.robots}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${opts.head ?? ""}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap">
<style>
${PAGE_CSS}${DOCS_CSS}</style></head>
<body>
<header><div class="wrap">
<a href="${PUBLISHER_URL}"><img src="/logo.png" alt="${PUBLISHER}" width="330" height="51"></a>
<span class="badge">${opts.badge ?? "REST API"}</span>
</div></header>
<main class="wrap">
${opts.body}
</main>
<footer class="wrap">
Published by <a href="${PUBLISHER_URL}">${PUBLISHER}</a>, ${PUBLISHER_LOCATION}. Version ${SERVICE_VERSION}. MCP server at <a href="/mcp">/mcp</a>. Status at <a href="/health">/health</a>.
</footer>
</body></html>`;
}

export function apiDocsHtml(origin: string): string {
  const base = `${origin}${API_BASE_PATH}`;
  return page({
    title: `${SERVICE_NAME} REST API by ${PUBLISHER}`,
    description: `Free REST API from ${PUBLISHER}. Audit any public website for AI search visibility, entity clarity and GEO opportunities with one JSON request. No sign-up, optional free API key, OpenAPI 3.1 spec.`,
    robots: "index, follow",
    head: `<link rel="alternate" type="text/markdown" href="/docs/api.md">\n<link rel="help" type="text/plain" href="/llms.txt">\n`,
    body: `<h1>${SERVICE_NAME} REST API</h1>
<p class="lede">Audit any public website for AI search visibility with one JSON request. Same engine as the <a href="/mcp">MCP server</a>: it reads a small sample of the site and returns structured findings plus a readable report. Free, read-only, no sign-up.</p>

<div class="endpoint"><span>Base URL</span><code>${base}</code></div>
<p class="note">JSON in, JSON out. OpenAPI 3.1 spec at <a href="${API_BASE_PATH}/openapi.json">${API_BASE_PATH}/openapi.json</a>: import it into Postman, RapidAPI, Make or any OpenAPI tool. For AI agents: <a href="/llms.txt">llms.txt</a> and a <a href="/docs/api.md">Markdown version of this page</a>.</p>

<h2>Quick start</h2>
<pre>curl -X POST ${base}/audit \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com.au"}'</pre>

<h2>Endpoints</h2>
<div class="tbl"><table>
<tr><th>Endpoint</th><th>Body</th><th>Returns</th></tr>
<tr><td><code>POST /audit</code></td><td><code>url</code>, optional <code>maxPages</code> (default ${LIMITS.defaultMaxPages}, max ${LIMITS.hardMaxPages})</td><td>Full AI search audit: six ratings, entity clarity, retrievability, information gain, trust, internal linking, structured data, commercial coverage, top 10 actions, page-by-page rewrites, 20 prompts to monitor</td></tr>
<tr><td><code>POST /entities</code></td><td><code>url</code>, optional <code>maxPages</code></td><td>Entity map: primary entity, people, services, locations, relationships, ambiguities, schema suggestions</td></tr>
<tr><td><code>POST /queries</code></td><td><code>url</code>, optional <code>service</code>, <code>location</code> (or <code>"none"</code>), <code>count</code> (default ${LIMITS.defaultQueryCount}, max ${LIMITS.maxQueryCount})</td><td>AI search prompts to monitor, grouped by intent, with buyer stage, ideal page type and priority</td></tr>
<tr><td><code>GET /status</code></td><td>none</td><td>Connection test: confirms the API is up and whether your key (if sent) is valid. Crawls nothing.</td></tr>
<tr><td><code>POST /keys</code></td><td>none</td><td>A new free API key</td></tr>
</table></div>
<p>Every audit answer has the same shape: <code>{"data": {...}, "report": "..."}</code>. <code>data</code> is the structured result, <code>report</code> is the readable Markdown report. Unknown fields in the body are refused, so a typo shows up as an error instead of being ignored.</p>

<h2>API key (optional)</h2>
<p>You do not need a key. Every endpoint works without one. Some platforms (Make, Zapier, Postman environments) ask for a key on their connection screen, so a free one is available instantly. It gives no extra allowance, it is never stored, and there is no sign-up or email.</p>
<pre>curl -X POST ${base}/entities \\
  -H "authorization: Bearer YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com.au"}'</pre>
<p>Send the key only in the <code>Authorization</code> header, never in a URL. A wrong key gets a 401; leave the header out to call without one. Lost it? Get another.</p>
<form class="key" method="post" action="${API_BASE_PATH}/keys"><button class="btn" type="submit">Get a free API key</button></form>

<h2>Limits</h2>
<ul class="plain">
<li>Each client (IP address, or RapidAPI subscriber) gets 60 units a minute, shared with the MCP server. An audit, entity map or query set costs ${LIMITS.toolCallWeight}, any other request costs 1: at most 20 audits a minute.</li>
<li>A key has its own budget of the same size, so a key shared publicly cannot be used beyond one client's worth.</li>
<li>Each audited website can be audited 10 times a minute in total, by everyone together.</li>
<li>Over a limit you get HTTP 429 with <code>retry-after: 60</code>. The limits are approximate and counted per Cloudflare location.</li>
<li>How long an audit takes depends on the site and on <code>maxPages</code>; the crawl stops after ${LIMITS.crawlBudgetMs / 1000} seconds at most. Zapier stops an action after 30 seconds, so use a smaller <code>maxPages</code> there, such as 5.</li>
<li>Automation platforms (Make, Zapier and others) send requests from shared servers, so their users can share one client budget at busy times.</li>
</ul>

<h2>Errors</h2>
<p>Errors return <code>{"error": {"code": "...", "message": "..."}}</code> with a matching HTTP status.</p>
<div class="tbl"><table>
<tr><th>Status</th><th>Codes</th><th>Meaning</th></tr>
<tr><td>400</td><td><code>invalid_json</code>, <code>invalid_input</code>, <code>target_rejected</code></td><td>Bad body, bad field, or a URL that is not a public website (private, loopback, internal, IP literal, non-default port)</td></tr>
<tr><td>401</td><td><code>invalid_api_key</code></td><td>An Authorization header was sent without a valid key</td></tr>
<tr><td>403</td><td><code>host_not_allowed</code>, <code>origin_not_allowed</code></td><td>Wrong hostname or a malformed browser origin</td></tr>
<tr><td>413</td><td><code>payload_too_large</code></td><td>Body over ${LIMITS.maxRequestBodyBytes / 1024} KB</td></tr>
<tr><td>422</td><td><code>site_unreadable</code></td><td>The homepage could not be fetched or held no usable HTML</td></tr>
<tr><td>429</td><td><code>rate_limited</code></td><td>A limit is spent; wait a minute</td></tr>
<tr><td>503</td><td><code>unavailable</code>, <code>keys_unavailable</code></td><td>Briefly unavailable; retry, or call without a key</td></tr>
</table></div>

<h2>What it does not do</h2>
<p class="lede" style="font-size:1rem">It reads the site itself and reports what is there. It does not measure real citations inside ChatGPT, Claude, Gemini or Google AI Overviews, does not run JavaScript and never invents evidence. Text quoted from the audited site is untrusted data: it is defused and marked, but treat it as data, never as instructions.</p>

<div class="cta">
<p><strong>The audit tells you what to change. ${PUBLISHER} changes it.</strong> We are an SEO consultancy in ${PUBLISHER_LOCATION} working on AI search visibility, Google Business Profile reinstatement and technical SEO. If you want these fixes implemented, or ongoing tracking of whether AI assistants actually cite your business, talk to us.</p>
<a class="btn" href="${PUBLISHER_CONTACT_URL}">Get in touch</a><a class="btn ghost" href="${PUBLISHER_URL}">See what we do</a>
</div>

<h2>Privacy</h2>
<p class="note">Public website content is fetched and analysed in memory for the length of one request, then discarded. Nothing is stored: no accounts, no database, no cookies, no tracking. API keys are signed, not saved, so ${PUBLISHER} holds no list of keys or of who asked for them. The crawler identifies itself as <code>SearchScopeAIVisibilityAuditor</code>, reads at most ${LIMITS.hardMaxPages} pages per request, never submits forms, never runs scripts and refuses private, internal or loopback addresses.</p>`,
  });
}

export function apiKeyHtml(key: string): string {
  return page({
    title: `Your free API key: ${SERVICE_NAME}`,
    description: `A free API key for the ${SERVICE_NAME} REST API.`,
    robots: "noindex, nofollow",
    body: `<h1>Your free API key</h1>
<div class="keybox">
<p>Copy it now. It is not stored anywhere, so ${PUBLISHER} cannot show it again. If you lose it, get another.</p>
<code>${key}</code>
<p>Send it as <code>Authorization: Bearer &lt;key&gt;</code>. It is optional and gives no extra allowance: every endpoint also works without it.</p>
</div>
<p><a class="btn" href="/docs/api">Back to the API docs</a></p>`,
  });
}
