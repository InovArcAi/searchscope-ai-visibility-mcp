/**
 * Rate-limit plumbing shared by /mcp and /api/v1. Both surfaces charge the
 * same bindings under the same keys, so a client cannot double its budget by
 * switching between them, and the global ceiling covers all traffic.
 */

import { targetKey } from "./request";

export type LimitVerdict = "ok" | "limited" | "unavailable";

/** "ok" when every limiter allowed the request. A limiter that errors (or throws) fails closed. */
export async function checkLimits(checks: Array<() => Promise<RateLimitOutcome>>): Promise<LimitVerdict> {
  try {
    const outcomes = await Promise.all(checks.map((check) => check()));
    return outcomes.every((o) => o.success) ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}

/** Charges the per-site limiter for a site reached by a cross-site homepage redirect. False (stop) when it is spent, missing or erroring. */
export function redirectCharger(limiter: RateLimit | undefined): (hostname: string) => Promise<boolean> {
  return async (hostname) => {
    const key = targetKey(hostname);
    if (!limiter || !key) return false;
    try {
      return (await limiter.limit({ key })).success;
    } catch {
      return false; // fail closed, as at the front door
    }
  };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The per-client rate-limit key for a request: the client IP, or "loopback"
 * for wrangler dev. Null on a public hostname without cf-connecting-ip, which
 * Cloudflare always sets, so the caller fails closed.
 */
export function clientIpKey(request: Request, hostname: string): string | null {
  return request.headers.get("cf-connecting-ip") ?? (isLoopbackHost(hostname) ? "loopback" : null);
}
