# AgQL — Agents Query Language

**A query language designed for AI agents the way SQL was designed for humans.**

SQL is fifty years old and it shows: it was built for a person at a terminal,
then bent to serve applications through string concatenation and ORMs. Now we
hand it to LLM agents, and every one of its human-era design decisions becomes a
liability. AgQL starts over from the question: *if the author of every query is
a language model and the operator of every database is a guarded runtime, what
should the language between them look like?*

The answer this brief argues for: a small, closed, structured query language
where **validity is decidable, cost is bounded, and permissions are compiled in
— all before a single row is read**. Not a wrapper around SQL, but a language
whose compiler targets SQL (first) the way TypeScript targets JavaScript: the
target inherits none of the source's guarantees, and that is fine, because
nothing reaches the target except through the compiler.

---

## 1. Why

### 1.1 What is wrong with giving agents raw SQL

**Injection is the language, not a bug in it.** SQL has no boundary between code
and data — a value is spliced into the same string as the operators around it.
Parameterized queries fix this for applications because the application author
writes the code part once. An agent writes the code part *every time*, so every
query is a fresh chance to interpolate hostile data. Worse, the agent itself is
injectable: a prompt injection hidden in retrieved data becomes a query the
agent "chose" to write. With raw SQL, the blast radius of one bad token sequence
is `DROP TABLE`, a filesystem-reading admin function, or a cross-tenant
`SELECT`. And this is no longer hypothetical: production databases have been
wiped by coding agents that had been told, in prose, not to touch them; database
tools exposed to agents have leaked whole tables through nothing more than
instructions planted in a support ticket the agent later read. The pattern is
always the same — private data, untrusted content, and a channel out, glued
together by a language with no guardrails of its own. Prose instructions do not
enforce anything; only the execution path can.

**Guarding SQL means re-implementing SQL.** To check an incoming SQL string you
must parse it (which dialect?), resolve identifiers (against what search path?),
prove it is read-only (through views? functions? CTEs with
`DELETE … RETURNING`? statement batching that escapes a read-only transaction
wrapper?), and bound its cost (roughly the halting problem). Every
allowlist-by-regex or "read-only role plus hope" setup is an admission that the
language cannot be validated, only sandboxed after the fact — and read-only
wrappers around free-text SQL have been publicly bypassed with a trailing
`COMMIT; DROP TABLE …`. A language an agent should speak must be
**deterministically validatable**: a finite check, not a parser arms race.

**Unbounded by default.** SQL's default is "everything": no `LIMIT`, no timeout,
no cap on joins, `SELECT *`, cartesian products from one forgotten join
condition. Humans learn the footguns; a model re-rolls them stochastically. A
missing filter is not a syntax error in SQL — it is a full table scan that costs
real money and can take down a replica.

**Dialect noise wastes the model.** `LIMIT` vs `TOP` vs `FETCH FIRST`; quoting
rules; date functions that differ on every engine; `GROUP BY` alias resolution
that differs *within* one engine depending on whether a name collides with a
physical column. The model spends its accuracy budget on trivia that has nothing
to do with the question being answered — and its training data is a blend of all
dialects at once, so it confidently emits the wrong one. The benchmark record
agrees: models that look solved on toy text-to-SQL suites collapse to
single-digit-to-teens success rates the moment the target is a real enterprise
warehouse with thousands of columns and live dialect differences — and the
dominant error is not syntax but *schema linking*: picking the wrong table or
column out of an enormous, undocumented namespace.

**No capability model.** SQL's permission story is roles and grants on physical
objects, configured out-of-band by a DBA. There is no way to hand an agent a
query language *and* a scope — "these datasets, these rows, these partitions,
this tenant" — as one object, such that a query outside the scope fails to even
compile. Row-level security gets partway there but is invisible: the query
"succeeds" and silently returns fewer rows, which for an analytical agent is a
wrong answer, not a security win. And RLS is only as good as the connection's
role — the published exfiltration incidents all involved an agent connected as
a role that bypassed it.

