import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from './http.js';
import { isSameSite } from './url.js';

export class SitemapNotFoundError extends Error {
  constructor(public readonly tried: string[]) {
    super(
      tried.length
        ? `No usable sitemap found. Tried: ${tried.join(', ')}`
        : 'No usable sitemap found.',
    );
  }
}

export type ParsedSitemap =
  | { kind: 'index'; sitemaps: string[] }
  | { kind: 'urlset'; urls: string[] };

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (name) => name === 'sitemap' || name === 'url',
});

function locOf(entry: unknown): string | null {
  const loc = (entry as { loc?: unknown })?.loc;
  return typeof loc === 'string' ? loc.trim() : null;
}

/** Detects index vs urlset from the XML root, not the file extension (Semrush serves /blog/sitemap/). */
export function parseSitemap(xml: string): ParsedSitemap | null {
  if (!/<(\w+:)?(sitemapindex|urlset)[\s>]/.test(xml)) return null;
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const index = doc.sitemapindex as { sitemap?: unknown[] } | undefined;
  if (index) return { kind: 'index', sitemaps: (index.sitemap ?? []).map(locOf).filter((u): u is string => !!u) };
  const urlset = doc.urlset as { url?: unknown[] } | undefined;
  if (urlset) return { kind: 'urlset', urls: (urlset.url ?? []).map(locOf).filter((u): u is string => !!u) };
  return null;
}

export function parseRobotsSitemaps(robots: string): string[] {
  return robots
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
    .filter((u): u is string => !!u);
}

const TAXONOMY = /(^|[^a-z])(tags?|categor(y|ies)|authors?|topics?|series|archives?)([^a-z]|$)/i;

/**
 * How strongly a sitemap URL suggests it lists blog posts.
 * 3 = post/blog, 2 = article, 1 = news, 0 = unrelated. Taxonomy sitemaps score 0.
 */
export function blogScore(sitemapUrl: string): number {
  let path: string;
  try {
    path = new URL(sitemapUrl).pathname.toLowerCase();
  } catch {
    return 0;
  }
  if (TAXONOMY.test(path)) return 0;
  if (/(^|[^a-z])(posts?|blogs?)([^a-z]|$)/.test(path)) return 3;
  if (/(^|[^a-z])articles?([^a-z]|$)/.test(path)) return 2;
  if (/(^|[^a-z])news([^a-z]|$)/.test(path)) return 1;
  return 0;
}

const BLOG_PROBES = [
  '/blog/sitemap_index.xml', '/blog/sitemap.xml', '/blog/wp-sitemap.xml', '/blog/sitemap/', '/blog/post-sitemap.xml',
  '/articles/sitemap.xml', '/news/sitemap.xml',
];

const BLOG_PATH = /\/(blog|blogs|articles?|posts?|news|insights|resources\/blog)\//i;

export interface Discovery {
  sitemapUrl: string;
  strategy: 'blog-sitemap' | 'blog-path-filter' | 'all-urls';
  urls: string[]; // candidate post URLs in the order the sitemap lists them
  tried: string[];
}

interface Ref { url: string; order: number }

/**
 * Finds the blog sitemap of a site from its website URL alone.
 *
 * 1. Root sitemaps from robots.txt (same site only), else common default locations.
 * 2. Child sitemaps of any index are ranked by blogScore(); best score wins, ties go to index order.
 * 3. If no sitemap looks like a blog, fall back to URLs with blog-like paths, then to every URL
 *    (the crawler's article check filters non-posts out).
 */
