export type BlockKind = "h1" | "h2" | "h3" | "h4" | "p" | "li" | "quote" | "cell";

export interface Block {
  kind: BlockKind;
  text: string;
  /** Inside nav/header/footer/aside: boilerplate rather than main copy. */
  chrome: boolean;
}

export interface LinkData {
  href: string;
  text: string;
  /** Link sits inside nav/header/footer/aside. */
  chrome: boolean;
  /** Inside a <nav> element specifically. */
  nav: boolean;
  rel: string;
  internal: boolean;
}

export interface JsonLdNode {
  type: string[];
  raw: Record<string, unknown>;
}

export interface ParsedPage {
  url: string;
  lang: string;
  title: string;
  metaDescription: string;
  metaRobots: string;
  canonical: string;
  ogSiteName: string;
  ogType: string;
  metaAuthor: string;
  publishedTime: string;
  modifiedTime: string;
  datesInText: string[];
  blocks: Block[];
  headings: { h1: string[]; h2: string[]; h3: string[] };
  /** Main-copy paragraphs (p/li/quote outside chrome), in reading order. */
  paragraphs: string[];
  /** Word count of main copy only. */
  wordCount: number;
  links: LinkData[];
  jsonLd: JsonLdNode[];
  authorTexts: string[];
  images: number;
  imagesWithAlt: number;
  lists: number;
  tables: number;
  forms: number;
  testimonialElements: number;
  /** Text captured from elements that look like a footer or copyright line. */
  footerText: string;
  truncated: boolean;
}
