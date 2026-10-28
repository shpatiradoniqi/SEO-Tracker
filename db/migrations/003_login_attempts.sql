-- Failed sign-in counters for login rate limiting, kept in Postgres so every API process shares them.
-- One row per key ('email:<address>' or 'ip:<address>') holding failures in the current window.
CREATE TABLE login_attempts (
  key          text PRIMARY KEY,
  failures     int  NOT NULL,
  window_start timestamptz NOT NULL
);
