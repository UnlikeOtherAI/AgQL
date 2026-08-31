# AgQL Agent Standards

## Rule zero — the spec is the product; the code proves it

`docs/rfc-v0.md` is normative and authoritative for v0. `docs/brief.md` is
rationale. Where they disagree, the RFC wins. Code that contradicts the RFC is a
defect in the code — **never** a licence to quietly amend the RFC. If the RFC is
genuinely wrong or under-specified, say so in your summary and propose the
change; do not paper over it.

Two consequences that decide most design arguments here:

1. **No construct without a conformance test.** Every implemented rule ships with
   the fixture that would catch its absence. Deferred v0 constructs
   (§1: joins, edges, nested queries, `derive`, `merge`, percentile, rerank,
   multi-vector, materialized datasets, artifacts, publication, federation,
   attenuable credentials, DP, derived-policy propagation) MUST be rejected with
   `UNSUPPORTED_IN_V0` — never implemented incompatibly, never silently ignored.
2. **Refusal is a successful outcome.** Unsupported profile, unenforceable
   scope, exact-scan budget exceeded, unavailable freshness tier, unindexed
   EmbeddingSpec, cost gate — each is a typed, repairable refusal returned as a
   *result*, not an exception and not a silent downgrade.

## The invariants that cannot be traded away

These are the whole value proposition. A change that weakens one is rejected on
sight, regardless of what it buys.

- **The Query Core cannot write.** No mutation reachable from any query
  construct, on any backend, ever. Ingest is a separate contract that cannot
  query.
- **The closed-vocabulary invariant.** Every model-produced string is either
  matched against a catalog/enum key or bound as a native parameter. There is no
  third path. An adapter that cannot uphold this for a construct MUST NOT
  implement that construct.
- **No native-query passthrough.** No `rawSql`, no `rawPipeline`, no power-user
  escape hatch, no string-concatenated identifiers. Physical identifiers come
  from the catalog only.
- **No evaluable anything.** No UDFs, expression strings, regex, or `eval`-shaped
  constructs. Text matching is escaped substring semantics.
- **Scope is mandatory and compile-time.** Every operation takes a scope; empty
  partitions mean *nothing visible*, never everything. Policy violations are
  refusals before the backend is called.
- **Mandatory pushdown of authorization.** No adapter may fetch unauthorized
  rows and filter them engine-side. Internal index traversal of ineligible nodes
  is permitted; surfacing them across the trust boundary is not.
- **Errors never enumerate what scope hides.** An unauthorized reference and a
  nonexistent one share one error shape, in every path including retrieval.
- **Determinism has no clocks and no randomness.** Relative-time operators read
  an explicit anchor that is logged and replayable. Compilation is a pure
  function of (query, catalog, policy, scope, binding, engine, adapter versions).
- **Receipts never falsely succeed.** `afterWrite` either observes every required
  visibility state or returns a structured timeout. A timeout is a valid result;
  a false success is a conformance failure.
- **The runtime owns embedding generation.** Adapters index and search vectors;
  they never produce them, and backend-native inference endpoints are never
  semantic authorities.

## Architecture

TypeScript, strict, pnpm workspace. The engine is **pure functions**; adapters
are packages; the MCP server is a thin shell over them.

```
packages/schemas     kinds, wire forms, JSON Schema/zod, JCS canonicalization,
                     the three identities, the error catalog
packages/catalog     catalog kernel, EmbeddingSpecs, scope + field policy types,
                     catalog-derived documentation
packages/engine      validation, policy evaluation, planning, limits, cost gate,
                     receipts, result envelopes  (no I/O, no backend knowledge)
packages/adapter-*   one package per backend; receives resolved logical plans
packages/mcp         the normative MCP profile
packages/http        the equivalent HTTP/JSON data-plane profile
conformance/         fixture corpora + the suites that run them
```

**The engine owns meaning; adapters own translation.** An adapter receives the
resolved, typed, scope-expanded logical plan — never the model AST. If an
adapter needs to understand a language construct to translate it, the boundary
is in the wrong place.

## Code quality

- Strict TypeScript. No `any`, no `as unknown as`, no non-null assertions to
  silence the compiler. Lint gates the build.
- **No fallbacks, no sentinel values, no compatibility shims.** Fix the contract.
  A silent default is how a determinism guarantee dies.
- 500 lines per file maximum. Split along cohesive responsibility seams, never
  into `-helpers` / `-utils` buckets.
- Validate at every boundary: tool arguments, stored JSON, adapter inputs.
- Build the simplest thing that satisfies the RFC. No speculative generality —
  v1 constructs are deferred *on purpose*, and half-implementing one is worse
  than not having it.
- Exact numerics are exact: decimals and money travel as strings and are
  computed with a decimal type. Binary floats are not a v0 kind, and they must
  not sneak in through an implementation shortcut.

## Testing

- Every package has unit tests; run them through the workspace test script.
- Conformance fixtures are data, not code paths: a suite runner reads
  `conformance/**` and reports per-fixture outcomes.
- Security probes are zero-tolerance and randomized at scale — an ineligible
  result in any run is a failing build, not a flake.
- Test the refusals as carefully as the successes: the error code, the JSON
  Pointer, and the enumerated alternatives are all part of the contract.

## Workflow

- Worktrees are mandatory: the main checkout stays on `main`; every task works in
  `.worktrees/<task>` on its own branch. Never edit another task's worktree.
- Package manager **pnpm**. Commit and push every turn; merge to `main` when
  lint, typecheck, and tests pass.
- **Stay inside your task's packages.** If your task needs a change to a package
  another task owns, work around it locally and report the needed change in your
  summary rather than editing it — parallel tasks merge cleanly only if they own
  disjoint directories.

## Documentation

- A change to a normative behaviour updates `docs/rfc-v0.md` in the same change,
  or explains in the summary why the RFC already covers it.
- Keep `README.md` true about implementation status.
- Model-facing documentation is **generated from the catalog**, never
  hand-maintained beside it — prompt-contract tests keep taught vocabulary and
  the compiler in lockstep.
