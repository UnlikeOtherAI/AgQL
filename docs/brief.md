# AgQL — Agents Query Language

**A query language designed for AI agents the way SQL was designed for humans.**

SQL is fifty years old and it shows: it was built for a person at a terminal,
then bent to serve applications through string concatenation and ORMs. Now we
hand it to LLM agents, and every one of its human-era design decisions becomes a
liability. AgQL starts over from the question: *if the author of every query is
a language model and the operator of every database is a guarded runtime, what
should the language between them look like?*

The whole idea in one line:

> **One deterministic, MCP-native query language → pluggable adapters → any
> database becomes agent-accessible.**

Three properties are the spine of the design, and everything else in this brief
hangs off them:

1. **Deterministic.** The same AgQL query always validates the same way,
   compiles the same way, and means exactly one thing. Validity is a pure,
   statically-checkable function of (query, catalog, scope) — no ambiguity, no
   dialect-dependent interpretation, no model-dependent reading. Determinism is
   a first-class design goal with its own section (§3.4), not a nice-to-have.
2. **Fully MCP-enabled.** MCP is *the* access path. Agents reach databases
   entirely through the AgQL MCP surface — tools for the query loop, resources
   for the catalog — and that surface is core language design (§3.8), not an
   integration bolted on later.
3. **Database-agnostic.** AgQL is defined against a **logical data model**, not
   against SQL. A per-backend **adapter** compiles AgQL to the native query of
   whatever sits underneath — Postgres, MySQL, SQLite, a document store, a
   graph database, a columnar warehouse, even a key-value store — with
   identical semantics everywhere, enforced by a cross-backend conformance
   suite (§3.7). SQL is the first compile target, not the definition.

AgQL is not a wrapper around SQL. It targets native query languages the way
TypeScript targets JavaScript: the target inherits none of the source's
guarantees, and that is fine, because nothing reaches the target except through
the compiler.

---

## 1. Why

### 1.1 What is wrong with giving agents raw database access

**Injection is the language, not a bug in it.** SQL has no boundary between code
and data — a value is spliced into the same string as the operators around it.
Parameterized queries fix this for applications because the application author
writes the code part once. An agent writes the code part *every time*, so every
query is a fresh chance to interpolate hostile data. Worse, the agent itself is
injectable: a prompt injection hidden in retrieved data becomes a query the
agent "chose" to write. With raw SQL, the blast radius of one bad token sequence
is `DROP TABLE`, a filesystem-reading admin function, or a cross-tenant
`SELECT`. This is no longer hypothetical: production databases have been wiped
by coding agents that had been told, in prose, not to touch them; database
tools exposed to agents have leaked whole tables through nothing more than
instructions planted in a support ticket the agent later read. The pattern is
always the same — private data, untrusted content, and a channel out, glued
together by a language with no guardrails of its own. Prose instructions do not
enforce anything; only the execution path can. And the problem is not
SQL-specific: structured query formats with open operator sets and embedded
evaluation (a value position that also accepts operators, a query stage that
runs JavaScript) reproduce every one of these failures in JSON.

**Guarding a native query language means re-implementing it.** To check an
incoming SQL string you must parse it (which dialect?), resolve identifiers
(against what search path?), prove it is read-only (through views? functions?
CTEs with `DELETE … RETURNING`? statement batching that escapes a read-only
transaction wrapper?), and bound its cost (roughly the halting problem). Every
allowlist-by-regex or "read-only role plus hope" setup is an admission that the
language cannot be validated, only sandboxed after the fact — and read-only
wrappers around free-text SQL have been publicly bypassed with a trailing
`COMMIT; DROP TABLE …`. The same holds for a Mongo shell string or a Cypher
string. A language an agent should speak must be **deterministically
validatable**: a finite check, not a parser arms race per backend.

**Unbounded by default.** The native languages default to "everything": no
limit, no timeout, no cap on joins or traversal depth, `SELECT *`, cartesian
products from one forgotten join condition, unbounded graph path expansion.
Humans learn the footguns; a model re-rolls them stochastically. A missing
filter is not a syntax error — it is a full scan that costs real money and can
take down a replica.

**Dialect noise wastes the model — and multiplies per backend.** `LIMIT` vs
`TOP` vs `FETCH FIRST`; quoting rules; date functions that differ on every
engine; grouping-alias resolution that differs *within* one engine depending on
whether a name collides with a physical column. Now add a second storage
paradigm: the same organization's data lives partly in Postgres, partly in a
document store, partly in a warehouse, and the agent is expected to speak
three unrelated native languages with three unrelated failure modes. The model
spends its accuracy budget on trivia that has nothing to do with the question
being asked. The benchmark record agrees: models that look solved on toy
text-to-SQL suites collapse to single-digit-to-teens success rates the moment
the target is a real enterprise warehouse with thousands of columns and live
dialect differences — and the dominant error is not syntax but *schema
linking*: picking the wrong table or column out of an enormous, undocumented
namespace.

**No capability model.** Native permission stories are roles and grants on
physical objects, configured out-of-band, differently per backend — and some
backends have almost none. There is no way to hand an agent a query language
*and* a scope — "these datasets, these rows, these partitions, this tenant" —
as one object, such that a query outside the scope fails to even compile.
Row-level security gets partway there but is invisible: the query "succeeds"
and silently returns fewer rows, which for an analytical agent is a wrong
answer, not a security win. And RLS is only as good as the connection's role —
the published exfiltration incidents all involved an agent connected as a role
that bypassed it.

**Errors are written for DBAs.** `ERROR: column "revanue" does not exist` with
a position offset into a string is a poor repair signal. The information the
model needs — *what columns do exist here?* — is exactly what the error
withholds. This matters measurably: the self-repair literature consistently
shows models fix a large share of their own query errors when the executor's
feedback is informative, and barely improve when it is a bare failure.

