import { crawlSite } from '../src/index.js';
const site = process.argv[2] ?? 'https://yoast.com';
const t = Date.now();
const { discovery, pages } = await crawlSite(site, { onProgress: (p) => { process.stdout.write(`\r${p.phase} ${p.done}/${p.found}   `); } });
console.log(`\n${site}: ${discovery.sitemapUrl} (${discovery.strategy}) ${pages.length} posts in ${Date.now() - t}ms`);
for (const p of pages) {
  console.log(`#${p.position} ${p.page.url}\n   title: ${p.page.title}\n   kw: ${p.keywords.map((k) => k.term).join(' | ')}\n   issues: ${p.issues.map((i) => i.code).join(', ')}`);
}
