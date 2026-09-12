import type { Block, BlockKind, JsonLdNode, LinkData, ParsedPage } from "./types";
import { isSameSite } from "../security/url";

/**
 * Extract audit signals from an HTML document using the Workers-native
 * HTMLRewriter (streaming, no JavaScript execution, no external parser).
 *
 * The document is read as a linear sequence of blocks (headings, paragraphs,
 * list items, quotes, cells) in reading order. That ordering is what the
 * retrievability analysis needs: "which passage follows this question heading".
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "select", "option", "textarea", "canvas", "math"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const BLOCK_TAGS: Record<string, BlockKind | "flush"> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h4",
  h6: "h4",
  p: "p",
  li: "li",
  dt: "li",
  dd: "p",
  blockquote: "quote",
  figcaption: "p",
  td: "cell",
  th: "cell",
  div: "flush",
  section: "flush",
  article: "flush",
  main: "flush",
  tr: "flush",
  br: "flush",
  hr: "flush",
  summary: "flush",
  details: "flush",
  ul: "flush",
  ol: "flush",
  table: "flush",
  form: "flush",
  label: "flush",
  button: "flush",
  pre: "flush",
};

const DATE_RE = /\b(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/g;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

export function extractJsonLdTypes(node: unknown): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!v || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
    const t = obj["@type"];
    if (typeof t === "string") out.push({ type: [t], raw: obj });
    else if (Array.isArray(t)) out.push({ type: t.filter((x): x is string => typeof x === "string"), raw: obj });
    // Nested entities that carry their own @type (e.g. Organization.address, author)
    for (const [k, val] of Object.entries(obj)) {
      if (k === "@graph") continue;
      if (val && typeof val === "object") visit(val);
    }
  };
  visit(node);
  return out;
}

export async function parsePage(url: string, html: string, truncated = false): Promise<ParsedPage> {
  const base = new URL(url);
  const page: ParsedPage = {
    url,
    lang: "",
    title: "",
    metaDescription: "",
    metaRobots: "",
    canonical: "",
    ogSiteName: "",
    ogType: "",
    metaAuthor: "",
    publishedTime: "",
    modifiedTime: "",
    datesInText: [],
    blocks: [],
    headings: { h1: [], h2: [], h3: [] },
    paragraphs: [],
    wordCount: 0,
    links: [],
    jsonLd: [],
    authorTexts: [],
    images: 0,
    imagesWithAlt: 0,
    lists: 0,
    tables: 0,
    forms: 0,
    testimonialElements: 0,
    footerText: "",
    truncated,
  };

  let skipDepth = 0;
  let inHead = false;
  let chromeDepth = 0;
  let navDepth = 0;
  let footerDepth = 0;
  let buffer = "";
  let currentKind: BlockKind = "p";
  let titleBuf = "";
  let jsonLdBuf: string | null = null;
  let footerBuf = "";
  const openAnchors: LinkData[] = [];
  const authorCaptures: string[] = [];
  let authorOpen = 0;

  const flush = (kind: BlockKind = currentKind): void => {
    const text = clean(decodeEntities(buffer));
    buffer = "";
    if (!text) return;
    page.blocks.push({ kind, text, chrome: chromeDepth > 0 });
  };

  const guardedEndTag = (el: Element, cb: () => void): void => {
    if (VOID_TAGS.has(el.tagName)) return;
    try {
      el.onEndTag(cb);
    } catch {
      /* lol-html refuses end-tag handlers on some elements; ignore */
    }
  };

  const rewriter = new HTMLRewriter()
    .on("html", {
      element(el) {
        page.lang = el.getAttribute("lang") ?? "";
      },
    })
    .on("head", {
      element() {
        inHead = true;
      },
    })
    .on("body", {
      element() {
        inHead = false;
      },
    })
    .on("title", {
      text(t) {
        titleBuf += t.text;
        if (t.lastInTextNode && !page.title) page.title = clean(decodeEntities(titleBuf));
      },
    })
    .on("meta", {
      element(el) {
        const name = (el.getAttribute("name") ?? el.getAttribute("property") ?? "").toLowerCase();
        const content = decodeEntities(el.getAttribute("content") ?? "").trim();
        if (!name || !content) return;
        switch (name) {
          case "description":
            if (!page.metaDescription) page.metaDescription = clean(content);
            break;
          case "robots":
          case "googlebot":
            page.metaRobots = page.metaRobots ? `${page.metaRobots}, ${content}` : content;
            break;
          case "author":
            page.metaAuthor = clean(content);
            break;
          case "og:site_name":
            page.ogSiteName = clean(content);
            break;
          case "og:type":
            page.ogType = clean(content);
            break;
          case "article:published_time":
          case "datepublished":
            page.publishedTime = content;
            break;
          case "article:modified_time":
          case "og:updated_time":
          case "datemodified":
            page.modifiedTime = content;
            break;
          default:
            break;
        }
      },
    })
    .on("link[rel]", {
      element(el) {
        const rel = (el.getAttribute("rel") ?? "").toLowerCase();
        const href = el.getAttribute("href") ?? "";
        if (rel.split(/\s+/).includes("canonical") && href && !page.canonical) {
          try {
            page.canonical = new URL(href, base).toString();
          } catch {
            page.canonical = href;
          }
        }
      },
    })
    .on([...SKIP_TAGS].join(","), {
      element(el) {
        skipDepth++;
        // JSON-LD is captured by the text handler below; only one onEndTag per element is allowed.
        const isJsonLd = el.tagName === "script" && /application\/ld\+json/i.test(el.getAttribute("type") ?? "");
        if (isJsonLd) jsonLdBuf = "";
        guardedEndTag(el, () => {
          skipDepth = Math.max(0, skipDepth - 1);
          if (isJsonLd) {
            const raw = jsonLdBuf ?? "";
            jsonLdBuf = null;
            try {
              const parsed: unknown = JSON.parse(raw.trim());
              page.jsonLd.push(...extractJsonLdTypes(parsed));
            } catch {
              /* malformed JSON-LD is itself a finding; ignore here */
            }
          }
        });
      },
    })
    .on([...CHROME_TAGS].join(","), {
      element(el) {
        flush();
        chromeDepth++;
        const isNav = el.tagName === "nav";
        const isFooter = el.tagName === "footer";
        if (isNav) navDepth++;
        if (isFooter) footerDepth++;
        guardedEndTag(el, () => {
          flush();
          chromeDepth = Math.max(0, chromeDepth - 1);
          if (isNav) navDepth = Math.max(0, navDepth - 1);
          if (isFooter) footerDepth = Math.max(0, footerDepth - 1);
        });
      },
    })
    .on(Object.keys(BLOCK_TAGS).join(","), {
      element(el) {
        const kind = BLOCK_TAGS[el.tagName];
        inHead = false;
        flush();
        currentKind = "p";
        if (kind === "flush" || kind === undefined) {
          if (el.tagName === "ul" || el.tagName === "ol") page.lists++;
          if (el.tagName === "table") page.tables++;
          if (el.tagName === "form") page.forms++;
          guardedEndTag(el, () => {
            flush();
            currentKind = "p";
          });
          return;
        }
        currentKind = kind;
        guardedEndTag(el, () => {
          flush(kind);
          currentKind = "p";
        });
      },
    })
    .on("a[href]", {
      element(el) {
        inHead = false;
        const href = el.getAttribute("href") ?? "";
        if (!href || /^(javascript|mailto|tel|sms|data):/i.test(href)) return;
        let abs: URL;
        try {
          abs = new URL(decodeEntities(href), base);
        } catch {
          return;
        }
        if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
        abs.hash = "";
        const link: LinkData = {
          href: abs.toString(),
          text: "",
          chrome: chromeDepth > 0,
          nav: navDepth > 0,
          rel: (el.getAttribute("rel") ?? "").toLowerCase(),
          internal: isSameSite(abs, base),
        };
        const fallbackText = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").trim();
        openAnchors.push(link);
        page.links.push(link);
        guardedEndTag(el, () => {
          const idx = openAnchors.lastIndexOf(link);
          if (idx !== -1) openAnchors.splice(idx, 1);
          link.text = clean(decodeEntities(link.text)) || fallbackText;
        });
      },
    })
    .on("img", {
      element(el) {
        page.images++;
        if ((el.getAttribute("alt") ?? "").trim()) page.imagesWithAlt++;
      },
    })
    .on("time", {
      element(el) {
        const dt = el.getAttribute("datetime");
        if (dt) page.datesInText.push(dt);
      },
    })
    .on('script[type="application/ld+json"]', {
      text(t) {
        if (jsonLdBuf !== null) jsonLdBuf += t.text;
      },
    })
    .on('a[rel~="author"], [itemprop="author"], [itemprop="name"][class*="author"], .author, .byline, .author-name, .post-author, .entry-author, [class*="byline"]', {
      element(el) {
        authorOpen++;
        authorCaptures.push("");
        guardedEndTag(el, () => {
          authorOpen = Math.max(0, authorOpen - 1);
          const captured = clean(decodeEntities(authorCaptures.pop() ?? ""));
          if (captured && captured.length < 80) page.authorTexts.push(captured);
        });
      },
    })
    .on('.testimonial, .testimonials, .review, .reviews, [itemprop="review"], [class*="testimonial"], [class*="review-card"], .rating', {
      element() {
        page.testimonialElements++;
      },
    })
    .onDocument({
      text(t) {
        if (skipDepth > 0 || inHead) return;
        const chunk = t.text;
        if (!chunk) return;
        buffer += chunk;
        for (const a of openAnchors) a.text += chunk;
        if (authorOpen > 0) {
          const last = authorCaptures.length - 1;
          if (last >= 0) authorCaptures[last] += chunk;
        }
        if (footerDepth > 0 && footerBuf.length < 4000) footerBuf += chunk;
      },
      end() {
        flush();
      },
    });

  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } })).text();
  flush();

  page.footerText = clean(decodeEntities(footerBuf));
  for (const b of page.blocks) {
    if (b.chrome) continue;
    if (b.kind === "h1") page.headings.h1.push(b.text);
    else if (b.kind === "h2") page.headings.h2.push(b.text);
    else if (b.kind === "h3") page.headings.h3.push(b.text);
    else if (b.kind === "p" || b.kind === "li" || b.kind === "quote") page.paragraphs.push(b.text);
  }
  page.wordCount = page.paragraphs.reduce((n, p) => n + countWords(p), 0);
  const allText = page.paragraphs.join(" ");
  for (const m of allText.matchAll(DATE_RE)) page.datesInText.push(m[0]);
  page.datesInText = [...new Set(page.datesInText)].slice(0, 20);
  page.links = page.links.filter((l) => l.href.length < 2048);
  return page;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
