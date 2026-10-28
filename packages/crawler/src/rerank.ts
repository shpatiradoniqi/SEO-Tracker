import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ParsedPage } from './parse.js';
import type { KeywordCandidate } from './keywords.js';

/**
 * Optional LLM pass over the heuristic keyword candidates. The heuristic proposes more candidates
 * than it keeps; the re-ranker picks and orders the best ones per page. It may only choose from the
 * candidates (anything else is dropped), and any failure falls back to the heuristic's own order.
 */

export interface RerankPage { url: string; title: string | null; h1: string | null; metaDescription: string | null; candidates: string[] }
/** Returns, per page and in the same order, the chosen candidate terms, best first. */
export type KeywordReranker = (site: string, pages: RerankPage[]) => Promise<string[][]>;

export const DEFAULT_RERANK_MODEL = 'claude-opus-5-5';

const Choice = z.object({
  pages: z.array(z.object({
    page: z.number().int().describe('The page number from the input'),
    keywords: z.array(z.string()).describe('Chosen candidate phrases, copied exactly, best first'),
  })),
});

const SYSTEM = `You pick the search queries a blog post is most likely to rank for in Google.
For each page you get its title, H1, meta description and a list of candidate phrases extracted from it.
Choose up to the requested number of candidates per page and order them best first.
Prefer phrases a real person would type into a search engine and that match the page's main topic.
Skip fragments, generic words, and phrases that only describe the site rather than the page.
Copy chosen phrases exactly as given; never invent new ones.`;

type MessagesClient = Pick<Anthropic, 'messages'>;

/** Re-ranker backed by Claude. Credentials come from the usual SDK sources (ANTHROPIC_API_KEY etc.). */
export function createClaudeReranker({ model = DEFAULT_RERANK_MODEL, perPage = 6, client }: {
  model?: string; perPage?: number; client?: MessagesClient;
} = {}): KeywordReranker {
  const anthropic = client ?? new Anthropic({ timeout: 120_000 });
  return async (site, pages) => {
    const input = pages.map((p, i) => ({
      page: i + 1, url: p.url, title: p.title, h1: p.h1, metaDescription: p.metaDescription, candidates: p.candidates,
    }));
    const response = await anthropic.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(Choice), effort: 'low' },
      messages: [{
        role: 'user',
        content: `Site: ${site}\nPick up to ${perPage} keywords per page.\n\n${JSON.stringify(input, null, 1)}`,
      }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Re-ranking request was declined.');
    if (!response.parsed_output) throw new Error(`Re-ranker returned no parseable output (stop reason ${response.stop_reason}).`);
    const byPage = new Map(response.parsed_output.pages.map((p) => [p.page, p.keywords]));
    return pages.map((_, i) => byPage.get(i + 1) ?? []);
  };
}

/**
 * Applies a re-ranker to heuristic candidates (each list ordered best first). Keeps only terms that
 * were candidates for that page, tops up from the heuristic order if fewer than `perPage` remain,
 * and returns the heuristic's top `perPage` unchanged if the re-ranker fails.
 */
export async function rerankKeywords(
  site: string,
  pages: ParsedPage[],
  candidates: KeywordCandidate[][],
  reranker: KeywordReranker,
  { perPage = 6, onError }: { perPage?: number; onError?: (err: unknown) => void } = {},
): Promise<KeywordCandidate[][]> {
  const heuristic = candidates.map((list) => list.slice(0, perPage));
  let chosen: string[][];
  try {
    chosen = await reranker(site, pages.map((p, i) => ({
      url: p.url, title: p.title, h1: p.h1[0] ?? null, metaDescription: p.metaDescription, candidates: candidates[i]!.map((c) => c.term),
    })));
  } catch (err) {
    onError?.(err);
    return heuristic;
  }
  return candidates.map((list, i) => {
    const byTerm = new Map(list.map((c) => [c.term, c]));
    const picked: KeywordCandidate[] = [];
    for (const raw of chosen[i] ?? []) {
      const c = byTerm.get(raw.trim().toLowerCase());
      if (c && !picked.includes(c)) picked.push(c);
      if (picked.length === perPage) break;
    }
    for (const c of list) {
      if (picked.length >= perPage) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked;
  });
}
