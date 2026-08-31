# `@agql/adapter-sqlite`

Embedded, file-backed SQLite reference adapter for the v0 exact core. It advertises
`records.v0`, `aggregate.v0`, `retrieve.semantic.v0`, and `ingest.canonical.v0`.
Semantic retrieval is exhaustive and exact only; hybrid is not advertised, and approximate
semantic plans receive `UNSUPPORTED_PROFILE`.

Driver choice: Node 24's built-in `node:sqlite` avoids a native package dependency while providing
file-backed read-only connections, defensive mode, prepared parameters, and disabled extensions.

```ts
import { createSqliteAdapter, provisionSqliteAdapterStorage } from '@agql/adapter-sqlite';

provisionSqliteAdapterStorage('/var/lib/agql/reference.sqlite');
const adapter = createSqliteAdapter({
  databasePath: '/var/lib/agql/reference.sqlite',
  exactScanAdmissionLimit: 10_000,
  supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '1' }],
  id: 'sqlite-reference',
  version: '0.0.0',
});
```

The host creates each catalog-resolved dataset table with catalog-branded field names, plus
`__agql_version INTEGER NOT NULL` and `__agql_deleted INTEGER NOT NULL` columns.
Vectors are runtime-produced BLOBs stored at the resolved EmbeddingSpec physical column.
`provisionSqliteAdapterStorage` separately creates the adapter-private receipt and idempotency
tables. Query execution opens a fresh SQLite connection with `readOnly: true`; no query path
creates tables or writes metadata.

Every physical dataset or field identifier is quoted only after arriving as a
`CatalogPhysicalIdentifier`. Model scalar values, including hostile text, list members, and
scope partitions, are SQLite parameters. Scope predicates and logical filters occur in the SQL
`WHERE` clause before rows, vectors, or source aggregate values enter adapter logic. Exact
semantic retrieval first counts only the scoped eligible set, refuses it when it exceeds the
engine-approved candidate limit, then scans and ranks that bounded set with stable-id ties.
Distance diagnostics use absolute and relative tolerances of `1e-12`; result membership and order
come from the exhaustive scan and the adapter does not expose rounded distances as scalar values.

Decimals are stored and compared as canonical text, never SQLite `REAL`. Aggregation uses the
shared exact decimal functions after scoped source selection; averages whose exact result has no
terminating decimal form refuse rather than round. Money is canonical JSON text with its currency
checked on reads and exact amount aggregation within the catalog-declared currency. Calendar
period calculation uses the supplied IANA timezone in adapter code, rather than SQLite UTC date
functions. Buckets cross the adapter boundary as `{start,endExclusive,timezone,grain,label}` with
instant boundaries; civil-time day, fiscal-day, configurable-week, and month boundaries therefore
preserve DST transitions instead of pretending that a bucket is an instant or fixed duration.

The adapter uses the RFC's two-valued null rule consistently in SQLite and compensated aggregate
filters: null equals only null, is unequal to non-null, ordered comparisons with null are false,
and list membership treats null as an ordinary explicit member. Whole-record replacement is an
atomic delete-plus-insert so
omitted columns and stale derived vectors cannot survive the replacement.

Canonical ingest receives the same expanded mandatory-pushdown scope used by reads. Inserts check
their complete candidate row, replacements check both the existing and replacement row, and
deletes include the scope predicate in the mutation. Batches retain one accepted/refused outcome
per input record; CAS conflicts do not roll back successful siblings, and only accepted records
appear in the batch write receipt. Receipt observation distinguishes a non-ready certified state
from an unavailable guarantee with `AFTER_WRITE_TIMEOUT` and its structured retry remedy.

The remaining deliberately unsupported write surface is derived indexing:

- `CanonicalIngestPlan` does not identify derived representations, so its receipt can truthfully
  certify only `record`. `RetrievalIndexMutation` also lacks the dataset and id-field bindings
  needed to locate a SQLite row safely, so `retrieval-index.v0` is deliberately not advertised.

The contract also does not contain a provisioning facet, indexed-EmbeddingSpec declaration, or
average scale/rounding rule. This adapter keeps provisioning explicit, treats the resolved vector
binding as its indexing declaration, and refuses non-terminating exact averages.
Because `ResolvedValueType.money` fixes one currency on each field, a conforming plan cannot
represent the RFC's mixed-currency aggregate case; stored values with another currency fail the
binding check before aggregation rather than being silently converted.
