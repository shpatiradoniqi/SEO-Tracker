import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 7;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The cookie holds a random token; the database only stores its hash, so a DB leak can't hijack sessions. */
export async function createSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query('INSERT INTO sessions(id, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    expires,
  });
}

export async function userIdFromRequest(req: FastifyRequest): Promise<string | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > now()', [sha256(token)]);
  return rows[0]?.user_id ?? null;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
