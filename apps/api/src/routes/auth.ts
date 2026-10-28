import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, csrfTokenFor, destroySession, SESSION_COOKIE } from '../auth/sessions.js';
import { clearFailures, lockedForSeconds, recordFailure, throttleKeys } from '../auth/throttle.js';

const Login = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) });
// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Enter a valid email and password.' });
    const keys = throttleKeys(body.data.email, req.ip);
    const retryAfter = await lockedForSeconds(keys);
    if (retryAfter > 0) {
      const minutes = Math.ceil(retryAfter / 60);
      return reply.code(429).header('retry-after', String(retryAfter))
        .send({ error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    }
    const { rows: [user] } = await pool.query<{ id: string; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE email = $1', [body.data.email]);
    const ok = await verifyPassword(body.data.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      await recordFailure(keys);
      return reply.code(401).send({ error: 'Email or password is incorrect.' });
    }
    await clearFailures(keys);
    const { csrfToken } = await createSession(reply, user.id);
    return { id: user.id, email: user.email, csrfToken };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: 'Not signed in.' });
    const { rows: [user] } = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.userId]);
    return { ...user, csrfToken: csrfTokenFor(req.cookies[SESSION_COOKIE]!) };
  });
}
