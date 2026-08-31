# AgQL — Agents Query Language

**A data contract designed for AI agents the way SQL was designed for humans.**

> AgQL is a vendor-neutral data contract for AI agents. Its closed query IR,
> governed ingestion protocol, and conformance profiles give structured queries
> and semantic retrieval the same authorization, freshness, provenance, and
> release semantics across supported backends.

SQL was built for a person at a terminal, then bent to serve applications
through string concatenation and ORMs. Now we hand it to language models —
alongside a second, unrelated stack of vector stores with their own APIs, their
own auth, and no shared governance. AgQL starts from a different question: *if
the author of every query is a language model and the operator of every database
is a guarded runtime, what should the contract between them look like?*

AgQL is **not a storage engine**. It is the contract under which existing and
future storage engines become safely interchangeable for agents. It targets
native engines the way TypeScript targets JavaScript: nothing reaches the target
except through the compiler, so the target's footguns stay out of reach.

## The three pillars

1. **Deterministic — as declared, testable tiers.** The same query always
   validates the same way, compiles the same way, and means exactly one thing;
   exact queries produce reference-identical results on every backend. Semantic
   retrieval is *explicitly approximate*, and its conformance is specified too:
   security invariants, filter correctness, measured quality envelopes, and full
   provenance — never a false promise of identical neighbours.
2. **Fully MCP-enabled.** MCP is the normative agent-facing profile — tools for
   the query loop, resources for the catalog — and that surface is core language
   design, not an integration bolted on later. The core stays
   transport-independent: an equivalent HTTP/JSON profile serves hot paths.
3. **Database-agnostic.** AgQL is defined against a logical data model, never a
   backend's language. Per-backend adapters compile it to native queries, and a
   backend earns the claim by passing the conformance suite, not by marketing.

One deliberate split protects the strongest safety property: the **Query Core**
is read-only and incapable of writes by construction, while **Ingest** is a
separate, tiny, idempotent contract. Agents do need to remember things — but
"easy storage" must never mean an update language inside the query language.

## The surfaces

```
AgQL Query Core     read-only, closed, bounded query IR
AgQL Ingest         idempotent record ingestion + derived-index visibility receipts
AgQL Runtime        catalog, policy, planning, adapters, audit, result channels
AgQL MCP Profile    the normative agent-facing protocol binding
```

## Documents

| Document | What it is |
|---|---|
| [docs/rfc-v0.md](docs/rfc-v0.md) | **The normative contract.** Small, implementable, and authoritative for v0 — where it disagrees with the brief, this wins |
| [docs/brief.md](docs/brief.md) | The vision and design-rationale paper: why the contract looks like this, prior art, and the falsification test it must pass |
| [docs/example-session.md](docs/example-session.md) | An agent working through the surface end to end |
| [docs/rollout.md](docs/rollout.md) | Non-normative: the author's own deployment plan. Nothing here constrains what AgQL is |
| [conformance/](conformance/) | Fixture corpora. `encoding/` (canonical-form pairs + rejections) is the first suite |

## Status

**Specification draft; reference implementation running.** The v0 RFC is frozen
enough to build against, the TypeScript runtime and its two adapters are
implemented, and the conformance suites execute against both.

Current conformance, measured against a live PostgreSQL + pgvector database:

| Suite | Pass | Fail | Blocked |
|---|---:|---:|---:|
| encoding | 12 | 0 | 0 |
| exact (SQLite) | 35 | 0 | 4 |
| exact (PostgreSQL) | 35 | 0 | 4 |
| portability (SQLite ↔ PostgreSQL) | 35 | 0 | 4 |
| receipts | 11 | 0 | 0 |
| retrieval | 3 | 0 | 4 |
| security probes (per adapter) | 13 | 0 | 0 |
| **total** | **157** | **0** | **16** |

Thirty-five exact fixtures return byte-identical results across two materially
different adapters, and 6,656 seeded adversarial security cases find zero
authorization violations. The 16 blocked fixtures are honest gaps, not skips:
three calendar aggregates and decimal precision/scale boundaries, plus the four
retrieval filter-selectivity families whose recall thresholds RFC §11 says must
come from first cross-adapter measurement rather than being invented up front.

Nothing here is stable yet. The acceptance gates in RFC §12 are what "v0" will
mean, and they are deliberately falsifiable: if the reference implementation
cannot pass them, the contract has not earned its complexity.

## Deployment

Docker, PostgreSQL, Caddy, operations, verification, rollback, and teardown
instructions are in [deploy/README.md](deploy/README.md).

## License

MIT — see [LICENSE](LICENSE). A contract that isn't freely implementable isn't a
contract.
