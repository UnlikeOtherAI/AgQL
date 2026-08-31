# `@agql/adapter-postgres`

Integrated AgQL v0 reference adapter for PostgreSQL and pgvector. Canonical rows,
scope predicates, exact aggregates, lexical search, and vectors share one MVCC
database and transactional visibility boundary.

## Requirements

- PostgreSQL 14 or newer, using UTF-8 server encoding.
- pgvector 0.8.0 or newer. Filtered ANN uses HNSW iterative scans introduced in
  pgvector 0.8.0.
- Three distinct PostgreSQL roles:
  - a query role granted `SELECT` only;
  - a writer role granted `SELECT`, `INSERT`, `UPDATE`, and `DELETE` only in the
    runtime namespace;
  - a provisioner role used only by `PostgresProvisioner`.
- An operator-configured runtime namespace, logical-to-physical dataset binding,
  logical quality-profile registry, and at least 32 bytes of token key material.

`PostgresProvisioner` checks the active third role, pgvector version, and each
physical collation's pinned database version. It creates NFC checks, exact
`numeric` columns, FTS indexes, HNSW indexes, and receipt control tables, then
applies the query/writer grants. It is not reachable through `PostgresAdapter`.

## Advertised contract

The adapter advertises `records.v0`, `aggregate.v0`,
`retrieve.semantic.v0`, `retrieve.hybrid.v0`, and
`ingest.canonical.v0`. Consistency is `afterWrite: certified`,
`snapshots: ["transaction"]`, and compare-and-swap is supported. It does not
claim request, historical-pinned, or no-snapshot execution.

Every query runs in a read-only repeatable-read transaction with a local
`statement_timeout`. Before executing generated SQL, it verifies the active role
has no DML privilege on the dataset and no `CREATE` privilege in the runtime
namespace. Snapshot identifiers and visibility tokens are HMAC-derived opaque
values; PostgreSQL XIDs, snapshots, LSNs, and CTIDs are never returned.

Exact vector search disables index scans and first runs a bounded eligible-set
admission probe. Approximate search maps a logical quality profile to private
HNSW settings. Scope and filters are present in every retrieval candidate query;
hybrid retrieval repeats them on the final payload join. Hybrid ranking uses
PostgreSQL FTS plus semantic rank with reciprocal-rank fusion and returns rank,
never backend scores.

Only runtime-owned `float32` vectors are provisioned in v0. PostgreSQL stores
instants at microsecond precision, so nanosecond bindings are rejected instead
of silently truncating them.

## Tests

```sh
pnpm --filter @agql/adapter-postgres test
```

Compiler, injection, refusal, ordering, collation, calendar-SQL, and retrieval
pushdown tests run without a database. Set `DATABASE_URL` to enable the real
PostgreSQL suite. That suite provisions temporary roles and a temporary runtime
schema, verifies direct DML is denied to the query role, exercises MVCC reads,
ingest/idempotency/receipts, pgvector writes, and randomized filtered ANN
scope-leak probes, then removes the temporary schema and roles.

Calendar-period aggregates return result-only half-open periods with instant boundaries,
timezone, grain, and label. The SQL compiler performs civil-time day, fiscal-day,
catalog-week-start, and month bucketing before converting boundaries back to UTC instants.

Canonical ingest compiles the expanded write scope into PostgreSQL predicates. Candidate
whole-record values are checked through SQL before inserts/replacements, and existing-row scope is
repeated on replacements and deletes. Per-record savepoints isolate CAS conflicts while preserving
one ordered outcome per input record and one receipt containing only accepted records. Derived
embedding visibility uses `pending` until the runtime-owned vector worker makes it `ready`, and a
bounded observation deadline returns the distinct structured `AFTER_WRITE_TIMEOUT` result.
