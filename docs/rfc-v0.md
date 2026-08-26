# AgQL v0 — Normative Contract (DRAFT)

Status: **draft for implementation**. This document is the small, normative
companion to [brief.md](brief.md) (vision and rationale). Where they
disagree, this document wins for v0. Key words MUST, MUST NOT, SHOULD, MAY
are used in their usual normative sense. Nothing here names or depends on
any specific product; backends are identified by adapter capability, never
by brand.

---

## 1. Scope of v0

v0 defines: the kind system and canonical wire forms (§2); canonicalization
and the three identities (§3); the catalog kernel (§4); three query modes
over **one logical dataset per query** (§5); policy evaluation (§6); the
ingestion contract with named visibility receipts (§7); result channels
(§8); capability profiles and the adapter contract (§9); errors (§10); and
conformance (§11).

v0 does **not** define: query-authored joins or edges, nested queries,
`derive`, `merge`, percentile, rerank pipelines, multi-vector retrieval,
materialized datasets, artifacts, publication, federation, attenuable
credential formats, differential privacy, or derived-policy propagation.
Deferral is normative: a v0 implementation MUST reject these constructs
with `UNSUPPORTED_IN_V0`, not implement them incompatibly.

## 2. Kinds and canonical wire forms

| Kind | Wire form | Rules |
|---|---|---|
| `id` | JSON string | exact code-unit identity |
| `boolean` | JSON boolean | no coercion |
| `integer` | JSON integer | within the safe interoperable range; no float coercion |
| `decimal` | canonical decimal **string** | never binary floating point |
| `money` | `{ "amount": "<decimal-string>", "currency": "<ISO-4217>" }` | currency is part of the type; cross-currency aggregation MUST be refused absent an explicit conversion definition |
| `text` | JSON string | core comparisons case-sensitive; Unicode normalization NFC; collation version declared per catalog |
| `enum` | stable code string | display label is metadata, never the value |
| `date` | `YYYY-MM-DD` | calendar date, no zone |
| `instant` | RFC 3339 UTC string, declared precision | |
| `null` | JSON `null` | backend null semantics map to AgQL rules, not vice versa |

Binary floats are not a v0 kind. Time buckets in results are **calendar
periods** (`{start, endExclusive, timezone}`), never fake instants.
`duration`, `localDateTime`, and richer numeric kinds are reserved for v1.

## 3. Canonicalization and identities

- The canonical form of any request is the RFC 8785 (JCS) serialization of
  the schema-validated tree **after defaults are materialized**.
- `sourceQueryHash` = SHA-256 over that canonical form. Equal hashes imply
  identical canonical queries; the implication is **one-directional** — no
  semantic-equivalence normalization is attempted.
- `effectivePlanHash` binds the resolved logical plan: `sourceQueryHash` +
  language, catalog, and policy versions + scope fingerprint.
- `executionFingerprint` binds one execution: `effectivePlanHash` + binding,
  engine, and adapter versions + anchor + snapshot/watermark + EmbeddingSpec
  + quality profile + channel policy. Caches key on this; audit stores all
  three.
- Accepted input encodings (JSON; the fenced AgQL-YAML profile) normalize to
  the canonical form at the edge before anything else. See
  `conformance/encoding/`.

## 4. Catalog kernel

A v0 catalog declares, per dataset: `idField`; typed `fields` (kind,
nullability, enum values, text collation); advertised `profiles` (§9);
`embeddings` (name → EmbeddingSpec reference); optional default filters;
a required row-scope declaration (partition dimensions or explicit
none-with-reason); and capability tags. Descriptions are REQUIRED on
datasets and fields — model-facing documentation is generated from the
catalog, and an implementation MUST be able to emit it.

An **EmbeddingSpec** declares: source fields; input transform id; model
`{id, revision}` where `revision` is the strongest immutable identifier the
provider allows (a marketing name alone is non-conformant); dimension;
metric; vector encoding; `chunking: "none"` (the only v0 value); and a
privacy class. **The runtime owns embedding generation**: one spec resolves
to one runtime-owned embedder, and adapters receive vectors — they MUST NOT
generate them or delegate semantics to backend inference endpoints. A
changed model revision is a new EmbeddingSpec version.

## 5. Query modes

