import type { PoolClient } from 'pg';
import type { CrawledPage } from '@seo/crawler';

/**
 * Replaces a client's pages with a fresh crawl result in one transaction.
 * Keywords are a shared vocabulary (one row per term); page_keywords links them with a score.
 */
export async function replaceClientPages(db: PoolClient, clientId: string, pages: CrawledPage[]): Promise<void> {
  await db.query('DELETE FROM pages WHERE client_id = $1', [clientId]);

  const terms = [...new Set(pages.flatMap((p) => p.keywords.map((k) => k.term)))];
  const { rows: kwRows } = await db.query<{ id: number; term: string }>(
    `INSERT INTO keywords(term) SELECT unnest($1::text[])
     ON CONFLICT (term) DO UPDATE SET term = EXCLUDED.term
     RETURNING id, term`,
    [terms],
  );
  const keywordId = new Map(kwRows.map((r) => [r.term, r.id]));

  for (const { position, page, keywords, issues } of pages) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO pages(client_id, url, sitemap_position, title, meta_description, h1, status_code, word_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [clientId, page.url, position, page.title, page.metaDescription, page.h1[0] ?? null, page.status, page.wordCount],
    );
    const pageId = rows[0]!.id;
    if (keywords.length) {
      await db.query(
        `INSERT INTO page_keywords(page_id, keyword_id, score, rank_order)
         SELECT $1, unnest($2::int[]), unnest($3::real[]), unnest($4::smallint[])`,
        [pageId, keywords.map((k) => keywordId.get(k.term)!), keywords.map((k) => k.score), keywords.map((_, i) => i + 1)],
      );
    }
    if (issues.length) {
      await db.query(
        `INSERT INTO seo_issues(page_id, code, severity, message, details)
         SELECT $1, unnest($2::text[]), unnest($3::issue_severity[]), unnest($4::text[]), unnest($5::jsonb[])`,
        [pageId, issues.map((i) => i.code), issues.map((i) => i.severity), issues.map((i) => i.message),
          issues.map((i) => JSON.stringify(i.details ?? {}))],
      );
    }
  }
}