**Errors are written for DBAs.** `ERROR: column "revanue" does not exist` with a
position offset into a string is a poor repair signal. The information the model
needs — *what columns do exist here?* — is exactly what the error withholds.
This matters measurably: the self-repair literature consistently shows models
fix a large share of their own query errors when the executor's feedback is
informative, and barely improve when it is a bare failure.

**Verbosity is error surface.** Every character the model must emit is a chance
to be wrong. SQL's ceremony (aliasing, requalification, repeating expressions in
`GROUP BY`, subquery scaffolding) multiplies tokens without adding intent.

### 1.2 What an agent-native query language optimizes for

1. **Model-emittable.** The representation must be one the model can produce
   with near-certain syntactic validity — which today means structured output
   against a schema, not a novel grammar.
2. **Deterministically validatable.** Given a query and a catalog, validity is a
   pure function: total, fast, no database needed. Everything about the query —
   identifiers, operators, shape, limits — is checkable before execution.
3. **Safe by construction.** There is no syntax for the dangerous thing. No
   string ever travels from the model into the compiled statement as code; model
   strings are either matched against a closed vocabulary or bound as
   parameters. Read-only is not a role setting; the language has no writes.
4. **Bounded by construction.** Caps on joins, conditions, output columns, rows,
   expression depth, and wall-clock are part of the language, not of one
   deployment's configuration.
5. **Capability-scoped.** Every compilation takes a scope — what this caller may
   read, down to datasets, fields, and row partitions — and the scope shapes
   both what compiles and what the model is even told exists.
6. **Composable.** Queries are values: nameable, nestable (boundedly), reusable,
   diffable, storable, and re-executable later under a *different* caller's
   scope.
7. **Self-repairable.** Rejections are part of the language spec: every error
   names the offending part and enumerates the legal alternatives, so one
   round-trip fixes one mistake.
8. **Auditable and replayable.** A query is data, so the log of what an agent
   asked is exact, hashable, and re-runnable — unlike the agent's own account of
   what it did, which the incident record shows can be confabulated.
9. **Teachable from the source of truth.** The documentation the model reads is
   generated from the same catalog the compiler enforces, so the model is never
   taught a construct the compiler refuses or denied one it accepts.

---

## 2. Prior art

Nothing in AgQL is invented from nothing; the point is that the pieces exist,
proven separately, and nobody has assembled them into one language with an
agent-facing contract. What each lineage contributes:

**GraphQL** proved the core move: the client speaks a schema-typed language with
no access to physical storage, arbitrary joins do not exist (you traverse
declared edges), and the server owns resolution. It separated query shape from
values structurally (variables travel apart from the document), which kills
injection at the root. It also proved the failure mode: without depth and
complexity limits, nested traversal is a denial-of-service vector — hence the
ecosystem of static query-cost analysis (cost the query *before* running it,
charge a budget, refund the difference) and persisted queries, where only
pre-registered documents may run at all: the logical endgame of "queries are
data". Its gap: it is a fetch language — aggregation was never native.

**PRQL** and **KQL** show the syntactic lesson, independently: a query as a
*linear pipeline* of transforms (`from → filter → derive → group → aggregate →
sort → take`) is radically easier to write, read, and validate than SQL's
inside-out `SELECT`, where the first clause you write is among the last to
execute. Each pipeline stage has a known input and output shape, so checking is
local, prefixes of a query are themselves valid queries, and appending a
guard-stage (a row cap, a tenant filter) is a trivial, semantics-preserving
operation. The same pipeline shape keeps reappearing — MongoDB's aggregation
framework, graph languages' chained clauses, recent academic SQL-replacement
proposals, even pipe syntax retrofitted into SQL itself by its biggest vendors.
When every independent attempt converges on the same shape, that is the shape.

