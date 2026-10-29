import { describe, expect, it, vi, beforeEach } from 'vitest';

const routes = new Map<string, string>();
vi.mock('../src/http.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    const body = routes.get(url);
    return { url, status: body === undefined ? 404 : 200, contentType: 'text/xml', body: body ?? '' };
  }),
}));

const { discoverBlogSitemap, parseSitemap, parseRobotsSitemaps, blogScore } = await import('../src/sitemap.js');

const index = (locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc><lastmod>2020-01-01</lastmod></url>`).join('')}</urlset>`;

beforeEach(() => routes.clear());

describe('parsing', () => {
  it('reads Sitemap lines from robots.txt case-insensitively', () => {
    expect(parseRobotsSitemaps('User-agent: *\nSITEMAP: https://a.com/s.xml\r\nsitemap:https://a.com/b.xml')).toEqual([
      'https://a.com/s.xml', 'https://a.com/b.xml',
    ]);
  });
  it('detects index vs urlset by XML root, not extension', () => {
    expect(parseSitemap(index(['https://a.com/x']))).toEqual({ kind: 'index', sitemaps: ['https://a.com/x'] });
    expect(parseSitemap(urlset(['https://a.com/p']))).toEqual({ kind: 'urlset', urls: ['https://a.com/p'] });
    expect(parseSitemap('<html>not a sitemap</html>')).toBeNull();
  });
  it('scores blog sitemaps and ignores taxonomy sitemaps', () => {
    expect(blogScore('https://a.com/post-sitemap.xml')).toBe(3);
    expect(blogScore('https://a.com/blog/sitemap/')).toBe(3);
    expect(blogScore('https://a.com/news/sitemap/')).toBe(1);
    expect(blogScore('https://a.com/post_tag-sitemap.xml')).toBe(0);
    expect(blogScore('https://a.com/category-sitemap.xml')).toBe(0);
    expect(blogScore('https://a.com/page-sitemap.xml')).toBe(0);
  });
});

describe('discoverBlogSitemap', () => {
  it('Semrush layout: prefers blog over news and ignores other-language subdomains', async () => {
    routes.set('https://www.semrush.com/robots.txt', [
      'Sitemap: https://www.semrush.com/sitemap.xml',
      'Sitemap: https://de.semrush.com/blog/sitemap/',
    ].join('\n'));
    routes.set('https://www.semrush.com/sitemap.xml', index([
      'https://www.semrush.com/news/sitemap/',
      'https://de.semrush.com/blog/sitemap/',
      'https://www.semrush.com/blog/sitemap/',
    ]));
    routes.set('https://www.semrush.com/blog/sitemap/', urlset([
      'https://www.semrush.com/blog/b/', 'https://www.semrush.com/blog/a/', 'https://de.semrush.com/blog/x/',
    ]));
    const d = await discoverBlogSitemap('https://www.semrush.com');
    expect(d.sitemapUrl).toBe('https://www.semrush.com/blog/sitemap/');
    expect(d.urls).toEqual(['https://www.semrush.com/blog/b/', 'https://www.semrush.com/blog/a/']); // listed order kept
  });

  it('Yoast layout: post sitemap wins the tie with a later *_blog sitemap by index order', async () => {
    routes.set('https://yoast.com/robots.txt', 'Sitemap: https://yoast.com/sitemap_index.xml');
    routes.set('https://yoast.com/sitemap_index.xml', index([
      'https://yoast.com/post-sitemap.xml', 'https://yoast.com/page-sitemap.xml',
      'https://yoast.com/yoast_developer_blog-sitemap.xml', 'https://yoast.com/post_tag-sitemap.xml',
    ]));
    routes.set('https://yoast.com/post-sitemap.xml', urlset(['https://yoast.com/seo-blog/', 'https://yoast.com/a/']));
    const d = await discoverBlogSitemap('https://yoast.com');
    expect(d.sitemapUrl).toBe('https://yoast.com/post-sitemap.xml');
    expect(d.strategy).toBe('blog-sitemap');
  });

  it('finds an unlinked blog sitemap index (Ahrefs layout)', async () => {
    routes.set('https://ahrefs.com/sitemap.xml', index(['https://ahrefs.com/academy/sitemap.xml']));
    routes.set('https://ahrefs.com/academy/sitemap.xml', urlset(['https://ahrefs.com/academy/x']));
    routes.set('https://ahrefs.com/blog/sitemap_index.xml', index([
      'https://ahrefs.com/blog/post-sitemap.xml', 'https://ahrefs.com/blog/category-sitemap.xml',
    ]));
    routes.set('https://ahrefs.com/blog/post-sitemap.xml', urlset(['https://ahrefs.com/blog/p/']));
    const d = await discoverBlogSitemap('https://ahrefs.com');
    expect(d.sitemapUrl).toBe('https://ahrefs.com/blog/post-sitemap.xml');
  });

  it('falls back to blog-looking paths in a flat sitemap', async () => {
    routes.set('https://flat.dev/sitemap.xml', urlset(['https://flat.dev/', 'https://flat.dev/pricing', 'https://flat.dev/blog/hello']));
    const d = await discoverBlogSitemap('https://flat.dev');
    expect(d.strategy).toBe('blog-path-filter');
    expect(d.urls).toEqual(['https://flat.dev/blog/hello']);
  });

  it('throws a SitemapNotFoundError listing what it tried', async () => {
    await expect(discoverBlogSitemap('https://none.dev')).rejects.toThrow(/No usable sitemap found. Tried: https:\/\/none.dev\/sitemap.xml/);
  });

  it('records locations the server refused, separately from missing ones', async () => {
    const fetch = async (url: string) => ({ url, status: url.endsWith('/sitemap.xml') ? 403 : 404, contentType: 'text/html', body: '' });
    const err = await discoverBlogSitemap('https://cf.dev', { fetch }).catch((e) => e);
    expect(err.refused).toEqual([
      { url: 'https://cf.dev/sitemap.xml', status: 403 },
      { url: 'https://cf.dev/blog/sitemap.xml', status: 403 },
      { url: 'https://cf.dev/articles/sitemap.xml', status: 403 },
      { url: 'https://cf.dev/news/sitemap.xml', status: 403 },
    ]);
  });
});
