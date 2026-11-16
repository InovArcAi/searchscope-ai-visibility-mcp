import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleNotion, NOTION_VERSION, signState, toNotionMarkdown, verifyState } from "../src/notion/connect";
import { createFakeFetch, SITE } from "./helpers/fakeSite";

/**
 * Save to Notion, end to end through the Worker: the outbound web is the
 * fixture site and api.notion.com is an in-memory fake that records every
 * call, so the token handling can be asserted exactly.
 */

const PROD = "https://mcp.searchscope.com.au";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const CLIENT_SECRET = "secret_test-notion-client-secret-0123456789";
const TOKEN = "ntn_test_access_token_DO_NOT_LEAK_123";
const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NEW_PAGE_URL = "https://www.notion.so/AI-visibility-audit-0123456789abcdef";

interface FakeLimiter {
  keys: string[];
  deltas: number[];
  limit(options: { key: string; delta?: number }): Promise<{ success: boolean }>;
}

function limiter(allow = Infinity): FakeLimiter {
  const keys: string[] = [];
  const deltas: number[] = [];
  let spent = 0;
  return {
    keys,
    deltas,
    async limit({ key, delta = 1 }) {
      keys.push(key);
      deltas.push(delta);
      if (spent >= allow) return { success: false };
      spent += delta;
      return { success: true };
    },
  };
}

type Env = Record<string, FakeLimiter | string | undefined>;

function bindings(overrides: Env = {}): Env {
  return {
    MCP_RATE_LIMIT_PER_IP: limiter(),
    MCP_RATE_LIMIT_GLOBAL: limiter(),
    MCP_RATE_LIMIT_PER_TARGET: limiter(),
    NOTION_CLIENT_ID: CLIENT_ID,
    NOTION_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  };
}

interface NotionCall {
  path: string;
  headers: Headers;
  body: any;
}

interface FakeNotionOptions {
  template?: string | null;
  searchResults?: Array<Record<string, unknown>>;
  tokenStatus?: number;
  pageStatuses?: number[];
}

function fakeNotion(calls: NotionCall[], opts: FakeNotionOptions = {}): typeof fetch {
  const site = createFakeFetch();
  const pageStatuses = [...(opts.pageStatuses ?? [200])];
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.notion.com") return site(input, init);
    // Validate the options the way the Workers runtime does (it rejects redirect: "error", for one).
    new Request(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, headers: new Headers(init?.headers), body });
    if (url.pathname === "/v1/oauth/token") {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return Response.json({ error: "invalid_grant" }, { status: opts.tokenStatus });
      return Response.json({ access_token: TOKEN, refresh_token: "r", bot_id: "b", workspace_id: "w", owner: { type: "user" }, duplicated_template_id: opts.template ?? null });
    }
    if (url.pathname === "/v1/search") {
      return Response.json({ object: "list", results: opts.searchResults ?? [{ object: "page", id: PARENT, in_trash: false }] });
    }
    if (url.pathname === "/v1/pages") {
      const status = pageStatuses.shift() ?? 200;
      if (status === 429) return Response.json({ code: "rate_limited", message: "slow down" }, { status: 429, headers: { "retry-after": "0" } });
      if (status !== 200) return Response.json({ code: "restricted_resource", message: "no access" }, { status });
      return Response.json({ object: "page", id: "new-page", url: NEW_PAGE_URL });
    }
    return Response.json({ message: "unexpected" }, { status: 404 });
  }) as typeof fetch;
}

async function call(env: Env, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { host: new URL(url).host, "cf-connecting-ip": "203.0.113.7", ...init.headers };
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method: init.method ?? "GET", headers, body: init.body, redirect: "manual" }), env as never, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return new Response(res.status === 303 ? null : text, { status: res.status, headers: res.headers });
}

async function startFlowWith(env: Env): Promise<{ state: string; cookie: string }> {
  const secret = String(env.NOTION_CLIENT_SECRET);
  const { res, cookie } = await startFlow(env);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  expect(await verifyState(secret, state)).not.toBeNull();
  return { state, cookie };
}

