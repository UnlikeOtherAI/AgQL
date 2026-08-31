# Exact conformance corpus

This directory is the independent oracle for the RFC v0 exact core. A runner
MUST execute every JSON fixture against every adapter that advertises the
fixture's required profile and compare the runner-neutral `expected.semantic`
projection after RFC 8785 canonicalization. Adapter-specific envelopes,
distances, timings, and backend scores are not part of that projection.

Every fixture is self-contained: it declares a catalog fragment, policy and
scope when relevant, seeded logical records (and seeded derived vectors for
retrieval), the request, the explicit execution inputs such as the anchor, and
the expected outcome. JSON files are UTF-8, use LF line endings, and contain no
machine-, locale-, clock-, or unpinned-random inputs.

## Fixture contract

- `format` is `agql-exact-fixture/0.1`.
- `rule` is the prose statement a failure would contradict.
- `rfc` identifies the normative clauses. A `brief` reference supplies
  rationale only and never overrides the RFC.
- `catalog`, `policy`, `scope`, and `seed` are fixture inputs, not proposed
  normative wire schemas. A runner maps these declarative fragments into its
  catalog and seed APIs without changing their logical meaning.
- `query` is the canonical JSON request submitted to the implementation.
- `execution` supplies every non-query semantic input, especially `anchor` and
  exact-retrieval query vectors. It is never populated from a wall clock.
- `expected.semantic` is the portable comparison surface. Object keys are
  field/output ids; row or group order is significant. The comparison is over
  JCS bytes.
- `expected.error` compares every non-marker member exactly. Rejections are
  result values, not thrown or transport errors, and the backend MUST NOT be
  called when `beforeBackend` is true.
- `compareWith` names a relational oracle, such as two error results whose JCS
  bytes must be identical. This is useful where the actual hidden-reference
  error vocabulary is not yet specified but its non-disclosure shape is.

The literal string `UNDETERMINED_BY_RFC_V0` is a specification-gap marker, not
an AgQL value or error code. A runner MUST report a fixture containing it as
`pending-spec` for that member, MUST still enforce every sibling `assertions`
entry, and MUST NOT substitute an implementation-chosen value into the oracle.
This lets the corpus expose omissions without laundering one implementation's
choice into the language.

## Layout

| Range | Area |
|---|---|
| `001`–`006` | total ordering, pagination, nulls, and half-open bounds |
| `007`–`015` | exact numerics, money, enum values, and ratio |
| `016`–`021` | calendar buckets and anchored relative time |
| `022`–`025` | NFC, case, literal text operators, and collation |
| `026`–`033` | deterministic errors, hidden references, hashes, aliases |
| `034`–`036` | exact retrieval membership, filtering, and admission |
| `037`–`039` | normative deferrals, forbidden escape hatches, empty scope |

The RFC currently does not define a complete result-envelope schema. The
semantic projection above is therefore the byte-comparison target for the
data-plane result, while envelope conformance is tested as named assertions
and by the host/protocol runners. Once the RFC fixes a canonical result wire
schema, these fixtures can add exact envelope bytes without changing their
semantic oracle.
