/**
 * Guards for inbound /mcp requests, applied in the Worker before the MCP
 * handler sees anything. (Outbound target checks live in ./url.ts.)
 */

import { normaliseTargetUrl } from "./url";

export interface ToolCall {
  /** Rate-limit key for the site the call would crawl: hostname without `www.`. Absent when the URL is unusable (the tool rejects it without fetching). */
  target?: string;
}

/**
 * The `tools/call` messages in a JSON-RPC body, whether it holds one message
 * or a batch. Classified from the parsed body, never from headers such as
 * Mcp-Method, which a client can simply leave out. A body that is not JSON
 * yields nothing here and is refused by the MCP handler as a parse error.
 */
export function toolCallsIn(body: Uint8Array): ToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "tools/call") continue;
    const args = (m as { params?: { arguments?: { url?: unknown } } }).params?.arguments;
    calls.push({ target: typeof args?.url === "string" ? targetKey(args.url) : undefined });
  }
  return calls;
}

/** Same host normalisation the crawler applies, so `www.` and case variants share one budget. */
export function targetKey(url: string): string | undefined {
  try {
    return normaliseTargetUrl(url).hostname.replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * Browser Origin policy for /mcp. Desktop, editor and server-side MCP clients
 * send no Origin, so a missing header is accepted. A present Origin must be a
 * well-formed http(s) origin (scheme, host, optional port, nothing else); any
 * such origin is accepted, because the server is public, unauthenticated,
 * read-only and stateless, holds no cookies or credentials, and applies the
 * same rate limits to a browser as to any other caller. `null` (sandboxed
 * iframes, file: pages), browser-extension schemes and anything unparseable
 * are refused: none of them is a web page a legitimate browser client runs on.
 */
export function isAcceptableOrigin(origin: string | null): boolean {
  if (origin === null || origin === "") return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // A serialised origin is exactly scheme://host[:port]: no credentials, path,
  // query or fragment. Comparing against the parser's own serialisation
  // rejects all of those in one step (a lone trailing slash is tolerated).
  return u.hostname !== "" && origin.replace(/\/$/, "").toLowerCase() === u.origin;
}

/**
 * Reads a body up to `max` bytes and returns null once it goes over.
 * Content-Length is only a hint (a chunked request has none), so the cap is
 * enforced on the bytes actually received.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}
