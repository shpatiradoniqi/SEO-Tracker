import { pool } from '../db/pool.js';

/**
 * Login rate limiting: fixed 15-minute windows of failed attempts, per email and per client IP.
 * The email limit stops guessing one account's password; the IP limit stops spraying many accounts.
 * Checked before the password is verified, so a locked-out response says nothing about the password.
 */
export const WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 50;

export const throttleKeys = (email: string, ip: string) => ({ email: `email:${email.toLowerCase()}`, ip: `ip:${ip}` });

/** Seconds until the caller may try again, or 0 when not locked out. */
export async function lockedForSeconds(keys: { email: string; ip: string }): Promise<number> {
  const { rows } = await pool.query<{ retry: number }>(
    `SELECT ceil(extract(epoch FROM window_start + make_interval(mins => $3) - now()))::int AS retry
     FROM login_attempts
     WHERE window_start > now() - make_interval(mins => $3)
       AND ((key = $1 AND failures >= $4) OR (key = $2 AND failures >= $5))`,
    [keys.email, keys.ip, WINDOW_MINUTES, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP],
  );
  return Math.max(0, ...rows.map((r) => r.retry));
}

export async function recordFailure(keys: { email: string; ip: string }): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts(key, failures, window_start) SELECT unnest($1::text[]), 1, now()
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_attempts.window_start > now() - make_interval(mins => $2) THEN login_attempts.failures + 1 ELSE 1 END,
       window_start = CASE WHEN login_attempts.window_start > now() - make_interval(mins => $2) THEN login_attempts.window_start ELSE now() END`,
    [[keys.email, keys.ip], WINDOW_MINUTES],
  );
  // Expired counters are harmless (they reset on the next failure); prune them now and then.
  if (Math.random() < 0.05) await pool.query(`DELETE FROM login_attempts WHERE window_start < now() - interval '1 day'`);
}

/** A successful sign-in clears the account's counter (not the IP's, which may be shared by an attacker). */
export async function clearFailures(keys: { email: string }): Promise<void> {
  await pool.query('DELETE FROM login_attempts WHERE key = $1', [keys.email]);
}
