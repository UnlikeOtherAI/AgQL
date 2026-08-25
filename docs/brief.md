# AgQL — Agents Query Language

**A data contract designed for AI agents the way SQL was designed for humans.**

SQL is fifty years old and it shows: it was built for a person at a terminal,
then bent to serve applications through string concatenation and ORMs. Now we
hand it to LLM agents — and alongside it a second, unrelated stack of vector
stores with their own APIs, their own auth, and no governance at all. AgQL
starts over from the question: *if the author of every query is a language
model and the operator of every database is a guarded runtime, what should the
contract between them look like?*

The whole idea in one line:

> **One governed, MCP-native contract for agents: store records, retrieve them
> structurally or semantically, and get the same security, meaning, and
> provenance across every supported backend.**

Three pillars are the spine of the design:

1. **Deterministic — as a set of declared, testable tiers.** The same AgQL
   query always validates the same way, compiles the same way, and means
   exactly one thing; exact queries produce reference-identical results on
   every backend. Semantic retrieval is *explicitly approximate* — and its
   conformance is specified too: security invariants, filter correctness,
   measured quality envelopes, and full provenance, never a false promise of
   identical neighbours (§3.5). Naming which guarantee applies, per query, is
   itself part of the contract.
2. **Fully MCP-enabled.** MCP is *the* access path. Agents reach data entirely
   through the AgQL MCP surface — tools for the query loop, resources for the
   catalog — and that surface is core language design (§3.11), not an
   integration bolted on later.
3. **Database-agnostic.** AgQL is defined against a **logical data model**, not
   against any backend's language. A per-backend **adapter** compiles AgQL to
   native queries — relational (Postgres, MySQL, SQLite), document, graph,
   columnar, and vector indexes — and a backend earns the claim by passing the
   conformance suite, not by marketing (§3.8). The honest phrasing: *any
   backend with a conforming adapter becomes agent-accessible.*

And one deliberate split that protects the strongest safety property: AgQL has
**two contracts, not one**. The **Query Core** is read-only and incapable of
writes by construction. The **Agent Storage API** (§3.9) is a separate, tiny,
idempotent ingestion contract — because agents do need to remember things, but
"easy storage" must never mean an update language inside the query language.

AgQL is not a wrapper around SQL, and it is not another database. It targets
native engines the way TypeScript targets JavaScript: nothing reaches the
target except through the compiler, so the target's footguns stay out of reach.

---

## 1. Why

### 1.1 What is wrong with what agents have today

**Injection is the language, not a bug in it.** SQL has no boundary between
code and data. An agent writes the code part *every time*, so every query is a
fresh chance to interpolate hostile data — and the agent itself is injectable:
a prompt injection hidden in retrieved content becomes a query the agent
"chose" to write. Production databases have been wiped by agents that were
told, in prose, not to touch them; database tools exposed to agents have leaked
whole tables through instructions planted in a support ticket. The pattern is
always private data + untrusted content + a channel out, glued together by a
language with no guardrails of its own. Prose enforces nothing; only the
execution path can. Structured formats do not save you either: JSON query
languages with open operator sets and embedded evaluation reproduce every one
of these failures — a value position that also accepts operators *is* the
injection.

**Guarding a native language means re-implementing it.** Parsing dialects,
proving read-only-ness (through views, functions, statement batching that
escapes a read-only transaction wrapper — publicly bypassed with a trailing
`COMMIT; DROP TABLE …`), bounding cost: every allowlist-by-regex setup is an
admission that the language cannot be validated, only sandboxed after the
fact. A language for agents must be **deterministically validatable**: a
finite check, not a parser arms race per backend.

**Unbounded by default.** No limit, no timeout, no cap on joins or traversal
depth, full scans from one forgotten filter. Humans learn the footguns; a
model re-rolls them stochastically.

**Two unrelated stacks, two security models, zero shared governance.** The
same product's data now lives in a relational store *and* a vector index. The
agent juggles SQL in one tool call and a vendor-specific retrieval JSON in the
next; row-level security exists on one side and nothing comparable on the
other; "sensitive" means something in the warehouse and nothing in the
embedding space — even though the embedding of a sensitive field is itself
sensitive data. Nobody's permission model spans both halves of one question.

**Freshness is folklore.** Vector indexing is asynchronous almost everywhere:
`put()` succeeding and `search()` finding the record are different events,
separated by an embedding queue and an index refresh. Today agents bridge that
gap with sleep-and-retry loops against backend-specific notions (log sequence
numbers, guarantee timestamps, refresh intervals) that no model should ever
have to know about.

**Results go to whoever holds the connection.** Every database and vector API
returns the same payload whether the consumer is an LLM whose context ships to
a third-party gateway, a browser UI, or an export job. There is no concept of
"the model may see a redacted preview while the human sees the real rows" —
which means every query result is a potential exfiltration payload.

**Errors are written for DBAs, and nondeterminism is a correctness bug.**
`column "revanue" does not exist` withholds exactly what the model needs (what
*does* exist). Unordered results, clocks read at unlogged instants, collation
differences between engines, and silently drifting embeddings make agent
answers unreproducible — and the incident record already includes an agent
confabulating what it executed, so nothing the agent says about its own
queries can be trusted; only the engine's log can.

**Dialect noise wastes the model — multiplied per backend.** The benchmark
record is blunt: models that look solved on toy text-to-SQL collapse to
single-digit-to-teens success on real enterprise warehouses, and the dominant
error is *schema linking* — picking the wrong table or column out of an
enormous undocumented namespace. Curated vocabularies attack exactly that.

### 1.2 What the contract optimizes for

1. **Deterministic in declared tiers** — one meaning, one validation outcome;
   reference-identical results where exact, specified quality envelopes where
   approximate, and every answer labeled with which it is.
2. **Model-emittable** — structured output against a schema, so syntactic
   validity is guaranteed at the sampling layer, not hoped for.
3. **Safe by construction** — no syntax for the dangerous thing; every model
   string is matched against a closed vocabulary or bound as a parameter; the
   query language has no writes.
4. **Bounded by construction** — caps on joins, predicates, output, rows,
   depth, and cost are part of the language, checked before execution.
5. **Capability-scoped** — every compilation takes a scope, down to
   per-field, per-*operation* permissions, and the scope shapes what the model
   is even told exists.
6. **One governance model over structured and semantic access** — the same
   scope, the same field policies, the same audit, whether the question is an
   aggregate or a similarity search.
7. **Fresh by contract** — writes return receipts; queries can wait on them;
   "searchable" is a guarantee, not a race.
8. **Channel-aware** — model preview and principal result are different
   release decisions with different policies.
9. **Self-repairable** — errors are part of the spec: they name the offending
   part and enumerate the legal alternatives.
10. **Auditable and replayable** — queries, anchors, embedding versions, and
    index watermarks are logged so any answer can be reconstructed.
11. **Teachable from the source of truth** — model-facing docs are generated
    from the same catalog the compiler enforces.

---

## 2. Prior art and the novelty boundary

Nothing here is invented from nothing. The pieces exist, proven separately;
the whitespace is the contract that joins them.

