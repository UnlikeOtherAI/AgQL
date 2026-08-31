# Security probe corpus

These fixtures are zero-tolerance randomized matrices for RFC §11. They do not
measure a leak rate: one ineligible logical record, one premature freshness
success, one hidden-catalog distinction, or one backend call after a required
compile refusal fails the build.

Each JSON file contains:

- `setup`: the catalog, policy/scope, records, vectors, channel state, or receipt
  timeline the runner instantiates. `{{name}}` placeholders are replaced by the
  expansion dimension of that name.
- `adversarialIntent`: one sentence describing the failure the case is designed
  to make attractive to an unsafe adapter.
- `expansion`: a pinned xorshift32-v1 seed, at least 20,000 cases, and dimensions
  in draw order. For case indices `0..caseCount-1`, initialize the PRNG once per
  fixture, consume one `nextU32` word per dimension in listed order, and select
  `values[word % values.length]`. The algorithm is exactly the one specified by
  `../retrieval/generator-spec.json`; no reseeding, rejection sampling, clock,
  or unpinned source is permitted. Repeated tuples are still executed and count
  as separate probes because adapter/index state and operation ordering may
  expose nondeterministic leaks.
- `invariant`: the eligibility or refusal property. `maximumViolations` is
  always zero and `failure` is always `fail-build`.

Templates are declarative runner inputs, not proposed AgQL wire-schema
extensions. A runner records the expanded case index, seed, selected dimension
values, adapter/binding/engine versions, and index or receipt state so every
failure is replayable. It MUST instrument the backend boundary where a fixture
requires proof that logical content was not fetched, and MUST run both cold and
warmed index/cache orderings when `stateOrder` is a dimension.

The ten probe families named by RFC §11 are files `001`–`010`. Files `011`–`013`
cover invariants and acceptance gates that are normative elsewhere in the RFC
but not named as security probe families: runtime-owned embeddings, backend
opacity, and principal/model channel isolation.
