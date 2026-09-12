/**
 * In-memory fake of a small business website plus a fake DNS-over-HTTPS
 * endpoint, exposed as a `fetch`-compatible function. Used both directly
 * (unit tests) and via `vi.stubGlobal("fetch", ...)` for end-to-end MCP tests.
 */

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  /** Omit content-length even though body is known (forces streaming cap path). */
  noLength?: boolean;
}

export const SITE = "https://www.acmeplumbing.com.au";

const NAV = `<header><nav><a href="/">Home</a><a href="/about/">About</a><a href="/services/blocked-drains/">Blocked Drains</a><a href="/services/hot-water/">Hot Water Systems</a><a href="/pricing/">Pricing</a><a href="/blog/">Blog</a><a href="/contact/">Contact</a><a href="/brochure.pdf">Brochure</a><a href="/privacy/">Privacy</a></nav></header>`;
const FOOTER = `<footer><p>Acme Plumbing Pty Ltd, ABN 12 345 678 901. 12 Example Street, Victoria Park WA 6100. Call 08 9123 4567.</p><p>© 2026 Acme Plumbing. All rights reserved.</p><a href="https://www.facebook.com/acmeplumbing">Facebook</a><a href="https://www.instagram.com/acmeplumbing">Instagram</a></footer>`;

function page(title: string, body: string, extraHead = ""): string {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title} description"><meta property="og:site_name" content="Acme Plumbing">${extraHead}<script>window.x = 1;</script><style>.a{}</style></head><body>${NAV}<main>${body}</main>${FOOTER}</body></html>`;
}