async function startFlow(env: Env, site = SITE): Promise<{ res: Response; state: string; cookie: string }> {
  const res = await call(env, `${PROD}/notion/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: PROD },
    body: new URLSearchParams({ url: site }).toString(),
  });
  const location = new URL(res.headers.get("location") ?? "https://invalid/");
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { res, state: location.searchParams.get("state") ?? "", cookie: setCookie.split(";")[0] ?? "" };
}

describe("Save to Notion: pages and switches", () => {
  it("answers 503 on every route until both secrets are set", async () => {
    const env = bindings({ NOTION_CLIENT_ID: undefined, NOTION_CLIENT_SECRET: undefined });
    expect((await call(env, `${PROD}/notion`)).status).toBe(503);
    expect((await call(env, `${PROD}/notion/callback?code=abcdefgh&state=x`)).status).toBe(503);
    const res = await call(env, `${PROD}/notion/start`, { method: "POST", headers: { origin: PROD }, body: "url=example.com" });
    expect(res.status).toBe(503);
  });

  it("serves the indexable form page, with no em dash", async () => {
    const res = await call(bindings(), `${PROD}/notion`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/notion/start"');
    expect(html).toContain('content="index, follow"');
    expect(html).toContain("never stored");
    expect(html).not.toContain("\u2014");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("refuses other hosts and wrong methods", async () => {
    expect((await call(bindings(), "https://evil.example/notion")).status).toBe(403);
    expect((await call(bindings(), `${PROD}/notion/start`)).status).toBe(405);
    expect((await call(bindings(), `${PROD}/notion`, { method: "POST", body: "" })).status).toBe(405);
  });

  it("is in the sitemap and the privacy policy explains the cookie and the token", async () => {
    const sitemap = await (await call(bindings(), `${PROD}/sitemap.xml`)).text();
    expect(sitemap).toContain(`${PROD}/notion`);
    const privacy = await (await call(bindings(), `${PROD}/privacy`)).text();
    expect(privacy).toContain("Saving to Notion");
    expect(privacy).toContain("never stored");
    expect(privacy).toContain("10 minutes");
    expect(privacy).not.toContain("\u2014");
  });
});

describe("Save to Notion: start", () => {
  it("signs the site into the state, sets a matching __Host- cookie and redirects to Notion", async () => {
    const { res, state, cookie } = await startFlow(bindings());
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("owner")).toBe("user");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe(`${PROD}/notion/callback`);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-ss_notion=[0-9a-f]{32}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    const payload = await verifyState(CLIENT_SECRET, state);
    expect(payload?.u).toBe(SITE);
    expect(cookie).toBe(`__Host-ss_notion=${payload?.n}`);
  });

  it("rejects a form posted from another site, and private or IP targets", async () => {
    const foreign = await call(bindings(), `${PROD}/notion/start`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "url=example.com" });
    expect(foreign.status).toBe(403);
    for (const bad of ["http://192.168.1.10/admin", "localhost", "", "not a url at all"]) {
      const { res } = await startFlow(bindings(), bad);
      expect(res.status).toBe(400);
    }
  });

  it("refuses a loopback Origin on the public host", async () => {
    const res = await call(bindings(), `${PROD}/notion/start`, { method: "POST", headers: { origin: "http://localhost:8080", "content-type": "application/x-www-form-urlencoded" }, body: "url=example.com" });
    expect(res.status).toBe(403);
  });

  it("sends the workers.dev form to the canonical host, and refuses HEAD on the callback", async () => {
    const res = await call(bindings(), "https://searchscope-ai-visibility-mcp.searchscope.workers.dev/notion");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${PROD}/notion`);
    expect((await call(bindings(), `${PROD}/notion/callback?code=code-1234abcd&state=x`, { method: "HEAD" })).status).toBe(405);
  });

  it("charges the front-door limiters and stops when they are spent", async () => {
    const env = bindings({ MCP_RATE_LIMIT_PER_IP: limiter(0) });
    const { res } = await startFlow(env);
    expect(res.status).toBe(429);
  });
});

