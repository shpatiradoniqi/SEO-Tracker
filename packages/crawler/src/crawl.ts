import { safeFetch } from './http.js';
import { parsePage, looksLikePost, type ParsedPage } from './parse.js';
import { discoverBlogSitemap, type Discovery } from './sitemap.js';
import { extractKeywords, brandTokens, type KeywordCandidate } from './keywords.js';
import { detectIssues, detectDuplicateTitles, type SeoIssue } from './issues.js';

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
}

export class NoPostsFoundError extends Error {}

/**
 * Full pipeline for one site: discover the blog sitemap, fetch URLs in sitemap order
 * (a few at a time, order preserved), keep the first `limit` that are actual posts,
 * then extract keywords (with site-level IDF) and SEO issues.
 */
export async function crawlSite(websiteUrl: string, opts: CrawlOptions = {}): Promise<{ discovery: Discovery; pages: CrawledPage[] }> {
  const { limit = 15, maxFetches = 40, concurrency = 3, onProgress } = opts;
  await onProgress?.({ phase: 'discovering', found: 0, done: 0 });
  const discovery = await discoverBlogSitemap(websiteUrl);
  const candidates = discovery.urls.slice(0, maxFetches);
  const target = Math.min(limit, candidates.length);
  await onProgress?.({ phase: 'crawling', found: target, done: 0, sitemapUrl: discovery.sitemapUrl });

  const posts: ParsedPage[] = [];
  for (let i = 0; i < candidates.length && posts.length < limit; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await safeFetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: 5 * 1024 * 1024 });
          if (!/html/i.test(res.contentType)) return null;
          const parsed = parsePage(res.body, url, res.status);
          return looksLikePost(parsed) ? parsed : null;
        } catch {
          return null; // a single broken URL should not fail the crawl
        }
      }),
    );
    for (const r of results) if (r && posts.length < limit) posts.push(r);
    await onProgress?.({ phase: 'crawling', found: target, done: posts.length, sitemapUrl: discovery.sitemapUrl });
  }
  if (posts.length === 0) {
    throw new NoPostsFoundError(`Found sitemap ${discovery.sitemapUrl}, but none of the first ${candidates.length} URLs looked like blog posts.`);
  }

  const keywords = extractKeywords(posts, brandTokens(websiteUrl, posts));
  const duplicates = detectDuplicateTitles(posts);
  const pages = posts.map((page, i) => ({
    position: i + 1,
    page,
    keywords: keywords[i]!,
    issues: [...detectIssues(page), ...(duplicates.has(i) ? [duplicates.get(i)!] : [])],
  }));
  return { discovery, pages };
}
