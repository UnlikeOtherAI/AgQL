# AgQL rollout plan — the author's ecosystem (non-normative)

> **This document is not part of the AgQL specification.** It is the
> deployment plan for one specific ecosystem — the author's products — and
> exists so the spec ([brief.md](brief.md)) can stay 100% project-agnostic.
> Nothing here constrains what AgQL is; it records where AgQL will be proven.

## The shape: hub and spoke, not per-product adoption

The ecosystem has a shared agentic core (`deep.agent`) whose memory package
already defines a `MemoryStore` contract (write/read/search by
`{namespace, principal}`, with classification, provenance, taint-with-safe-
default, and freshness fields) and names Remember Ninja's hosted API as its
concrete backing — via a `RememberNinjaStore` HTTP adapter that exists today
as a feature-flagged stub. That makes the rollout a dependency graph, not a
migration campaign.

## Phases

**Phase 0 — AgQL becomes Remember Ninja's engine.** Remember Ninja already
demands both query modes (keypath `records` lookups + hybrid `retrieve`),
the Storage API, watermarks, EmbeddingSpecs, and subject-scoped privacy —
and runs two backends with two architectures (cloud Postgres+pgvector
integrated; local SQLite CLI split-store) that today implement the same
concepts twice by hand. Rebuilding both on one AgQL catalog with two
adapters collapses the duplication and exercises every pillar. Its editorial
verbs (`remember`/`why`/`forget`, cards, ingestion) remain the thin domain
layer above the substrate.

**Phase 1 — wire `@deep/memory`'s `RememberNinjaStore`.** Flip the stub to
live, and extend the `MemoryStore` contract *at wiring time, not after*:
add write receipts (`{version, watermark, embeddingState}`) and
`MemoryQuery.afterWrite`, so every consumer gets read-your-writes rather
than inheriting fire-and-forget memory through the shared interface.

**Phase 2 — consumers upgrade a dependency.** DeepSignal (filesystem link)
picks it up immediately; DeepTest re-vendors; the KiloMayo monorepo's
aiStats agent swaps its process-lifetime `InMemoryStore` for the wired
store; DeepWater adopts deep.agent as already intended.

**Phase 3 — the parallel stacks migrate.** Nessie (the ancestor deep.agent
was extracted from, deliberately not a consumer, running its own ~8.5k-LOC
Thoughts memory stack with no agent-facing API) and the monorepo's
structured-analytics side (classic widgets onto the aiStats catalog,
retiring the duplicated ~25k-LOC classic stack with parity proven by the
conformance suite). Full AgQL surfaces — structured queries, datasets,
artifacts — then expose product-by-product on the runtime the memory path
already proved.

**Designing to the contract ahead of the runtime.** One Nessie feature is
already designed against the contract before any phase ships: the
**agent-tables plan** (`nessie/docs/plans/2026-08-31-agent-tables.md`) —
agent-owned, shareable simple tables at fleet scale — adopts the v0 shapes
natively (closed kinds, single-dataset `records`/`aggregate` queries, the
Ingest receipt contract with named visibility states, declared-dataset
provisioning, scratch/durable tiers, and §3.8's shared-placement rule for the
millions-of-small-datasets case). It is a consumer-shaped proof of the
contract, not a second implementation of the spec: when the runtime lands
(after Phases 0–2), that feature converges to a catalog + Postgres binding
rather than a migration, and becomes Nessie's first full AgQL surface in this
phase.

## Why this sequencing de-risks the project

Phases 0–2 pay for themselves even if AgQL never becomes a public standard:
Remember Ninja gets its engine, five products get governed read-your-writes
memory through one dependency bump, and the expensive migrations (nessie,
classic stats) happen only after the substrate has proven itself in
production twice. The plan is never more than one phase deep on an
unvalidated bet.

## Community wedge: the OB1 compatibility bridge

Alongside the in-house phases, one outward-facing wedge: **Open Brain (OB1)**
(github.com/NateBJones-Projects/OB1, ~4.5k stars) is a community-scale,
self-hosted personal memory hub — Postgres+pgvector on Supabase, a `thoughts`
table as the universal unit, an MCP gateway, and an ecosystem of extensions,
importer recipes, and prompt-pack skills. It is the public proof of demand
for the shared-memory thesis, and it is technically shallow in every
dimension AgQL is deep: no contract, no portability, RLS-only security with
full rows entering model context, LLM-directed writes into tables, no
freshness contract, no embedding lifecycle, no provenance envelope.

The bridge: an **AgQL catalog + binding over an existing OB1 database**. The
`thoughts` schema is small and stable, so this is on the order of a week —
and it gives that community a one-command upgrade ("keep your data; gain
result channels, freshness receipts, operation-level field policies, an
embedding lifecycle, and a real query language") while giving AgQL a warm,
thousands-strong audience already self-selected for exactly this problem.
Their extension/recipe/skill model maps directly onto AgQL: an extension
becomes a catalog + skill pack; an importer becomes a catalog fragment + an
Ingest script, governed the moment it lands.

Sequencing: after Phase 0 proves the engine on Remember Ninja, the OB1
bridge is the cheapest external validation available — a foreign schema
nobody on the team designed, adopted by users nobody on the team knows.
Compatibility-as-adoption is how contracts win against implementations.

## Open question carried here from the brief

Per-application namespacing of the hosted service: one multi-catalog AgQL
deployment (one catalog per product — cleaner isolation) or one catalog with
a product partition dimension (cheaper to operate, weaker blast-radius
story)? This shapes the first catalog written in Phase 0.