**Nondeterminism is a correctness bug for agents.** Unordered results that come
back in a different order per run; `now()` evaluated at some unlogged instant;
collation- and null-ordering differences between engines; a "same" query
meaning different things on different backends. A human analyst shrugs these
off; an agent pipeline built on them produces answers that cannot be
reproduced, compared, cached, or audited — and an agent's own account of what
it ran has already been shown, in the incident record, to be confabulated. If
the query and its meaning are not deterministic, nothing downstream of them is
trustworthy.

### 1.2 What an agent-native query language optimizes for

1. **Deterministic.** One query, one meaning, one validation outcome, one
   result given one data snapshot — on every backend (§3.4).
2. **Model-emittable.** The representation must be one the model can produce
   with near-certain syntactic validity — which today means structured output
   against a schema, not a novel grammar.
3. **Deterministically validatable.** Given a query and a catalog, validity is
   a pure function: total, fast, no database needed.
4. **Safe by construction.** There is no syntax for the dangerous thing. No
   string ever travels from the model into a compiled native query as code;
   model strings are either matched against a closed vocabulary or bound as
   parameters. Read-only is not a role setting; the language has no writes.
5. **Bounded by construction.** Caps on joins, conditions, output columns,
   rows, expression depth, and wall-clock are part of the language, not of one
   deployment's configuration.
6. **Capability-scoped.** Every compilation takes a scope — what this caller
   may read, down to datasets, fields, and row partitions — and the scope
   shapes both what compiles and what the model is even told exists.
7. **Backend-independent.** The query expresses intent against the logical
   model; where the data physically lives is the adapter's business. An agent
   that learned AgQL once can query every store the catalog covers.
8. **Composable.** Queries are values: nameable, nestable (boundedly),
   reusable, diffable, storable, and re-executable later under a *different*
   caller's scope.
9. **Self-repairable.** Rejections are part of the language spec: every error
   names the offending part and enumerates the legal alternatives, so one
   round-trip fixes one mistake.
10. **Auditable and replayable.** A query is data, so the log of what an agent
    asked is exact, hashable, and re-runnable.
11. **Teachable from the source of truth.** The documentation the model reads
    is generated from the same catalog the compiler enforces, so the model is
    never taught a construct the compiler refuses or denied one it accepts.

---

## 2. Prior art

### 2.1 The in-house precedent: the aiStats querySpec

The closest working precedent is in-house: the Kilomayo monorepo's AI stats
assistant (`organization/backend/lib/aiStats/`) ships a complete, production
instance of the guarded-structured-query pattern for the relational case, and
AgQL should be read as its generalization. The shape:

- A **JSON query spec** validated by a Zod schema: root `dataset`, `joins`
  (named edges, not free join conditions), `select` (columns,
  `dateTrunc`/`extract` time buckets, aggregates with per-aggregate `filter`,
  and a `ratio` of two aggregates), AND-combined `where` with a closed operator
  set including relative-time operators (`inLast`, `inCurrent`, `inPrevious`),
  `groupBy`/`orderBy` by output alias, `limit`.
- A **catalog allowlist** as the single source of truth: datasets, fields (with
  kinds and descriptions), join edges, default filters, and per-dataset
  row-scoping strategy. The model never sees a physical table; the compiler
  resolves every identifier through the catalog or rejects. Model strings are
  only ever *matched against catalog keys or bound as SQL parameters* — never
  interpolated.
- **Hard limits as constants** — max select entries, joins, conditions,
  in-list values, rows — plus a per-statement timeout inside a read-only
  transaction, each limit documented with *why that number*.
- **Scope compiled in, mandatorily.** Every compilation takes capabilities
  (which data domains) and allowed venues (row partition), with no default — a
  new call site cannot forget them. The gate applies to join *targets* too,
  because every restricted dataset is reachable by joining toward it. An empty
  venue list means "nothing", never "everything".
- **Errors written for the model.** Rejections name the offending part and list
  what *is* available ("Unknown join X. Available joins from this query: …") —
  while deliberately not naming datasets the caller's capabilities hide. Tools
  return failures as `"Rejected: …"` text, and the prompt says: fix it from the
  message and retry.
- **Progressive disclosure.** The prompt carries only a dataset *index*
  narrowed to the caller's capabilities; a tool loads one domain's full
  field/join vocabulary on demand — and the tool's own domain enum is built
  from the caller's capabilities, so an off-limits domain is not even nameable.
- **Verify-then-persist.** Queries must run successfully before being saved as
  dashboard widgets, and saved widgets re-execute later under the *then-current
  caller's* scope — persistence is not privilege escalation.
- **Two result channels.** Catalog-flagged sensitive fields render to the
  authorized user but are blanked in what the model sees; rows shown to the
  model are capped regardless of the query's limit.
- **Defense in depth.** Per-tenant databases as the hard boundary, a
  least-privilege database role under the compiler, the read-only transaction —
  a compiler bug degrades to "permission denied".
- **Prompt-contract tests.** Unit tests assert the hand-written prompt agrees
  with the schema — every operator the schema accepts is taught, every
  construct taught exists — catching silent drift between what the model is
  told and what the compiler does. Strict schemas make unknown keys an error
  rather than silently stripping them.
- **Deliberate model ergonomics:** grouping compiled by ordinal to dodge the
  engine's alias-vs-column resolution trap; scope predicates on left-joined
  datasets placed into the join's `ON` clause so a filter cannot silently turn
  the join inner; a `__proto__` output-alias ban; timezone and business-day
  offsets handled entirely by the compiler so the model never does calendar
  math.

**Its limits — which are also AgQL's starting backlog:**

- `where` is AND-only; no OR, no NOT beyond operator negations.
- No subqueries, no nesting, no composition: one flat SELECT, ever.
- No window functions; no post-aggregation filtering (HAVING); no UNION; each
  dataset joinable at most once.
- Arithmetic is a single closed operator over one or two fields — deliberately
  not an expression tree, which keeps result kinds derivable, but excludes
  everything past one level.
