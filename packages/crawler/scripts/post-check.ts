import { safeFetch } from '../src/http.js';
import { parsePage, looksLikePost } from '../src/parse.js';
const urls = process.argv.slice(2);
for (const u of urls) {
  const r = await safeFetch(u);
  const p = parsePage(r.body, r.url, r.status);
  console.log(looksLikePost(p) ? 'POST ' : 'SKIP ', r.status, u, '| og:', p.ogType, '| ld:', p.jsonLdTypes.join(','), '| words', p.wordCount, '| h1', p.h1.length);
}