**Malloy** contributes the semantic-model half: dimensions and *measures*
declared once on a source, invoked by name in queries; queries that nest (a
query can be a source); and — critically — join semantics that understand
cardinality, so aggregating across a one-to-many join cannot silently
double-count. Its lesson: the model's vocabulary should be curated names with
meanings, not raw columns, and join-aware aggregation belongs in the language.

**EdgeQL** is the sharpest articulated critique of SQL as a language: not
composable (a query cannot cleanly be an expression inside another), not
orthogonal (the same idea spelled differently per clause), null semantics as a
landmine. Its fix — every expression uniformly operates over sets, so any
subexpression can be factored out without restructuring — is the cleanest
statement of what composability actually requires.

**MongoDB's aggregation pipeline** is the largest deployed structured-JSON query
language, and it teaches the essential warning: **JSON structure is not
safety**. Operator injection (a value position that also accepts operator
objects, distinguished only by a `$` prefix), an embedded-JavaScript escape
hatch, and attacker-supplied regex show that a structured carrier with an *open*
operator set and evaluable constructs reproduces SQL's problems in JSON. Safety
comes from a **closed** operator vocabulary, disjoint syntactic positions for
operators and data, and no evaluation constructs. The carrier format is
incidental.

**SOQL** is the longest-running "deliberately restricted SQL exposed to
untrusted authors" precedent: select-only, no `SELECT *`, no arbitrary joins
(only declared relationship traversal), governor limits on rows and time, inside
a massive multi-tenant platform, for two decades. Restriction is not a toy
property; it is what made that exposure survivable.

**Datalog** is the theoretical anchor: a query language that is not
Turing-complete by design, where termination and complexity are analyzable
properties. AgQL does not need its syntax, but keeps its discipline:
expressiveness is added only when its cost remains statically boundable. The
same restricted Datalog turns up inside modern **attenuable authorization
tokens** — bearer tokens that carry their own machine-checkable restrictions and
that any holder can narrow offline but never widen — which is the right
primitive for handing query rights down a tree of sub-agents.

**Semantic layers** (the metrics-layer products and the warehouse vendors' new
governed metric views) converge on the same architecture from the BI direction:
entities, dimensions, measures, and join topology defined once in a governed
model; the query interface collapses to "metrics + dimensions + filters + time
grain + limit". Notably, when the warehouse vendors added AI analytics, they did
not make SQL safer — they *shrank the vocabulary*. That is strong convergent
evidence for AgQL's premise. But semantic layers stop at metrics retrieval;
they never specified the agent-facing contract — errors, disclosure, repair,
scope — and their query languages are not general enough to be the whole
answer.

**The agent-tooling reality** supplies the final two facts. First, structured
output changed the calculus: with JSON-Schema-constrained decoding, a model can
be *guaranteed* to emit schema-valid JSON — schema adherence went from "usually"
to "always" the moment providers enforced grammars at sampling time. No such
guarantee exists for a novel textual syntax on mainstream hosted APIs. Second,
the current state of agent database access is a raw-SQL string in a tool call,
and the incident record around exactly that pattern — read-only wrappers
bypassed, tokens that override row security, prompt-injected exfiltration — is
the clearest possible demonstration that the guardrails must be a language, not
a per-server pile of flags. The mitigations the better tools are converging on
(database-role read-only, scoped access tiers, parameterized pre-defined
templates, execution-time limits, semantic-layer indirection) are each a
fragment of AgQL. AgQL is the thesis that these fragments are one coherent,
specifiable language.

---

## 3. Design proposal

### 3.1 Representation: structured JSON core, textual projection later

**Recommendation: AgQL's canonical form is a JSON document validated by a
published JSON Schema.** Not a textual DSL. Reasoning:

- **Emission reliability.** JSON-under-schema gets constrained decoding and
  tool-call guarantees from every major provider today. A new textual grammar
  gets none of that: the model free-writes it, and syntax errors — the error
  class structured output *eliminates* — come back as a repair-loop tax on every
  query. Betting a new language on models' zero-shot fluency in a syntax absent
  from their training data is the single most avoidable risk in this project.
