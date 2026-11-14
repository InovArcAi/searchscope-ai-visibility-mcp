/** Bindings and settings the Worker reads. Rate limiters are declared in wrangler.jsonc; secrets are set on the Worker, never committed. */
export interface Env {
  /** Development only (wrangler dev --var DEV_ALLOW_LOOPBACK_TARGETS:1). Inert unless the request host is loopback. */
  DEV_ALLOW_LOOPBACK_TARGETS?: string;
  /** Per-client budget on /mcp and /api/v1 (see wrangler.jsonc `ratelimits`): every request costs 1, a tool call costs LIMITS.toolCallWeight in total. */
  MCP_RATE_LIMIT_PER_IP?: RateLimit;
  /** Ceiling on all /mcp and /api/v1 traffic, so a crawler or loop cannot exhaust the account's Workers quota. */
  MCP_RATE_LIMIT_GLOBAL?: RateLimit;
  /** Per audited hostname, so the Worker cannot be used to hammer one website from many clients. */
  MCP_RATE_LIMIT_PER_TARGET?: RateLimit;
  /**
   * Secret that signs the optional free API keys (at least 32 characters).
   * Unset: keyless requests still work, a request that sends a key gets 503
   * and no keys are issued.
   */
  API_KEY_SIGNING_SECRET?: string;
  /**
   * The X-RapidAPI-Proxy-Secret value from the RapidAPI listing. Unset: the
   * RapidAPI path is off and RapidAPI traffic is limited per IP like anyone else.
   */
  RAPIDAPI_PROXY_SECRET?: string;
}
