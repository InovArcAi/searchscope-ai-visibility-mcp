import type { Block, ParsedPage } from "../parse/types";
import { countWords } from "../parse/html";
import type { Rating } from "./site";

/**
 * AI retrievability: can an answer engine lift a clear, self-contained passage
 * from this page? The rubric is deliberately explicit and deterministic.
 *
 * Per page we compute:
 *  - definition: a paragraph of 20+ words within the first three main-copy blocks after the H1
 *    that reads like a definition or positioning statement ("X is a...", "we provide...").
 *  - question headings: H2/H3 that are phrased as questions or start with a question word.
 *  - answer quality for each question heading, judged on the passage that follows it.
 *  - specificity: numbers, currency, dates, percentages and capitalised entities per 100 words.
 *  - fragmentation: share of main-copy paragraphs under 15 words (marketing fragments).
 *
 * Rating rules (documented in README):
 *  Strong   = definition present AND specificity >= 1.5/100 words AND fragmentation < 45%
 *             AND (no question headings OR >= 60% of them answered directly)
 *  Weak     = no definition AND (specificity < 0.6 OR fragmentation > 65%)
 *             OR page has < 120 words of main copy
 *  Moderate = everything else
 */

export interface QaPassage {
  question: string;
  answer: string;
  answerWords: number;
  verdict: "direct" | "thin" | "vague" | "split" | "missing";
  reason: string;
}

export interface PageRetrievability {
  url: string;
  rating: Rating;
  words: number;
  hasDefinition: boolean;
  definition?: string;
  questionHeadings: number;
  directAnswers: number;
  specificityPer100: number;
  fragmentationPct: number;
  genericHeadings: string[];
  qa: QaPassage[];
  issues: string[];
}

const QUESTION_START = /^(what|how|why|when|where|which|who|can|could|do|does|did|is|are|should|will|would|has|have)\b/i;
const HEDGE_RE = /\b(it depends|depends on|varies|many factors|a range of|contact us (?:to|for)|get in touch|reach out|every (?:business|situation|case) is different|case[- ]by[- ]case|we can help|talk to us|book a (?:call|consult)|find out more)\b/i;
const GENERIC_HEADING_RE = /^(overview|introduction|about|about us|services|our services|why us|why choose us|what we do|how it works|get started|contact|contact us|faq|faqs|testimonials|reviews|our process|our approach|benefits|features|pricing|learn more|more info|resources|blog|latest news|news|gallery|our team|team|welcome|home)$/i;
const SPECIFIC_RE = /(\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\b(?:19|20)\d{2}\b|\b\d+(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:km|kg|mm|cm|m|hours?|hrs|days?|weeks?|months?|years?|minutes?|mins?|litres?|kW|kWh|sqm|m2)\b|\b\d+\+?\s?(?:clients|customers|projects|reviews|locations|staff|employees|years|installs?|jobs)\b)/g;

function countSpecifics(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(SPECIFIC_RE)) n++;
  // Proper-noun runs (capitalised multiword phrases not at sentence start) as a weak entity signal
  for (const m of text.matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/g)) if ((m[1] ?? "").length > 5) n += 0.5;
  return n;
}

function isQuestionHeading(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || (QUESTION_START.test(t) && countWords(t) >= 3);
}

function keywordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(what|how|why|when|where|which|who|does|do|can|should|your|with|from|that|this|the|and|for|are|is|will|would|about|into|more|much|many|need|have)$/.test(w));
}