export async function discoverBlogSitemap(websiteUrl: string, maxDepth = 3): Promise<Discovery> {
  const base = new URL(websiteUrl);
  const tried: string[] = [];
  const fetched = new Map<string, ParsedSitemap>();

  async function load(url: string): Promise<ParsedSitemap | null> {
    if (fetched.has(url)) return fetched.get(url)!;
    tried.push(url);
    try {
      const res = await safeFetch(url, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8', retries: 1 });
      if (res.status !== 200) return null;
      const parsed = parseSitemap(res.body);
      if (parsed) fetched.set(url, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  let roots: string[] = [];
  try {
    const robots = await safeFetch(new URL('/robots.txt', base).href, { retries: 1 });
    if (robots.status === 200) roots = parseRobotsSitemaps(robots.body).filter((u) => isSameSite(u, base));
  } catch {
    /* no robots.txt is fine */
  }
  const defaults = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap/']
    .map((p) => new URL(p, base).href);
  roots = [...new Set([...roots, ...defaults])];

  // Collect sitemap refs in encounter order: index children, plus urlset roots themselves.
  const refs: Ref[] = [];
  let order = 0;
  for (const root of roots) {
    const parsed = await load(root);
    if (!parsed) continue;
    if (parsed.kind === 'index') {
      for (const child of parsed.sitemaps) if (isSameSite(child, base)) refs.push({ url: child, order: order++ });
    } else {
      refs.push({ url: root, order: order++ });
    }
    // Stop probing defaults once robots.txt (or the first default) gave us something.
    if (refs.length > 0) break;
  }

  // Descend into the most blog-like sitemap until we reach a urlset.
  async function pickBlog(candidates: Ref[], depth: number): Promise<{ url: string; urls: string[] } | null> {
    const ranked = candidates
      .map((r) => ({ ...r, score: blogScore(r.url) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order);
    for (const ref of ranked) {
      const parsed = await load(ref.url);
      if (!parsed) continue;
      if (parsed.kind === 'urlset') {
        const urls = parsed.urls.filter((u) => isSameSite(u, base));
        if (urls.length) return { url: ref.url, urls };
      } else if (depth < maxDepth) {
        const children = parsed.sitemaps.filter((u) => isSameSite(u, base)).map((url, i) => ({ url, order: i }));
        // A blog-named index (e.g. /blog/sitemap_index.xml) may have generic child names: treat them as blog.
        const found =
          (await pickBlog(children, depth + 1)) ?? (await firstUrlset(children.map((c) => c.url), depth + 1));
        if (found) return found;
      }
    }
    return null;
  }

  async function firstUrlset(urls: string[], depth: number): Promise<{ url: string; urls: string[] } | null> {
    for (const url of urls.slice(0, 5)) {
      const parsed = await load(url);
      if (parsed?.kind === 'urlset') {
        const same = parsed.urls.filter((u) => isSameSite(u, base));
        if (same.length) return { url, urls: same };
      } else if (parsed?.kind === 'index' && depth < maxDepth) {
        const found = await firstUrlset(parsed.sitemaps.filter((u) => isSameSite(u, base)), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const blog = await pickBlog(refs, 1);
  if (blog) return { sitemapUrl: blog.url, strategy: 'blog-sitemap', urls: blog.urls, tried };

  // Blogs often live in a separate install with an unlinked sitemap (e.g. ahrefs.com/blog/sitemap_index.xml).
  for (const probe of BLOG_PROBES) {
    const url = new URL(probe, base).href;
    const parsed = await load(url);
    if (!parsed) continue;
    const found =
      parsed.kind === 'urlset'
        ? await firstUrlset([url], 1)
        : (await pickBlog(parsed.sitemaps.filter((u) => isSameSite(u, base)).map((u, i) => ({ url: u, order: i })), 2)) ??
          (await firstUrlset(parsed.sitemaps.filter((u) => isSameSite(u, base)), 2));
    if (found) return { sitemapUrl: found.url, strategy: 'blog-sitemap', urls: found.urls, tried };
  }

  // Fallback: read up to 10 leaf sitemaps in order and keep blog-looking paths, else everything.
  const all: string[] = [];
  let firstLeaf: string | null = null;
  for (const ref of refs.slice(0, 10)) {
    const leaf = await firstUrlset([ref.url], 1);
    if (!leaf) continue;
    firstLeaf ??= leaf.url;
    all.push(...leaf.urls);
  }
  if (!firstLeaf) throw new SitemapNotFoundError(tried);
  const unique = [...new Set(all)];
  const blogPaths = unique.filter((u) => BLOG_PATH.test(new URL(u).pathname));
  if (blogPaths.length) return { sitemapUrl: firstLeaf, strategy: 'blog-path-filter', urls: blogPaths, tried };
  const nonRoot = unique.filter((u) => new URL(u).pathname.replace(/\/$/, '') !== '');
  return { sitemapUrl: firstLeaf, strategy: 'all-urls', urls: nonRoot, tried };
}