- **Validation is the language.** A JSON Schema plus a catalog-resolution pass
  is the whole front half of the compiler, portable to any host language, and
  usable client-side, server-side, and in CI over stored queries.
- **Queries are data.** Hashing, diffing, storing, transforming, and
  programmatically generating queries (dashboards do this constantly) fall out
  for free.
- **The verbosity objection is real but cheap.** JSON costs tokens and human
  readability. Mitigations: keep the vocabulary terse (§3.3), and define a
  **canonical textual projection** — a pipeline-style pretty-printed rendering,
  bijective with the JSON — used in logs, docs, diffs, and UIs. Humans read the
  projection; models and machines exchange the JSON. If future models prove
  reliably grammar-fluent, the projection can be promoted to an accepted input
  format without changing the language, because the language *is* the validated
  structure, not the surface syntax.

One consequence of the format-constraint research is worth baking in: heavy
output constraints can slightly tax reasoning when the constrained artifact
comes first. So the surface convention is that the agent reasons freely in
prose, then emits the query as a tool call — which is the natural agentic
pattern anyway — rather than being forced to open with the constrained block.

### 3.2 The catalog is half the language

An AgQL deployment is a **catalog** plus the engine. The catalog declares:

- **Datasets** — named, described, mapped to physical relations by the adapter.
- **Fields** — name, kind (from a closed kind system: `id`, `text`, `integer`,
  `number`, `money`, `boolean`, `timestamp`, `enum`), description, flags
  (`sensitive`, `filterOnly` — usable in predicates but never in output).
- **Edges** — named join paths with declared direction, type, and
  **cardinality** (`one` | `many`). Cardinality lets the compiler *reject or
  auto-correct fan-out double-counting* (aggregating a one-side measure across a
  many-join) instead of silently returning wrong numbers — the worst failure
  class for an analytics agent, because it looks like success.
- **Measures** — named, described aggregations declared on a dataset ("revenue =
  sum of net line totals, excluding canceled orders"), so common questions are
  askable by *name* and the definition of "revenue" is governed, not
  re-improvised per query. Raw aggregates over fields remain available; measures
  are the paved road. This is also the direct answer to schema linking being the
  dominant text-to-SQL failure: shrink the namespace to curated names.
- **Default filters** — with descriptions and an explicit opt-out (a query that
  filters the same field, or names it in `withoutDefaults`, drops the default) —
  because "excluding canceled/archived/test rows" is the right default for
  ninety percent of questions and actively wrong for the rest, and both cases
  must be expressible *and visible*.
- **Row scopes** — how each dataset narrows to a caller's partitions (direct
  column, one-hop lookup, via a peer dataset, or none-with-reason), declared
  *per dataset and required*, so forgetting is a compile error of the catalog,
  not a silent hole in production.
- **Capability tags** — which grant unlocks each dataset (and thus each edge
  into it).
- **Statistics hints** — expected magnitude per dataset (order-of-magnitude row
  counts), feeding pre-flight cost checks (§3.4).

Everything the model is taught is **generated from the catalog**: the index, the
per-domain detail docs, the operator reference. One source of truth, enforced by
contract tests (§4.1), so prompt and compiler can never drift apart.

### 3.3 Core operations: a bounded pipeline

Semantically, an AgQL query is a short pipeline over the catalog; the JSON is a
direct encoding of it. The stages, in fixed order (each optional except `from`):

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

The vocabulary, deliberately closed:

- **Predicates**: comparison ops, `in`/`notIn`, null checks, bounded text ops
  (`contains`/`startsWith`, compiled to escaped pattern matching — never
  regex), and a relative-time family (`inLast`, `inCurrent`, `inPrevious`)
  because "this month", "the last 30 days", and "the previous quarter" are the
  overwhelmingly dominant analytical filters and calendar math belongs to the
  compiler — timezone- and fiscal-day-aware — not to the model.
