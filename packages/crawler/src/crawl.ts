import { safeFetch, BlockedHostError, type FetchOptions, type FetchResult } from './http.js';
import { parsePage, looksLikePost, type ParsedPage } from './parse.js';
import { discoverBlogSitemap, SitemapNotFoundError, type Discovery, type Fetcher } from './sitemap.js';
import { extractKeywords, brandTokens, type KeywordCandidate } from './keywords.js';
import { detectIssues, detectDuplicateTitles, type SeoIssue } from './issues.js';
import { parseRobots, ALLOW_ALL, DISALLOW_ALL, type Robots } from './robots.js';
import { HostThrottle } from './throttle.js';
import { rerankKeywords, type KeywordReranker } from './rerank.js';

export interface CrawledPage {
  position: number; // 1-based order among kept posts, following the sitemap
  page: ParsedPage;
  keywords: KeywordCandidate[];
  issues: SeoIssue[];
}

export interface CrawlProgress { phase: 'discovering' | 'crawling'; found: number; done: number; sitemapUrl?: string }

export interface CrawlOptions {
  limit?: number;        // posts to keep
  maxFetches?: number;   // give up after this many sitemap URLs
  concurrency?: number;
  onProgress?: (p: CrawlProgress) => void | Promise<void>;
  fetch?: (url: string, opts?: FetchOptions) => Promise<FetchResult>; // raw fetcher, for tests
  /** Upper bound on a site's robots.txt Crawl-delay, for operators who need faster crawls. Default: honour it (max 60 s). */
  maxCrawlDelaySeconds?: number;
  /** Optional LLM pass that picks the final keywords from a longer heuristic candidate list. */
  reranker?: KeywordReranker;
  onRerankError?: (err: unknown) => void;
}

const KEYWORDS_PER_PAGE = 6;
const CANDIDATES_FOR_RERANK = 12;

export class NoPostsFoundError extends Error {}
/** The site's robots.txt doesn't let us crawl what we need (or couldn't be read). */
export class RobotsDisallowedError extends Error {}
class DisallowedUrl extends Error {}

/**
 * Wraps a fetcher with crawling politeness: each host's robots.txt is read once and its rules apply
 * to every later request (sitemaps and pages); requests are throttled per host, honouring Crawl-delay.
 * Per RFC 9309, a missing robots.txt (4xx) allows everything and an unreachable one (5xx, network
 * error) disallows everything until it can be read.
 */
export function politeFetcher(raw: Fetcher = safeFetch, throttle = new HostThrottle(), { maxCrawlDelaySeconds = Infinity } = {}) {
  const robotsByOrigin = new Map<string, Promise<Robots & { unreachable?: boolean }>>();
  const stats = { disallowed: 0 };

  const robotsFor = (url: string) => {
    const origin = new URL(url).origin;
    let robots = robotsByOrigin.get(origin);
    if (!robots) {
      robots = throttle.run(origin, () => raw(`${origin}/robots.txt`, { retries: 1, accept: 'text/plain,*/*' }))
        .then((res) => (res.status >= 200 && res.status < 300 ? parseRobots(res.body) : ALLOW_ALL))
        .catch((err) => {
          if (err instanceof BlockedHostError) throw err;
          return { ...DISALLOW_ALL, unreachable: true };
        })
        .then((r) => {
          const delay = Math.min(r.crawlDelay ?? 0, maxCrawlDelaySeconds);
          if (delay > 0) throttle.setLimits(new URL(origin).host, { minGapMs: delay * 1000, maxConcurrent: 1 });
          return r;
        });
      robotsByOrigin.set(origin, robots);
    }
    return robots;
  };

  const fetch: Fetcher = async (url, opts) => {
    const robots = await robotsFor(url);
    if (!robots.isAllowed(url)) {
      stats.disallowed++;
      throw new DisallowedUrl(`robots.txt disallows ${url}`);
    }
    return throttle.run(url, () => raw(url, opts));
  };

  return { fetch, robotsFor, stats };
}

/**
 * Full pipeline for one site: read robots.txt, discover the blog sitemap, fetch URLs in sitemap
 * order (a few at a time, order preserved, politely), keep the first `limit` that are actual posts,
 * then extract keywords (with site-level IDF) and SEO issues.
 */
export async function crawlSite(websiteUrl: string, opts: CrawlOptions = {}): Promise<{ discovery: Discovery; pages: CrawledPage[] }> {
  const { limit = 15, maxFetches = 40, concurrency = 3, onProgress, fetch: raw = safeFetch, maxCrawlDelaySeconds, reranker, onRerankError } = opts;
  await onProgress?.({ phase: 'discovering', found: 0, done: 0 });
  const polite = politeFetcher(raw, new HostThrottle(), { maxCrawlDelaySeconds });
  const robots = await polite.robotsFor(websiteUrl);
  if (robots.unreachable) {
    throw new RobotsDisallowedError(`Couldn't read ${new URL('/robots.txt', websiteUrl).href}, so the site can't be crawled politely yet. Try again later.`);
  }

  let discovery: Discovery;
  try {
    discovery = await discoverBlogSitemap(websiteUrl, { fetch: polite.fetch, robots });
  } catch (err) {
    if (err instanceof SitemapNotFoundError && polite.stats.disallowed > 0) {
      throw new RobotsDisallowedError(`The site's robots.txt doesn't allow crawling its sitemaps.`);
    }
    throw err;
  }
  const candidates = discovery.urls.slice(0, maxFetches);
  const target = Math.min(limit, candidates.length);
  await onProgress?.({ phase: 'crawling', found: target, done: 0, sitemapUrl: discovery.sitemapUrl });

  const posts: ParsedPage[] = [];
  let disallowed = 0;
  for (let i = 0; i < candidates.length && posts.length < limit; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await polite.fetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 5 * 1024 * 1024 });
          if (!/html/i.test(res.contentType)) return null;
          const parsed = parsePage(res.body, url, res.status);
          return looksLikePost(parsed) ? parsed : null;
        } catch (err) {
          if (err instanceof DisallowedUrl) disallowed++;
          return null; // a single broken URL should not fail the crawl
        }
      }),
    );
    for (const r of results) if (r && posts.length < limit) posts.push(r);
    await onProgress?.({ phase: 'crawling', found: target, done: posts.length, sitemapUrl: discovery.sitemapUrl });
  }
  if (posts.length === 0) {
    if (disallowed === candidates.length) {
      throw new RobotsDisallowedError(`Found sitemap ${discovery.sitemapUrl}, but the site's robots.txt doesn't allow crawling its posts.`);
    }
    throw new NoPostsFoundError(`Found sitemap ${discovery.sitemapUrl}, but none of the first ${candidates.length} URLs looked like blog posts.`);
  }

  const brand = brandTokens(websiteUrl, posts);
  const keywords = reranker
    ? await rerankKeywords(websiteUrl, posts, extractKeywords(posts, brand, CANDIDATES_FOR_RERANK), reranker,
      { perPage: KEYWORDS_PER_PAGE, onError: onRerankError })
    : extractKeywords(posts, brand, KEYWORDS_PER_PAGE);
  const duplicates = detectDuplicateTitles(posts);
  const pages = posts.map((page, i) => ({
    position: i + 1,
    page,
    keywords: keywords[i]!,
    issues: [...detectIssues(page), ...(duplicates.has(i) ? [duplicates.get(i)!] : [])],
  }));
  return { discovery, pages };
}