Every query: `version: "0"`, one `mode` (`records` | `aggregate` |
`retrieve`), one `from` dataset, optional closed `where`, explicit `order`
(records/aggregate) with a stable-id final tie-break, mandatory bounded
`take`. All output references use explicit `id`s. Structural limits
(predicate nodes and depth ≤ 2 boolean nesting, in-list size, select count,
take ceilings) are spec constants deployments may lower, never raise.

**Predicates** (closed): `eq ne lt lte gt gte in notIn isNull isNotNull
contains startsWith` (escaped substring semantics, never regex), the
relative-time family (`inLast`, `inCurrent`, `inPrevious`; compiler-owned
calendar math over an explicit anchor), combined with `and`/`or`/`not`.

**`records`**: projection (`select` from the field vocabulary, policy
filtered) + predicates + total ordering + `take`.

**`aggregate`**: `dimensions` (fields, calendar time buckets),
`metrics` (`count`, `countDistinct`, `sum`, `avg`, `min`, `max`, `ratio`
of two aggregates with divide-by-zero → null; per-metric predicate
filters), `having` over metric ids, ordering over output ids.
Cross-currency `sum`/`avg` over `money` MUST refuse.

**`retrieve`**: a `search` block —
`{kind: "semantic", using: <EmbeddingSpec ref>, text, accuracy:
"exact"|"approximate", quality: <profile>}` or
`{kind: "hybrid", semantic: {...}, lexical: {field, text},
fusion: "rrf-v0", quality}` — plus predicates, projection, `take`.
There is no `topK`, no index name, no physical knob. `rrf-v0` is a fixed
formula and constant with stable-ID tie-break; fusion is byte-identical
conformant, hybrid results are always approximate. Results carry `rank`,
never backend scores.

**Determinism declaration**: every result names `query: exact` (records,
aggregate, exact retrieval — golden byte-equivalent conformance; exact
vector = deterministic membership and order with bounded numeric distance
tolerance, behind a declared eligible-set admission limit) or
`retrieval: approximate` (never identical neighbours; hard eligibility
invariants + certified recall distribution). Freshness reports two axes:
write visibility (`unconstrained` | `afterWrite`) and execution snapshot
(`none` | `request` | `transaction` | `historicalPinned`). Replay tier is
`auditable` | `reevaluable` | `exactReplay`.

## 6. Policy evaluation

Scope = `{principal, capabilities, partitions, budgets, expiresAt}`,
resolved server-side, REQUIRED on every operation; empty partitions mean
*nothing visible*. Field policy is per **operation** and per **channel**:
`select, filter, group, order, aggregate[], lexicalSearch` on fields;
`semanticSearch` on EmbeddingSpecs (an embedding derived from protected
fields inherits the most restrictive search permission of its sources
absent an explicit reviewed rule). Release policies (e.g. `minimumCohort`)
are output-release controls applied per channel — **inference dampeners,
not privacy theorems** — paired with per-task query budgets and audit.
Policy violations are compile-time refusals: the backend is never called.
Errors never enumerate what scope hides; unauthorized and nonexistent
references share one error shape.

## 7. Ingestion and receipts

Operations: `insertOnly`, whole-record `replace`, `delete` — with stable
ids, REQUIRED idempotency keys, per-record outcomes plus one batch receipt.
`ifVersion` compare-and-swap is a declared capability of canonical-store
adapters. No update operators, no expressions, no `merge`.

A **write receipt** reports, per record, named visibility states over the
canonical record and every derived representation:

```json
{ "receipt": "wr_…", "records": [ { "id": "…", "version": 7,
  "visibility": {
    "record":  { "state": "ready", "token": "opaque:…" },
    "lexical": { "state": "ready", "token": "opaque:…" },
    "embedding:memory_text@3": { "state": "pending" } } } ] }
```

States are monotonic (`accepted → ready | failed → superseded`); tokens are
opaque and MUST NOT expose backend-native identifiers. A query MAY carry
`afterWrite: {receipt, require: [...], timeoutMs}`; the engine MUST succeed
only when every required state is visible **to that query**, else return a
structured timeout. **False success is a conformance failure; timeout is a
valid result.** Deletes carry the same contract: after a delete's `record`
state, no read returns the record; retrieval may additionally require the
embedding-deletion state. During an embedding migration, a query requiring
`spec@2` MUST wait or refuse — never silently search `spec@1`. Where an
adapter's deployment mode cannot honor the receipt (e.g. weak replicated
write ordering it has not certified), `afterWrite` MUST refuse.

## 8. Result channels

