import { describe, expect, it } from 'vitest';
import { parsePage, looksLikePost } from '../src/parse.js';

const page = (head: string, body = '<article><h1>T</h1><p>hello world</p></article>') =>
  parsePage(`<html lang="en"><head>${head}</head><body>${body}</body></html>`, 'https://a.com/x', 200);
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe('looksLikePost', () => {
  it('accepts an Article in a JSON-LD @graph', () => {
    expect(looksLikePost(page(ld({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Article' }] })))).toBe(true);
  });
  it('rejects a CollectionPage even with og:type=article (Yoast /seo-blog/)', () => {
    expect(looksLikePost(page(`<meta property="og:type" content="article">${ld({ '@type': 'CollectionPage' })}`))).toBe(false);
  });
  it('rejects JSON-LD without an article type even with og:type=article (Backlinko /blog)', () => {
    expect(looksLikePost(page(`<meta property="og:type" content="article">${ld({ '@type': 'WebPage' })}`))).toBe(false);
  });
  it('falls back to og:type when there is no JSON-LD', () => {
    expect(looksLikePost(page('<meta property="og:type" content="article">'))).toBe(true);
    expect(looksLikePost(page('<meta property="og:type" content="website">'))).toBe(false);
  });
});

describe('parsePage', () => {
  it('extracts main content without nav/footer and counts images missing alt', () => {
    const p = page('<title> Hi </title>', '<nav>menu menu</nav><main><h1>A</h1><h3>C</h3><img src=a><img src=b alt="ok"><p>one two three</p></main><footer>f</footer>');
    expect(p.title).toBe('Hi');
    expect(p.bodyText).toBe('A C one two three');
    expect(p.images).toEqual({ total: 2, missingAlt: 1 });
    expect(p.headings.map((h) => h.level)).toEqual([1, 3]);
  });
});