- **One backend, one paradigm.** It compiles to Postgres, period. The catalog
  is hand-written TypeScript inside one product; the query semantics lean on
  Postgres behavior rather than being specified independently; nothing is
  reusable as a standalone system, and nothing addresses a second storage
  engine, let alone a non-relational one.
- Cost control is limits-plus-timeout only; "too expensive" surfaces as a
  timeout, which is a poor repair signal.
- The tool surface is bespoke in-process tooling, not a protocol another agent
  could connect to.

The design lesson is not that these gaps are mistakes — each was a scoping
decision that kept a product feature shippable — but that they mark exactly
where a *language* has to be more than a *feature*: composition, bounded
richer expressions, OR, specified backend-independent semantics, a pluggable
adapter layer, and a standard protocol surface are what separate AgQL from
querySpec. The three pillars map directly: querySpec is deterministic only by
accident of Postgres, MCP-shaped but not MCP, and single-backend by design.

### 2.2 Query language design lineage

**GraphQL** proved the core move: the client speaks a schema-typed language
with no access to physical storage, arbitrary joins do not exist (you traverse
declared edges), and the server owns resolution — and it proved it *per
backend-agnostic resolver*, which is a primitive form of the adapter idea. It
separated query shape from values structurally (variables travel apart from the
document), which kills injection at the root. It also proved the failure mode:
without depth and complexity limits, nested traversal is a denial-of-service
vector — hence static query-cost analysis (cost the query *before* running it,
charge a budget, refund the difference) and persisted queries, where only
pre-registered documents may run: the logical endgame of "queries are data".
Its gap: it is a fetch language — aggregation was never native.

**PRQL** and **KQL** show the syntactic lesson, independently: a query as a
*linear pipeline* of transforms is radically easier to write, read, and
validate than SQL's inside-out `SELECT`. Each stage has a known input and
output shape, so checking is local, prefixes of a query are themselves valid
queries, and appending a guard-stage (a row cap, a tenant filter) is a
trivial, semantics-preserving operation. The pipeline shape keeps reappearing —
MongoDB's aggregation framework, graph languages' chained clauses, academic
SQL-replacement proposals, pipe syntax retrofitted into SQL itself by its
biggest vendors. When every independent attempt converges on one shape, that is
the shape — and, decisively for AgQL, a pipeline over a logical model is
*paradigm-neutral*: it compiles as naturally to a document store's aggregation
stages or a graph traversal as to SQL.

**Malloy** contributes the semantic-model half: dimensions and *measures*
declared once on a source, invoked by name in queries; queries that nest; and —
critically — join semantics that understand cardinality, so aggregating across
a one-to-many join cannot silently double-count. Its lesson: the model's
vocabulary should be curated names with meanings, not raw columns, and
join-aware aggregation belongs in the language.

**EdgeQL** is the sharpest articulated critique of SQL as a language: not
composable, not orthogonal, null semantics as a landmine. Its fix — every
expression uniformly operates over sets, so any subexpression can be factored
out without restructuring — is the cleanest statement of what composability
requires.

**MongoDB's aggregation pipeline** matters twice. As a warning: **JSON
structure is not safety** — operator injection through a value position that
also accepts operator objects, an embedded-JavaScript escape hatch, and
attacker-supplied regex reproduce SQL's problems in JSON; safety comes from a
*closed* operator vocabulary, disjoint syntactic positions for operators and
data, and no evaluation constructs. And as a target: it is proof that a
capable, pipeline-shaped execution engine exists on the document side for an
AgQL adapter to compile to.

**Cypher and the new ISO graph query standard** show both that pattern-based
traversal over *declared* relationship types is a bounded, checkable vocabulary
— and that unbounded path expansion is the graph world's own cost footgun,
needing exactly the kind of mandatory bounds AgQL imposes everywhere. A graph
store is a natural AgQL adapter target: catalog edges *are* relationships.

**SOQL** is the longest-running "deliberately restricted query language exposed
to untrusted authors" precedent: select-only, no arbitrary joins (only declared
relationship traversal), governor limits on rows and time, inside a massive
multi-tenant platform, for two decades. Restriction is not a toy property; it
is what made that exposure survivable.

**Datalog** is the theoretical anchor: a query language that is not
Turing-complete by design, where termination and complexity are analyzable
properties. AgQL keeps its discipline — expressiveness is added only when its
cost remains statically boundable. The same restricted Datalog turns up inside
modern **attenuable authorization tokens** — bearer tokens that carry their own
machine-checkable restrictions and that any holder can narrow offline but never
widen — the right primitive for handing query rights down a tree of sub-agents.

**Semantic layers** (metrics-layer products and the warehouse vendors' governed
metric views) converge on the same architecture from the BI direction:
entities, dimensions, measures, and join topology defined once in a governed
model; the query interface collapses to "metrics + dimensions + filters + time
grain + limit". Notably, when the warehouse vendors added AI analytics, they
did not make SQL safer — they *shrank the vocabulary*. Strong convergent
evidence. But semantic layers stop at metrics retrieval, mostly assume a SQL
warehouse underneath, and never specified the agent-facing contract — errors,
disclosure, repair, scope.

**The agent-tooling reality** supplies the final facts. Structured output
changed the calculus: with JSON-Schema-constrained decoding, a model can be
*guaranteed* to emit schema-valid JSON — no such guarantee exists for a novel
textual syntax on mainstream hosted APIs. MCP standardized how agents reach
tools and data — and its database ecosystem today is largely a raw-native-query
string in a tool call, with an incident record (read-only wrappers bypassed,
tokens that override row security, prompt-injected exfiltration) that
demonstrates the guardrails must be a language, not a per-server pile of
flags. The mitigations the better MCP servers are converging on — database-role
read-only, scoped access tiers, parameterized pre-defined templates,
execution-time limits, semantic-layer indirection — are each a fragment of
AgQL. AgQL is the thesis that these fragments are one coherent, specifiable,
MCP-native language.

---

## 3. Design proposal

### 3.1 Representation: structured JSON core, textual projection later

