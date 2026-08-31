# `@agql/adapter-sqlite`

Embedded, file-backed SQLite reference adapter for the v0 exact core. It advertises
`records.v0`, `aggregate.v0`, `retrieve.semantic.v0`, and `ingest.canonical.v0`.
Semantic retrieval is exhaustive and exact only; hybrid and approximate retrieval are not
advertised and approximate semantic plans receive `UNSUPPORTED_PROFILE`.

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

The runtime provisioner creates one catalog-resolved dataset table with catalog-branded field
names, plus `__agql_version INTEGER NOT NULL` and `__agql_deleted INTEGER NOT NULL` columns.
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

Decimals are stored and compared as canonical text, never SQLite `REAL`. Aggregation uses the
shared exact decimal functions after scoped source selection; averages whose exact result has no
terminating decimal form refuse rather than round. Money is canonical JSON text with its currency
checked on reads and exact amount aggregation within the catalog-declared currency. Calendar
period calculation uses the supplied IANA timezone in adapter code, rather than SQLite UTC date
functions; Monday is its fixed week start.

## Contract gaps kept explicit

The frozen v0 contracts leave three required behaviours without a representable adapter result,
so this package refuses rather than fabricating compatibility data:

- `AdapterRow` accepts only `TypedValue`, which has no `calendarPeriod` variant. Aggregate plans
  with calendar dimensions calculate their period but return `UNSUPPORTED_PROFILE` before emitting
  an unrepresentable row.
- `VisibilityOperations.observe` can return only the restricted `AdapterRefusal` union, which
  excludes RFC §7's `AFTER_WRITE_TIMEOUT`. This adapter observes immediately-ready `record`
  visibility and uses `FRESHNESS_UNAVAILABLE` for non-ready or unsupported representations.
- `CanonicalIngestPlan` contains only a scope fingerprint, not an expanded write-scope predicate,
  and `WriteReceipt` has no outcome shape for a missing CAS/delete record because every receipt
  record requires a version. The engine must authorize writes before this adapter boundary; a
  missing CAS/delete is therefore rejected as a contract-input failure rather than assigned a
  made-up version.

The contract also does not contain a provisioning facet, indexed-EmbeddingSpec declaration, or
average scale/rounding rule. This adapter keeps provisioning explicit, treats the resolved vector
binding as its indexing declaration, and refuses non-terminating exact averages.
