import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { hasValidCsrfToken, userIdFromRequest, SESSION_COOKIE } from './auth/sessions.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';

declare module 'fastify' {
  interface FastifyRequest { userId: string | null }
}

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp({ logger = false }: { logger?: boolean } = {}) {
  // Behind a reverse proxy, set TRUST_PROXY=true so req.ip (used for login rate limiting) is the real client.
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === 'true' });
  await app.register(cookie);
  app.decorateRequest('userId', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    // State-changing requests that carry a session cookie must also carry the session's CSRF token.
    // Login is exempt: it has no session yet, and it only accepts a JSON body, which a cross-site form can't send.
    if (!SAFE_METHODS.has(req.method) && path !== '/api/auth/login' && req.cookies[SESSION_COOKIE] && !hasValidCsrfToken(req)) {
      return reply.code(403).send({ error: 'Missing or invalid CSRF token. Reload the page and try again.' });
    }
    // Everything under /api except the auth endpoints requires a session.
    req.userId = await userIdFromRequest(req);
    if (!req.userId && !PUBLIC_ROUTES.has(path)) return reply.code(401).send({ error: 'Not signed in.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(dataRoutes, { prefix: '/api' });
  return app;
}