The model channel returns: result schema, policy-filtered capped preview
rows, truncation flag, determinism/freshness declarations, the provenance
envelope (all three identities, catalog/policy/binding/adapter versions,
scope fingerprint, anchor, retrieval provenance incl. EmbeddingSpec,
query-vector digest, quality certification reference, replay tier), and a
non-authoritative `principalResultAvailable`. Principal results are served
only by a **separately authenticated endpoint** under the user's own
credential and MUST never appear in model-channel payloads. Host
conformance (§11) covers the rest; the server-side guarantee is that
nothing principal-only is ever placed in a tool result. Operator responses
SHOULD carry a component timing breakdown (auth, validation/policy,
query embedding, adapter compile, backend, fusion/release).

## 9. Capability profiles and the adapter contract

Profiles: `records.v0`, `aggregate.v0`, `retrieve.semantic.v0`,
`retrieve.hybrid.v0`, `ingest.canonical.v0`, `retrieval-index.v0`. A source
advertises profiles plus consistency capabilities; a query is portable
between sources **iff both advertise its profile**. A retrieval-index
adapter legitimately declines records/aggregate/canonical profiles.

Adapters receive the resolved, typed, scope-expanded logical plan — never
the model AST. Hard rules: effective scope predicates enforced before any
logical record content crosses the backend/adapter trust boundary (internal
index traversal of ineligible nodes is permitted; surfacing them is not);
model scalars travel as native parameters/typed API values only;
catalog-resolved physical identifiers only; hard backend row/candidate
limits present. Bounded compensation in v0 is limited to: final
projection/redaction, canonical scalar conversion, stable tie ordering
over bounded results, `rrf-v0` fusion over bounded ranked lists, and exact
distance-convention normalization. No engine-side joins or grouping.
Refusal (unsupported profile, unenforceable scope, exact-scan budget,
unavailable freshness tier, unindexed EmbeddingSpec, uncertified filter
shape, cost gate) is a typed success of the safety design.

Canonical-store and retrieval bindings are separate; the runtime's durable
outbox and embedding worker connect them where they are split.

## 10. Errors

Every rejection: stable machine code + self-contained sentence + JSON
Pointer path + enumerated legal alternatives computed **within scope**.
Validation order is deterministic: all structural errors, then the first
semantic error in document order. Cost/capability/freshness refusals name
a remedy. Rejections are results, not transport errors. The error catalog
(codes, required content, disclosure rules) is normative; `ENCODING_*`
codes are already fixed in `conformance/encoding/`.

## 11. Conformance

- **Exact suite** (golden, byte-equivalent after canonicalization): seeded
  corpora over records/aggregate/exact-retrieval for every adapter
  advertising those profiles; includes tie-break, null, half-open ranges,
  negative decimals, money refusals, enum ordering, deterministic errors,
  hidden-field shapes, canonical-hash fixtures.
- **Retrieval suite** (statistical + adversarial): deterministic PRNG
  corpus with filter-selectivity classes (≈50%, 10%, 1%, sparse
  intersections); exact eligible-set oracle; recall@k reported as a
  distribution (mean, median, lower-tail quantiles) — thresholds for named
  quality profiles are set **from the first cross-adapter measurements**,
  not invented beforehand; certifications name corpus + configuration +
  version and are re-measured on drift.
- **Security probes** (zero-tolerance, fuzzed at scale): nearest
  unauthorized vector; filter trap; hybrid channel leak; sparse
  intersections with no padding; embedding-permission compile refusal;
  hidden-catalog probe shape; cohort release; write→search; delete→search;
  migration split. Tens of thousands of randomized scope/filter/query
  combinations MUST yield **zero ineligible results**.
- **Encoding suite**: `conformance/encoding/` (pairs + rejections).
- **Host profile**: a conforming host never routes principal-only data into
  model context; verified by instrumented host tests.
- **Protocol equivalence**: one request through the MCP profile and the
  HTTP profile yields identical identities and semantics.

## 12. Acceptance gates (v0 exit)

Exact portability across two canonical adapters (byte-equivalent golden
results); zero authorization violations across the adversarial corpus;
receipts never falsely succeed; per-adapter recall distributions published
against one oracle; complete backend opacity in all agent-facing surfaces
(no dialect, index, or physical names); runtime overhead measured
separately from backend/embedding latency and small relative to them;
protocol equivalence; complete provenance on every retrieval answer. These
gates are the falsification test of the brief §5 made executable: failing
them means the contract has not earned its complexity.
