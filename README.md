<p align="center"><a href="https://searchscope.com.au/"><img src="assets/search-scope-logo.png" alt="Search Scope" width="330"></a></p>

# Search Scope AI Visibility Auditor

A free remote [MCP](https://modelcontextprotocol.io) server from [Search Scope](https://searchscope.com.au/) that lets Claude, ChatGPT, Cursor and other MCP-compatible assistants audit a public website for AI search visibility, entity clarity, retrieval readiness, information gain and GEO opportunities.

Stateless, read-only, no accounts, no API key, no database, no paid APIs.

- **MCP endpoint (Streamable HTTP):** `https://mcp.searchscope.com.au/mcp`
- Landing page: [mcp.searchscope.com.au](https://mcp.searchscope.com.au/) (HTML, or JSON with `Accept: application/json`)
- Health: `/health` returns `{"status":"ok","service":"Search Scope AI Visibility Auditor"}`

Connect it in one line:

```bash
claude mcp add --transport http searchscope-auditor https://mcp.searchscope.com.au/mcp
```

## About Search Scope

[Search Scope](https://searchscope.com.au/) is an SEO consultancy in Victoria Park, Perth, Western Australia. It was founded in 2021 by [Dorian Menard](https://www.linkedin.com/in/dorianmenard/), an SEO consultant who has worked in SEO since 2013. Search Scope works with multi-location and national brands across Australia, providing multi-location SEO, national SEO, AI search visibility, Google Business Profile management and Google Maps and local SEO, with no lock-in contracts.

Search Scope built this auditor and runs it as a free public tool. It shows what an AI assistant can and cannot read about a business. If you want the fixes implemented, or ongoing tracking of whether ChatGPT, Gemini, Perplexity and Google AI Overviews actually name your brand, talk to Search Scope.

- Website: [searchscope.com.au](https://searchscope.com.au/)
- AI Visibility Scanner: [searchscope.com.au/ai-visibility-scanner](https://searchscope.com.au/ai-visibility-scanner/)
- Book a strategy call: [lunacal.ai/searchscope/30min](https://lunacal.ai/searchscope/30min)
- Email: [seo@searchscope.com.au](mailto:seo@searchscope.com.au)
- LinkedIn: [Search Scope](https://www.linkedin.com/company/search-scope/) and [Dorian Menard](https://www.linkedin.com/in/dorianmenard/)
- YouTube: [@searchscopeseo](https://www.youtube.com/@searchscopeseo)
- X: [@searchscopeseo](https://x.com/searchscopeseo)
- Bluesky: [searchscopeseo.bsky.social](https://bsky.app/profile/searchscopeseo.bsky.social)
- Instagram: [@searchscopeseo](https://www.instagram.com/searchscopeseo)
- Facebook: [Search Scope](https://www.facebook.com/people/Search-Scope/61568270942475/)

## 1. What the server does

It fetches a small prioritised sample of a site (homepage, about, services or products, pricing, locations, key guides), extracts on-page signals with deterministic heuristics, and returns structured findings a professional SEO can act on. It does not call an LLM, does not measure real citations inside ChatGPT, Claude, Gemini or Google AI Overviews, and never invents evidence. Everything reported is either observed on the fetched pages or explicitly labelled as an inferred gap.

## 2. Exposed MCP tools

Three focused tools, following Cloudflare's guidance that a few well-described tools beat a large API surface.

### `audit_ai_visibility`

Input: `{ "url": "https://example.com", "maxPages": 8 }` (`maxPages` optional, default 8, hard maximum 15).

Returns Markdown text plus `structuredContent` with ten sections:

| Section | Content |
|---|---|
| A. Executive summary | Short diagnosis, six qualitative ratings, headline facts |
| B. Entity clarity | Primary entity, supporting entities, unclear relationships, confidence notes |
| C. AI retrievability | Per-page rating with the rubric, question-heading answer verdicts, site-wide issues |
| D. Information gain | First-party evidence phrases actually found (with excerpts) and what was not detected |
| E. Trust / corroboration | Named people, organisation identity, contact details, citations, credentials, third-party evidence, gaps |
| F. Internal linking / architecture | Orphan-like pages, hierarchy issues, ambiguous anchors, missing commercial-to-supporting links |
| G. Structured data | Schema types found, relevant omissions, issues; explicitly notes schema is not a ranking factor |
| H. Commercial query coverage | Inferred offerings, category, locations, likely intents with the page that covers each, gaps |
| I. Top 10 actions | Ranked by commercial impact, then AI/search visibility impact, then ease, each with evidence and, where one exists, a concrete `how` |
| I2. Page-by-page rewrites | The offending text quoted verbatim with a prefilled replacement: opening paragraphs, opening sentences for question headings, internal links to add with suggested anchor text, and a paste-ready JSON-LD block |
| J. 20 prompts to monitor | Balanced across informational, commercial, comparison, recommendation, alternatives, brand, category, trust and local (only when a location is detected) |

### `extract_site_entities`

Input: `{ "url": "https://example.com", "maxPages": 8 }`.

Returns the primary entity; related entities grouped into people, organisation/brand, products, services, locations and topics; relationships (`Brand -> offers -> Service`, `Brand -> located in -> City`, `Person -> founder of -> Brand`); ambiguities; missing entity support; schema types found; suggested schema types appropriate to the visible business. Every detection carries a confidence (`high`, `medium`, `low`) and the source it came from.

### `generate_geo_query_universe`

Input: `{ "url": "https://example.com", "service": "optional override", "location": "optional override", "count": 40 }` (`count` default 40, max 100; pass `location: "none"` to force non-local prompts).

Returns prompts grouped by intent (informational, problem-aware, commercial, recommendation, comparison, alternatives, brand, category, local, trust/validation). Each prompt has `intent`, `buyerStage`, `idealPageType` and `commercialPriority`.

## 3. Local development

Requirements: Node 22+, npm.

```bash
npm install --legacy-peer-deps   # the agents SDK declares many optional peers; npm 10 needs this flag
npm run dev                      # wrangler dev on http://localhost:8787
curl http://localhost:8787/health
```

To audit a local mock site while developing (the SSRF rules reject loopback targets by default):

```bash
node scripts/mock-site.mjs 80                     # serves the test fixture on http://127.0.0.1
npx wrangler dev --var DEV_ALLOW_LOOPBACK_TARGETS:1
```

The flag only has effect when the request itself arrives on a loopback host, so it is inert on `workers.dev` or a custom domain even if set by mistake.

## 4. Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/list
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/call \
  --tool-name audit_ai_visibility --tool-arg url=https://example.com.au maxPages=8
npx @modelcontextprotocol/inspector            # web UI; connect with transport "Streamable HTTP" and the /mcp URL
```

Automated tests run inside the Workers runtime (workerd) via `@cloudflare/vitest-pool-workers`, so `HTMLRewriter`, timeouts and fetch semantics match production:

```bash
npm run typecheck
npm test
```

The suite covers URL validation (malformed, localhost, 127.0.0.1, private IPv4, private IPv6, cloud metadata, credentials, ports), redirect re-validation into private space, DNS rebinding, maxPages and the hard cap, non-HTML and oversized responses, timeouts, sitemap and robots parsing, link extraction, de-duplication, the HTTP surface, `tools/list`, and every tool called end to end through the official MCP client against an in-memory fixture site.

## 5. Deployment

The Worker has no bindings or secrets. Two options:

**Option A: Cloudflare Workers Builds (recommended, no tokens in GitHub).** In the Cloudflare dashboard go to Workers & Pages, Create, Import a repository, pick this repo, keep the defaults (build command `npm install --legacy-peer-deps`, deploy command `npx wrangler deploy`). Every push to `main` then deploys automatically. This is how the production Worker is deployed, which is why `.github/workflows/deploy.yml` only runs typecheck and tests.

**Option B: GitHub Actions.** Add a deploy job using `cloudflare/wrangler-action` and repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`. Do not combine this with Option A, or the Worker deploys twice.

**Manual.** `npx wrangler login && npm run deploy`.

Plan note: the crawl parses up to 15 HTML pages per call. That comfortably fits the Workers Paid plan CPU limit (30 s). On the Workers Free plan (10 ms CPU per request) larger audits may be cut short; keep `maxPages` small or move to Paid.

## 6. Production MCP URL

`https://mcp.searchscope.com.au/mcp` (custom domain), with `https://searchscope-ai-visibility-mcp.searchscope.workers.dev/mcp` still serving the same Worker.

A custom domain is attached under the Worker's Settings, then Domains & Routes, then Add, then Custom Domain. The zone must already be on the same Cloudflare account; the DNS record and certificate are created automatically. No code or config change is needed: host validation is skipped for non-workers.dev hostnames, and the handler accepts any request origin.

The root URL serves a branded landing page (Search Scope logo, brand palette, tool list, privacy statement and a contact call to action) built from the constants in `src/config.ts`. The logo and favicon are embedded in the Worker (`src/brand/assets.ts`) and served from `/logo.png` and `/favicon.svg`, not hotlinked, so the page does not depend on another site staying up. Regenerate that file from the Search Scope site repository's `public/` directory if the brand mark changes. Every tool response also ends with a short `## About this report` attribution block, defined once as `REPORT_FOOTER` in `src/config.ts` so the wording stays consistent across all three tools. Tests assert both are present, so removing them fails the suite rather than silently shipping an unbranded build.

## 7. Example prompts

- "Audit https://example.com.au for AI search visibility and give me the top 10 fixes."
- "Extract the entity map for https://example.com.au and tell me which relationships are weak."
- "Generate 60 AI search prompts to monitor for https://example.com.au, focused on 'emergency plumbing' in Perth."
- "Run the AI visibility audit on my client's site with 12 pages and summarise section C and section I for a non-technical owner."

## 8. Security architecture

The Worker must not be usable as an open proxy. Every URL it fetches (initial target, each redirect hop, each discovered page, sitemaps, robots.txt) goes through the same gate:

1. Syntax: only `http`/`https`; credentials in the URL rejected; only default ports (checked on the initial target, every redirect hop, every discovered page and every sitemap URL); hostnames only (IP literals rejected, including obfuscated forms the URL parser normalises).
2. Hostname deny-list: `localhost`, single-label names, `.local`, `.internal`, `.home.arpa`, `.arpa`, `.onion`, `metadata.google.internal` and similar.
3. IP deny-list: loopback, RFC1918, CGNAT (100.64/10), link-local, multicast, reserved, TEST-NETs, unique-local and link-local IPv6, IPv4-mapped/NAT64/6to4/Teredo embeddings, and known cloud metadata addresses.
4. DNS resolution through Cloudflare DNS-over-HTTPS with every A/AAAA answer checked against the deny-list. Resolution failure rejects the target (fail closed). This is what stops a public hostname that resolves to a private address.
5. Redirects are handled manually (`redirect: "manual"`), capped at 5, and each hop is re-validated from step 1.
6. The crawler stays on the same site (host, ignoring `www.`), never fetches off-site links, never submits forms, never executes JavaScript, never authenticates.
7. Only `text/html` (pages) and XML/plain text (sitemaps, robots) are read; anything else is rejected before the body is read. Bodies are capped (1.5 MB per page) and truncated with a flag.
8. Per-page timeout 8 s, whole-crawl budget 25 s, concurrency 4, at most 15 pages, at most 3 child sitemaps, 500 sitemap URLs.
9. The server refuses to audit its own hostname, rejects MCP request bodies over 32 KB, and identifies itself as `SearchScopeAIVisibilityAuditor/1.0 (+https://searchscope.com.au/ai-visibility-scanner/)`.
10. Browser `Origin` headers are accepted from any origin, so custom domains and browser-based MCP clients work. This is safe because the server is stateless and holds no credentials or user data.
11. Reports quote text from the audited site (headings, opening paragraphs, JSON-LD). Treat that quoted text as untrusted data, not as instructions: a hostile site can put anything in its own copy.

There is no authentication. `/mcp` is rate limited inside the Worker on every hostname, using the Workers rate limiting binding: 60 requests a minute per client IP and 1,200 a minute in total, per Cloudflare location. Over the limit the server returns HTTP 429 with `retry-after: 60`.

## 9. Privacy behaviour

Public website content is fetched and analysed in memory for the duration of one request and is not stored anywhere. There is no database, no KV, no cache writes, no cookies and no user accounts. Cloudflare Workers observability logs are sampled at 20% and can include the URL that was audited, but never page content. Fetched HTML never leaves the request.

## 10. Connecting another MCP client

Any client that supports MCP Streamable HTTP can connect with the endpoint URL and no credentials.

- Claude (web or desktop): Settings, Connectors, Add custom connector, paste the `/mcp` URL.
- Claude Code: `claude mcp add --transport http searchscope-auditor https://mcp.searchscope.com.au/mcp`
- Cursor / Windsurf / other editors: add an MCP server of type `http` (or `streamable-http`) with the same URL.
- Programmatic (TypeScript):

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.searchscope.com.au/mcp")));
const result = await client.callTool({ name: "audit_ai_visibility", arguments: { url: "https://example.com.au" } });
```

Legacy 2025-era clients that POST plain JSON-RPC to `/mcp` are also served through the SDK's stateless compatibility lane.

## How fixes are generated

Section I2 exists because "rewrite the opening paragraph" is a diagnosis, not a task. Every fix quotes the current text verbatim and returns a replacement built only from what the crawl observed: the page's own H1 as the subject, the detected brand, the detected primary service area, and a price or turnaround found in that page's copy. Anything not observed is left as a visible `[placeholder]`.

The tool will not write a claim it cannot source. A fabricated price or a made-up client type in a template is worse than a blank, because a blank gets filled and an invented fact gets published. Two guards follow from that: a figure inside a market statistic ("$402.8 billion") is never reused as pricing, and a duration is only reused as a turnaround when it is measured in days or longer, so "30-minute strategy call" cannot become "typical turnaround is 30-minute".

Internal link suggestions name the source page, the destination, and anchor text taken from the destination's own H1, following the house rule of naming the destination's topic rather than its format. No destination is suggested more than twice, since one popular page proposed as the answer to every service page is noise.

## Known extraction limits

The entity extraction is deterministic pattern matching over visible copy and JSON-LD, not a language model, so it trades recall for precision. Specific guards, each added after a real site produced a wrong answer:

- People must look like human names. Acronyms (`GBP`, `SEO`, `MBA`), stopwords and the brand's own words are rejected, and only the name-then-role order is read from prose, because "specialist Jane Lee" is not how English names people.
- `EducationalOrganization` nodes are excluded from brand candidates. On a consultancy site that node is the founder's university, and treating it as a brand produced a false "brand name is stated inconsistently" finding.
- Free-text locations must pass a place test. AI products, crawler names and industry acronyms are frequent capitalised nouns in this sector's copy and were otherwise promoted to service areas.
- Offerings reject pricing tiers, table cells, multi-sentence text, unbalanced brackets, bare numbers and headlines written as commands. Over-long candidates are dropped rather than truncated mid-word.
- The business category is read from the brand name, title and meta description before the job list, because a handyman who lists gutter cleaning and pressure washing was being called a cleaning company, which then wrote every monitoring prompt wrong.
- A repeated slug prefix across three or more pages (`handyman-belconnen`, `handyman-gungahlin`) is read as a suburb landing-page network, so the trailing segment becomes a location rather than a service. Slugs carrying a commercial modifier (`handyman-prices-canberra`) are excluded.
- Definition detection expands contractions and lets a first-person positioning sentence clear a lower word count, since "We're a Canberra-based handyman team" does the same job as a longer third-person one.
- A heading is only treated as a question when it carries at least two topical words, so a call-to-action band like "NEED IT SORTED?" is not reported as a question with no answer.
- Page roles match on hyphen boundaries, so `faqs-seo` and `seo-glossary` are read as editorial. Without that, any single-segment slug fell through to a "service" default and editorial pages were counted as commercial.

`test/regressions.test.ts` pins each of these with a reproduction of the original failure.

## Rating rubrics

All ratings are qualitative (`Strong`, `Moderate`, `Weak`) with deterministic rules. There is no universal "GEO score".

- **AI retrievability (per page)**: Strong = a definition or positioning paragraph of 20+ words within the first blocks after the H1, at least 1.5 concrete facts (numbers, prices, dates, units, named entities) per 100 words, under 45% of passages shorter than 15 words, and at least 60% of question headings answered directly in the following passage. Weak = under 120 words of main copy, or no definition paragraph combined with under 0.6 facts per 100 words or over 65% fragment passages. Otherwise Moderate. The site rating averages page ratings.
- **Question answers**: `direct` (opens by restating and answering, or substantive and concrete), `thin` (under 20 words follow), `vague` (hedges such as "it depends" or "contact us" with no concrete facts), `split` (a 45+ word first sentence that neither restates nor answers), `missing` (heading followed by another heading).
- **Information gain**: Strong = three or more of {original data or research phrases, experiments or benchmarks, case studies, quantified results, quotes}; Moderate = one or two; Weak = none.
- **Trust**: eight signals (named people, phone, email or contact page, address, outbound citations, credentials, third-party evidence, legal identity). Strong = 6+, Moderate = 3 to 5, Weak = under 3.
- **Entity clarity**: six checks (brand from schema or og:site_name, one consistent name, offerings identified, at most six locations, named people, organisation schema present). Strong = 5+, Moderate = 3 to 4, Weak = under 3.
- **Architecture**: Strong = no orphan-like pages, hierarchy issues, missing commercial-to-supporting links or heavy generic anchors; Moderate = up to three issues; Weak = more.
- **Structured data**: Strong = organisation entity on the homepage with at most two issues; Moderate = some JSON-LD; Weak = none. FAQPage, HowTo and self-serving Review/AggregateRating markup are never recommended.

## Stack

- Cloudflare Workers, `wrangler` 4, `compatibility_date` 2026-08-22, `nodejs_compat`
- `agents` 0.23 (`createMcpHandler` from `agents/mcp/server`, the current stateless pattern; no `McpAgent`, no Durable Objects)
- `@modelcontextprotocol/server` 2.0 with Zod 4 input and output schemas
- Native `HTMLRewriter` for parsing (no JavaScript execution, streaming, no third-party HTML parser)
- `@cloudflare/vitest-pool-workers` + Vitest 4 for tests

## Provenance

This project was developed inside the `searchscope` site repository under `ai-visibility-mcp/` and split out into its own repository with `git subtree split`, so the commit history is preserved. `scripts/extract-to-own-repo.sh` reproduces that split and can also emit a portable git bundle, which is how the code moves between machines without needing access to both repositories at once.

## Licence

MIT. See `LICENSE`.
