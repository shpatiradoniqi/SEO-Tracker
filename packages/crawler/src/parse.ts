import * as cheerio from 'cheerio';

export interface ParsedPage {
  url: string;
  status: number;
  lang: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;
  ogType: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  siteName: string | null;
  h1: string[];
  headings: Array<{ level: number; text: string }>;
  images: { total: number; missingAlt: number };
  jsonLdTypes: string[];
  publishedTime: string | null;
  bodyText: string;
  wordCount: number;
}

const BLOCK_TAGS = 'p,div,section,article,main,h1,h2,h3,h4,h5,h6,li,dt,dd,td,th,tr,blockquote,pre,figcaption,caption,hr';

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

function collectJsonLdTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => collectJsonLdTypes(n, out));
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.add(t);
  if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
  if (obj['@graph']) collectJsonLdTypes(obj['@graph'], out);
}

export function parsePage(html: string, url: string, status: number): ParsedPage {
  const $ = cheerio.load(html);
  const meta = (sel: string) => clean($(sel).first().attr('content'));

  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectJsonLdTypes(JSON.parse($(el).text()), types);
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  });

  const headings: ParsedPage['headings'] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const text = clean($(el).text());
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  const images = $('img');
  const missingAlt = images.filter((_, el) => !clean($(el).attr('alt'))).length;

  // Main content: prefer <article>/<main>, strip page chrome either way.
  $('script,style,noscript,template,svg,iframe,nav,header,footer,aside,form').remove();
  const container = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  // cheerio's .text() glues adjacent blocks together ("<h1>A</h1><p>B</p>" -> "AB"); pad block elements first.
  container.find('br').replaceWith(' ');
  container.find(BLOCK_TAGS).append(' ');
  const bodyText = clean(container.text()) ?? '';

  return {
    url,
    status,
    lang: clean($('html').attr('lang')),
    title: clean($('head title').first().text()),
    metaDescription: meta('meta[name="description" i]'),
    canonical: clean($('link[rel="canonical" i]').attr('href')),
    robots: meta('meta[name="robots" i]'),
    ogType: meta('meta[property="og:type"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings,
    images: { total: images.length, missingAlt },
    jsonLdTypes: [...types],
    publishedTime: meta('meta[property="article:published_time"]'),
    bodyText,
    wordCount: bodyText ? bodyText.split(' ').length : 0,
  };
}

const ARTICLE_TYPES = /^(Article|BlogPosting|NewsArticle|TechArticle|Report|ScholarlyArticle|SocialMediaPosting)$/;
const LISTING_TYPES = /^(CollectionPage|SearchResultsPage|ItemList)$/;

/**
 * Decides whether a fetched page is an individual post rather than a blog index or landing page.
 * JSON-LD is the most deliberate signal a site gives, so when present it decides on its own;
 * og:type and article:published_time are only used for pages without structured data
 * (several blog indexes set og:type=article site-wide).
 */
export function looksLikePost(p: ParsedPage): boolean {
  if (p.status !== 200) return false;
  if (p.jsonLdTypes.length > 0) {
    const isArticle = p.jsonLdTypes.some((t) => ARTICLE_TYPES.test(t));
    const isListing = p.jsonLdTypes.some((t) => LISTING_TYPES.test(t));
    return isArticle && !isListing;
  }
  return p.ogType?.toLowerCase() === 'article' || !!p.publishedTime;
}
