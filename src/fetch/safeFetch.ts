import { LIMITS, USER_AGENT } from "../config";
import { assertPublicTarget, TargetError, type TargetPolicy } from "../security/url";

export type BodyKind = "html" | "xml" | "text";

export interface SafeFetchOptions {
  policy: TargetPolicy;
  fetchImpl?: typeof fetch;
  /** Which content types are acceptable. Anything else is rejected without reading the body. */
  kind: BodyKind;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
  redirects: number;
  fetchMs: number;
  xRobotsTag: string;
  /** Set when the response could not be used. The audit reports it instead of failing. */
  error?: "non_html" | "too_large" | "timeout" | "network" | "http_error" | "too_many_redirects" | "blocked";
  errorDetail?: string;
}

const ACCEPT: Record<BodyKind, { header: string; types: RegExp }> = {
  html: {
    header: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    types: /^(text\/html|application\/xhtml\+xml)/i,
  },
  xml: {
    header: "application/xml,text/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
    types: /^(application\/xml|text\/xml|application\/rss\+xml|application\/atom\+xml|text\/plain|application\/gzip|application\/x-gzip)/i,
  },
  text: {
    header: "text/plain,*/*;q=0.1",
    types: /^(text\/plain|text\/html)/i,
  },
};

function baseResult(url: string): SafeFetchResult {
  return {
    ok: false,
    requestedUrl: url,
    finalUrl: url,
    status: 0,
    contentType: "",
    body: "",
    bytes: 0,
    truncated: false,
    redirects: 0,
    fetchMs: 0,
    xRobotsTag: "",
  };
}

/**
 * Fetch a public URL with every safety rail the auditor relies on:
 * validated target, manual redirect handling with re-validation of each hop,
 * timeout, content-type gate and a byte cap on the body. Never throws for
 * target-side problems; they are reported in the result so the audit can
 * continue with the pages it did get.
 */
export async function safeFetch(inputUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LIMITS.fetchTimeoutMs;
  const maxBytes = opts.maxBytes ?? (opts.kind === "html" ? LIMITS.maxHtmlBytes : LIMITS.maxTextBytes);
  const maxRedirects = opts.maxRedirects ?? LIMITS.maxRedirects;
  const accept = ACCEPT[opts.kind];
  const result = baseResult(inputUrl);
  const started = Date.now();

  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    return { ...result, error: "blocked", errorDetail: "Invalid URL." };
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      await assertPublicTarget(current, opts.policy);
    } catch (e) {
      const detail = e instanceof TargetError ? e.message : "Target rejected.";
      return { ...result, finalUrl: current.toString(), redirects: hop, fetchMs: Date.now() - started, error: "blocked", errorDetail: detail };
    }

    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          accept: accept.header,
          "accept-language": "en-AU,en;q=0.8",
        },
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return {
        ...result,
        finalUrl: current.toString(),
        redirects: hop,
        fetchMs: Date.now() - started,
        error: isTimeout ? "timeout" : "network",
        errorDetail: isTimeout ? `No response within ${timeoutMs} ms.` : (e instanceof Error ? e.message : "Network error."),
      };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) {
        return { ...result, finalUrl: current.toString(), status: res.status, redirects: hop, fetchMs: Date.now() - started, error: "http_error", errorDetail: "Redirect without Location header." };
      }
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return { ...result, finalUrl: current.toString(), status: res.status, redirects: hop, fetchMs: Date.now() - started, error: "blocked", errorDetail: "Invalid redirect target." };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { ...result, finalUrl: current.toString(), status: res.status, redirects: hop, fetchMs: Date.now() - started, error: "blocked", errorDetail: "Redirect to unsupported scheme." };
      }
      if (next.username || next.password) {
        return { ...result, finalUrl: current.toString(), status: res.status, redirects: hop, fetchMs: Date.now() - started, error: "blocked", errorDetail: "Redirect target contains credentials." };
      }
      next.hash = "";
      if (hop === maxRedirects) {
        return { ...result, finalUrl: next.toString(), status: res.status, redirects: hop + 1, fetchMs: Date.now() - started, error: "too_many_redirects", errorDetail: `More than ${maxRedirects} redirects.` };
      }
      current = next;
      continue; // loop re-validates the new target before fetching it
    }

    const contentType = (res.headers.get("content-type") ?? "").trim();
    const xRobots = res.headers.get("x-robots-tag") ?? "";
    const common = {
      ...result,
      finalUrl: current.toString(),
      status: res.status,
      contentType,
      redirects: hop,
      xRobotsTag: xRobots,
    };

    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ...common, fetchMs: Date.now() - started, error: "http_error", errorDetail: `HTTP ${res.status}` };
    }

    if (contentType && !accept.types.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      return { ...common, fetchMs: Date.now() - started, error: "non_html", errorDetail: `Unsupported content type: ${contentType.split(";")[0]}` };
    }

    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { ...common, bytes: declared, fetchMs: Date.now() - started, error: "too_large", errorDetail: `Body is ${declared} bytes; limit is ${maxBytes}.` };
    }

    const { text, bytes, truncated } = await readCapped(res, maxBytes, timeoutMs);
    return { ...common, ok: true, body: text, bytes, truncated, fetchMs: Date.now() - started };
  }

  return { ...result, error: "too_many_redirects", errorDetail: "Redirect limit reached." };
}

async function readCapped(res: Response, maxBytes: number, timeoutMs: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (received + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - received));
        received = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(merged), bytes: received, truncated };
}
