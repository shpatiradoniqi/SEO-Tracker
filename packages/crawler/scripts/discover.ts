import { discoverBlogSitemap } from '../src/sitemap.js';
for (const site of ['https://www.semrush.com', 'https://yoast.com', 'https://ahrefs.com', 'https://backlinko.com', 'https://example.com']) {
  const t = Date.now();
  try {
    const d = await discoverBlogSitemap(site);
    console.log(site, '→', d.strategy, d.sitemapUrl, d.urls.length, `${Date.now()-t}ms`);
    console.log('   ', d.urls.slice(0, 3).join('\n    '));
  } catch (e) { console.log(site, 'ERR', (e as Error).message); }
}