export function analysePageRetrievability(page: ParsedPage): PageRetrievability {
  const main = page.blocks.filter((b) => !b.chrome);
  const words = page.wordCount;
  const issues: string[] = [];

  // Definition / positioning statement near the top
  let hasDefinition = false;
  let definition: string | undefined;
  const h1Index = main.findIndex((b) => b.kind === "h1");
  const startAt = h1Index === -1 ? 0 : h1Index + 1;
  const early = main.slice(startAt, startAt + 4).filter((b) => b.kind === "p" || b.kind === "li" || b.kind === "quote");
  for (const b of early) {
    const w = countWords(b.text);
    if (w >= 20 && /\b(is|are|provides?|offers?|helps?|specialis(?:es|ing)|delivers?|means|refers to|we (?:are|provide|offer|help|deliver|build|design|repair|install|treat|represent)|our (?:team|clinic|studio|firm|company|practice))\b/i.test(b.text)) {
      hasDefinition = true;
      definition = b.text.length > 220 ? `${b.text.slice(0, 217)}...` : b.text;
      break;
    }
  }
  if (!hasDefinition) issues.push("No clear definition or positioning paragraph directly under the H1 (first 20+ word passage does not say what this page or offer is).");

  // Question headings and their answers
  const qa: QaPassage[] = [];
  for (let i = 0; i < main.length; i++) {
    const b = main[i] as Block;
    if (!(b.kind === "h2" || b.kind === "h3" || b.kind === "h4") || !isQuestionHeading(b.text)) continue;
    const following: string[] = [];
    for (let j = i + 1; j < main.length && following.length < 3; j++) {
      const nb = main[j] as Block;
      if (nb.kind === "h1" || nb.kind === "h2" || nb.kind === "h3" || nb.kind === "h4") break;
      if (nb.kind === "p" || nb.kind === "li" || nb.kind === "quote") following.push(nb.text);
    }
    const answer = following.join(" ");
    const answerWords = countWords(answer);
    let verdict: QaPassage["verdict"];
    let reason: string;
    const firstSentence = (following[0] ?? "").split(/(?<=[.!?])\s/)[0] ?? "";
    const kws = keywordsOf(b.text);
    const echoes = kws.some((k) => firstSentence.toLowerCase().includes(k));
    const specifics = countSpecifics(answer);
    if (following.length === 0) {
      verdict = "missing";
      reason = "Heading is followed by another heading or nothing; there is no passage to lift.";
    } else if (HEDGE_RE.test(answer) && specifics === 0) {
      verdict = "vague";
      reason = "Answer hedges (\"it depends\", \"contact us\") and contains no numbers, names or concrete facts.";
    } else if (answerWords < 20) {
      verdict = "thin";
      reason = `Only ${answerWords} words follow the heading.`;
    } else if (!echoes && countWords(firstSentence) > 45) {
      verdict = "split";
      reason = "First sentence neither restates the question nor answers it; the answer is buried further down.";
    } else {
      verdict = "direct";
      reason = echoes ? "Opens with a sentence that restates and answers the question." : "Answer is substantive and concrete.";
    }
    qa.push({ question: b.text, answer: answer.length > 260 ? `${answer.slice(0, 257)}...` : answer, answerWords, verdict, reason });
  }
  const questionHeadings = qa.length;
  const directAnswers = qa.filter((q) => q.verdict === "direct").length;
  for (const q of qa) {
    if (q.verdict !== "direct") issues.push(`"${q.question}" -> ${q.verdict}: ${q.reason}`);
  }

  // Heading quality
  const genericHeadings = main.filter((b) => b.kind === "h2" || b.kind === "h3").map((b) => b.text).filter((t) => GENERIC_HEADING_RE.test(t.trim()));
  if (genericHeadings.length >= 3) issues.push(`${genericHeadings.length} generic headings (${genericHeadings.slice(0, 3).join(", ")}) give retrieval systems no topical signal.`);

  // Specificity and fragmentation
  const paragraphs = main.filter((b) => b.kind === "p" || b.kind === "li" || b.kind === "quote");
  const text = paragraphs.map((b) => b.text).join(" ");
  const specificityPer100 = words > 0 ? Math.round((countSpecifics(text) / words) * 100 * 100) / 100 : 0;
  const shortCount = paragraphs.filter((b) => countWords(b.text) < 15).length;
  const fragmentationPct = paragraphs.length > 0 ? Math.round((shortCount / paragraphs.length) * 100) : 0;
  if (words < 120) issues.push(`Only ${words} words of main copy; too little for an answer engine to extract anything.`);
  if (specificityPer100 < 0.6 && words >= 120) issues.push("Weak factual specificity: almost no numbers, prices, dates, named entities or measurable claims.");
  if (fragmentationPct > 65 && paragraphs.length >= 6) issues.push(`${fragmentationPct}% of passages are under 15 words; copy is fragmented into slogans rather than self-contained answers.`);

  let rating: Rating;
  const qaOk = questionHeadings === 0 || directAnswers / questionHeadings >= 0.6;
  if (words < 120 || (!hasDefinition && (specificityPer100 < 0.6 || fragmentationPct > 65))) rating = "Weak";
  else if (hasDefinition && specificityPer100 >= 1.5 && fragmentationPct < 45 && qaOk) rating = "Strong";
  else rating = "Moderate";

  return { url: page.url, rating, words, hasDefinition, definition, questionHeadings, directAnswers, specificityPer100, fragmentationPct, genericHeadings: genericHeadings.slice(0, 6), qa: qa.slice(0, 12), issues: issues.slice(0, 8) };
}

export function aggregateRating(ratings: Rating[]): Rating {
  if (ratings.length === 0) return "Weak";
  const score = ratings.reduce((n, r) => n + (r === "Strong" ? 2 : r === "Moderate" ? 1 : 0), 0) / ratings.length;
  return score >= 1.5 ? "Strong" : score >= 0.75 ? "Moderate" : "Weak";
}
