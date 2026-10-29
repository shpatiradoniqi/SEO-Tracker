import { describe, expect, it } from 'vitest';
import { parseRobots } from '../src/robots.js';
import { HostThrottle } from '../src/throttle.js';
import { politeFetcher, crawlSite, SiteBlockedError } from '../src/crawl.js';
import { SitemapNotFoundError } from '../src/sitemap.js';
import type { FetchResult } from '../src/http.js';

describe('robots.txt rules', () => {
  // Excerpts of the live semrush.com and yoast.com files, plus a group for our own token.
  const semrush = parseRobots(`
User-agent: SiteAuditBot
Crawl-delay: 1
Allow: /
User-agent: *
Disallow: /blog/*?img=*
Disallow: /blog/search/*
Disallow: /archive/
Disallow: */dvd-mode/
Disallow: /?*/
Disallow: /projects/?*
Allow: /projects/
Allow: /news/*?page=*
Sitemap: https://www.semrush.com/sitemap.xml`);

  it.each([
    ['https://www.semrush.com/blog/keyword-research-tools/', true],
    ['https://www.semrush.com/blog/sitemap/', true],
    ['https://www.semrush.com/blog/post/?img=1', false],
    ['https://www.semrush.com/blog/search/seo/', false],
    ['https://www.semrush.com/archive/old', false],
    ['https://www.semrush.com/kb/dvd-mode/', false],      // pattern starting with *
    ['https://www.semrush.com/projects/', true],          // Allow beats the shorter-matching Disallow
    ['https://www.semrush.com/projects/?id=3', false],    // longer Disallow wins
    ['https://www.semrush.com/robots.txt', true],
  ])('%s allowed: %s', (url, allowed) => expect(semrush.isAllowed(url)).toBe(allowed));

  it('ignores Crawl-delay of groups for other bots and collects Sitemap lines', () => {
    expect(semrush.crawlDelay).toBeUndefined();
    expect(semrush.sitemaps).toEqual(['https://www.semrush.com/sitemap.xml']);
  });

  it('treats consecutive User-agent lines as one group (yoast.com ban list)', () => {
    const yoast = parseRobots('User-agent: *\nDisallow: /wp-json/\n\nUser-agent: PetalBot\nUser-agent: SeoTracker/2.0\nDisallow: /');
    expect(yoast.isAllowed('https://yoast.com/seo-blog/')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /wp-json/').isAllowed('https://yoast.com/seo-blog/')).toBe(true);
  });

  it('prefers our own group over "*" and reads its Crawl-delay', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nuser-agent: seotracker\nCrawl-delay: 2\nDisallow: /private');
    expect(r.isAllowed('https://a.com/blog/x')).toBe(true);
    expect(r.isAllowed('https://a.com/private/x')).toBe(false);
    expect(r.crawlDelay).toBe(2);
  });

  it('supports $ anchors, tie-breaks to Allow, and empty Disallow', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /same\nAllow: /same');
    expect(r.isAllowed('https://a.com/file.pdf')).toBe(false);
    expect(r.isAllowed('https://a.com/file.pdf?x=1')).toBe(true);
    expect(r.isAllowed('https://a.com/same/page')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow:').isAllowed('https://a.com/anything')).toBe(true);
  });
});

