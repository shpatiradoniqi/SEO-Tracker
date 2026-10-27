import { describe, expect, it } from 'vitest';
import { parsePage } from '../src/parse.js';
import { extractKeywords } from '../src/keywords.js';
import { detectIssues, detectDuplicateTitles } from '../src/issues.js';

const make = (url: string, title: string, h1: string, body: string, extraHead = '') =>
  parsePage(`<html lang="en"><head><title>${title}</title>${extraHead}</head><body><article><h1>${h1}</h1>${body}</article></body></html>`, url, 200);

describe('extractKeywords', () => {
  const pages = [
    make('https://acme.com/blog/keyword-research-tools/', 'Keyword Research Tools for 2026 | Acme', 'Keyword research tools',
      '<p>Keyword research tools help with keyword research. Acme SEO makes keyword research tools. SEO SEO SEO.</p>',
      '<meta name="author" content="Jane Doe">'),
    make('https://acme.com/blog/link-building/', 'Link Building Basics | Acme', 'Link building',
      '<p>Link building is SEO work. Link building earns backlinks. Backlinks matter for SEO by Jane Doe.</p>'),
    make('https://acme.com/blog/site-audit/', 'How to Run a Site Audit | Acme', 'Site audit',
      '<p>A site audit finds SEO problems. Run a site audit monthly.</p>'),
  ];
  const brand = new Set(['acme']);
  const result = extractKeywords(pages, brand);

  it('ranks the page topic first and never returns brand terms', () => {
    expect(result[0]![0]!.term).toBe('keyword research tools');
    expect(result[1]![0]!.term).toBe('link building');
    expect(result.flat().some((k) => k.term.includes('acme'))).toBe(false);
  });
  it('excludes author names and phrases containing stopwords', () => {
    const all = result.flat().map((k) => k.term);
    expect(all.some((t) => /jane|doe/.test(t))).toBe(false);
    expect(all.some((t) => /\b(for|a|to|the)\b/.test(t))).toBe(false);
  });
  it('does not return overlapping phrases for one page', () => {
    const terms = result[0]!.map((k) => k.term);
    expect(terms).not.toContain('keyword research');
  });
});

describe('detectIssues', () => {
  it('flags missing title, H1, meta, noindex and thin content', () => {
    const p = parsePage('<html><head><meta name="robots" content="noindex,follow"></head><body><p>short</p></body></html>', 'https://a.com/x', 200);
    const codes = detectIssues(p).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['title_missing', 'h1_missing', 'meta_description_missing', 'noindex', 'thin_content', 'html_lang_missing']));
  });
  it('flags a canonical that points elsewhere but not a trailing-slash variant', () => {
    const at = (c: string) => detectIssues(make('https://a.com/x/', 'T', 'H', '', `<link rel="canonical" href="${c}">`)).map((i) => i.code);
    expect(at('https://a.com/other/')).toContain('canonical_points_elsewhere');
    expect(at('https://a.com/x')).not.toContain('canonical_points_elsewhere');
  });
  it('finds duplicate titles across pages', () => {
    const dup = detectDuplicateTitles([make('https://a.com/1', 'Same', 'a', ''), make('https://a.com/2', 'same', 'b', ''), make('https://a.com/3', 'Other', 'c', '')]);
    expect([...dup.keys()]).toEqual([0, 1]);
  });
});