### 2.1 The in-house precedents: aiStats querySpec and Remember Ninja

The closest working precedent is in-house: the Kilomayo monorepo's AI stats
assistant (`organization/backend/lib/aiStats/`) is a production instance of
the guarded-structured-query pattern for the relational case. Its shape: a
JSON query spec validated by a strict schema (dataset, named join edges,
select with time buckets, aggregates with per-aggregate filters, a ratio
composite, AND-combined closed-operator predicates including relative-time
operators, alias-based grouping and ordering, a capped limit); a **catalog
allowlist** through which every identifier resolves or is rejected, model
strings only ever matched against catalog keys or bound as parameters; hard
limits as documented constants plus a statement timeout inside a read-only
transaction; **scope compiled in mandatorily** (capabilities and row
partitions, enforced on join targets too, empty meaning nothing); errors
written for the model, naming the offending part and listing legal
alternatives while never enumerating what capabilities hide; progressive
catalog disclosure narrowed to the caller; verify-then-persist for saved
queries, which re-execute under the *reader's* scope; two result channels
(sensitive fields blanked for the model, rendered for the user); prompt-
contract tests keeping taught vocabulary and schema in lockstep; and hard-won
engine ergonomics (grouping by ordinal, scope predicates in LEFT-join `ON`
clauses, a `__proto__` alias ban, compiler-owned timezone and business-day
math).

Its limits are AgQL's starting backlog: AND-only predicates, no composition
of any kind, no OR at first, single-operator arithmetic, no post-aggregation
filtering, **one backend (Postgres), one paradigm, zero vector or retrieval
story**, cost control by timeout only, and a bespoke in-process tool surface
rather than a protocol. Every one was a sane product-scoping decision; the
list marks exactly where a *language* has to be more than a *feature*.

**The second precedent is Remember Ninja** (`remember.ninja` /
`remember.ninja-cli`) — memory-as-a-service for agents, and the strongest
demand evidence this brief has: a memory product whose architecture was
forced, independently and for one vertical, to reinvent most of AgQL's
runtime contract. Its shipped v1: versioned assertions with hierarchical
keypaths (deterministic point lookup), supersede-and-retract instead of
overwrite, hybrid lexical+semantic search over Postgres FTS + pgvector,
scoping by service → user/team, REST + WebSocket + MCP transports, and a
local-first SQLite CLI implementing the *same concepts on a second backend*.
Its v3 target design converges further, line by line, on this brief:
`index_state: lexical_only|embedded` and `indexed_through` on every recall
**are** the write-watermark / read-your-writes contract; pinned immutable
`embedding_profiles` with dual-write blue-green migration **are**
EmbeddingSpecs; server-derived most-restrictive visibility, per-membership
clearance ranks, and a registry-authoritative RLS matrix **are** the scope
model; RRF fusion with deterministic final ordering and raw scores never
exposed **is** the retrieval profile; mandatory idempotency keys, metered
quotas enforced before work begins, visibility-preserving `not_found`, and a
flagged degrade ladder (drop rerank → vector → lexical-only) all appear in
both documents, discovered separately. Two in-house products, two verticals,
one substrate reinvented twice — the substrate is the product.

Remember Ninja also *teaches* AgQL things the brief would otherwise miss,
now folded in as requirements: **data-provenance trust tiers and taint**
(who wrote a record — verified source vs agent vs external sender — carried
into the model channel, with trust-weighted ranking and per-author caps so a
poisoned source cannot stuff the context); **lineage** (supersede history as
a first-class, queryable version chain, not just `ifVersion` CAS);
**two-phase guarded destruction** (a preview listing attached rationale and
dependents plus a confirm token, so an agent weighs before it deletes);
**compliance erasure as a cascade** that must reach embeddings, caches, and
the audit's replay envelope — "replayable" and "erasable" have to be
reconciled by design, not discovered in conflict later; and the reminder
that retrieved memory is *untrusted evidence, never instructions*, which the
model channel should label structurally. What stays out of AgQL is equally
instructive: Remember Ninja's editorial verbs (`remember`, `why`, `forget`),
its memory cards, its ingestion segmenter — that is a *domain application*,
exactly the layer AgQL says belongs in purpose-built tools above the
substrate.

**A third precedent, KiloTalk**, closes the case. A support-response
suggester whose admin loop learns from the humans it assists: suggestions are
attributed against what the human actually sent (embedding-similarity edit
classification), edits become feedback events, an extractor distills them
into versioned, embedded **lessons** with evidence and history, retrieval
scores lessons back into future suggestions with per-use attribution rows
(lesson id, version, rank, similarity, score — a hand-built provenance
envelope), an outcome judge closes the loop, and a nightly half-life decay
retires what stops being reinforced. Underneath that genuinely novel domain
loop sits the same substrate a third time: seven separately-plumbed pgvector
tables on the same embedding model the other two systems use, hand-written
similarity-scoring SQL, bespoke namespaced MCP tools, outcome-gated
retrieval, and an eval/replay harness. The lesson for AgQL is the division
the loop itself proves: extraction, decay, and judgment are *application*
intelligence and stay above the contract — while versioned embedded records,
retrieval with scoring profiles, per-use provenance, scoped access, and
freshness are the substrate that has now been built three times where once
would have done.

### 2.2 Query-language lineage

**GraphQL**: schema-typed queries with no storage access, traversal only along
declared edges, query shape separated from values (killing injection
structurally), persisted-query allowlists as the endgame of "queries are
data" — and the proof that without static cost analysis, declared-edge
traversal is still a denial-of-service vector. **PRQL and KQL**,
independently: the linear pipeline of transforms beats SQL's inside-out
SELECT for writing, reading, and stage-local validation — and pipelines are
paradigm-neutral, compiling as naturally to document-store aggregation stages
or graph traversals as to SQL; the shape keeps reappearing (Mongo's
aggregation framework, pipe syntax retrofitted into SQL by its biggest
vendors) because it is the shape. **Malloy**: measures and dimensions
declared once and invoked by name; cardinality-aware join semantics so
one-to-many aggregation cannot silently double-count. **EdgeQL**: the
sharpest critique of SQL's non-composability and the cleanest statement of
what composability requires. **MongoDB's aggregation pipeline**: the largest
deployed structured-JSON query language, and the standing warning that JSON
structure is not safety — closed operator vocabularies, disjoint positions
for operators and data, and no evaluable constructs are what safety is.
**SOQL**: two decades of deliberately restricted querying exposed to
untrusted multi-tenant authors — restriction is a survivable, scalable
property. **Datalog**: boundedness as an analyzable language property, and —
inside modern attenuable authorization tokens — the precedent for credentials
that carry machine-checkable restrictions any holder can narrow offline but
never widen.

### 2.3 Vector and retrieval systems

The vector world has grown from "store a float array, call nearest neighbour"
into real structured query systems: one prominent engine exposes a single
structured query API spanning nearest-neighbour, recommendation, filtering,
grouping, ordering, hybrid and multi-stage retrieval, with an explicit
exact-scan mode precisely because its normal path is approximate; others
combine dense and sparse retrieval with reranking, expose selectable
consistency tiers (strong, bounded-staleness, session, eventual), publish
freshness tokens a caller can check a query against, replace whole records on
upsert, and embed configured source text automatically. Three lessons carry:

