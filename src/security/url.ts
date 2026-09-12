/**
 * SSRF protection for user-supplied URLs.
 *
 * Every URL the auditor fetches (initial target, every redirect hop, every
 * discovered page, every sitemap) passes through `assertPublicTarget` first.
 * The checks are layered:
 *   1. syntactic: scheme, credentials, port, hostname shape
 *   2. hostname deny-list: loopback, link-local, .local/.internal/.arpa, metadata hosts
 *   3. IP literal deny-list: private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped IPv6
 *   4. DNS-over-HTTPS resolution of the hostname and the same IP deny-list on every answer
 *
 * Step 4 is what defeats DNS rebinding style tricks (public hostname resolving to 10.x).
 * If resolution fails, the target is rejected (fail closed).
 */

export class TargetError extends Error {
  constructor(
    public readonly code:
      | "invalid_url"
      | "unsupported_scheme"
      | "credentials_in_url"
      | "blocked_port"
      | "blocked_host"
      | "blocked_ip"
      | "unresolvable_host"
      | "off_site",
    message: string,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
  ".onion",
  ".test",
  ".example",
  ".invalid",
];

/** Well-known cloud metadata / control-plane addresses, checked as literals and as DNS answers. */
const BLOCKED_IP_LITERALS = new Set([
  "169.254.169.254", // AWS, Azure, GCP, OpenStack metadata
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud metadata
  "192.0.0.192", // Oracle Cloud metadata
  "fd00:ec2::254", // AWS IMDS IPv6
]);

export interface ParsedIPv4 {
  kind: "v4";
  octets: [number, number, number, number];
}
export interface ParsedIPv6 {
  kind: "v6";
  /** eight 16-bit groups */
  groups: number[];
}

export function parseIPv4(text: string): ParsedIPv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return { kind: "v4", octets: octets as [number, number, number, number] };
}