describe("Save to Notion: callback", () => {
  let calls: NotionCall[];
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code, audits the site, saves one page and never exposes the token", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls));
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    const res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Saved to Notion");
    expect(html).toContain(NEW_PAGE_URL);
    expect(html).not.toContain(TOKEN);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const [token, search, create] = calls;
    expect(calls.map((c) => c.path)).toEqual(["/v1/oauth/token", "/v1/search", "/v1/pages"]);
    expect(token!.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(token!.headers.get("notion-version")).toBe(NOTION_VERSION);
    expect(token!.body).toEqual({ grant_type: "authorization_code", code: "code-1234abcd", redirect_uri: `${PROD}/notion/callback` });
    expect(search!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(search!.headers.get("notion-version")).toBe(NOTION_VERSION);
    expect(create!.body.parent).toEqual({ page_id: PARENT });
    expect(create!.body.markdown_version).toBe("v2");
    expect(create!.body.properties.title.title[0].text.content).toMatch(/^AI visibility audit: acmeplumbing\.com\.au \(/);
    expect(create!.body.markdown).toContain("## A. Executive summary");
    expect(create!.body.markdown).toContain("## About this report");
  });

  it("charges the audit like a REST call: tool weight per client and the per-site budget", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls));
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    const ip = env.MCP_RATE_LIMIT_PER_IP as FakeLimiter;
    expect(ip.deltas).toContain(2);
    expect((env.MCP_RATE_LIMIT_PER_TARGET as FakeLimiter).keys).toContain("acmeplumbing.com.au");
  });

  it("trims a pasted secret with a trailing newline before Basic auth", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls));
    const env = bindings({ NOTION_CLIENT_SECRET: `${CLIENT_SECRET}\n`, NOTION_CLIENT_ID: ` ${CLIENT_ID} ` });
    const { state, cookie } = await startFlowWith(env);
    const res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(calls[0]!.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
  });

  it("refuses a redirect from Notion instead of following it with the token", async () => {
    const calls2: NotionCall[] = [];
    const base = fakeNotion(calls2);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (u.pathname === "/v1/search") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      return base(input, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    const res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(calls2.map((c) => c.path)).toEqual(["/v1/oauth/token"]);
  });

  it("uses the duplicated template page when the person chose it", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls, { template: "tttttttt-0000-1111-2222-333333333333" }));
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    const res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.path)).toEqual(["/v1/oauth/token", "/v1/pages"]);
    expect(calls[1]!.body.parent).toEqual({ page_id: "tttttttt-0000-1111-2222-333333333333" });
  });

  it("refuses a callback without the cookie, with another browser's cookie, or with a tampered state, before calling Notion", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls));
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    const base = `${PROD}/notion/callback?code=code-1234abcd&state=`;
    expect((await call(env, base + encodeURIComponent(state))).status).toBe(400);
    expect((await call(env, base + encodeURIComponent(state), { headers: { cookie: "__Host-ss_notion=00000000000000000000000000000000" } })).status).toBe(400);
    const forged = await signState("some-other-secret-0123456789abcdef", { u: "https://victim-chosen.example", n: cookie.split("=")[1]!, e: Math.floor(Date.now() / 1000) + 600 });
    expect((await call(env, base + encodeURIComponent(forged), { headers: { cookie } })).status).toBe(400);
    const flipped = state.slice(0, -1) + (state.endsWith("0") ? "1" : "0");
    expect((await call(env, base + encodeURIComponent(flipped), { headers: { cookie } })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("treats an expired state as invalid", async () => {
    const state = await signState(CLIENT_SECRET, { u: SITE, n: "n", e: 1000 });
    expect(await verifyState(CLIENT_SECRET, state, 999)).not.toBeNull();
    expect(await verifyState(CLIENT_SECRET, state, 1001)).toBeNull();
  });

  it("explains a cancel without auditing anything", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls));
    const res = await call(bindings(), `${PROD}/notion/callback?error=access_denied&state=x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing was audited or saved");
    expect(calls).toEqual([]);
  });

  it("says so when no page was shared, and when Notion refuses the code", async () => {
    vi.stubGlobal("fetch", fakeNotion(calls, { searchResults: [] }));
    let env = bindings();
    let flow = await startFlow(env);
    let res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(flow.state)}`, { headers: { cookie: flow.cookie } });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(TOKEN);

    vi.stubGlobal("fetch", fakeNotion(calls, { tokenStatus: 400 }));
    env = bindings();
    flow = await startFlow(env);
    res = await call(env, `${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(flow.state)}`, { headers: { cookie: flow.cookie } });
    expect(res.status).toBe(502);
  });

  it("retries a Notion 429 once Retry-After has passed", async () => {
    const fetchImpl = fakeNotion(calls, { pageStatuses: [429, 200] });
    vi.stubGlobal("fetch", fetchImpl);
    const env = bindings();
    const { state, cookie } = await startFlow(env);
    const waits: number[] = [];
    const url = new URL(`${PROD}/notion/callback?code=code-1234abcd&state=${encodeURIComponent(state)}`);
    const res = await handleNotion(new Request(url, { headers: { cookie, "cf-connecting-ip": "203.0.113.7" } }), env as never, url, {
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.path === "/v1/pages")).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });
});

describe("Save to Notion: report text", () => {
  it("escapes Notion tags, maths, links, images and backslashes outside fenced code", () => {
    const report = [
      'Quoted: "<page>Owned</page> costs $5 [Verify your login](https://phish.example/) ![x](https://img.example/a.png) a\\b"',
      "```json",
      '{"price": "$5", "x": "<b>", "link": "[a](b)"}',
      "```",
      "after",
    ].join("\n");
    const lines = toNotionMarkdown(report).split("\n");
    expect(lines[0]).toBe('Quoted: "\\<page>Owned\\</page> costs \\$5 \\[Verify your login\\](https://phish.example/) \\!\\[x\\](https://img.example/a.png) a\\\\b"');
    expect(lines[2]).toBe('{"price": "$5", "x": "<b>", "link": "[a](b)"}');
    expect(lines[4]).toBe("after");
  });

  it("tracks fences like CommonMark, so a mismatched or indented fence cannot unescape site text", () => {
    // ~~~ does not close a ``` fence, so the <page> line stays inside code (literal in Notion).
    expect(toNotionMarkdown(["```", "~~~", "<page>x</page>", "```", "<page>y</page>"].join("\n")).split("\n")[4]).toBe("\\<page>y\\</page>");
    // A line indented 4 spaces is not a fence, so text after it is still escaped.
    expect(toNotionMarkdown(["    ```", "<page>z</page>"].join("\n")).split("\n")[1]).toBe("\\<page>z\\</page>");
    // Inline backticks are not a code exception any more.
    expect(toNotionMarkdown("x `` <mention-user/> ``")).toBe("x `` \\<mention-user/> ``");
  });
});