**AgQL's canonical form is a JSON document validated by a published JSON
Schema.** Not a textual DSL. Reasoning:

- **Emission reliability.** JSON-under-schema gets constrained decoding and
  tool-call guarantees from every major provider today — and over MCP, the tool
  input schema *is* the language schema, so every conforming client constrains
  the model to the language for free. A new textual grammar gets none of that.
- **Validation is the language.** A JSON Schema plus a catalog-resolution pass
  is the whole front half of the compiler, portable to any host language,
  usable client-side, server-side, and in CI over stored queries.
- **Queries are data.** Hashing, diffing, storing, transforming, and
  programmatically generating queries fall out for free — and determinism
  (§3.4) requires a canonical byte form, which a structured document gives
  cheaply and a free-text syntax fights.
- **The verbosity objection is real but cheap.** JSON costs tokens and human
  readability. Mitigations: a terse vocabulary (§3.3), and a **canonical
  textual projection** — a pipeline-style pretty-printed rendering, bijective
  with the JSON — used in logs, docs, diffs, and UIs. Humans read the
  projection; models and machines exchange the JSON. If future models prove
  reliably grammar-fluent, the projection can be promoted to an accepted input
  format without changing the language, because the language *is* the
  validated structure, not the surface syntax.

One consequence of the format-constraint research is baked into the surface
convention: the agent reasons freely in prose, then emits the query as a tool
call — never forced to open with the constrained block.

### 3.2 The logical data model: the catalog is half the language

AgQL queries are written against a **logical data model**, never against
storage. The catalog defines that model, and it is deliberately
paradigm-neutral — nothing in it names tables, collections, node labels, or
key prefixes; those live in per-backend **bindings** (§3.7):

- **Datasets** — named, described logical relations. A dataset may be backed by
  a table, a collection, a node label, a key range, a view, or a named AgQL
  query (§3.6) — the query cannot tell and must not care.
- **Fields** — name, kind from a closed kind system (`id`, `text`, `integer`,
  `number`, `money`, `boolean`, `timestamp`, `enum`), description, flags
  (`sensitive`, `filterOnly`). The kind system is the language's, with
  specified semantics (§3.4); adapters map native types into it, never the
  reverse.
- **Edges** — named relationships with declared direction, join type, and
  **cardinality** (`one` | `many`). Cardinality lets the compiler *reject or
  auto-correct fan-out double-counting* (aggregating a one-side measure across
  a many-edge) instead of silently returning wrong numbers — the worst failure
  class for an analytics agent, because it looks like success. On a relational
  backend an edge compiles to a join; on a document backend to a lookup stage
  or an embedded path; on a graph backend it *is* a relationship. The query
  spells all three identically.
- **Measures** — named, described aggregations declared on a dataset
  ("revenue = sum of net line totals, excluding canceled orders"), so common
  questions are askable by *name* and the definition of "revenue" is governed,
  not re-improvised per query. Raw aggregates over fields remain available;
  measures are the paved road — and the direct answer to schema linking being
  the dominant model failure: shrink the namespace to curated names.
- **Default filters** — with descriptions and an explicit opt-out (a query that
  filters the same field, or names it in `withoutDefaults`, drops the default),
  because "excluding canceled/archived/test rows" is the right default for
  ninety percent of questions and actively wrong for the rest, and both cases
  must be expressible *and visible*.
- **Row scopes** — how each dataset narrows to a caller's partitions (direct
  field, one-hop lookup, via a peer dataset, or none-with-reason), declared
  *per dataset and required*, so forgetting is a compile error of the catalog,
  not a silent hole in production.
- **Capability tags** — which grant unlocks each dataset (and every edge into
  it).
- **Statistics hints** — expected magnitude per dataset, feeding pre-flight
  cost checks (§3.5).

Everything the model is taught is **generated from the catalog**: the index,
the per-domain docs, the operator reference — served as MCP resources (§3.8).
One source of truth, enforced by contract tests (§4.1), so prompt, protocol,
and compiler can never drift apart.

### 3.3 Core operations: a bounded pipeline

Semantically, an AgQL query is a short pipeline over the logical model; the
JSON is a direct encoding of it. Stages, in fixed order (each optional except
`from`):

```
from → join* → where → select(+group) → having → order → take
```

A representative query — "daily revenue and cancel rate over the last 30 days,
web and in-store only":

```json
{
  "from": "orders",
  "where": { "all": [
    { "field": "orders.createdAt", "op": "inLast", "amount": 30, "unit": "day" },
    { "field": "orders.channel", "op": "in", "values": ["web", "store"] }
  ]},
  "select": [
    { "bucket": "day", "of": "orders.createdAt", "as": "day" },
    { "measure": "orders.revenue", "as": "revenue" },
    { "ratio": { "num": { "agg": "count", "filter": [{ "field": "orders.canceledAt", "op": "isNotNull" }] },
                 "den": { "agg": "count" } }, "as": "cancelRate" }
  ],
  "group": ["day"],
  "order": [{ "by": "day", "dir": "asc" }],
  "take": 100
}
```

Nothing in it says Postgres. The same document compiles to a SQL `SELECT`, a
document-store aggregation pipeline, or a graph query — whichever adapter backs
`orders` — with the identical result contract.

The vocabulary, deliberately closed:

- **Predicates**: comparison ops, `in`/`notIn`, null checks, bounded text ops
  (`contains`/`startsWith`, compiled to escaped pattern matching — never
  regex), and a relative-time family (`inLast`, `inCurrent`, `inPrevious`),
  because "this month", "the last 30 days", and "the previous quarter" are the
  overwhelmingly dominant analytical filters and calendar math belongs to the
  compiler — timezone- and fiscal-day-aware — not to the model.
- **Boolean structure**: `all` / `any` / `not` trees with a **hard depth cap
  (2)** and a node cap. OR exists; unbounded boolean algebra does not.
- **Buckets**: timeline buckets (truncate a timestamp to hour/day/week/month/
  year — keeps the timeline) and profile folds (extract hour-of-day,
  day-of-week, etc. — folds all occurrences together). Distinct question
  shapes, named separately so the model picks deliberately.
