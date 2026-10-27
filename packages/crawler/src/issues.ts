import type { ParsedPage } from './parse.js';

export type Severity = 'high' | 'medium' | 'low';
export interface SeoIssue { code: string; severity: Severity; message: string; details?: Record<string, unknown> }

const norm = (u: string) => u.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

/** On-page checks for a single page. Thresholds follow common SEO tooling defaults. */
export function detectIssues(p: ParsedPage): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const add = (code: string, severity: Severity, message: string, details?: Record<string, unknown>) =>
    issues.push({ code, severity, message, details });

  const titleLen = p.title?.length ?? 0;
  if (!p.title) add('title_missing', 'high', 'Page has no <title>.');
  else if (titleLen < 30) add('title_too_short', 'medium', `Title is ${titleLen} characters (aim for 30–60).`, { length: titleLen });
  else if (titleLen > 60) add('title_too_long', 'medium', `Title is ${titleLen} characters and may be truncated in results (aim for 30–60).`, { length: titleLen });

  const metaLen = p.metaDescription?.length ?? 0;
  if (!p.metaDescription) add('meta_description_missing', 'medium', 'No meta description.');
  else if (metaLen < 70) add('meta_description_too_short', 'low', `Meta description is ${metaLen} characters (aim for 70–160).`, { length: metaLen });
  else if (metaLen > 160) add('meta_description_too_long', 'low', `Meta description is ${metaLen} characters (aim for 70–160).`, { length: metaLen });

  if (p.h1.length === 0) add('h1_missing', 'high', 'Page has no H1.');
  if (p.h1.length > 1) add('h1_multiple', 'medium', `Page has ${p.h1.length} H1 headings.`, { h1: p.h1 });

  for (let i = 1; i < p.headings.length; i++) {
    const prev = p.headings[i - 1]!.level;
    const cur = p.headings[i]!.level;
    if (cur > prev + 1) {
      add('heading_level_skipped', 'low', `Heading jumps from H${prev} to H${cur} ("${p.headings[i]!.text.slice(0, 60)}").`, { from: prev, to: cur });
      break; // one report per page is enough
    }
  }

  if (p.images.missingAlt > 0) {
    add('images_missing_alt', p.images.missingAlt >= 5 ? 'medium' : 'low',
      `${p.images.missingAlt} of ${p.images.total} images have no alt text.`, p.images);
  }

  if (!p.canonical) add('canonical_missing', 'low', 'No canonical link.');
  else {
    let target: string | null = null;
    try { target = new URL(p.canonical, p.url).href; } catch { /* invalid */ }
    if (!target) add('canonical_invalid', 'medium', `Canonical "${p.canonical}" is not a valid URL.`);
    else if (norm(target) !== norm(p.url)) add('canonical_points_elsewhere', 'high', 'Canonical points to a different URL, so this page may not be indexed.', { canonical: target });
  }

  if (p.robots && /noindex/i.test(p.robots)) add('noindex', 'high', 'Meta robots contains noindex.', { robots: p.robots });
  if (p.wordCount < 300) add('thin_content', 'medium', `Only ${p.wordCount} words of main content.`, { wordCount: p.wordCount });
  if (!p.lang) add('html_lang_missing', 'low', 'The <html> element has no lang attribute.');
  if (!p.ogTitle || !p.ogDescription) add('open_graph_incomplete', 'low', 'Missing og:title or og:description.');

  return issues;
}

/** Cross-page check: the same title on several of a client's pages. Returns issues keyed by page index. */
export function detectDuplicateTitles(pages: ParsedPage[]): Map<number, SeoIssue> {
  const byTitle = new Map<string, number[]>();
  pages.forEach((p, i) => {
    if (!p.title) return;
    const key = p.title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), i]);
  });
  const out = new Map<number, SeoIssue>();
  for (const idx of byTitle.values()) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      out.set(i, {
        code: 'title_duplicate', severity: 'medium',
        message: `Title is shared with ${idx.length - 1} other page(s) on this site.`,
        details: { urls: idx.filter((j) => j !== i).map((j) => pages[j]!.url) },
      });
    }
  }
  return out;
}
