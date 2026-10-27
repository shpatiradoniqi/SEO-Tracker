import type { ParsedPage } from './parse.js';

// Common English function words plus blog filler that never carries search intent on its own.
const STOPWORDS = new Set(`a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each even ever every few for from further get
gets got had has have having he her here hers him his how i if in into is it its itself just let like make makes many
may me might more most much must my need new no nor not now of off often on once one only or other our ours out over
own per really same she should since so some still such than that the their theirs them then there these they this
those through to too under until up us use used using very via was way ways we well were what when where whether which
while who whom why will with within without would yet you your yours yourself
best top ultimate complete guide guides tips tip step steps easy simple quick everything thing things know need learn
read article post blog today year years first last next free great good better full examples example list lists vs
jan feb mar apr jun jul aug sep sept oct nov dec january february march april june july august september october
november december updated published min mins minute minutes reading`
  .split(/\s+/).filter(Boolean));

const FIELD_WEIGHTS = { title: 3, h1: 3, slug: 2.5, meta: 2, h2: 1.5 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

export interface KeywordCandidate { term: string; score: number }

/** Splits text into phrases at punctuation so n-grams never span sentence or clause boundaries. */
function phrases(text: string): string[][] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[.,!?;:()[\]{}"“”|/\\–—…]+|\s-\s/)
    .map((p) => p.split(/[^\p{L}\p{N}+#-]+/u).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t.length > 1));
}

function ngrams(text: string, brand: Set<string>): string[] {
  const out: string[] = [];
  for (const words of phrases(text)) {
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        // No stopwords anywhere: "segments in google" or "draw the right" are fragments, not queries.
        if (gram.some((w) => STOPWORDS.has(w))) continue;
        if (gram.some((w) => brand.has(w) || /^\d+$/.test(w))) continue;
        out.push(gram.join(' '));
      }
    }
  }
  return out;
}

/** Removes " | Brand" / " - Brand" segments from titles so the brand does not dominate. */
function stripBrandSegments(title: string, brand: Set<string>): string {
  const parts = title.split(/\s[|–—•·-]\s/);
  const kept = parts.filter((p) => !p.toLowerCase().split(/\W+/).some((w) => brand.has(w)) || parts.length === 1);
  return kept.join(' ');
}

function slugText(url: string): string {
  const path = new URL(url).pathname.split('/').filter(Boolean);
  return (path[path.length - 1] ?? '').replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
}

export function brandTokens(siteUrl: string, pages: ParsedPage[]): Set<string> {
  const host = new URL(siteUrl).hostname.replace(/^www\./, '').split('.')[0]!;
  const tokens = new Set([host.toLowerCase()]);
  for (const p of pages) for (const w of (p.siteName ?? '').toLowerCase().split(/\W+/)) if (w.length > 2) tokens.add(w);
  return tokens;
}

interface Signals { fields: Partial<Record<Field, number>>; bodyTf: number }

function pageSignals(page: ParsedPage, siteBrand: Set<string>): Map<string, Signals> {
  // Author names show up in bylines on every post; treat them like the brand.
  const brand = new Set(siteBrand);
  for (const a of page.authors) for (const w of a.toLowerCase().split(/[^\p{L}]+/u)) if (w.length > 1) brand.add(w);
  const signals = new Map<string, Signals>();
  const get = (g: string) => signals.get(g) ?? signals.set(g, { fields: {}, bodyTf: 0 }).get(g)!;
  const fieldTexts: Record<Field, string[]> = {
    title: [stripBrandSegments(page.title ?? '', brand)],
    h1: page.h1,
    slug: [slugText(page.url)],
    meta: [page.metaDescription ?? ''],
    h2: page.headings.filter((h) => h.level === 2).map((h) => h.text),
  };
  for (const field of Object.keys(fieldTexts) as Field[]) {
    const seen = new Set<string>();
    for (const text of fieldTexts[field]) for (const g of ngrams(text, brand)) seen.add(g);
    for (const g of seen) get(g).fields[field] = (get(g).fields[field] ?? 0) + 1;
  }
  for (const g of ngrams(page.bodyText, brand)) get(g).bodyTf++;
  return signals;
}

/**
 * Picks the search terms each page is most likely to rank for.
 *
 * score = (sum of field weights where the phrase appears + log(1 + body frequency))
 *         x phrase-length bonus x site-level IDF
 *
 * Phrases must appear in a prominent field (title, H1, slug, meta, H2) or at least 3 times in the body.
 * Single words additionally need to be in the title, H1 or slug: on their own they are too broad.
 * IDF across the client's pages pushes down terms the whole site uses (e.g. "seo" on an SEO blog).
 * A phrase that overlaps an already-chosen one (contains it or is contained by it) is skipped.
 */
export function extractKeywords(pages: ParsedPage[], brand: Set<string>, perPage = 6): KeywordCandidate[][] {
  const perPageSignals = pages.map((p) => pageSignals(p, brand));
  const df = new Map<string, number>();
  for (const s of perPageSignals) for (const g of s.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  const n = pages.length;

  return perPageSignals.map((signals) => {
    const scored: KeywordCandidate[] = [];
    for (const [term, { fields, bodyTf }] of signals) {
      const fieldScore = (Object.keys(fields) as Field[]).reduce((s, f) => s + FIELD_WEIGHTS[f], 0);
      const prominent = fieldScore > 0;
      const words = term.split(' ').length;
      if (!prominent && bodyTf < 3) continue;
      if (words === 1 && !(fields.title || fields.h1 || fields.slug)) continue;
      if (bodyTf === 0 && !(fields.title || fields.h1)) continue; // must be supported by the content
      const lengthBonus = words === 1 ? 0.7 : words === 2 ? 1.4 : 1.6;
      const idf = n > 1 ? Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1 : 1;
      scored.push({ term, score: (fieldScore + Math.log1p(bodyTf)) * lengthBonus * idf });
    }
    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    const kept: KeywordCandidate[] = [];
    // Compare singularized forms so "traffic source" and "traffic sources" count as the same keyword.
    const stem = (t: string) => ` ${t.split(' ').map((w) => (w.length > 3 ? w.replace(/(ies|es|s)$/, '') : w)).join(' ')} `;
    const overlaps = (a: string, b: string) => stem(a).includes(stem(b)) || stem(b).includes(stem(a));
    for (const c of scored) {
      if (kept.some((k) => overlaps(k.term, c.term))) continue;
      kept.push({ term: c.term, score: Math.round(c.score * 100) / 100 });
      if (kept.length === perPage) break;
    }
    return kept;
  });
}