export function parseIPv6(text: string): ParsedIPv6 | null {
  let s = text.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;

  // Embedded IPv4 tail (e.g. ::ffff:192.168.0.1)
  let tailGroups: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    tailGroups = [(v4.octets[0] << 8) | v4.octets[1], (v4.octets[2] << 8) | v4.octets[3]];
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const parts = s.split("::");
  if (parts.length > 2) return null;
  const toGroups = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const out: number[] = [];
    for (const g of chunk.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(parts[0] ?? "");
  const rest = parts.length === 2 ? toGroups(parts[1] ?? "") : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (parts.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tailGroups.length) {
    groups[6] = tailGroups[0] ?? 0;
    groups[7] = tailGroups[1] ?? 0;
  }
  return { kind: "v6", groups };
}

function inV4Range(o: [number, number, number, number], base: [number, number, number, number], bits: number): boolean {
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const b = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

const BLOCKED_V4: Array<[[number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // RFC1918
  [[100, 64, 0, 0], 10], // CGNAT (also used internally by many clouds)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local + metadata
  [[172, 16, 0, 0], 12], // RFC1918
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16], // RFC1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

export function isBlockedIPv4(ip: ParsedIPv4): boolean {
  if (BLOCKED_IP_LITERALS.has(ip.octets.join("."))) return true;
  return BLOCKED_V4.some(([base, bits]) => inV4Range(ip.octets, base, bits));
}

export function isBlockedIPv6(ip: ParsedIPv6): boolean {
  const g = ip.groups;
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const first = g[0] ?? 0;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIPv4(v4FromGroups(g[6] ?? 0, g[7] ?? 0));
  }
  // NAT64 64:ff9b::/96
  if (first === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(v4FromGroups(g[6] ?? 0, g[7] ?? 0));
  }
  // 6to4 2002::/16 embeds the IPv4 address in groups 1-2
  if (first === 0x2002) return isBlockedIPv4(v4FromGroups(g[1] ?? 0, g[2] ?? 0));
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (first === 0x2001 && g[1] === 0x0000) return true; // Teredo (embeds client IPv4)
  if (BLOCKED_IP_LITERALS.has(formatV6(g))) return true;
  return false;
}

function v4FromGroups(hi: number, lo: number): ParsedIPv4 {
  return { kind: "v4", octets: [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff] };
}

function formatV6(groups: number[]): string {
  // Only used for literal comparison against BLOCKED_IP_LITERALS; produce the
  // canonical compressed form for the few entries we care about.
  const hex = groups.map((x) => x.toString(16));
  const s = hex.join(":");
  return s.replace(/(^|:)0(:0)+(:|$)/, "::").replace(/^::0$/, "::");
}

/** True when the string is an IP literal (v4 or bracketed/unbracketed v6) that must not be fetched. */
export function isBlockedIpLiteral(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(host);
  if (v6) return isBlockedIPv6(v6);
  return false;
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (!h.includes(".")) return true; // single-label names are never public sites
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (/^(metadata|instance-data|169\.254|localhost)/.test(h)) return true;
  return false;
}

/**
 * Parse and normalise a user-supplied URL without any network access.
 * Accepts bare domains ("example.com") by assuming https.
 */
export function normaliseTargetUrl(input: string): URL {
  const raw = (input ?? "").trim();
  if (!raw) throw new TargetError("invalid_url", "URL is empty.");
  if (raw.length > 2048) throw new TargetError("invalid_url", "URL is too long.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TargetError("invalid_url", `"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetError("unsupported_scheme", `Only http and https URLs are supported (got ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new TargetError("credentials_in_url", "URLs containing credentials are not allowed.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new TargetError("blocked_port", "Only the default http/https ports are allowed.");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (!url.hostname) throw new TargetError("invalid_url", "URL has no hostname.");
  return url;
}

/**
 * Syntactic + literal checks. Throws for anything that is obviously not a public
 * website. Does not touch the network.
 */
export function assertPublicHostSyntax(url: URL): void {
  const host = url.hostname;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIpLiteral(bare)) {
    if (isBlockedIpLiteral(bare)) {
      throw new TargetError("blocked_ip", `${host} is a private, loopback, link-local or reserved address.`);
    }
    // Public IP literals are technically reachable but are never a real marketing site.
    throw new TargetError("blocked_host", "IP address targets are not supported; supply a hostname.");
  }
  if (isBlockedHostname(host)) {
    throw new TargetError("blocked_host", `${host} is not a public hostname.`);
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
}

/**
 * Resolve A and AAAA records through Cloudflare's DNS-over-HTTPS JSON API.
 * Workers cannot perform raw DNS lookups; this is the supported approach.
 */
export function createDohResolver(fetchImpl: typeof fetch = fetch): Resolver {
  return async (hostname: string): Promise<string[]> => {
    const lookup = async (type: "A" | "AAAA"): Promise<string[]> => {
      const u = new URL("https://cloudflare-dns.com/dns-query");
      u.searchParams.set("name", hostname);
      u.searchParams.set("type", type);
      const res = await fetchImpl(u.toString(), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
      if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];
      const want = type === "A" ? 1 : 28;
      return body.Answer.filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data as string);
    };
    const [a, aaaa] = await Promise.all([lookup("A").catch(() => []), lookup("AAAA").catch(() => [])]);
    return [...a, ...aaaa];
  };
}

export interface TargetPolicy {
  resolve: Resolver;
  /** Optional: hostnames that are the auditor itself (never audit yourself). */
  selfHostnames?: string[];
  /**
   * Development only. When true AND the incoming request came from a loopback
   * host (wrangler dev), loopback targets are permitted so a local mock site can
   * be audited. Never set in production; the loopback-origin guard makes it inert
   * on workers.dev or a custom domain anyway.
   */
  devAllowLoopbackTargets?: boolean;
}

/** In-memory per-request cache so a host is resolved once per audit. */
export function cachedResolver(inner: Resolver): Resolver {
  const cache = new Map<string, Promise<string[]>>();
  return (hostname) => {
    let p = cache.get(hostname);
    if (!p) {
      p = inner(hostname);
      cache.set(hostname, p);
    }
    return p;
  };
}

/**
 * Full validation: syntax, hostname deny-list, DNS resolution and IP deny-list.
 * Throws TargetError on rejection.
 */
export async function assertPublicTarget(url: URL, policy: TargetPolicy): Promise<void> {
  const host = url.hostname;
  if (policy.devAllowLoopbackTargets && (host === "localhost" || host === "127.0.0.1")) return;
  assertPublicHostSyntax(url);
  if (policy.selfHostnames?.includes(host)) {
    throw new TargetError("blocked_host", "The auditor cannot audit itself.");
  }
  let ips: string[];
  try {
    ips = await policy.resolve(host);
  } catch {
    throw new TargetError("unresolvable_host", `Could not resolve ${host}.`);
  }
  if (ips.length === 0) throw new TargetError("unresolvable_host", `${host} does not resolve to any address.`);
  for (const ip of ips) {
    if (isBlockedIpLiteral(ip)) {
      throw new TargetError("blocked_ip", `${host} resolves to a non-public address and was rejected.`);
    }
  }
}

/** Registrable-site check: same host, ignoring a leading "www.". */
export function isSameSite(a: URL, b: URL): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a.hostname) === strip(b.hostname);
}
