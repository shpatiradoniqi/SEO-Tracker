-- Scale: rank_snapshots becomes a table partitioned by month on captured_at, so old months can be
-- detached, archived or dropped cheaply, and each month's primary-key index stays small.
-- rank_daily is a rollup with one row per (page keyword, Toronto calendar day) that serves long ranges.

-- Creates the monthly partitions covering [from_ts, to_ts]. Any rows that landed in the default
-- partition for a month are moved into the new partition, so this never fails on existing data.
CREATE FUNCTION ensure_rank_snapshot_partitions(from_ts timestamptz, to_ts timestamptz) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  m       date := date_trunc('month', from_ts AT TIME ZONE 'UTC')::date;
  lo      timestamptz;
  hi      timestamptz;
  name    text;
  created int := 0;
BEGIN
  WHILE m <= (to_ts AT TIME ZONE 'UTC')::date LOOP
    name := format('rank_snapshots_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(name) IS NULL THEN
      lo := m::timestamp AT TIME ZONE 'UTC';
      hi := (m + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      EXECUTE format('CREATE TABLE %I (LIKE rank_snapshots INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', name);
      EXECUTE format('WITH moved AS (DELETE FROM rank_snapshots_default WHERE captured_at >= %L AND captured_at < %L RETURNING *)
                      INSERT INTO %I SELECT * FROM moved', lo, hi, name);
      EXECUTE format('ALTER TABLE rank_snapshots ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', name, lo, hi);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END $$;

ALTER TABLE rank_snapshots RENAME TO rank_snapshots_unpartitioned;
ALTER TABLE rank_snapshots_unpartitioned RENAME CONSTRAINT rank_snapshots_pkey TO rank_snapshots_unpartitioned_pkey;
ALTER TABLE rank_snapshots_unpartitioned RENAME CONSTRAINT rank_snapshots_page_keyword_id_fkey TO rank_snapshots_unpartitioned_page_keyword_id_fkey;

-- One row per (page, keyword, capture). The PK is still the only index the raw history query needs.
CREATE TABLE rank_snapshots (
  page_keyword_id int NOT NULL REFERENCES page_keywords(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  position        smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  PRIMARY KEY (page_keyword_id, captured_at)
) PARTITION BY RANGE (captured_at);

-- Safety net for writes outside the prepared months; writers call ensure_rank_snapshot_partitions first.
CREATE TABLE rank_snapshots_default PARTITION OF rank_snapshots DEFAULT;

-- Three years back (the longest range the API serves) through a year ahead, plus whatever exists already.
SELECT ensure_rank_snapshot_partitions(
  LEAST(now() - interval '3 years', COALESCE((SELECT min(captured_at) FROM rank_snapshots_unpartitioned), now())),
  GREATEST(now() + interval '12 months', COALESCE((SELECT max(captured_at) FROM rank_snapshots_unpartitioned), now())));

INSERT INTO rank_snapshots SELECT * FROM rank_snapshots_unpartitioned;
DROP TABLE rank_snapshots_unpartitioned;

-- Daily rollup in Toronto calendar days (the app's reporting time zone): the day's last position,
-- plus best/worst for days with several captures. Long-range history reads this instead of raw rows.
CREATE TABLE rank_daily (
  page_keyword_id int      NOT NULL REFERENCES page_keywords(id) ON DELETE CASCADE,
  day             date     NOT NULL,
  position        smallint NOT NULL,
  best_position   smallint NOT NULL,
  worst_position  smallint NOT NULL,
  samples         smallint NOT NULL,
  PRIMARY KEY (page_keyword_id, day)
);

-- Rebuilds the rollup for Toronto days [from_day, to_day], optionally for some page keywords only.
CREATE FUNCTION refresh_rank_daily(from_day date, to_day date, only_page_keywords int[] DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM rank_daily
  WHERE day BETWEEN from_day AND to_day
    AND (only_page_keywords IS NULL OR page_keyword_id = ANY (only_page_keywords));
  INSERT INTO rank_daily (page_keyword_id, day, position, best_position, worst_position, samples)
  SELECT s.page_keyword_id, d.day,
         (array_agg(s.position ORDER BY s.captured_at DESC))[1],
         min(s.position), max(s.position), count(*)
  FROM rank_snapshots s
  CROSS JOIN LATERAL (SELECT (s.captured_at AT TIME ZONE 'America/Toronto')::date AS day) d
  WHERE s.captured_at >= from_day::timestamp AT TIME ZONE 'America/Toronto'
    AND s.captured_at <  (to_day + 1)::timestamp AT TIME ZONE 'America/Toronto'
    AND (only_page_keywords IS NULL OR s.page_keyword_id = ANY (only_page_keywords))
  GROUP BY s.page_keyword_id, d.day;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Backfill the rollup for whatever history already exists.
SELECT refresh_rank_daily(
  COALESCE((SELECT (min(captured_at) AT TIME ZONE 'America/Toronto')::date FROM rank_snapshots), current_date),
  COALESCE((SELECT (max(captured_at) AT TIME ZONE 'America/Toronto')::date FROM rank_snapshots), current_date));