- **Boolean structure**: `all` / `any` / `not` trees with a **hard depth cap
  (2)** and a node cap. OR exists; unbounded boolean algebra does not. No
  free-form expressions.
- **Buckets**: timeline buckets (truncate a timestamp to hour/day/week/month/
  year — keeps the timeline) and profile folds (extract hour-of-day,
  day-of-week, etc. — folds all occurrences together). These are distinct
  question shapes and the language names them separately so the model picks
  deliberately.
- **Aggregates**: count, countDistinct, sum, avg, min, max, percentile (bounded
  to declared quantiles), each with an optional per-aggregate `filter` (a list
  of the same predicate forms, narrowing that aggregate alone — this is what
  puts "issued next to returned" or "guests next to members" in one row of one
  query), plus the `ratio` composite (one aggregate divided by another — shares,
  rates, occupancy — with divide-by-zero defined as null, never an error).
- **Aggregate expressions**: an aggregate may be taken over a **single-level**
  arithmetic form — one operator (`add`, `subtract`, `multiply`, `negate`,
  `coalesce`, `minutesBetween`) over field references. Deliberately not an
  expression tree: nothing nests, precedence cannot be gotten wrong, and the
  result's kind (money stays money, minutes are a number) is derivable at
  compile time. A need that outgrows one level is a `derive` in a composed
  query (§3.6) or a measure in the catalog.
- **`having`**: the same predicate forms applied to aggregate select aliases
  ("categories with revenue over X"). Reuses the predicate language verbatim, so
  it costs the model nothing new to learn.
- **`take`**: mandatory-with-default, capped.

**Not in the vocabulary** (see §4.2 for reasoning): raw expressions as strings,
user-defined functions, regex, recursion, correlated subqueries, and any form of
write.

### 3.4 Bounded and safe by construction

- **The closed-vocabulary invariant** — the load-bearing rule of the entire
  language: every string the model produces is either matched against a
  catalog/enum key or bound as a parameter. There is no third path. A compiler
  that cannot uphold this for a construct must not implement the construct.
- **Structural limits in the spec**, not per deployment (deployments may lower,
  never raise): max joins, max predicate nodes and depth, max select entries,
  max in-list size, max rows, max composition depth (§3.6). Every limit ships
  with its rationale, and every limit violation is an enumerable, repairable
  error — never a silent truncation.