- **Aggregates**: count, countDistinct, sum, avg, min, max, percentile (bounded
  to declared quantiles), each with an optional per-aggregate `filter`
  (narrowing that aggregate alone — what puts "issued next to returned" in one
  row of one query), plus the `ratio` composite (shares, rates, occupancy —
  divide-by-zero defined as null, never an error).
- **Aggregate expressions**: a **single-level** arithmetic form — one operator
  (`add`, `subtract`, `multiply`, `negate`, `coalesce`, `minutesBetween`) over
  field references. Deliberately not an expression tree: nothing nests,
  precedence cannot be gotten wrong, and the result's kind (money stays money,
  minutes are a number) is derivable at compile time. A need that outgrows one
  level is a `derive` in a composed query (§3.6) or a catalog measure.
- **`having`**: the same predicate forms applied to aggregate select aliases.
  Reuses the predicate language verbatim; costs the model nothing new.
- **`take`**: mandatory-with-default, capped.

**Not in the vocabulary** (see §4.2): raw expressions as strings, user-defined
functions, regex, recursion, correlated subqueries, and any form of write.

### 3.4 Determinism as a specified guarantee

Determinism is a pillar, so it is a contract with named parts, not an emergent
property:

- **One meaning.** The spec defines a single semantics for every construct —
  null handling and null ordering, money as fixed-point decimal (never floats),
  integer vs decimal division, comparison and ordering **collation** (a
  specified Unicode collation, not the backend's locale), case sensitivity,
  week start (Monday), timezone bucketing, fiscal-day offsets, divide-by-zero
  (null). Adapters implement *AgQL's* semantics on their backend — natively
  where the backend agrees, by explicit compensation where it does not — and
  the cross-backend conformance suite (§4.1) holds golden results that every
  adapter must reproduce byte-for-byte. A backend that cannot be made to agree
  on some construct does not get a lenient variant; its adapter simply does not
  ship until it can (or evaluates that construct engine-side, §3.7).
- **Canonical form.** Every query has a canonical serialization — defined key
  order, defaults materialized, no duplicate keys — and therefore a canonical
  hash. Two queries mean the same thing iff their canonical forms are equal.
  Caching, deduplication, persisted-query allowlists, and audit all key off
  this hash.
- **Deterministic validation.** Validation order is specified (all structural
  errors, then semantic resolution in document order, stopping at the first
  failure), so the same invalid query produces the same error with the same
  code on every engine, every time. Error output is part of conformance.
- **Deterministic compilation.** Given (query, catalog version, scope, adapter
  version), the compiled native query is byte-identical. No randomness, no
  environment-dependent output, no wall clock read at compile time.
- **Anchored time.** Relative-time operators never read the clock implicitly.
  Every execution carries an explicit **anchor timestamp** — stamped by the
  engine at request time, recorded in the audit log, overridable by the caller
  for replay — and `inLast`/`inCurrent`/`inPrevious` are pure functions of the
  anchor, the timezone, and the fiscal-day offset. Replaying a query with its
  logged anchor reproduces the exact predicate.
- **Total ordering.** An unordered result is nondeterministic, and `take` over
  a partial order is a lottery. The spec requires the engine to extend any
  user-supplied `order` to a total order with defined tie-breakers (remaining
  group keys, then a stable dataset key), so pagination and `take` are
  reproducible. The extension is deterministic and visible in `explain`.
- **Snapshot honesty.** Result determinism is defined *given a data snapshot*.
  Where the backend offers snapshot or point-in-time reads, the adapter uses
  them and the engine logs the snapshot identity; where it does not, the engine
  says so in the result metadata rather than pretending. Determinism claims are
  never silently weakened.
- **No model-dependent interpretation.** There are no fuzzy constructs — no
  "smart" date parsing, no approximate matching, no relevance-ranked anything
  in the core language. Anything heuristic lives outside AgQL, in the agent.

### 3.5 Bounded and safe by construction

- **The closed-vocabulary invariant** — the load-bearing rule of the entire
  language: every string the model produces is either matched against a
  catalog/enum key or bound as a parameter in the native query. There is no
  third path, on any backend. An adapter that cannot uphold this for a
  construct must not implement the construct.
- **Structural limits in the spec**, not per deployment (deployments may
  lower, never raise): max edges traversed, max predicate nodes and depth, max
  select entries, max in-list size, max rows, max composition depth (§3.6).
  Every limit ships with its rationale; every violation is an enumerable,
  repairable error — never a silent truncation.
- **Pre-flight cost gate.** `explain` (§3.8) runs before `run`: the engine
  combines catalog magnitude hints with whatever the backend offers (a SQL
  planner estimate, a document-store explain, nothing at all for a bare KV
  store — in which case the catalog hints carry the load) and rejects
  over-budget queries with a *repairable* message ("this scans roughly ten
  million rows; narrow the time window or filter on X") instead of letting them
  die as timeouts. Estimates are unreliable at the margin, so the gate admits
  generously and runtime backstops remain authoritative. The proven budget
  shape: price the query statically, charge a leaky-bucket budget, true up
  after execution.
- **Execution guarantees**: read-only access at the backend's own privilege
  layer wherever one exists (a read-only role, not a wrapper — so even a
  compiler bug degrades to "permission denied"), per-statement timeout, row cap
  applied by the engine (never trusted from the query document), session
  timezone and fiscal-day set by the engine.
- **Two result channels** as a spec-level concept: the *principal channel*
  (full rows, to the authorized human surface) and the *model channel*
  (catalog-flagged sensitive fields redacted, rows truncated to a small window
  with an explicit truncation note) — because model-channel results are
  serialized into a conversation that typically travels to a third-party
  inference provider. Engines must implement both; conflating them is
  non-conformant.

### 3.6 Capability and permission scoping

A query never compiles alone; it compiles against a **scope**:

```
scope = { capabilities: set<grant>, partitions: {dimension → allowed values | all}, principal }
```

- Capabilities gate datasets *and every edge into them* — reachability equals
  readability, because every restricted dataset is otherwise reachable by
  joining toward it. There is no long way around, on any backend.
- Partition scoping (tenant, region, branch, team — named dimensions declared
  in the catalog) is **mandatory at the type level**: an engine API where
  scope is optional is non-conformant. An empty partition list means *nothing
  is visible*, never "no restriction".
- Scope shapes *disclosure* too: catalog resources, tool enums, and error
  alternatives are all narrowed to the caller's scope, so what the model can
  name and what it may query are the same set — and errors never enumerate
  hidden data.
- **Stored queries re-compile under the reader's scope, always.** Persistence
  is not privilege escalation.
- Scopes should be **attenuable**: a holder can derive a strictly narrower
  scope (fewer datasets, fewer partitions, lower limits, shorter expiry) to
  hand a sub-agent, offline, and never a wider one. This is the natural unit
  for multi-agent systems: the orchestrator holds the tenant scope; the
  sub-agent researching one region gets that region, a row budget, an expiry.
- Because scope enforcement lives in the AgQL engine, it is **uniform across
  backends** — including backends that have no row-security story of their own.
  For a document or KV store, AgQL's scope layer is likely the *only* row-level
  authorization the data has ever had.

### 3.7 The adapter layer: any database under the hood

This is the pillar that turns a guarded query feature into an abstraction
layer. The architecture has three levels:

```
AgQL query  →  engine (validate · scope · plan · limits · budget)
            →  adapter (compile logical plan → native query/queries)
            →  backend (Postgres | MySQL | SQLite | document | graph | columnar | KV | …)
```

**The engine owns meaning; adapters own translation.** Validation, scope,
limits, determinism semantics, error rendering, redaction, and audit all happen
once, in the engine, identically for every backend. The adapter receives a
fully validated, scope-resolved **logical plan** — never the raw query, never
an unresolved identifier — and returns native queries plus a description of
whatever it could not push down.

**The adapter contract:**

- A **binding** maps each catalog dataset/field/edge to physical storage
  (table+column, collection+path, label+property, key schema). Bindings are
  per-adapter deployment config; the logical catalog never changes when data
  moves between backends — which is precisely the point: migrating a dataset
  from Postgres to a document store is invisible to every agent and every
  stored query.
- Adapters declare a **capability profile**: which plan nodes they compile
  natively (joins? group-aggregate? having? text ops?). The **core profile** —
  everything in §3.3 — must be *honored* by every shipped adapter, but not
  necessarily *pushed down*: where the backend lacks a construct, the adapter
  pushes down what it can (at minimum: scope filters, predicate pushdown where
  possible, and row bounds) and the engine's **compensating executor**
  finishes the plan — joining, grouping, aggregating — over the bounded
  intermediate rows, using the spec's own semantics. Compensation is bounded
  by the same budgets as everything else (intermediate row caps are part of
  the cost gate), deterministic by construction (it *is* the reference
  semantics), and visible in `explain` ("edge `customer` evaluated
  engine-side; ~2k intermediate rows"), so cost surprises are disclosed, not
  discovered.
- **First-class adapter families**, in order:
  1. **Relational SQL** — Postgres first, then SQLite and MySQL. Near-total
     pushdown; the compensating executor is idle.
  2. **Embedded analytical / columnar** — DuckDB early (it makes the
     conformance suite and eval harness dependency-free), then
     warehouse-style backends. Same plan shape, different cost model.
  3. **Document** — datasets as collections, edges as lookup stages or
     embedded paths (an embedded array is just a `many`-edge whose binding
     says "same document"), pipelines compile to aggregation stages.
  4. **Graph** — datasets as labels, edges as relationships; the traversal
     vocabulary AgQL already has (named edges, bounded hops) is the safe
     subset of a graph query language.
  5. **Key-value / wide-column** — honest minimalism: the binding declares the
     access paths that exist (get by key, scan by prefix/range); datasets
     without a usable access path for a given predicate are rejected at
     `explain` with that exact message; everything above the scan is
     compensating execution within budget.
- **Adapter conformance** is the determinism pillar made enforceable: every
  adapter runs the same golden-query suite against seeded data and must
  produce byte-identical canonical results (§3.4). An adapter is not "mostly
  compatible"; it either reproduces the reference semantics or it does not
  ship.

**Explicitly deferred:** cross-backend federation — one query joining datasets
that live on *different* adapters. The compensating executor makes it
technically reachable, but v1 scopes a query to one adapter and keeps
federation an open question (§5), because its cost model and failure modes
deserve their own design pass, not a footnote.

### 3.8 The MCP surface: the access path, not an integration

MCP is how agents reach AgQL — not one binding among many, but the designed
front door. The reference implementation *is* an MCP server; embedding the
engine as a library is possible (that is what the conformance suite tests),
but the protocol surface is normative: its tool names, schemas, resource
shapes, and error payloads are defined in the spec, so any AgQL server looks
identical to any MCP client.

**Tools** (the verbs of the query loop):

- `catalog(domain?)` — progressive disclosure: a compact index narrowed to the
  caller's scope, or one domain's full field/edge/measure vocabulary on
  demand. Prompt cost stays flat as the catalog grows, and the tool's domain
  enum is built from the scope, so an off-limits domain is not even nameable.
- `validate(query)` — full compile, no execution: returns the typed
  result-shape contract (column names and kinds — so the agent can plan a
  chart or a table before spending a query) or a rejection.
- `explain(query)` — validate + cost verdict + the deterministic execution
  story: the textual projection, which parts push down to the backend and
  which run engine-side, the ordering extension applied, the anchor semantics
  — and optionally the compiled native query for operators. This is the
  **compile-and-explain loop**; the budget gate lives here.
- `run(query | queries)` — execute under scope; model-channel results: column
  contract, row count, truncation flag, capped rows, anchor timestamp, and
  snapshot identity where available. The multi-query form executes several
  independent queries under one scope and one budget in one round-trip —
  agents constantly want three small numbers at once.
- `save(name, query, description)` — optional stored-query module, with
  verify-before-save enforced server-side: a query that has not been `run` in
  this session cannot be saved.

**Resources** (the nouns): the catalog index, per-domain documentation, the
operator/limit reference, and stored queries are all MCP resources — readable,
subscribable where the client supports it, and always scope-narrowed. The
model-facing documentation is *served by the same process that compiles*, so
docs and compiler cannot drift; the prompt-contract tests run against the
resource output.

**Scope binding**: the MCP session's authentication resolves, server-side, to
the scope (§3.6). The query document carries zero authority; two sessions
sending the identical document get exactly what their respective scopes allow.
Attenuated scopes ride the same mechanism: an orchestrator mints a narrower
credential and hands it to the sub-agent's session.

**Structured emission for free**: because `run`'s input schema is the language
schema, any client that enforces tool-input schemas — which constrained
decoding now makes universal — guarantees syntactically valid AgQL at the
sampling layer. Syntax errors cease to exist as a category; the error budget is
spent entirely on semantics, which is where the repair loop (§3.9) earns its
keep.

One server can host **multiple catalogs over multiple adapters** — the agent
sees a list of sources, each with the same tools and the same language. That
is the pillar restated as product: point the server at Postgres, at a document
store, at SQLite on disk, and the agent's world does not change shape.

### 3.9 Errors as a specified part of the language

No query language has ever specified its error messages as part of the
language contract, and for an agent consumer the error channel *is* the
learning channel. Rules:

1. **Every rejection is addressed to the model**: it names the offending part
   by its path in the query, states the rule, and **enumerates the legal
   alternatives** ("`group` entry `day` must be the alias of a non-aggregated
   select entry. Non-aggregated aliases: `week`, `channel`").
2. **Stable machine code + self-contained human sentence.** Codes make error
   frequencies measurable — *which mistakes models actually make* is the
   empirical feedback loop for evolving the language.
3. **Never enumerate what scope hides.** Alternatives are computed within the
   caller's scope; an unauthorized dataset yields the same "unknown" shape as a
   nonexistent one.
4. **Deterministic error selection** (§3.4): all structural errors at once,
   then the first semantic error in document order — the same invalid query
   yields the same error everywhere.
5. **Cost and capability-profile rejections must include a remedy** (narrow
   this, filter that, this backend needs an access path on X) — "no" without a
   direction is where repair loops die.
6. **Rejections are tool results, not protocol errors.** An error the agent
   loop can read is a turn; an exception is an outage.

### 3.10 Audit and replay

Every `run` logs `(principal, scope, canonical query hash, query, anchor
timestamp, snapshot identity, cost verdict, pushdown/compensation split, row
count, duration)`. That log is exact and replayable — an auditor re-runs
precisely what the agent asked, with the same anchor, under the same or a
different scope, and diffs the answers. The incident record includes an agent
flatly misreporting what it had executed, so the agent's transcript can never
be the audit record; only the engine's can. The catalog is versioned; stored
queries record the catalog version they were written against, so migrations
are detectable instead of silent.

---

## 4. What makes it genuinely good — and where it stops

### 4.1 Not a toy: the substance checklist

A JSON schema around `SELECT` is a weekend project and a toy. AgQL is the
position that the following are the actual product:

- **A written spec** with conformance semantics: the query grammar (as JSON
  Schema), the closed kind system with its cross-backend semantics (§3.4), the
  limit table with rationales, the scope model, the adapter contract and core
  profile, the normative MCP surface, the two-channel result contract, and the
  **error catalog** with codes, required content, and disclosure rules.
- **A conformance suite in two layers.** *Engine conformance*: valid/invalid
  query corpora, deterministic-error checks, scope-leak probes (does any error
  path name hidden data?), fan-out-aggregation traps, limit boundaries,
  redaction, canonical-form/hash stability. *Adapter conformance*: the
  golden-result suite over seeded data that every adapter must reproduce
  byte-identically — the mechanism that makes "database-agnostic" a verified
  claim instead of a slogan — plus the classic engine traps (alias/column
  ambiguity in grouping, scope predicates on left joins silently turning them
  inner, prototype-pollution via output aliases in JavaScript engines).
- **Catalog-derived teaching as a conformance requirement**: the model-facing
  docs are emitted from the catalog through the MCP resources, and a
  **prompt-contract test** pattern is part of the suite — every operator the
  schema accepts is taught, every construct taught exists. A construct the
  model never hears of is one it will never use; a construct still taught
  after a rename ships silent failures.
- **An emission eval harness**: natural-language questions over a reference
  catalog (run on the embedded adapter, so the harness is dependency-free),
  scored on first-emission validity, repair convergence within N turns, and
  semantic correctness. This is how design choices get decided — does `having`
  earn its place? does depth-2 nesting confuse models? — with data instead of
  taste. It is also the pitch made falsifiable: measurably higher agent
  accuracy than raw SQL on the same questions.
- **Cardinality-aware edge semantics** (§3.2): silently-wrong aggregates are
  the difference between a demo and something a finance team can trust.
- **Three adapters at launch, two paradigms** — Postgres, an embedded engine
  (SQLite or DuckDB), and one document store — because two SQL dialects prove
  a dialect layer, while a second paradigm proves the *language*. The pillar
  is only demonstrated when the same golden suite passes on a backend that has
  no SQL in it.
- **A reference implementation** shaped for adoption: a TypeScript library
  with the engine as pure functions, adapters as packages, and the MCP server
  as a thin shell over it.

### 4.2 Deliberate non-goals

- **No writes. Ever. In the language.** No insert/update/delete/DDL analog, on
  any backend. Mutations from agents are a different problem with different
  guardrails (idempotency, confirmation, domain invariants) and belong in
  purpose-built tools with domain semantics ("issue_refund"), not in a general
  data language. Fusing them would poison the core safety claim — *nothing
  that compiles can change anything* — and hand every prompt injection a
  write-back exfiltration channel inside the query language itself.
- **No user-defined functions, no expression strings, no regex, no evaluable
  anything.** Every escape hatch becomes the vector — the deepest lesson of
  structured query languages that shipped one. Pressure for expressiveness
  routes to catalog measures (governed) or composition (bounded), or is
  declined.
- **No native-query passthrough.** No `rawSql`, no `rawPipeline`, no
  "power-user mode" — the single most tempting adapter feature and the one
  that deletes the entire value proposition the day it ships.
- **No full parity with any backend, and no ambition of it.** Window
  functions, recursive traversal, arbitrary self-joins, unions stay out of v1
  — each, in its general form, breaks either "cost is boundable" or "shape is
  derivable". Where real demand emerges, admit the *bounded, named* form of
  the need (a `deltaOverPrevious` select kind; a `rank` with mandatory
  partition and take; a graph `path` with a hard hop cap), never the general
  mechanism. The language grows by named idioms, not by operators that
  recombine.
- **Not an ORM, not an application query layer.** Applications have build
  steps and type systems; native languages and ORMs serve them fine. AgQL is
  only for the case where the query author is a model at runtime.
- **Not a natural-language layer.** AgQL is the *target* the model compiles
  intent into; it does not parse English. Keeping NL out keeps the spec
  decidable — and is what "no model-dependent interpretation" means in
  practice.
- **No client-trusted anything**: scope, limits, redaction, anchors, and caps
  live server-side; the query document carries zero authority.

### 4.3 Composability (kept deliberately small)

Exactly two mechanisms, both bounded:

1. **Named queries (views).** A validated query registered in the catalog
   under a name becomes a dataset like any other — including as a *binding
   target*, so a logical dataset can be backed by a query the same way it can
   be backed by a table. The view compiles under the *reader's* scope at read
   time, so it can never launder privilege. This is how the paved road grows:
   yesterday's clever agent query becomes today's named, reviewed dataset.
2. **One level of inline nesting.** `"from"` may be a full query instead of a
   dataset name — aggregation over aggregation ("average of daily revenue"),
   shares of a total. Composition depth caps at **2** in v1; a bounded
   **`derive`** stage between outer and inner (single-level arithmetic over
   the inner query's aliases) covers period-over-period deltas and normalized
   metrics without opening general expressions.

### 4.4 Honest risks

- **The expressiveness cliff.** Agents will hit the walls (window functions
  first, most likely) and route around AgQL back to native access where it
  exists. Mitigations: the eval harness shows *which* wall matters
  empirically; composition, measures, and named idioms are the pressure
  valves; and sometimes the correct answer is "a human writes a catalog view".
- **The compensating executor is a tarpit if unwatched.** It is what makes
  "any database" true, and it could quietly become a slow, memory-hungry
  in-house query engine. Containment: it only ever runs over budget-bounded
  intermediate sets, `explain` always discloses it, and adapter work should
  always prefer pushdown.
- **Catalog authoring is real work** — the semantic-layer industry's hard
  lesson, doubled by bindings per backend. Mitigations: a catalog-bootstrap
  tool (introspect a schema or a collection sample, draft
  datasets/edges/kinds/descriptions with LLM assistance, human curates), and a
  design that makes a *small* catalog useful on day one.
- **Standard vs product tension.** A spec nobody implements is a PDF; a
  product without a spec is one more internal query DSL. The sequencing bet:
  reference implementation, adapters, and eval harness first; spec extracted
  from what they prove.

---

## 5. Open questions

1. **Adapter capability floors.** Should the spec require a minimum *pushdown*
   set per adapter family (not just honored-via-compensation semantics), so
   `explain` cost stories stay sane — and what is that floor for KV stores?
2. **Federation.** Cross-adapter queries are deferred (§3.7) — is v2
   federation via the compensating executor the plan of record, or should
   cross-source questions stay a multi-query + agent-side-synthesis pattern
   forever?
3. **Scope of v1 composition.** Is depth-2 nesting + named views + `derive`
   the right cut, or does period-over-period comparison — the single most
   common real analytics ask — deserve a dedicated first-class construct?
4. **The textual projection.** Ship in v1 (docs, logs, diffs benefit
   immediately) or defer until the JSON core is stable? Should `explain`
   return the projection, the compiled native query, both, or per-caller
   choice?
5. **Catalog and binding format.** TypeScript-first (typed, composable,
   refactorable) with a JSON export, or declarative YAML/JSON with a TS SDK on
   top? The answer decides who can author catalogs — and whether bindings live
   with the catalog or with the deployment.
6. **Measures vs raw aggregates.** Should raw `sum(field)` require the field
   to be marked aggregatable, making measures the default path rather than the
   optional one?
7. **Attenuable scopes.** V1 as signed scope tokens, or plain server-side
   scope objects first, adding offline attenuation when a multi-agent consumer
   actually exists?
8. **Cost model depth.** Are catalog magnitude hints plus backend estimates
   enough, or does v1 need a real budget unit (scanned-row credits per
   session) so orchestrators can ration sub-agents — and how does that unit
   stay meaningful across paradigms as different as a warehouse and a KV
   scan?
9. **Snapshot semantics as a tier.** Should the spec formalize determinism
   tiers (snapshot-exact / anchor-exact / best-effort) that backends declare,
   so agents can *ask* for the tier a task needs?
10. **Streaming and big results.** The model channel is capped by design, but
    the principal channel (exports, dashboards) wants pagination or streaming
    — in the v1 spec, or an engine concern?
11. **First deployment.** What is the dogfood target — a real product surface
    whose agent queries run on AgQL from day one, ideally spanning two
    backends so the pillar is exercised, not just claimed? The language should
    be extracted from a working deployment, not designed in a vacuum.
12. **The name.** "AgQL" reads as "agriculture QL" to some; worth deciding
    before anything public. (Counterpoint: it is short, and the puns available
    in the alternatives are worse.)
