/**
 * robots.txt support following RFC 9309: groups start with one or more User-agent lines; the group
 * naming our product token wins over "*"; among matching rules the longest pattern wins and Allow
 * wins a tie; "*" matches any characters and a trailing "$" anchors the end. Crawl-delay (not in
 * the RFC, but widely used) sets the minimum gap between requests to the host.
 */

export const ROBOTS_PRODUCT_TOKEN = 'seotracker';
const MAX_CRAWL_DELAY_S = 60; // ignore absurd values instead of stalling a crawl for hours

interface Rule { allow: boolean; pattern: string; regex: RegExp }
interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number }

export interface Robots {
  isAllowed(url: string): boolean;
  /** Seconds between requests asked for by the matching group, if any. */
  crawlDelay?: number;
  sitemaps: string[];
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** RFC 9309 compares paths with percent-encoding normalized; decode what is safe to decode. */
function normalizePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function parseRobots(text: string, productToken = ROBOTS_PRODUCT_TOKEN): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase().split('/')[0]!.trim());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any User-agent line apply to nobody
    if (field === 'allow' || field === 'disallow') {
      if (!value) continue; // "Disallow:" with no path allows everything
      const pattern = normalizePath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
      current.rules.push({ allow: field === 'allow', pattern, regex: toRegex(pattern) });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelay = Math.min(seconds, MAX_CRAWL_DELAY_S);
    }
  }

  const token = productToken.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(token));
  const matching = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  const rules = matching.flatMap((g) => g.rules);
  const delays = matching.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);

  return {
    sitemaps,
    crawlDelay: delays.length ? Math.max(...delays) : undefined,
    isAllowed(url: string) {
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return true;
      const target = normalizePath(u.pathname + u.search);
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(target)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}

export const ALLOW_ALL: Robots = { sitemaps: [], isAllowed: () => true };
export const DISALLOW_ALL: Robots = { sitemaps: [], isAllowed: (url) => new URL(url).pathname === '/robots.txt' };