const HOME_LD = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Plumber",
  name: "Acme Plumbing",
  url: SITE,
  telephone: "+61 8 9123 4567",
  founder: { "@type": "Person", name: "John Smith", jobTitle: "Founder and licensed plumber" },
  address: { "@type": "PostalAddress", streetAddress: "12 Example Street", addressLocality: "Victoria Park", addressRegion: "WA", postalCode: "6100", addressCountry: "AU" },
  areaServed: ["Perth", "Fremantle"],
  sameAs: ["https://www.facebook.com/acmeplumbing", "https://www.linkedin.com/company/acmeplumbing"],
  hasOfferCatalog: { "@type": "OfferCatalog", itemListElement: [{ "@type": "Offer", itemOffered: { "@type": "Service", name: "Blocked drain clearing" } }] },
})}</script>`;

export const ROUTES: Record<string, Route> = {
  [`${SITE}/`]: {
    body: page(
      "Acme Plumbing | Perth Plumber",
      `<h1>Perth plumbers for blocked drains and hot water</h1>
       <p>Acme Plumbing is a licensed plumbing company based in Victoria Park that provides blocked drain clearing, hot water system replacement and general plumbing repairs across Perth, with same-day service and upfront pricing from $150.</p>
       <h2>How quickly can a plumber get to me in Perth?</h2>
       <p>We reach most Perth suburbs within 60 minutes of your call between 7am and 7pm, and we carry parts for the 12 most common hot water systems so 80% of repairs are finished on the first visit.</p>
       <h2>Our services</h2>
       <ul><li><a href="/services/blocked-drains/">Blocked drain clearing</a> with CCTV inspection</li><li><a href="/services/hot-water/">Hot water system replacement</a> for gas and electric units</li></ul>
       <h2>Why choose us</h2>
       <p>Fast.</p><p>Reliable.</p>
       <div class="testimonial"><p>"Fixed our drain in an hour." Sarah, Como</p></div>
       <p>Read our <a href="/blog/how-to-fix-a-blocked-drain/">guide to fixing a blocked drain</a> or <a href="/blog/how-to-fix-a-blocked-drain/">learn more</a>.</p>
       <p><a href="/contact/">Contact us</a> or <a href="/about/">click here</a>.</p>`,
      HOME_LD,
    ),
  },
  [`${SITE}/about/`]: {
    body: page(
      "About Us | Acme Plumbing",
      `<h1>About Acme Plumbing</h1>
       <p>Acme Plumbing was founded in 2009 by John Smith, a licensed plumber (PL 1234) and member of Master Plumbers WA, and now runs four vans across Perth.</p>
       <p>John Smith is the founder and managing director. Our team has 40 years of combined experience and we are rated 4.9 stars on Google reviews from 312 reviews.</p>
       <p><a href="/services/blocked-drains/">See our blocked drain service</a>.</p>`,
    ),
  },
  [`${SITE}/services/blocked-drains/`]: {
    body: page(
      "Blocked Drain Clearing Perth | Acme Plumbing",
      `<h1>Blocked drain clearing in Perth</h1>
       <p>Book now.</p>
       <h2>How much does blocked drain clearing cost?</h2>
       <p>It depends on many factors, contact us to find out.</p>
       <h2>What causes blocked drains?</h2>
       <h2>Do you use CCTV?</h2>
       <p>Yes, every blocked drain job includes a CCTV camera inspection so you can see the cause, and jetting from $220 clears 95% of tree root intrusions in under two hours.</p>`,
    ),
  },
  [`${SITE}/services/hot-water/`]: {
    body: page(
      "Hot Water System Replacement | Acme Plumbing",
      `<h1>Hot water system replacement</h1>
       <p>We supply and install Rheem and Rinnai gas and electric hot water systems across Perth, usually same day, with installed prices from $1,450 for a 135 litre electric unit.</p>
       <p>Read <a href="/blog/how-to-fix-a-blocked-drain/">our drain guide</a>.</p>`,
    ),
  },
  [`${SITE}/pricing/`]: {
    body: page("Pricing | Acme Plumbing", `<h1>Plumbing prices</h1><p>Call-out fee $99. Blocked drains from $150. Hot water replacement from $1,450. All prices include GST and a 12 month workmanship warranty.</p>`),
  },
  [`${SITE}/blog/`]: {
    body: page("Blog | Acme Plumbing", `<h1>Plumbing guides</h1><ul><li><a href="/blog/how-to-fix-a-blocked-drain/">How to fix a blocked drain</a></li></ul>`),
  },
  [`${SITE}/blog/how-to-fix-a-blocked-drain/`]: {
    body: page(
      "How to Fix a Blocked Drain | Acme Plumbing",
      `<article><h1>How to fix a blocked drain</h1>
       <p class="byline">By John Smith, 3 March 2026</p>
       <p>A blocked drain is a pipe that no longer carries wastewater away at its normal rate because of a physical obstruction such as grease, hair, wipes or tree roots.</p>
       <h2>What is the fastest way to clear a blocked drain?</h2>
       <p>The fastest safe method is a plunger followed by a drain snake; in our data from 1,200 jobs in 2025, 62% of kitchen blockages cleared with a snake alone.</p>
       <p>Water Corporation guidance on what not to flush is <a href="https://www.watercorporation.com.au/help/what-not-to-flush">published here</a>.</p>
       <p>Need a hand? Our <a href="/services/blocked-drains/">blocked drain service</a> is available today.</p></article>`,
      `<meta property="article:published_time" content="2026-03-03T09:00:00+08:00"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"How to fix a blocked drain","author":{"@type":"Person","name":"John Smith"},"datePublished":"2026-03-03"}</script>`,
    ),
  },
  [`${SITE}/blog/orphan-guide/`]: {
    body: page("Hot water maintenance checklist | Acme Plumbing", `<h1>Hot water maintenance checklist</h1><p>Flush the tank every 12 months, test the pressure relief valve every 6 months and replace the sacrificial anode every 5 years to extend the life of a storage hot water system beyond 15 years.</p>`),
  },
  [`${SITE}/contact/`]: {
    body: page("Contact | Acme Plumbing", `<h1>Contact Acme Plumbing</h1><p>Email hello@acmeplumbing.com.au or call 08 9123 4567. We are at 12 Example Street, Victoria Park WA 6100.</p><form><input name="q"></form>`),
  },
  [`${SITE}/privacy/`]: { body: page("Privacy Policy | Acme Plumbing", `<h1>Privacy</h1><p>Policy text.</p>`) },
  [`${SITE}/brochure.pdf`]: { headers: { "content-type": "application/pdf" }, body: "%PDF-1.4 fake" },
  [`${SITE}/huge/`]: { headers: { "content-type": "text/html", "content-length": String(5_000_000) }, body: "<html><body>tiny</body></html>" },
  [`${SITE}/huge-stream/`]: { noLength: true, body: `<html><body><p>${"x".repeat(2_000_000)}</p></body></html>` },
  [`${SITE}/slow/`]: { delayMs: 30_000, body: page("Slow", "<h1>Slow</h1>") },
  [`${SITE}/redirect-private/`]: { status: 302, headers: { location: "http://10.0.0.5/admin" } },
  [`${SITE}/redirect-metadata/`]: { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
  [`${SITE}/redirect-rebind/`]: { status: 302, headers: { location: "https://evil.rebind.net/" } },
  [`${SITE}/redirect-loop/`]: { status: 302, headers: { location: `${SITE}/redirect-loop/` } },
  [`${SITE}/redirect-ok/`]: { status: 301, headers: { location: `${SITE}/pricing/` } },
  [`${SITE}/robots.txt`]: {
    headers: { "content-type": "text/plain" },
    body: `User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
  },
  [`${SITE}/sitemap.xml`]: {
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/post-sitemap.xml</loc></sitemap></sitemapindex>`,
  },
  [`${SITE}/page-sitemap.xml`]: {
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about/", "/services/blocked-drains/", "/services/hot-water/", "/pricing/", "/contact/", "/privacy/"].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("")}</urlset>`,
  },
  [`${SITE}/post-sitemap.xml`]: {
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/blog/how-to-fix-a-blocked-drain/</loc></url><url><loc>${SITE}/blog/orphan-guide/</loc></url><url><loc>${SITE}/blog/orphan-guide/?utm_source=x</loc></url></urlset>`,
  },
  "https://acmeplumbing.com.au/": { status: 301, headers: { location: `${SITE}/` } },
  "https://evil.rebind.net/": { body: page("Evil", "<h1>Evil</h1>") },
  "https://ipv6-internal.net/": { body: page("v6", "<h1>v6</h1>") },
};

export const DNS: Record<string, string[]> = {
  "www.acmeplumbing.com.au": ["93.184.216.34"],
  "acmeplumbing.com.au": ["93.184.216.34"],
  "evil.rebind.net": ["10.0.0.1"],
  "ipv6-internal.net": ["fd12:3456::1"],
  "public-v6.net": ["2606:4700::1111"],
  "watercorporation.com.au": ["93.184.216.35"],
  "www.watercorporation.com.au": ["93.184.216.35"],
};

function abortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export interface FakeFetchOptions {
  routes?: Record<string, Route>;
  dns?: Record<string, string[]>;
  /** Records every URL requested, for assertions. */
  log?: string[];
}

export function createFakeFetch(opts: FakeFetchOptions = {}): typeof fetch {
  const routes = opts.routes ?? ROUTES;
  const dns = opts.dns ?? DNS;
  const log = opts.log ?? [];
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    log.push(url);
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      const name = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type") === "AAAA" ? 28 : 1;
      const ips = dns[name] ?? [];
      const answers = ips.filter((ip) => (ip.includes(":") ? type === 28 : type === 1)).map((ip) => ({ name, type, TTL: 60, data: ip }));
      return Response.json({ Status: 0, Answer: answers });
    }
    const route = routes[url] ?? routes[url.replace(/\/$/, "")] ?? routes[`${url}/`];
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    if (route.delayMs) await abortable(route.delayMs, init?.signal);
    const headers = new Headers({ "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) });
    const body = route.body ?? "";
    if (!route.noLength && !headers.has("content-length") && body) headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
    const status = route.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  }) as typeof fetch;
}
