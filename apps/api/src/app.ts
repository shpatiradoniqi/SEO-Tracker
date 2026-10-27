import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { userIdFromRequest } from './auth/sessions.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';

declare module 'fastify' {
  interface FastifyRequest { userId: string | null }
}

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health']);

export async function buildApp({ logger = false }: { logger?: boolean } = {}) {
  const app = Fastify({ logger });
  await app.register(cookie);
  app.decorateRequest('userId', null);

  // Everything under /api except the auth endpoints requires a session.
  app.addHook('onRequest', async (req, reply) => {
    req.userId = await userIdFromRequest(req);
    const path = req.url.split('?')[0]!;
    if (!req.userId && !PUBLIC_ROUTES.has(path)) return reply.code(401).send({ error: 'Not signed in.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(dataRoutes, { prefix: '/api' });
  return app;
}
