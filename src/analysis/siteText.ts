/**
 * Untrusted site text in tool output.
 *
 * Everything a report repeats from the audited site (headings, passages,
 * names, schema values) is controlled by whoever runs that site, and a hostile
 * page can address the model that reads the report ("ignore previous
 * instructions ..."). The report cannot stop a model reading that text, but it
 * can make sure the text arrives as clearly marked data:
 *
 * - verbatim passages sit in double quotes, and site text can never contain a
 *   double quote, so it cannot close its own quotation early;
 * - every kind of line break collapses to a space, so site text cannot start a
 *   heading, list item or fake section of its own;
 * - backticks, tag-like `<` and Markdown link and image syntax are defused, so
 *   it cannot open a code fence, pose as markup or render a remote image;
 * - invisible characters (controls, bidi overrides, zero-width and Unicode tag
 *   characters, variation selectors) are removed, so nothing a model would
 *   read is hidden from the person reviewing the report;
 * - every value is length-capped.
 */

/** Read at most this much of any one value; caps below are far smaller. */
const MAX_INPUT_CHARS = 20_000;
/** C0/C1 controls and the Unicode line and paragraph separators become spaces. */
const BREAKS = /[\p{Cc}\u2028\u2029]/gu;
/** Format (bidi, zero-width, tag characters), private-use, variation selectors and invisible fillers are dropped. */
const INVISIBLE = /[\p{Cf}\p{Co}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const DOUBLE_QUOTES = /["\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g;
const BACKTICKS = /[`\u02CB\u2035\uFF40]/g;

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 3));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

function defuse(value: unknown): string {
  return String(value ?? "")
    .slice(0, MAX_INPUT_CHARS)
    .replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(BACKTICKS, "'")
    .replace(/<(?=[A-Za-z/!?])/g, "\u2039")
    .replace(/!\[/g, "! [")
    .replace(/\]\(/g, "] (")
    .replace(/\s+/g, " ")
    .trim()
    // A value printed at the start of a line must not become a heading, quote or table row.
    .replace(/^(?=[#>|])/, "\\");
}

/** A name, heading or other short value from the site, safe to print unquoted. */
export function siteText(value: unknown, max = 200): string {
  return cap(defuse(value).replace(DOUBLE_QUOTES, "'"), max);
}

/** A verbatim passage from the site, wrapped in the double quotes that mark site text. */
export function quoted(value: unknown, max = 300): string {
  return `"${siteText(value, max)}"`;
}

/**
 * A sentence the auditor wrote that may mention site values. Its own double
 * quotes are kept (they delimit site text already passed through `quoted`);
 * everything else that could break the report's structure is defused.
 */
export function prose(value: unknown, max = 800): string {
  return cap(defuse(value), max);
}

/** Invisible characters and controls other than tab and newline, for multi-line text whose line breaks are the auditor's own. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
}

/**
 * JSON with every character that could break out of a Markdown code fence or
 * hide text rewritten as a \u escape. The JSON value is unchanged, so the
 * snippet still pastes and parses exactly as before.
 */
export function jsonSafe(json: string): string {
  return json.replace(/[`<>\u007F-\u009F\u2028\u2029\p{Cf}\p{Co}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/** Removes invisible characters from every string in a JSON-shaped value (structured tool output). */
export function stripInvisibleDeep<T>(value: T): T {
  if (typeof value === "string") return stripInvisible(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripInvisibleDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripInvisibleDeep(v);
    return out as T;
  }
  return value;
}
