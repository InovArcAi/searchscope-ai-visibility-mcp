/** Minimal, dependency-free sitemap and robots.txt readers. */

export interface SitemapParse {
  isIndex: boolean;
  urls: string[];
}

export function parseSitemapXml(xml: string, limit = 500): SitemapParse {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && urls.length < limit) {
    const loc = m[1]?.trim();
    if (loc) urls.push(loc.replace(/&amp;/g, "&"));
  }
  return { isIndex, urls };
}

export function parseRobotsSitemaps(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** True when robots.txt disallows the whole site for all agents (a real finding). */
export function robotsDisallowsAll(robots: string): boolean {
  let inStar = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const ua = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (ua) {
      inStar = ua[1]?.trim() === "*";
      continue;
    }
    if (inStar && /^disallow\s*:\s*\/\s*$/i.test(line)) return true;
  }
  return false;
}

/** Names of AI crawlers the site explicitly blocks in robots.txt. */
export function robotsBlockedAgents(robots: string): string[] {
  const interesting = ["gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-searchbot", "claude-user", "anthropic-ai", "perplexitybot", "google-extended", "bingbot", "ccbot", "applebot-extended"];
  const blocked = new Set<string>();
  let current: string[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) {
      current = [];
      continue;
    }
    const ua = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (ua) {
      current.push((ua[1] ?? "").trim().toLowerCase());
      continue;
    }
    if (/^disallow\s*:\s*\/\s*$/i.test(line)) {
      for (const agent of current) if (interesting.includes(agent)) blocked.add(agent);
    }
  }
  return [...blocked];
}
