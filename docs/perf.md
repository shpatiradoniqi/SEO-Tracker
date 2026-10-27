# Query performance notes

Measured locally on PostgreSQL 16 with the seed loaded (30 pages, 171 page/keyword pairs, 62,415 snapshots).
Times are full HTTP round trips through the API, warm cache.

| Endpoint | Time | Notes |
|---|---|---|
| `GET /api/pages?page=1&pageSize=25` | ~4 ms | Never touches `rank_snapshots`: latest position is denormalized on `page_keywords` |
| `GET /api/pages?q=seo` | ~4 ms | `ILIKE` on URL or keyword, backed by `pg_trgm` GIN indexes |
| `GET /api/pages/:id` | ~3 ms | |
| `GET /api/pages/:id/history` (365 days, 6 keywords, 2,190 points) | ~15 ms | Range scan on the `(page_keyword_id, captured_at)` primary key |

History query plan (one page, one year):

```
Unique (rows=2190)
  -> Sort
     -> Nested Loop
        -> Seq Scan on page_keywords pk (rows=6)            -- 171-row table; index used once it grows
        -> Index Scan using rank_snapshots_pkey on rank_snapshots s
             Index Cond: page_keyword_id = pk.id
                         AND captured_at >= '2025-10-28 04:00:00+00'   -- Toronto midnight, EDT
                         AND captured_at <  '2026-10-28 04:00:00+00'
Execution Time: ~1.3 ms
```

## How this scales

- The pages list cost depends on pages per user, not on snapshot volume.
- History cost is proportional to the rows returned (keywords x days in range), thanks to the composite primary key.
- At tens of millions of snapshots, partition `rank_snapshots` by month on `captured_at` so old partitions can be
  detached or compressed; the primary key still serves each partition. A daily rollup table would back long-range charts.
