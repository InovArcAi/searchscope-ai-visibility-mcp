import { describe, expect, it } from "vitest";
import { assertPublicHostSyntax, assertPublicTarget, isBlockedIpLiteral, isSameSite, normaliseTargetUrl, parseIPv6, TargetError } from "../src/security/url";

const resolveFrom = (table: Record<string, string[]>) => async (h: string) => table[h] ?? [];

describe("normaliseTargetUrl", () => {
  it("accepts a valid public URL and a bare domain", () => {
    expect(normaliseTargetUrl("https://Example.com.au/path?x=1#frag").toString()).toBe("https://example.com.au/path?x=1");
    expect(normaliseTargetUrl("example.com.au").toString()).toBe("https://example.com.au/");
  });
  it("rejects malformed URLs", () => {
    expect(() => normaliseTargetUrl("")).toThrow(TargetError);
    expect(() => normaliseTargetUrl("http://")).toThrow(TargetError);
    expect(() => normaliseTargetUrl("not a url at all")).toThrow(TargetError);
  });
  it("rejects unsupported schemes, credentials and odd ports", () => {
    expect(() => normaliseTargetUrl("ftp://example.com")).toThrow(/Only http and https/);
    expect(() => normaliseTargetUrl("file:///etc/passwd")).toThrow(TargetError);
    expect(() => normaliseTargetUrl("https://user:pass@example.com")).toThrow(/credentials/);
    expect(() => normaliseTargetUrl("https://example.com:8080")).toThrow(/ports/);
  });
});

describe("assertPublicHostSyntax", () => {
  const bad = ["http://localhost/", "http://127.0.0.1/", "http://127.1.2.3/", "http://[::1]/", "http://10.0.0.1/", "http://172.16.5.5/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:10.0.0.1]/", "http://[64:ff9b::a00:1]/", "http://100.64.0.1/", "http://0.0.0.0/", "http://intranet/", "http://app.internal/", "http://printer.local/", "http://0x7f000001/", "http://2130706433/", "http://[2002:0a00:0001::1]/"];
  for (const u of bad) {
    it(`rejects ${u}`, () => {
      expect(() => assertPublicHostSyntax(new URL(u))).toThrow(TargetError);
    });
  }
  it("rejects public IP literals too (hostnames only)", () => {
    expect(() => assertPublicHostSyntax(new URL("http://93.184.216.34/"))).toThrow(/IP address targets/);
  });
  it("accepts public hostnames", () => {
    expect(() => assertPublicHostSyntax(new URL("https://searchscope.com.au/"))).not.toThrow();
  });
  it("holds discovered pages and redirect hops to the default ports, not just the initial target", () => {
    expect(() => assertPublicHostSyntax(new URL("https://example.org:8443/page"))).toThrow(/default http\/https ports/);
    expect(() => assertPublicHostSyntax(new URL("http://example.org:22/"))).toThrow(TargetError);
    expect(() => assertPublicHostSyntax(new URL("https://example.org:443/"))).not.toThrow();
  });
});

describe("IP literal classification", () => {
  it("parses compressed and mapped IPv6", () => {
    expect(parseIPv6("::1")?.groups).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[::ffff:192.168.0.1]")?.groups.slice(5)).toEqual([0xffff, 0xc0a8, 0x0001]);
  });
  it("flags private and reserved IPv4/IPv6, allows public", () => {
    expect(isBlockedIpLiteral("10.1.1.1")).toBe(true);
    expect(isBlockedIpLiteral("192.168.0.9")).toBe(true);
    expect(isBlockedIpLiteral("169.254.170.2")).toBe(true);
    expect(isBlockedIpLiteral("224.0.0.1")).toBe(true);
    expect(isBlockedIpLiteral("fc00::1")).toBe(true);
    expect(isBlockedIpLiteral("fd00:ec2::254")).toBe(true);
    expect(isBlockedIpLiteral("::")).toBe(true);
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
    expect(isBlockedIpLiteral("2606:4700::1111")).toBe(false);
  });
});

describe("assertPublicTarget (DNS layer)", () => {
  it("accepts a host that resolves to a public address", async () => {
    await expect(assertPublicTarget(new URL("https://good.example.org/"), { resolve: resolveFrom({ "good.example.org": ["93.184.216.34"] }) })).resolves.toBeUndefined();
  });
  it("rejects a host that resolves to a private IPv4 (rebinding)", async () => {
    await expect(assertPublicTarget(new URL("https://rebind.example.org/"), { resolve: resolveFrom({ "rebind.example.org": ["93.184.216.34", "10.0.0.1"] }) })).rejects.toThrow(/non-public address/);
  });
  it("rejects a host that resolves to a private IPv6", async () => {
    await expect(assertPublicTarget(new URL("https://v6.example.org/"), { resolve: resolveFrom({ "v6.example.org": ["fd12::1"] }) })).rejects.toThrow(/non-public address/);
  });
  it("rejects a host that resolves to a cloud metadata address", async () => {
    await expect(assertPublicTarget(new URL("https://meta.example.org/"), { resolve: resolveFrom({ "meta.example.org": ["169.254.169.254"] }) })).rejects.toThrow(/non-public address/);
  });
  it("fails closed when the host does not resolve", async () => {
    await expect(assertPublicTarget(new URL("https://nowhere.example.org/"), { resolve: resolveFrom({}) })).rejects.toThrow(/does not resolve/);
    await expect(assertPublicTarget(new URL("https://boom.example.org/"), { resolve: async () => { throw new Error("dns down"); } })).rejects.toThrow(/Could not resolve/);
  });
  it("refuses to audit itself", async () => {
    await expect(assertPublicTarget(new URL("https://auditor.workers.dev/"), { resolve: resolveFrom({ "auditor.workers.dev": ["1.1.1.1"] }), selfHostnames: ["auditor.workers.dev"] })).rejects.toThrow(/audit itself/);
  });
  it("only allows loopback in dev mode", async () => {
    await expect(assertPublicTarget(new URL("http://localhost/"), { resolve: resolveFrom({}) })).rejects.toThrow(TargetError);
    await expect(assertPublicTarget(new URL("http://localhost/"), { resolve: resolveFrom({}), devAllowLoopbackTargets: true })).resolves.toBeUndefined();
  });
});

describe("isSameSite", () => {
  it("treats www and apex as the same site, other hosts as different", () => {
    expect(isSameSite(new URL("https://www.a.com/"), new URL("https://a.com/x"))).toBe(true);
    expect(isSameSite(new URL("https://blog.a.com/"), new URL("https://a.com/"))).toBe(false);
  });
});
