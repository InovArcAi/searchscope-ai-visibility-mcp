/**
 * Hard limits for the auditor. These are deliberately conservative: the Worker
 * must never be usable as an open proxy or a load generator against a target.
 */
export const LIMITS = {
  /** Default number of pages fetched per audit when the caller does not specify one. */
  defaultMaxPages: 8,
  /** Absolute cap on pages fetched per audit, regardless of the caller's request. */
  hardMaxPages: 15,
  /** Concurrent outbound fetches while crawling. */
  crawlConcurrency: 4,
  /** Per-response timeout (connection + headers + body). */
  fetchTimeoutMs: 8_000,
  /** Wall-clock budget for the whole crawl. Pages not fetched inside it are reported as skipped. */
  crawlBudgetMs: 25_000,
  /** Maximum bytes read from a single HTML page. Larger bodies are truncated and flagged. */
  maxHtmlBytes: 1_500_000,
  /** Maximum bytes read from a sitemap or robots.txt. */
  maxTextBytes: 1_000_000,
  /** Maximum redirects followed for one URL. Every hop is re-validated. */
  maxRedirects: 5,
  /** Maximum child sitemaps fetched from a sitemap index. */
  maxChildSitemaps: 3,
  /** Maximum URLs retained from sitemaps before prioritisation. */
  maxSitemapUrls: 500,
  /** Maximum size of an inbound MCP request body. */
  maxRequestBodyBytes: 32_768,
  /** Query universe defaults. */
  defaultQueryCount: 40,
  maxQueryCount: 100,
} as const;

export const SERVICE_NAME = "Search Scope AI Visibility Auditor";
export const SERVICE_VERSION = "1.0.0";
export const PUBLISHER = "Search Scope";
export const PUBLISHER_URL = "https://searchscope.com.au/";
export const USER_AGENT = `SearchScopeAIVisibilityAuditor/${SERVICE_VERSION} (+https://searchscope.com.au/ai-visibility-scanner/; read-only site audit bot)`;
