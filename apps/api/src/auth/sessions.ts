import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_DAYS = 7;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error('SESSION_SECRET is not set. Copy .env.example to .env.');

/**
 * CSRF token bound to the session: HMAC(SESSION_SECRET, session token). The browser gets it from the
 * login and /auth/me responses and sends it back in a header on every state-changing request.
 * Another site can make the browser send the cookie, but it can't read this value, so it can't forge the header.
 */
export const csrfTokenFor = (sessionToken: string) => createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');

export function hasValidCsrfToken(req: FastifyRequest): boolean {
  const token = req.cookies[SESSION_COOKIE];
  const sent = req.headers[CSRF_HEADER];
  if (!token || typeof sent !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(token));
  const actual = Buffer.from(sent);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The cookie holds a random token; the database only stores its hash, so a DB leak can't hijack sessions. */
export async function createSession(reply: FastifyReply, userId: string): Promise<{ csrfToken: string }> {
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
  return { csrfToken: csrfTokenFor(token) };
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