- **ANN is approximate on purpose.** Graph indexes (HNSW-family) and
  partition indexes (IVF-family) explicitly trade exactness for speed;
  disk-oriented designs trade memory for SSD I/O; flat scan is exact and fine
  when small. Any spec that demands byte-identical top-k across ANN backends
  is demanding what the algorithms do not promise even to themselves.
- **The good primitives exist but are vendor-idioms**: freshness watermarks,
  blue-green embedding migration, content-fingerprint incremental
  re-embedding, namespace isolation. None of them is portable, and none is
  connected to a governance model.
- **Tuning knobs are physical-plan details.** Search-effort parameters, probe
  counts, quantisation — backends expose them to clients; an agent contract
  must hide them behind logical quality profiles.

### 2.4 Semantic layers, agent data planes, and the crowded ground

Semantic layers (metrics platforms, the warehouse vendors' governed metric
views, and now an emerging vendor-neutral semantic-model interchange effort)
converge on: define entities, dimensions, measures, joins once; query by
name. When the warehouse vendors added AI analytics they did not make SQL
safer — they shrank the vocabulary. Meanwhile the operational vendors now
bundle "AI data planes": one product holding agent memory, operational
records, vectors, MCP, prompts, and traces. Between them, the easy novelty
claims are all taken: *another* semantic layer, *another* vector database,
*another* MCP façade over a single store, *another* text-to-SQL improver.

What none of them ships is the **contract**: a portable execution
specification that says exactly what an authorised agent may ask, how exact
and approximate retrieval compose under one scope model, what freshness and
embedding version an answer represents, what each channel may be shown, and
what every backend adapter must prove. Semantic-model *syntax* should be
imported, not reinvented — the catalog can consume existing semantic models
where they exist — but AgQL's catalog is more than semantics: it is the
security object (row scopes, capability tags, field policies, embedding
specs), and no interchange format carries those. That contract — plus the
conformance machinery that makes it testable — is the defensible ground this
project should occupy.

---

## 3. Design proposal

### 3.1 Two contracts

```
AgQL Query Core          read-only · deterministic where exact ·
                         explicitly approximate where retrieval says so

Agent Storage API        idempotent put/delete · typed · scope-controlled ·
                         no update language · catalog-governed embedding
```

The Query Core cannot write; the Storage API cannot query. Nothing that
compiles in the query language can change anything — that sentence stays true
forever, and the storage contract is kept too small to grow into its own
attack surface.

### 3.2 Representation: structured JSON core, textual projection later

**Canonical form: a JSON document validated by a published JSON Schema.** Not
a textual DSL. JSON-under-schema gets constrained decoding and tool-call
guarantees from every provider — over MCP, the tool input schema *is* the
language schema, so syntactic validity is enforced at the sampling layer and
the error budget is spent entirely on semantics. Validation is portable pure
code; queries are data (hashable, diffable, storable, generatable); and
determinism needs a canonical byte form, which a structured document gives
cheaply. The verbosity cost is real and paid deliberately: a terse vocabulary,
plus a **canonical textual projection** (pipeline-style, bijective with the
JSON) for logs, docs, diffs, and humans. The agent reasons freely in prose
and emits the query as a tool call — never forced to open with the
constrained block.

Queries declare one of three **modes** — `records` (fetch), `aggregate`
(group/measure), `retrieve` (semantic/hybrid search) — so the first
discriminator an agent emits is the shape of its question.

### 3.3 The catalog: the logical model and the security object

Queries are written against a logical model, never against storage. The
catalog declares:

- **Datasets** — named, described logical relations; backed by a table, a
  collection, a label, a key range, or a named AgQL query — the query cannot
  tell and must not care.
- **Fields** — closed kind system (`id`, `text`, `integer`, `number`,
  `money`, `boolean`, `timestamp`, `enum`), descriptions, and **operation-
  level policies** (§3.7) instead of a boolean "sensitive".
- **Edges** — named relationships with direction, join type, and
  **cardinality** (`one`|`many`), so fan-out double-counting is rejected or
  auto-corrected at compile time instead of returning numbers that are wrong
  but look right.
