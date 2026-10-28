import { describe, expect, it, vi } from 'vitest';
import { createClaudeReranker, rerankKeywords, type KeywordReranker } from '../src/rerank.js';
import type { ParsedPage } from '../src/parse.js';

const page = (url: string, title: string) => ({ url, title, h1: [title], metaDescription: `About ${title}` }) as unknown as ParsedPage;
const cands = (...terms: string[]) => terms.map((term, i) => ({ term, score: 10 - i }));

const pages = [page('https://a.com/blog/kw-research/', 'Keyword research guide'), page('https://a.com/blog/links/', 'Link building')];
const candidates = [
  cands('keyword research', 'research tools', 'search volume', 'long tail keywords', 'seo strategy', 'content plan', 'keyword difficulty', 'free tools'),
  cands('link building', 'backlink outreach', 'guest posts', 'anchor text', 'broken links', 'domain authority', 'pr outreach'),
];

describe('rerankKeywords', () => {
  it('uses the re-ranker\'s order and tops up from the heuristic order', async () => {
    const reranker: KeywordReranker = async () => [
      ['long tail keywords', 'keyword research', 'keyword difficulty'],
      ['backlink outreach', 'link building', 'anchor text', 'broken links', 'guest posts', 'domain authority'],
    ];
    const out = await rerankKeywords('https://a.com', pages, candidates, reranker);
    expect(out[0]!.map((c) => c.term)).toEqual(['long tail keywords', 'keyword research', 'keyword difficulty', 'research tools', 'search volume', 'seo strategy']);
    expect(out[1]!.map((c) => c.term)).toEqual(['backlink outreach', 'link building', 'anchor text', 'broken links', 'guest posts', 'domain authority']);
    expect(out[0]![0]!.score).toBe(7); // keeps the heuristic score
  });

  it('drops terms that were not candidates for that page, and duplicates', async () => {
    const reranker: KeywordReranker = async () => [['invented phrase', 'Keyword Research ', 'keyword research', 'link building'], []];
    const out = await rerankKeywords('https://a.com', pages, candidates, reranker);
    expect(out[0]!.map((c) => c.term)).toEqual(['keyword research', 'research tools', 'search volume', 'long tail keywords', 'seo strategy', 'content plan']);
    expect(out[1]!.map((c) => c.term)).toEqual(candidates[1]!.slice(0, 6).map((c) => c.term));
  });

  it('falls back to the heuristic top 6 when the re-ranker fails', async () => {
    const onError = vi.fn();
    const out = await rerankKeywords('https://a.com', pages, candidates, async () => { throw new Error('timeout'); }, { onError });
    expect(out.map((l) => l.map((c) => c.term))).toEqual(candidates.map((l) => l.slice(0, 6).map((c) => c.term)));
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createClaudeReranker', () => {
  const fakeClient = (response: object) => {
    const parse = vi.fn(async () => response);
    return { client: { messages: { parse } } as never, parse };
  };

  it('sends every page with its candidates in one structured-output request and maps the answer back', async () => {
    const { client, parse } = fakeClient({
      stop_reason: 'end_turn',
      parsed_output: { pages: [{ page: 2, keywords: ['link building'] }, { page: 1, keywords: ['keyword research'] }] },
    });
    const rerank = createClaudeReranker({ client, model: 'claude-opus-5-5' });
    const out = await rerank('https://a.com', [
      { url: 'https://a.com/1', title: 'One', h1: 'One', metaDescription: null, candidates: ['keyword research'] },
      { url: 'https://a.com/2', title: 'Two', h1: 'Two', metaDescription: null, candidates: ['link building'] },
    ]);
    expect(out).toEqual([['keyword research'], ['link building']]);
    const req = (parse.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format).toBeDefined();
    expect(req.messages[0].content).toContain('"candidates"');
  });

  it('treats a refusal or unparseable output as a failure (so the heuristic is used)', async () => {
    await expect(createClaudeReranker({ client: fakeClient({ stop_reason: 'refusal', parsed_output: null }).client })('s', []))
      .rejects.toThrow(/declined/);
    await expect(createClaudeReranker({ client: fakeClient({ stop_reason: 'max_tokens', parsed_output: null }).client })('s', []))
      .rejects.toThrow(/no parseable output/);
  });
});
