/**
 * Optional free API keys, with nothing stored. A key is a random id plus an
 * HMAC of that id under API_KEY_SIGNING_SECRET, so the Worker can check one
 * without a database, and holds no record of who asked for it.
 *
 * A key gives no extra allowance: keyed requests pay the same per-client
 * budget as keyless ones, plus a per-key budget of the same size, so a key
 * pasted somewhere public cannot be shared out beyond one client's worth.
 * It exists for platforms whose connection screen insists on a key, and so a
 * wrong key gets a clear 401 instead of silently working.
 *
 * Keys are only read from the Authorization header, never from the URL, and
 * are never echoed in a response or written to a log.
 */

import { SERVICE_ORIGIN } from "../config";

const KEY_PREFIX = "ssk_";
const KEY_PATTERN = /^ssk_([0-9a-f]{32})([0-9a-f]{32})$/;
/** Shorter secrets are treated as missing, so a placeholder value cannot sign real keys. */
export const MIN_SIGNING_SECRET_LENGTH = 32;
const TAG_CONTEXT = "searchscope-api-key-v1:";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function keysEnabled(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SIGNING_SECRET_LENGTH;
}

async function tag(secret: string, id: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(TAG_CONTEXT + id)));
  return mac.slice(0, 16);
}

export async function issueApiKey(secret: string): Promise<string> {
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  return KEY_PREFIX + id + hex(await tag(secret, id));
}

/** The key's id when the signature checks out, otherwise null. Compared in constant time. */
export async function verifyApiKey(secret: string, key: string): Promise<string | null> {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  const id = m[1]!;
  const expected = await tag(secret, id);
  return crypto.subtle.timingSafeEqual(expected, fromHex(m[2]!)) ? id : null;
}

export type KeyCheck =
  | { kind: "none" }
  | { kind: "valid"; id: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable" };

/**
 * Reads the optional key. No Authorization header means a keyless request.
 * A header that is present must carry a valid key: anything else is refused
 * rather than ignored, so a misconfigured connection fails its test call.
 */
export async function checkApiKey(request: Request, secret: string | undefined): Promise<KeyCheck> {
  const header = request.headers.get("authorization");
  if (header === null || header.trim() === "") return { kind: "none" };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!m) return { kind: "invalid", message: "Send the API key as 'Authorization: Bearer <key>', or leave the header out: a key is optional." };
  if (!keysEnabled(secret)) return { kind: "unavailable" };
  const id = await verifyApiKey(secret, m[1]!);
  return id ? { kind: "valid", id } : { kind: "invalid", message: `Invalid API key. Get a free one at ${SERVICE_ORIGIN}/docs/api, or leave the Authorization header out: a key is optional.` };
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * The RapidAPI username, only when the request carries the listing's proxy
 * secret (RapidAPI adds both headers to every request it forwards). Without a
 * configured secret, or with a wrong one, this is null and the caller is
 * treated like anyone else, so X-RapidAPI-User cannot be forged to dodge the
 * per-client limit. Hashing first gives timingSafeEqual equal lengths.
 */
export async function verifiedRapidApiUser(request: Request, proxySecret: string | undefined): Promise<string | null> {
  if (!proxySecret) return null;
  const sent = request.headers.get("x-rapidapi-proxy-secret");
  const user = request.headers.get("x-rapidapi-user")?.trim();
  if (!sent || !user || user.length > 128) return null;
  const [a, b] = await Promise.all([sha256(sent), sha256(proxySecret)]);
  return crypto.subtle.timingSafeEqual(a, b) ? user : null;
}