- **Measures** — governed named aggregations ("revenue = sum of net line
  totals excluding canceled"), the paved road past schema linking.
- **Default filters** — with descriptions and an explicit, visible opt-out
  (`withoutDefaults`).
- **Row scopes** — per dataset, required: how it narrows to a caller's
  partitions, or an explicit none-with-reason.
- **Capability tags** — which grant unlocks each dataset and every edge into
  it.
- **EmbeddingSpecs** — embeddings as schema, not incidental float arrays:

  ```text
  EmbeddingSpec: id · source fields · normalisation · chunking policy+version ·
                 model family + immutable version/digest · dimension · metric ·
                 privacy classification · index quality profiles
  ```

  Every materialised vector records the record version, source content
  digest, spec id+version, and index watermark, with a lifecycle state
  (`pending | ready | failed | superseded`). Changing an encoder is a schema
  migration (dual-write, background re-embed, switch) — never an invisible
  relevance change. `embedding_v3` means the same logical derivation on every
  backend. A sensitive field's embedding is itself sensitive derived data and
  inherits policy.
- **Statistics hints** — expected magnitudes, feeding the cost gate.

Everything the model is taught is generated from the catalog and served as
MCP resources; prompt-contract tests keep taught vocabulary and compiler in
lockstep. Where an organisation already maintains semantic models in an
interchangeable format, the catalog imports them and adds the execution-only
parts (policies, scopes, embedding specs, bindings) — AgQL does not compete
on semantic-model syntax.

### 3.4 Core operations

**Structured pipeline** (modes `records` and `aggregate`), stages in fixed
order: `from → join* → where → select(+group) → having → order → take`.
Closed vocabulary: comparison/in/null/bounded-text predicates (escaped
pattern matching, never regex) and the relative-time family (`inLast`,
`inCurrent`, `inPrevious` — calendar math is the compiler's, timezone- and
fiscal-day-aware); `all`/`any`/`not` trees capped at depth 2; timeline
buckets vs profile folds as distinct named constructs; aggregates
(count/countDistinct/sum/avg/min/max/bounded percentile) with per-aggregate
filters and the ratio composite (zero denominator → null); single-level
aggregate arithmetic (`add`, `subtract`, `multiply`, `negate`, `coalesce`,
`minutesBetween`) — deliberately not an expression tree; `having` reusing the
predicate forms; `take` mandatory-with-default, capped.

**Retrieval** (mode `retrieve`) adds a `search` block that composes with the
same predicates, the same scope, the same field policies:

```json
{
  "version": "1",
  "mode": "retrieve",
  "from": "documents",
  "search": {
    "kind": "semantic",
    "field": "body",
    "text": "refunds for cancelled annual plans",
    "accuracy": "approximate",
    "topK": 20
  },
  "where": { "kind": "predicate", "field": "status", "op": "eq", "value": "published" },
  "take": 20
}
```

What is *not* in it is the point: no index name, no ANN parameters, no vector
dimensions, no model provider. `accuracy` is `exact` (true distance over the
eligible set — the reference semantics, always available, cheap when
collections are small or filters are tight) or `approximate` (ANN under a
named **quality profile**). Hybrid retrieval (semantic + lexical channels) is
specified as **rank-based fusion** — backend-specific raw scores are not
portable and are never treated as such — and an optional bounded rerank stage
records its model version in provenance. Filters and scopes apply to
candidate *eligibility*, never as post-hoc trimming an adapter may skip.

**Composability**, deliberately small: named queries registered in the
catalog become datasets (compiling under the reader's scope, so views cannot
launder privilege); `from` may be one inline query (depth cap 2) with a
bounded `derive` between the levels; and a **multi-query request** runs
several independent queries under one scope and budget in one round-trip.

**Not in the vocabulary** (§5.2): raw expressions, UDFs, regex, recursion,
correlated subqueries, writes.

### 3.5 Determinism: declared tiers, dual conformance

"Deterministic" is not one promise stretched over incompatible guarantees; it
is a small vocabulary of testable ones, and every answer names the tier it
was served under.

**Always, for every query, on every backend:**

- *Structural determinism* — canonical serialization (defined key order,
  defaults materialized), so equal meaning ⇔ equal canonical hash.
- *Semantic determinism* — one spec-defined meaning per construct: null
  handling and ordering, fixed-point money (never floats), integer vs decimal
  division, a specified Unicode collation, week start, timezone and
  fiscal-day bucketing, divide-by-zero → null.
- *Validation determinism* — specified error ordering: all structural errors,
  then the first semantic error in document order; same invalid query, same
  error code, everywhere.
- *Compilation determinism* — (query, catalog version, scope, adapter
  version) → byte-identical native plan; no clocks, no randomness.
- *Authorisation determinism* — scope enforcement is exact and identical
  across backends, including in every approximate path.
- *Anchored time* — relative-time operators never read the clock; every
  execution carries an explicit anchor timestamp, logged, replayable,
  caller-overridable for replay.

**The Exact Core** (structured queries; `accuracy:"exact"` retrieval): full
result determinism. The engine extends any ordering to a total order with
defined tie-breakers, so `take` and pagination are reproducible; adapters
must reproduce golden results **byte-identically** or they do not ship. Exact
vector search additionally specifies metric, tie-break, and a numeric score
tolerance.

**The Retrieval Profile** (`accuracy:"approximate"`, hybrid, reranked):
explicitly approximate, with conformance redefined — *never* identical
candidate sets across adapters, but instead, all of:

- no out-of-scope candidate is ever returned, and every predicate is honored
  in eligibility (hard invariants, tested adversarially);
- the declared quality profile's recall floor is met, measured as a
  *distribution* over a reference corpus, not an average that hides tail
  queries;
- deterministic final tie-breaking after fusion/rerank;
- the freshness contract (§3.9) is honored;
- full provenance is returned (§3.11).

**Snapshot tiers**, declared per adapter and reported per result:
`snapshot-exact` (point-in-time read) · `read-your-writes` (watermark
honored) · `bounded` · `best-effort`. Claims are never silently weakened; a
query may *require* a tier and receive a structured refusal if the backend
cannot provide it.

This split is a feature, not a concession: it is what lets one contract span
a warehouse aggregate and an ANN lookup without lying about either.

### 3.6 Bounded and safe by construction

- **The closed-vocabulary invariant**: every model-produced string is matched
  against a catalog/enum key or bound as a parameter in the native query.
  There is no third path, on any backend. An adapter that cannot uphold this
  for a construct must not implement the construct.
- **Structural limits in the spec** (deployments may lower, never raise):
  edges, predicate nodes and depth, select entries, in-list size, rows, topK,
  composition depth — each with its rationale, each violation an enumerable
  repairable error, never a silent truncation.
- **Pre-flight cost gate**: `explain` combines catalog magnitude hints with
  whatever the backend offers (planner estimates, index stats, nothing for a
  bare KV store) and rejects over-budget queries with a remedy ("this scans
  ~10M rows; narrow the time window or filter on X"). Estimates are admitted
  generously; runtime backstops (timeouts, row caps applied by the engine,
  intermediate-byte caps) remain authoritative. Budget shape: price
  statically, charge a leaky bucket, true up after execution.
- **Execution guarantees**: read-only access at the backend's own privilege
  layer wherever one exists (a real read-only role, not a wrapper), so a
  compiler bug degrades to "permission denied".
- **The compensating executor has a hard boundary.** Where a backend lacks a
  construct, the engine may finish the plan — but **only over data the
  backend has already filtered to the effective authorised scope**, and only
  below a fixed intermediate-byte limit. Capability and partition filtering
  is *mandatory pushdown*: no adapter may fetch unauthorized rows and rely on
  engine-side filtering, ever. Allowed compensation: bounded rank fusion,
  final canonical ordering, score normalisation, projection, redaction, small
  bounded joins/groups. Not allowed: cross-adapter joins, large engine-side
  grouping, engine-side vector search. Every compensated operation is
  disclosed in `explain`. This is what keeps the portable runtime from
  becoming a slow, memory-hungry, hard-to-secure query engine.

### 3.7 Scope: capabilities, operation-level policies, attenuation, release

```
scope = { capabilities, partitions: {dimension → values | all}, principal,
          budgets: {queries, rows, intermediateBytes}, expiry }
```

- Capabilities gate datasets and every edge into them — reachability equals
  readability. Partition scoping is mandatory at the type level; empty means
  *nothing*, never "everything". Scope shapes disclosure too: catalog
  resources, tool enums, and error alternatives are all narrowed, so what the
  model can name and what it may query are the same set.
- **Field policy is per operation and per channel**, not a boolean. A field
  declares what each channel may do with it:

  ```json
  { "model":     { "select": false, "filter": true, "group": false,
                   "order": false, "semanticSearch": false, "aggregate": ["count"] },
    "principal": { "select": true } }
  ```

  Counting salaries without seeing them, filtering by a field without
  grouping by it, and — crucially — `semanticSearch` as its own permission,
  because retrieval leaks through presence, counts, and rank even when no
  column is returned. Release policies can add minimum-cohort thresholds and
  per-task query budgets; these are honest inference *dampeners*, not formal
  privacy guarantees — a formal differential-privacy aggregate profile is an
  optional later module for datasets that genuinely need it, never a default.
- **Stored queries re-compile under the reader's scope, always.** Persistence
  is not privilege escalation.
- **Scopes are attenuable.** A holder derives a strictly narrower scope —
  fewer datasets, fewer partitions, lower budgets, shorter expiry — offline,
  and hands it to a sub-agent; widening is cryptographically impossible.
  Standard attenuable-token designs (signed tokens carrying appendable
  restriction rules) exist; AgQL adopts one rather than inventing
  cryptography. This is the unit of multi-agent delegation: the orchestrator
  holds the tenant; the sub-agent gets one region, three queries, fifteen
  minutes.
- Because enforcement lives in the engine, it is **uniform across backends —
  including backends that have no row-security story of their own**. For a
  document or vector store, AgQL's scope layer is likely the only row-level
  authorization the data has ever had.

**Deterministic ownership.** Who owns a piece of data — and therefore who may
ever see it — is a pure function with a written algebra, never an inference
made at read time:

1. **Stamped at write, server-derived, immutable.** Every record carries an
   owner tuple `(tenant, ownerSubject | shared, confidentiality)` derived from
   the *authenticated* write context. A caller may request a narrower
   ownership than its context implies, never a wider one: effective =
   most-restrictive(requested, context). After the write, ownership fields
   are immutable to the data path; reclassification is a separate audited
   admin operation that produces a new version, so "who owned this at time T"
   stays answerable and replays use the ownership as of their anchor.
2. **Ownership is data, not location.** Where a record was created — which
   channel, conversation, or agent — is provenance. Who may see it is the
   owner tuple. Deriving visibility from the container is the classic leak
   (a memory created in a private context surfacing wherever the agent
   roams); AgQL forbids it structurally: no read path consults creation
   context for authorization.
3. **One identity authority.** Owner subjects and tenants are stable ids from
   the deployment's declared identity authority; the catalog never stores a
   second copy of who-is-who. Ownership cannot fork because identity drifted.
4. **A specified derivation merge.** Anything derived — materialized dataset,
   view row, embedding, cache entry, index, replay envelope — gets ownership
   computed by the engine as the most-restrictive merge of its sources:
   confidentiality = max, partitions = intersection, shared only if every
   source is shared. Two different subjects' *private* data never merges into
   one object — the derivation is refused, deterministically, rather than
   assigned an arbitrary owner. Same sources, same owner, on every backend;
   the merge has golden conformance tests like any other semantics.
5. **Derived representations inherit, always.** The embedding of a private
   field is private to the same owner; cache keys include the owner
   fingerprint so a cache hit can never become a cross-subject equality
   oracle; audit replay envelopes carry the owner and participate in erasure.
   Nothing derived is ever less restricted than its source.
6. **Widening is a grant, never a mutation.** Sharing does not edit the owner
   tuple; it appends a recorded, principal-confirmed grant (who, to whom,
   what, when, computed under which scope). "Who can see X" is therefore
   always `owner tuple + grant set` — all data, all versioned, all
   replayable — and revoking a grant is deleting a row, not un-mutating a
   label.
7. **Refusal over guessing.** Any operation whose ownership outcome the
   algebra does not define — mixed-private derivation, a write claiming a
   subject the context cannot prove, a link between objects the caller cannot
   fully read — is a typed, repairable error. Ownership is never resolved by
   precedence luck, evaluation order, or a model's judgment.

### 3.8 The adapter layer

```
AgQL → engine (validate · scope · plan · limits · budget · channels)
     → adapter (compile logical plan → native queries; declare pushdown)
     → backend (Postgres+pgvector | SQLite/DuckDB | document | graph |
                columnar | dedicated vector index | KV)
```

The engine owns meaning; adapters own translation. A **binding** maps each
dataset/field/edge/EmbeddingSpec to physical storage — so moving a dataset
between backends is a binding change, invisible to every agent, stored query,
and prompt. Adapters declare a capability profile; the core must be *honored*
everywhere (natively or via bounded compensation, §3.6) and scope pushdown is
non-negotiable. Physical retrieval choices — flat scan vs HNSW-family vs
IVF-family vs disk-oriented ANN, dense+sparse hybrid — are adapter concerns
selected via logical quality profiles; agents never see a knob.

**Reference adapters, chosen to prove different things:** Postgres + pgvector
(one transactional system owning records, filters, exact queries, and
vectors — the integrated path); an embedded pair (DuckDB or SQLite + a
vector-index library) proving the *split* canonical-store/vector-sidecar
architecture and powering a dependency-free conformance and eval harness; one
distributed vector engine proving the IR is not "pgvector in JSON" and
forcing consistency tiers, filtered-ANN, and quality profiles to be genuinely
backend-neutral. Graph and KV families follow later with honest minimalism
(declared access paths; reject at `explain` what the paths cannot serve).

**Conformance has two philosophies** (§3.5): golden byte-identical suites for
the exact core; invariant + quality-envelope suites for retrieval — including
adversarial scope-leak probes against the approximate paths, where the
temptation to cut corners lives.

### 3.9 The Agent Storage API

A separate, deliberately tiny contract — not part of AgQL:

```json
{
  "dataset": "agent_memory",
  "mode": "replace",
  "records": [{
    "id": "memory:customer:123:preference",
    "value": { "text": "Customer prefers invoices as PDF", "customerId": "123" },
    "ifVersion": 6
  }],
  "embeddingPolicy": "catalog",
  "idempotencyKey": "task-7:memory-12"
}
```

- **Modes are explicit and few**: `insertOnly`, `replace` (whole record —
  stated, not inherited from backend upsert folklore), and a narrowly defined
  `merge`. No update operators, no expressions.
- **Stable ids, optional compare-and-swap versions, mandatory idempotency
  keys** — retried agent turns must not duplicate memories.
- **Embedding is catalog-governed**: the EmbeddingSpec decides what gets
  embedded and with what; a model never picks an encoder.
- **Writes return receipts**:

  ```json
  { "writeReceipt": { "recordVersion": 1441, "watermark": "opaque:…",
                      "embeddingState": "pending" } }
  ```

  and any query may carry `afterWrite: watermark` — *execute only when the
  acknowledged write, and whatever embedding state the query needs, is
  visible* — or receive a structured timeout. That single portable primitive
  replaces every sleep-and-retry loop and every backend-specific freshness
  concept, and it is what makes agent memory actually dependable: an agent
  that just stored a fact can rely on retrieving it.
- Deletion is explicit and by id; TTLs are catalog policy. Scope applies to
  writes exactly as to reads: an agent may only write where its scope says.

### 3.10 Derived datasets, artifacts, and the by-reference principle

The end products of agent data work are rarely rows in a chat: they are new
datasets, tables, charts, dashboards, reports. None of that may be paid for
in context tokens. The governing rule, stated once and applied everywhere:

> **Data moves by reference. The model's channel carries names, schemas,
> previews, and receipts — never the payload.**

The model orchestrates; the data plane moves rows between backends,
materialized datasets, and rendering surfaces without transiting the model.

- **Live views** (§3.4) already exist: a validated query registered as a
  dataset, recompiling under each reader's scope. They disclose nothing a
  reader's own scope doesn't allow, so they need no ceremony — but they are
  computation, not products.
- **Declared datasets** cover data that exists in no backend yet.
  `create_dataset(name, description, fields)` lets an agent register a
  brand-new dataset — a research table, a lead list, a tracker — by
  declaring typed fields from the closed kind system (plus optional
  embedding on text fields and optional edges to existing catalog datasets
  it may read). The runtime validates the schema exactly as it validates a
  query: kinds from the closed set only, field policies defaulting
  conservative, description mandatory (an undescribed dataset is one no
  other agent can ever use). The owner tuple is stamped from the creating
  scope (§3.7 rule 1); the dataset starts in `draft` lifecycle under the
  creator's quota; schema evolution is additive and versioned. From that
  moment it is an ordinary catalog dataset: `put_records` fills it,
  every query mode reads it, artifacts render it, publication shares it.
- **Materialized datasets** are the products of queries. `materialize_dataset(query |
  executionReceipt, name)` runs server-side and freezes the result as a
  first-class, versioned dataset — rows flow from backend to storage with
  the model holding only the receipt and the new dataset's name and schema.
  A two-million-row aggregation becomes a queryable dataset without one row
  entering context. The new dataset carries full provenance (source
  datasets, plan hash, anchor, watermark, the scope fingerprint it was
  computed under) and inherits the **most-restrictive** policy of everything
  it derived from — field policies, capability tags, and partition
  constraints flow through, so a derived dataset can never launder privilege
  (the same rule Remember Ninja's memory cards enforce for the same reason).
  Refresh is explicit: re-materialize produces a new version with a new
  provenance record; a materialized dataset is a labeled snapshot, never
  silently live.
- **Sharing is a principal decision.** Within the creator's own scope, a
  derived dataset is immediately queryable — by the creator, and by any
  sub-agent holding an attenuation of that scope (a dataset name plus a
  narrow scope is how agents hand each other large results). Widening the
  audience — publishing to other users, a team, a capability tag — is a
  *release* action confirmed through the principal channel, because a
  snapshot's rows are disclosure, not computation: the human approves what
  the grant covers, and the grant is recorded like any other scope change.
  A model can propose publication; it cannot perform it.
- **Presentation artifacts** — tables and charts — are declarative specs,
  not data: `artifact = (dataset | stored query) + a closed-vocabulary
  presentation mapping` (type from an enum — table, line, bar, pie, stat,
  …; x/y/series mappings validated against the result-shape contract the
  compiler already returns; formats; layout). An artifact is a few hundred
  bytes the model can emit, validate, and edit — while the rendering
  surface resolves the actual data through the principal channel at view
  time, paginated, under the *viewer's* scope. The model builds and edits
  dashboards over data it never holds. (This is the aiStats widget model —
  query + visualization spec, keys checked against select aliases,
  verify-before-save — generalized and made portable.)
- **Lifecycle and budgets.** Agent-created datasets and artifacts are
  quota'd (count, bytes, TTL) and lifecycle-managed (draft → published →
  archived, with retention policy), so the catalog cannot silt up with
  abandoned materializations. Creation, refresh, and publication are
  Storage-API-side operations with idempotency keys — the query language
  itself remains incapable of creating anything.

**Sharing across products.** In an ecosystem of many products on one
identity authority, cross-product data sharing is the same design one level
up — and today it is done pairwise: each product pair builds a bespoke
integration (proxied MCP turns, webhooks, signed identity headers), so N
products cost O(N²) integrations. The AgQL model replaces that with four
rules:

1. **A product's AgQL source is its sharing surface.** Any product that
   exposes an AgQL catalog is consumable by any other product's agents with
   zero pairwise integration code: the consumer *mounts* the source (an MCP
   client + a scope), and the same tools, language, errors, and channels
   apply. The catalog — not a hand-negotiated API — is the contract.
2. **Scopes bridge through the identity authority.** A cross-product caller
   authenticates as (product identity via its product-bound key) + (the
   delegated end-user via identity-authority token exchange) — the dual
   proof the ecosystem already uses — and the *serving* product's engine
   resolves that pair to an attenuated scope under its own catalog and
   policies. The serving product always remains the authority on what a
   foreign principal may read; a cross-product grant is recorded like any
   other (ownership rule: widening is a grant, never a mutation).
3. **Published datasets are the sharing unit; mirrors are marked, never
   authorities.** A product publishes a materialized dataset (or live view)
   to an audience that can include another product. The consumer queries it
   by reference — or *imports* it as a local dataset whose binding names the
   remote source, carrying provenance (source product, catalog version,
   watermark) and explicit refresh. This generalizes the ecosystem's
   identity invariant to all data: **one product is the durable authority
   for any shared dataset; every other product holds references or
   explicitly-marked mirrors with freshness — never a compatibility copy**
   that drifts into a second authority.
4. **Memory shares through the memory service, not sideways.** Agent memory
   is already namespaced `{product}/{org|team|user}` in the shared memory
   service; cross-product memory sharing is a subject-owned, consented
   grant across namespaces there — not products reaching into each other's
   stores.

Cross-*source* joins remain out (§3.8): cross-product composition is
multi-query plus agent synthesis, or materialize-and-import. Both sides log
the same canonical query hash, so a cross-product access is one auditable
event with two coordinated records.

### 3.11 The MCP surface

MCP is the front door and the reference deployment; the tool names, schemas,
resource shapes, and error payloads are normative, so any AgQL server looks
identical to any MCP client. The surface is small:

- `search_catalog` / `describe_catalog` / `lookup_values` — progressive
  disclosure, scope-narrowed; the index in the prompt stays flat as the
  catalog grows; `lookup_values` resolves "what do we call the enterprise
  tier" without a query.
- `explain_query(source, query, afterWrite?)` — full compile, cost verdict,
  result-shape contract, pushdown/compensation split, and the determinism
  declaration (`query: exact`, `retrieval: approximate`, `snapshot: …`).
- `run_query(source, query, afterWrite?)` — executes and returns the
  **model channel**: schema, capped preview rows with field policies applied,
  truncation flag, consistency metadata, retrieval provenance, and an
  **execution receipt**.
- `put_records` — the Storage API (§3.9).
- `materialize_dataset` / `create_artifact` / `update_artifact` /
  `propose_publication` — the derived-dataset and artifact operations
  (§3.10); publication itself completes only with principal-channel
  confirmation.
- `save_query(source, name, query, executionReceipt)` — verify-before-persist
  bound to a **signed receipt** (canonical plan hash + scope + principal +
  expiry, invalidated by catalog/policy changes), not to a transport session.
  Works identically over MCP, REST, and embedded use.

**Result channels are an architecture, not a redaction pass.** The model
channel is a bounded, policy-filtered preview. The **principal channel** is
an opaque, audience-bound result handle resolved by the trusted host or
principal SDK — pagination, streaming, export — which the model never holds.
A prompt-injected agent cannot exfiltrate what its channel never contained.

**Every retrieval answer carries a provenance envelope:**

```json
{
  "sourceQueryHash": "sha256:…",
  "effectivePlanHash": "sha256:…",
  "catalogVersion": "sales@41",
  "scopeFingerprint": "sha256:…",
  "retrieval": { "semantics": "approximate", "embeddingSpec": "support_body@3",
                 "queryVectorDigest": "sha256:…", "indexWatermark": "opaque:…",
                 "qualityProfile": "high-recall-v1" },
  "consistency": { "requested": "readYourWrites", "delivered": "readYourWrites" },
  "anchor": "2026-08-25T12:00:00Z"
}
```

An approximate answer is thereby *auditable* without pretending to be exact:
you know which data version, which embedding definition, which index state,
and which quality promise produced it.

A REST/JSON profile exposes the same contract to browsers and SDKs (MCP for
agents is normative, not exclusive); gRPC/streaming are optional profiles.
Caches key on the **effective plan** — language + catalog + policy versions,
scope fingerprint, embedding spec, query-vector digest, watermark, anchor,
channel policy — never on the source-query hash alone, which remains the
audit/persistence identity.

### 3.12 Errors as a specified part of the language

1. Every rejection is addressed to the model: it names the offending part by
   path, states the rule, and **enumerates the legal alternatives**.
2. Stable machine code + self-contained sentence; error frequencies are the
   empirical feedback loop for evolving the language.
3. **Never enumerate what scope hides** — an unauthorized dataset yields the
   same "unknown" shape as a nonexistent one, in every path including
   retrieval.
4. Deterministic error selection (§3.5).
5. Cost, capability, and consistency rejections include a remedy ("narrow the
   window", "this source cannot guarantee read-your-writes; retry without
   `afterWrite` or against source X").
6. Rejections are tool results, not protocol errors — a readable error is a
   turn; an exception is an outage.

### 3.13 Audit, replay, and the two-tier log

Every execution logs principal, scope fingerprint, canonical and effective-
plan hashes, anchor, snapshot/watermark, cost verdict, pushdown/compensation
split, row counts, duration. But "replayable" must never mean "copy sensitive
query content into ordinary logs": the audit store splits into an
**operational record** (hashes, ids, counts, policies — normal telemetry) and
an encrypted **replay envelope** (full query values, query text/vector,
effective scope, embedding provenance) under stricter access and retention.
Replays re-execute the exact query with its logged anchor and watermark —
under the same or a different scope — and diff the answers. The agent's
transcript is never the audit record; the engine's is. And because the
replay envelope can hold personal data (filter values, query text, query
vectors), it participates in **compliance erasure**: an erasure cascade
reaches records, embeddings, caches, and replay envelopes alike, with the
operational record keeping only hashes and receipts — replayability and
erasability are reconciled by design.

---

## 4. What this enables that today's stacks cannot do easily

Concrete usage, each with the property that makes it hard or impossible to
assemble today from a SQL database + a vector store + an MCP wrapper.

**1. One governed question across structured data and meaning.**
"Which complaint themes are trending among enterprise customers this quarter,
and how much revenue is attached?" — one `retrieve` query semantically
searching tickets, filtered by structured predicates (tier, quarter), joined
by declared edges to revenue measures, under one scope. Today this is two
systems with two auth models and hand-written glue: the vector store doesn't
know what "enterprise" or "revenue" is, the warehouse can't do similarity,
and the joining code is where the security holes live.

**2. A sub-agent that physically cannot exceed its brief.**
An orchestrator investigating a fraud pattern hands a research sub-agent an
attenuated scope: `partitions.region={GB}`, datasets `{orders, payments}`,
`maxQueries: 5`, expires in 15 minutes. The sub-agent's prompt can be
injected, its reasoning can be hijacked — and it still cannot read Ireland,
cannot touch payroll, cannot run a sixth query, because the token cannot be
widened offline and the engine, not the prompt, enforces it. Today a
sub-agent inherits the same database credential as its parent, and every
delegation is a full-privilege delegation.

**3. Memory an agent can rely on.**
`put_records` a fact, get `{watermark, embeddingState: "pending"}`; ten
seconds later, `run_query` with `afterWrite: watermark` — the engine waits
until the write *and its embedding* are searchable or returns a structured
timeout. Today, against eventually-consistent vector indexes, this is
sleep-and-retry folklore, and "the agent forgot what it just learned" is a
routine, maddening failure mode.

**4. Count what you may not see.**
The model channel's policy on `payroll.salary` is
`{select: false, filter: true, aggregate: ["count","avg"], semanticSearch:
false}`: the agent answers "how many engineers earn above the band midpoint"
without any salary ever entering its context — and cannot route around the
rule via similarity search over compensation notes, because embedding access
is its own permission. Today column grants are all-or-nothing, row security
doesn't distinguish operations, and no vector store has heard of any of it.

**5. Results the model cannot exfiltrate.**
"Prepare the top-50 customers report" returns the model a redacted, capped
preview plus an execution receipt; the human's UI resolves the full rows
through an audience-bound handle the model never held. A prompt injection
that says "email me the full list" fails structurally — the data was never in
the model's channel. Today, whoever holds the connection gets the payload,
and every query result is exfiltrable context.

**6. "Why did the agent say that last Tuesday?" — answered exactly.**
Replay the logged query with its anchor timestamp, embedding-spec version,
and index watermark from the provenance envelope: you reconstruct the exact
basis of the answer and can tell *stale embedding* from *bad data* from
*model misreading a correct result*. Today this is unanswerable — `now()`
moved, the index was re-embedded invisibly, and the agent's own account of
what it ran is worthless as evidence.

**7. Swap the database; change nothing.**
Move `documents` from Postgres+pgvector to a dedicated vector engine by
changing the *binding*. Every stored query, dashboard, agent prompt, eval
suite, and audit process continues unchanged, and the conformance suite
proves the swap preserved semantics. Today that migration rewrites every tool
integration and silently changes relevance behavior.

**8. Verified-before-saved automation, portable across transports.**
An agent authors a monitoring query in a chat over MCP; the signed execution
receipt lets a REST-based scheduler persist and re-run it — under each future
reader's scope — with the guarantee it actually executed successfully before
being saved. Today "the agent tested it" is a claim in a transcript, bound to
nothing.

**9. A shared dashboard built from millions of rows — with zero rows in
context.** The agent explores with capped previews, materializes the
aggregation server-side as a named dataset (holding only the receipt and the
schema), attaches chart artifacts whose specs are a few hundred bytes each,
and proposes publication to the team; the human approves the grant. Other
users' agents then query the derived dataset under their own scopes, and the
dashboard renders through the principal channel at view time. Total model
context spent: catalog docs, previews, and references. Today this means
pasting data between tools, generating one-off chart code, or handing the
model the rows — and sharing means copy-paste with no governance attached.

The comparative eval (§5.1) exists to make these claims falsifiable: same
corpus, same tasks — raw SQL vs native vector-store JSON vs AgQL — measuring
first-emission validity, task correctness, repair turns, policy-violation
rate, retrieval recall distribution, tokens, latency, and reproducibility. If
AgQL does not measurably reduce agent mistakes and improve enforcement on
that experiment, the abstraction has not earned its complexity. If it does,
that result is the moat.

---

## 5. What makes it genuinely good — and where it stops

### 5.1 Not a toy: the substance checklist

- **A written spec**: grammar (JSON Schema), kind system with cross-backend
  semantics, limit table with rationales, scope and field-policy model,
  attenuation, the two determinism profiles and snapshot tiers, EmbeddingSpec
  and lifecycle, the storage contract, freshness watermarks, the normative
  MCP surface, channels and receipts, and the **error catalog** with codes,
  required content, and disclosure rules.
- **Two-philosophy conformance**: golden byte-identical suites for the exact
  core (plus the classic traps: grouping-alias ambiguity, scope predicates on
  left joins, prototype-pollution aliases); invariant + quality-envelope
  suites for retrieval (scope-leak probes, filter adversaries, recall
  *distributions* not averages, freshness honesty, provenance completeness).
- **Catalog-derived teaching as conformance**: docs emitted from the catalog
  through MCP resources; prompt-contract tests in the suite.
- **The comparative eval harness** (§4) on the embedded adapter,
  dependency-free — the falsification instrument and the pitch.
- **Cardinality-aware edges**: silently-wrong aggregates are the difference
  between a demo and something a finance team trusts.
- **Three launch adapters spanning architectures**: integrated
  (Postgres+pgvector), split-store (embedded + vector sidecar), distributed
  vector — because two SQL dialects prove a dialect layer, while a split
  store and a non-SQL engine prove the *contract*.
- **A reference implementation** shaped for adoption: TypeScript engine as
  pure functions, adapters as packages, the MCP server as a thin shell.

### 5.2 Deliberate non-goals

- **No writes in the query language, ever** — and the Storage API stays tiny:
  no update operators, no expressions, no bulk transforms. Mutations with
  domain semantics ("issue_refund") are purpose-built tools elsewhere.
- **No native-query passthrough.** No `rawSql`, no `rawPipeline`, no
  power-user mode — the one adapter feature that deletes the entire value
  proposition the day it ships.
- **No UDFs, expression strings, regex, or evaluable anything.**
- **No custom ANN algorithm, no new storage engine, no new semantic-model
  syntax.** Compose what exists; the contract is the product.
- **No full parity with any backend.** Window functions, recursive traversal,
  arbitrary self-joins, unions stay out of v1; real demand gets the *bounded,
  named* form (a `deltaOverPrevious` select kind, a `rank` with mandatory
  partition and take), never the general mechanism.
- **Deferred, explicitly**: cross-adapter federation; graph traversal
  language; universal KV claims; portable lexical-scoring semantics; a
  universal cost-credit unit; formal DP as default; byte-identical ANN
  anything.
- **Not an ORM, not a natural-language layer, no client-trusted anything.**

### 5.3 Honest risks

- **The expressiveness cliff**: agents will hit walls and route to native
  access where it exists; the eval shows which wall matters, and views,
  measures, and named idioms are the valves.
- **The compensating executor** is contained by the §3.6 boundary or it
  becomes an accidental distributed query engine.
- **Catalog + binding authoring is the adoption cost** — bootstrap tooling
  (introspect, LLM-draft, human-curate) and a small-catalog-useful-on-day-one
  design are mandatory, not nice-to-haves.
- **Redaction is not privacy.** Operation-level policies and budgets dampen
  inference; only the optional DP profile ever *quantifies* it. The spec says
  so plainly rather than overclaiming.
- **Scope creep toward "AI data plane".** The bundled-platform space is
  crowded and incumbent-friendly. The center of gravity stays the portable
  contract and its conformance machinery; runtime features are admitted only
  when the eval or a dogfood deployment demands them.

---

## 6. Open questions

1. **Retrieval profile v1 cut.** Is semantic top-k + filters + hybrid
   rank-fusion the right first slice, with recommendation/discovery-style
   operators deferred? What are the named quality profiles, exactly?
2. **Quality-profile governance.** Who defines recall floors and reference
   corpora — the spec, the deployment, or the catalog — and how are they
   re-measured as data drifts?
3. **Semantic-model import.** Which interchange formats does the catalog
   import in v1, and where is the line between imported semantics and
   AgQL-owned execution metadata (policies, scopes, embedding specs,
   bindings)?
4. **Attenuation format.** Adopt an existing attenuable-token design
   wholesale, or profile one (which?) — and how do scope tokens interact with
   the host's OAuth story?
5. **Embedding migration UX.** Dual-write + background re-embed + switch is
   the mechanism; what is the operator-facing workflow, and does v1 support
   two live EmbeddingSpecs per field?
6. **`merge` semantics.** How narrow can Storage API `merge` be and still be
   useful — field-set replacement only? Is it in v1 at all?
7. **Watermark scope.** Is `afterWrite` per-record, per-dataset, or
   per-source — and what does it promise on backends with no native
   watermark primitive?
8. **Result-handle store.** Does the principal channel require the runtime to
   persist results (a new stateful component), or can handles proxy to
   re-execution with snapshot pinning where available?
9. **Composition vs first-class comparison.** Does period-over-period earn a
   dedicated construct in v1, or is depth-2 nesting + `derive` enough?
10. **Cost units across paradigms.** Can one budget vocabulary meaningfully
    cover a warehouse scan and an ANN probe, or do budgets stay
    per-adapter-family in v1?
11. **First deployment — decided: Remember Ninja first, distributed
    through deep.agent.** The rollout is a hub-and-spoke, not per-product
    adoption. **Phase 0**: AgQL becomes Remember Ninja's engine — it
    already demands both modes (keypath `records` lookups + hybrid
    `retrieve`), the Storage API, watermarks, EmbeddingSpecs,
    subject-scoped privacy, and two backends with two architectures (cloud
    Postgres+pgvector integrated; local SQLite CLI split-store) that today
    implement the same concepts twice by hand. Its editorial verbs
    (`remember`/`why`/`forget`, cards, ingestion) stay the thin domain
    layer above. **Phase 1**: wire deep.agent's `@deep/memory`
    `RememberNinjaStore` — the adapter already exists as a feature-flagged
    stub whose contract (classification, provenance, taint-with-safe-
    default, `{org, team, user}` principal, freshness) is already an AgQL
    model-channel client in miniature — and extend that contract with
    write receipts and `afterWrite` watermarks so consumers get
    read-your-writes rather than inheriting fire-and-forget memory.
    **Phase 2**: every deep.agent consumer gets governed memory by
    upgrading a dependency — DeepSignal (filesystem link), DeepTest
    (re-vendor), the monorepo's aiStats agent (swap its process-lifetime
    `InMemoryStore`); DeepWater adopts deep.agent as intended. **Phase 3**:
    the two big parallel stacks migrate — nessie's Thoughts subsystem (the
    ancestor deep.agent was extracted from, still running its own ~8.5k-LOC
    memory stack with no agent-facing API) and the monorepo's structured-
    analytics side (classic widgets onto the catalog). Full AgQL surfaces
    (structured queries, datasets, artifacts) then expose product-by-
    product on the runtime the memory path already proved. Remaining
    question: per-product namespacing — one hosted multi-catalog AgQL
    behind the ninja API, or one catalog with a product partition
    dimension?
12. **Derived-data mechanics.** Where do materialized rows live — the
    source backend, a runtime-owned store, or the deployment's choice — and
    who pays for them? How rich is the artifact presentation vocabulary in
    v1 (a handful of chart types with validated mappings, or a bounded
    grammar), and is scheduled re-materialization ("refresh nightly") a v1
    feature or an application concern above the contract?
13. **The name.** "AgQL" now covers more than queries; is the name still
    right when the contract includes storage, retrieval, and derived
    datasets — and does the query language keep the name while the whole is
    something like an "agent data contract"?
