import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { normalizeWebsiteUrl, assertPublicHost, BlockedHostError } from '@seo/crawler';
import * as repo from '../repo.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');

const PageListQuery = z.object({
  clientId: uuid.optional(),
  q: z.string().trim().max(200).optional().transform((s) => s || undefined),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const HistoryQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, 'from must be on or before to');
const NewClient = z.object({ name: z.string().trim().min(1).max(100), websiteUrl: z.string().trim().min(1).max(2000) });

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found.' });
const badRequest = (reply: FastifyReply, error: z.ZodError | string) =>
  reply.code(400).send({ error: typeof error === 'string' ? error : error.issues.map((i) => i.message).join('; ') });

export async function dataRoutes(app: FastifyInstance) {
  app.get('/clients', async (req) => repo.listClients(req.userId!));

  app.post('/clients', async (req, reply) => {
    const body = NewClient.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    const site = normalizeWebsiteUrl(body.data.websiteUrl);
    if (!site) return badRequest(reply, 'Enter a valid website URL, for example https://example.com.');
    try {
      await assertPublicHost(new URL(site.url));
    } catch (err) {
      return badRequest(reply, err instanceof BlockedHostError
        ? 'That address points to a private or reserved network and cannot be crawled.'
        : `Could not find a website at ${site.url}.`);
    }
    const created = await repo.createClientWithJob(req.userId!, body.data.name, site.url, site.host);
    if (!created) return reply.code(409).send({ error: `You already have a client for ${site.host}.` });
    return reply.code(202).send(created);
  });

  app.get('/crawl-jobs/:id', async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const job = id.success ? await repo.getJob(req.userId!, id.data) : null;
    return job ?? notFound(reply);
  });

  app.get('/pages', async (req, reply) => {
    const query = PageListQuery.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    return repo.listPages(req.userId!, query.data);
  });

  app.get('/pages/:id', async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const page = id.success ? await repo.getPage(req.userId!, id.data) : null;
    return page ?? notFound(reply);
  });

  app.get('/pages/:id/history', async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return notFound(reply);
    const query = HistoryQuery.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    const days = (Date.parse(query.data.to) - Date.parse(query.data.from)) / 86_400_000;
    if (days > 3 * 366) return badRequest(reply, 'Choose a range of at most three years.');
    const history = await repo.getHistory(req.userId!, id.data, query.data.from, query.data.to);
    return history ?? notFound(reply);
  });
}