describe('per-host throttle', () => {
  it('spaces requests to one host and lets other hosts through', async () => {
    const throttle = new HostThrottle({ minGapMs: 80, maxConcurrent: 3 });
    const t0 = Date.now();
    const starts: Record<'a' | 'b', number[]> = { a: [], b: [] };
    const hit = (host: 'a' | 'b') => throttle.run(`https://${host}.com/x`, async () => { starts[host].push(Date.now() - t0); });
    await Promise.all([hit('a'), hit('a'), hit('a'), hit('b')]);
    const [a1, a2, a3] = starts.a as [number, number, number];
    expect(a2 - a1).toBeGreaterThanOrEqual(70);
    expect(a3 - a2).toBeGreaterThanOrEqual(70);
    expect(starts.b[0]!).toBeLessThan(50);
  });

  it('caps requests in flight per host', async () => {
    const throttle = new HostThrottle({ minGapMs: 0, maxConcurrent: 1 });
    let inFlight = 0, peak = 0;
    const job = () => throttle.run('https://a.com/', async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(1);
  });
});

describe('polite fetcher', () => {
  const ok = (url: string, body = ''): FetchResult => ({ url, status: 200, contentType: 'text/plain', body });

  it('applies the host\'s robots.txt to every request and reads it only once', async () => {
    const calls: string[] = [];
    const raw = async (url: string) => {
      calls.push(url);
      return url.endsWith('/robots.txt') ? ok(url, 'User-agent: *\nDisallow: /private/') : ok(url, 'page');
    };
    const polite = politeFetcher(raw, new HostThrottle({ minGapMs: 0, maxConcurrent: 3 }));
    await expect(polite.fetch('https://a.com/blog/1')).resolves.toMatchObject({ body: 'page' });
    await expect(polite.fetch('https://a.com/private/x')).rejects.toThrow(/robots.txt disallows/);
    await polite.fetch('https://a.com/blog/2');
    expect(calls).toEqual(['https://a.com/robots.txt', 'https://a.com/blog/1', 'https://a.com/blog/2']);
    expect(polite.stats.disallowed).toBe(1);
  });

  it('treats a missing robots.txt as allow-all and an unreachable one as disallow-all (RFC 9309)', async () => {
    const missing = politeFetcher(async (url) => (url.endsWith('/robots.txt') ? { ...ok(url), status: 404 } : ok(url, 'page')));
    await expect(missing.fetch('https://a.com/blog/1')).resolves.toMatchObject({ body: 'page' });
    const down = politeFetcher(async (url) => { if (url.endsWith('/robots.txt')) throw new Error('HTTP 503'); return ok(url); });
    await expect(down.fetch('https://b.com/blog/1')).rejects.toThrow(/robots.txt disallows/);
    expect((await down.robotsFor('https://b.com/')).unreachable).toBe(true);
  });

  it('slows a host down to its Crawl-delay', async () => {
    const throttle = new HostThrottle({ minGapMs: 0, maxConcurrent: 3 });
    const polite = politeFetcher(async (url) => (url.endsWith('/robots.txt') ? ok(url, 'User-agent: *\nCrawl-delay: 0.1') : ok(url)), throttle);
    await polite.robotsFor('https://slow.com/');
    expect(throttle.limitsFor('slow.com')).toEqual({ minGapMs: 100, maxConcurrent: 1 });
  });

  it('lets an operator cap a long Crawl-delay', async () => {
    const throttle = new HostThrottle({ minGapMs: 0, maxConcurrent: 3 });
    const robots = 'User-agent: *\nCrawl-delay: 20'; // what www.semrush.com asks of generic bots
    const polite = politeFetcher(async (url) => ok(url, robots), throttle, { maxCrawlDelaySeconds: 2 });
    await polite.robotsFor('https://www.semrush.com/');
    expect(throttle.limitsFor('www.semrush.com').minGapMs).toBe(2000);
  });
});

describe('crawl failure reasons', () => {
  const status = (url: string, code: number): FetchResult => ({ url, status: code, contentType: 'text/html', body: '' });

  it('says the site refused the crawler when bot protection answers 403 (www.nacionale.com)', async () => {
    const raw = async (url: string) => status(url, url.endsWith('/robots.txt') ? 404 : 403);
    const err = await crawlSite('https://shielded.com', { fetch: raw }).catch((e) => e);
    expect(err).toBeInstanceOf(SiteBlockedError);
    expect(err.message).toMatch(/refused the crawler \(HTTP 403 for https:\/\/shielded.com\/sitemap.xml\)/);
  });

  it('still says "no sitemap" when every location is simply missing', async () => {
    const raw = async (url: string) => status(url, 404);
    await expect(crawlSite('https://plain.com', { fetch: raw })).rejects.toBeInstanceOf(SitemapNotFoundError);
  });
});