- **Pre-flight cost gate.** `explain` (§3.7) runs before `run`: the engine
  combines catalog magnitude hints and, where the backend allows, a planner
  estimate, and rejects over-budget queries with a *repairable* message ("this
  scans roughly ten million rows; narrow the time window or filter on X")
  instead of letting them die as timeouts. Planner estimates are known to be
  unreliable at the margin, so the gate admits generously and the runtime
  backstops (below) remain authoritative. The proven budget shape: price the
  query statically, charge a leaky-bucket budget, true-up after execution.
- **Execution guarantees**: read-only transaction on a least-privilege database
  role (so even a compiler bug degrades to "permission denied"), per-statement
  timeout, row cap applied by the engine (never trusted from the query
  document), session timezone and fiscal-day offset set by the engine.
- **Two result channels** as a spec-level concept: the *principal channel*
  (full rows, to the authorized human surface) and the *model channel*
  (catalog-flagged sensitive fields redacted, rows truncated to a small window
  with an explicit truncation note) — because model-channel results are
  serialized into a conversation that typically travels to a third-party
  inference provider, and that channel must never carry personal data the human
  surface is entitled to render. Engines must implement both; conflating them
  is non-conformant.

### 3.5 Capability and permission scoping

A query never compiles alone; it compiles against a **scope**:

```
scope = { capabilities: set<grant>, partitions: {dimension → allowed values | all}, principal }
```

- Capabilities gate datasets *and every edge into them* — reachability equals
  readability, because every restricted dataset is otherwise reachable by
  joining toward it. There is no long way around.
- Partition scoping (tenant, region, branch, team — named dimensions declared in
  the catalog) is **mandatory at the type level**: an engine API where scope is
  optional is non-conformant, so a new call site cannot forget it and silently
  query everything. An empty partition list means *nothing is visible*, never
  "no restriction".
- Scope shapes *disclosure* too: catalog descriptions, tool enums, and error
  alternatives are all narrowed to the caller's scope, so what the model can
  name and what it may query are the same set — and errors never enumerate
  hidden data.
- **Stored queries re-compile under the reader's scope, always.** A saved query
  authored by a privileged user simply refuses to run for an unprivileged
  viewer. Persistence is not privilege escalation.
- Scopes should be **attenuable**: a holder can derive a strictly narrower
  scope (fewer datasets, fewer partitions, lower limits, shorter expiry) to
  hand a sub-agent, offline, and never a wider one — the attenuable-token idea
  applied to query rights. This is the natural unit for multi-agent systems:
  the orchestrator holds the tenant scope; the sub-agent researching one region
  gets that region, with a row budget and an expiry.

### 3.6 Composability

Exactly two composition mechanisms, both bounded:

1. **Named queries (views).** A validated query can be registered in the catalog
   under a name, with a description, becoming a dataset like any other.
   Governance follows automatically: the view compiles under the *reader's*
   scope at read time, so it can never launder privilege. This is also how the
   paved road grows: yesterday's clever agent query becomes today's named,
   reviewed, documented dataset.

2. **One level of inline nesting.** `"from"` may be a full query instead of a
   dataset name — aggregation over aggregation ("average of daily revenue"),
   shares of a total (the inner query computes the total, the outer divides).
   Composition depth is capped at **2** in v1: this small step covers the large
   majority of "I needed two queries and client-side math" cases while keeping
   cost analysis trivial.

Between outer and inner query, a bounded **`derive`** stage (single-level
arithmetic over the inner query's output aliases) covers period-over-period
deltas and normalized metrics without opening general expressions.

Adjacent to composition: a **multi-query request** — several independent queries
in one call, executed under one scope and one budget, results keyed by name.
Agents constantly want three small numbers at once; making that one round-trip
removes both latency and the temptation to over-join.

### 3.7 How the language surfaces to an agent

AgQL's reference surface is an **MCP server** (the same contract can be exposed
as plain tool definitions in any agent framework):

- `catalog(domain?)` — progressive disclosure: a compact index narrowed to the
  caller's scope lives in the system prompt; full field/join/measure vocabulary
  for one domain loads on demand. Prompt cost stays flat as the catalog grows,
  and the tool's own domain enum is built from the scope, so an off-limits
  domain is not even nameable.
- `validate(query)` — full compile, no execution: returns either the typed
  result-shape contract (column names and kinds — so the agent can plan a chart
  or a table before spending a query) or a rejection.
- `explain(query)` — validate + cost verdict + a readable rendering of what
  will run (the textual projection; optionally the compiled SQL for operators).
  This is the **compile-and-explain loop**: prompts instruct the agent to
  explain before running anything non-trivial, and the budget gate lives here.
- `run(query | queries)` — execute under scope; model-channel results: column
  contract, row count, truncation flag, capped rows.
- `save(name, query, description)` — optional stored-query module for products
  with a persistence surface (dashboards, reports, alerts), with
  verify-before-save enforced server-side: a query that has not been `run` in
  this session cannot be saved.

Prompt guidance, generated from the catalog, teaches the loop explicitly:
discover → validate/explain → run → (persist). The error contract makes the
loop converge:

### 3.8 Errors as a specified part of the language

This is AgQL's most novel surface: no query language has ever specified its
error messages as part of the language contract, and for an agent consumer the
error channel *is* the learning channel. Rules:

1. **Every rejection is addressed to the model**: it names the offending part by
   its path in the query, states the rule, and **enumerates the legal
   alternatives** ("`group` entry `day` must be the alias of a non-aggregated
   select entry. Non-aggregated aliases: `week`, `channel`").
2. **Stable machine code + self-contained human sentence.** Codes make error
   frequencies measurable — *which mistakes do models actually make* is the
   empirical feedback loop for evolving the language.
3. **Never enumerate what scope hides.** Alternatives are computed within the
   caller's scope; an unauthorized dataset yields the same "unknown" shape as a
   nonexistent one. Repair guidance must never become a map of forbidden data.
4. **All structural errors at once, then the first semantic error.** Schema
   issues are cheap to list together; semantic resolution stops at the first
   failure so messages stay small and repairs stay sequential.
5. **Cost rejections must include a remedy** (narrow this, filter that) —
   "too expensive" without a direction is where repair loops die.
6. **Rejections are tool results, not exceptions.** An error the agent loop can
   read is a turn; an exception is an outage.

### 3.9 Determinism, audit, replay

Because queries are data: every `run` logs `(principal, scope, query hash,
query, cost verdict, row count, duration)`. That log is exact and replayable —
an auditor re-runs precisely what the agent asked, under the same or a different
scope, and diffs the answers. This is not a nicety: the incident record includes
an agent flatly misreporting what it had executed, so the agent's transcript can
never be the audit record; only the engine's can. Compilation is deterministic
given (query, catalog version, scope); the catalog is versioned, and stored
queries record the catalog version they were written against, so migrations are
detectable instead of silent.

---

## 4. What makes it genuinely good — and where it stops

### 4.1 Not a toy: the substance checklist

A JSON schema around `SELECT` is a weekend project and a toy. AgQL is the
position that the following are the actual product, and each must exist for the
project to matter:

- **A written spec** with conformance semantics: the query grammar (as JSON
  Schema), the closed kind system, the limit table with rationales, the scope
  model, the two-channel result contract, and the **error catalog** with codes,
  required content, and disclosure rules.
- **A conformance test suite** an implementation runs against: valid/invalid
  query corpora, scope-leak probes (does any error path name hidden data?),
  fan-out-aggregation traps, limit boundary cases, redaction checks, and the
  classic engine traps (alias/column ambiguity in grouping, predicates on
  left-joined datasets silently turning the join inner, prototype-pollution via
  output aliases in JavaScript engines).
- **Catalog-derived teaching as a conformance requirement**: an engine must emit
  the model-facing docs from the catalog, and a **prompt-contract test** pattern
  is part of the suite — every operator the schema accepts is taught, every
  construct taught exists. A construct the model never hears of is one it will
  never use; a construct the prompt still teaches after a rename ships silent
  failures.
- **An emission eval harness**: a benchmark of natural-language questions over a
  reference catalog, scored on first-emission validity, repair convergence
  within N turns, and semantic correctness of results. This is how design
  choices get decided — does `having` earn its place? does depth-2 nesting
  confuse models? — with data instead of taste. It is also the pitch: AgQL's
  claim is measurably higher agent accuracy than raw SQL on the same questions,
  and the harness is what makes the claim falsifiable.
- **Cardinality-aware join semantics** (§3.2): silently-wrong aggregates are the
  difference between a demo and something a finance team can trust.
- **At least two compile targets** — Postgres first; DuckDB second (embedded and
  fast, which makes the test suite and eval harness dependency-free) — to prove
  the language, not one adapter, is the artifact.
- **A reference implementation** shaped for adoption: a TypeScript library with
  the compiler as pure functions, and the MCP server as a thin shell over it.

### 4.2 Deliberate non-goals

- **No writes. Ever. In the language.** No insert/update/delete/DDL analog.
  Mutations from agents are a different problem with different guardrails
  (idempotency, confirmation, domain invariants) and belong in purpose-built
  tools with domain semantics ("issue_refund"), not in a general data language.
  Fusing them would poison the core safety claim: *nothing that compiles can
  change anything* — and it would hand every prompt injection a write-back
  exfiltration channel inside the query language itself.
- **No user-defined functions, no expression strings, no regex, no evaluable
  anything.** Every escape hatch becomes the vector — that is the deepest
  lesson of structured query languages that shipped one. Pressure for
  expressiveness routes to catalog measures (governed) or composition
  (bounded), or is declined.
- **No full SQL parity, and no ambition of it.** Window functions, recursive
  CTEs, arbitrary self-joins, UNION, lateral joins stay out of v1 — not because
  they are useless but because each, in its general form, breaks either "cost
  is boundable" or "shape is derivable". Where real demand emerges, admit the
  *bounded, named* form of the need (a `deltaOverPrevious` select kind; a
  `rank` with mandatory partition and take), never the general mechanism. The
  language grows by named idioms, not by operators that recombine.
- **Not an ORM, not an application query layer.** Applications have build steps
  and type systems; SQL and ORMs serve them fine. AgQL is only for the case
  where the query author is a model at runtime.
- **Not a natural-language layer.** AgQL is the *target* the model compiles
  intent into; it does not parse English. Keeping NL out of the spec keeps the
  spec decidable.
- **No client-trusted anything**: scope, limits, redaction, and caps live
  server-side; the query document carries zero authority.

### 4.3 Honest risks

- **The expressiveness cliff.** Agents will hit the walls (window functions
  first, most likely) and route around AgQL back to raw SQL where it is
  available. Mitigations: the eval harness shows *which* wall matters
  empirically; composition, measures, and named idioms are the pressure valves;
  and sometimes the correct answer to "the agent needed a query AgQL cannot
  express" is "a human writes a catalog view".
- **Catalog authoring is real work** and the actual adoption cost — the
  semantic-layer industry's hard-won lesson. Mitigations: a catalog-bootstrap
  tool (introspect a schema, draft datasets/edges/kinds/descriptions with LLM
  assistance, human curates), and a design that makes a *small* catalog useful
  on day one.
- **Standard vs product tension.** A spec nobody implements is a PDF; a product
  without a spec is one more internal query DSL. The sequencing bet: reference
  implementation and eval harness first, spec extracted from what they prove.

---

## 5. Open questions

1. **Scope of v1 composition.** Is depth-2 nesting + named views + `derive` the
   right cut, or does period-over-period comparison — the single most common
   real analytics ask — deserve a dedicated first-class construct in v1?
2. **The textual projection.** Ship it in v1 (docs, logs, and diffs benefit
   immediately) or defer until the JSON core is stable? And should `explain`
   return the projection, the compiled SQL, both, or per-caller choice?
3. **Catalog format.** TypeScript-first (typed, composable, refactorable) with
   a JSON export, or a declarative YAML/JSON format with a TS SDK on top? The
   answer decides who can author catalogs.
4. **Measures vs raw aggregates.** How hard should the language push toward
   catalog measures — should raw `sum(field)` require the field to be marked
   aggregatable, making measures the default path rather than the optional one?
5. **Attenuable scopes.** In v1 as signed scope tokens, or start with plain
   server-side scope objects and add offline attenuation when a multi-agent
   consumer actually exists?
6. **Cost model depth.** Are catalog magnitude hints plus planner estimates
   enough, or does v1 need a real budget unit (scanned-row credits per session)
   so orchestrators can ration sub-agents?
7. **Streaming and big results.** The model channel is capped by design, but
   the principal channel (exports, dashboards) wants pagination or streaming —
   in the v1 spec, or an engine concern?
8. **Non-SQL backends.** Is compiling to one non-relational target early worth
   it to keep SQL-isms out of the spec, or premature?
9. **First deployment.** What is the dogfood target — a real product surface
   whose agent queries run on AgQL from day one — and what does its catalog
   need? The language should be extracted from a working deployment, not
   designed in a vacuum.
10. **The name.** "AgQL" reads as "agriculture QL" to some; worth deciding
    before anything public. (Counterpoint: it is short, and the puns available
    in the alternatives are worse.)
