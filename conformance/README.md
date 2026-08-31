# AgQL conformance corpora

These corpora are the implementation-independent oracle for AgQL v0. They are
derived from `docs/rfc-v0.md`, not from an adapter or reference engine. A runner
is intentionally absent: implementations consume the same data, and a value
the RFC does not determine is marked rather than inferred from whichever engine
runs first.

All new wire and oracle data is UTF-8 JSON with LF endings. JSON is used because
identity fixtures depend on exact RFC 8785 bytes and because it avoids creating
a second YAML profile. The existing `encoding/` suite retains its paired JSON
and fenced AgQL-YAML files unchanged; it is the encoding-format precedent.

## Suite map

| Suite | What it proves | Normative source |
|---|---|---|
| `encoding/` | Accepted JSON/YAML pairs normalize identically; forbidden YAML features receive deterministic `ENCODING_*` rejections. | RFC §§3, 11 |
| `exact/` | Runner-neutral JCS results for records, aggregate, and exact retrieval; total order, nulls, bounds, exact numerics, money refusal, enums, calendars, anchored relative time, text, deterministic errors, hidden references, hashes, aliases, normative deferrals, and core safety refusals. | RFC §§1–6, 9–11 |
| `retrieval/` | A byte-reproducible PRNG corpus, exact eligible-set and top-k oracles for four selectivity families, recall-distribution reporting, and versioned drift-sensitive certification. | RFC §§5, 6, 9, 11, 12 |
| `security/` | Pinned randomized matrices with zero permitted violations for all ten §11 probes plus runtime embedding authority, backend opacity, and channel isolation. | RFC §§4–12 |
| `receipts/` | Logical-time visibility timelines: every required state, valid structured timeout, false-success failure, delete ordering, state monotonicity, opaque tokens, unsupported tiers, and migration isolation. | RFC §§7, 9–12 |

Each suite README defines its local format and comparison rules. Every fixture
states the rule it enforces in prose. The literal
`UNDETERMINED_BY_RFC_V0` is a gap marker, never an AgQL runtime value or error
code. A runner reports that member as `pending-spec` while still executing all
determined sibling assertions.

## Runner consumption contract

1. Parse fixture JSON strictly: reject duplicate keys and non-UTF-8 input. Do
   not mutate the checked-in file before digest verification.
2. Materialize the declared catalog, policy, scope, seed records, derived
   vectors, binding capabilities, and logical scheduler. Fixture catalog/setup
   objects are declarative harness data, not a competing normative wire schema.
3. Submit the fixture query through the normal validation, policy, compile, and
   adapter boundaries. Refusals and timeouts are result values, not thrown or
   transport errors. Honor `beforeBackend` and boundary-instrumentation checks.
4. For exact success, reduce the implementation response to the fixture's
   runner-neutral `expected.semantic` projection, RFC 8785-canonicalize it, and
   compare bytes. Preserve row/group/rank order. Exact retrieval compares
   membership and rank, never raw distance.
5. Compare every specified error member exactly. For relational hidden-reference
   fixtures, compare the complete two error results to each other after JCS even
   where the shared code is still a gap marker.
6. Regenerate or verify retrieval bytes with
   `node conformance/retrieval/reference-generator.mjs --check`, enforce exact
   eligibility before measuring recall, then emit the distribution and
   certification shapes in that suite. Do not assign a named-profile threshold
   until the first cross-adapter measurements.
7. Expand every security matrix exactly as its README specifies. Record seed,
   case index, selected dimensions, versions, and state order. One violation
   fails the build; no statistical allowance or flake retry applies.
8. Drive receipt fixtures with logical steps, not sleeps. A success before all
   required query-visible states is a failing observation; a deadline timeout
   is a conforming result.
9. Run applicable exact fixtures against every advertised profile. Run the same
   request through MCP and HTTP for protocol-equivalence checks, preserving
   identities and semantics. Host/channel checks require instrumented host
   context in addition to adapter results.

## RFC §12 acceptance-gate mapping

| Acceptance gate | Corpus evidence | Remaining runner responsibility |
|---|---|---|
| Exact portability across two canonical adapters | `exact/` and `encoding/` | Execute every applicable fixture on two adapters and compare JCS projections/identities. |
| Zero authorization violations | `security/001`–`010`, exact hidden/scope fixtures | Expand every matrix, instrument the trust boundary, fail on the first violation. |
| Receipts never falsely succeed | `receipts/`, `security/008`–`010` | Control visibility schedules and observe actual query route/state. |
| Per-adapter recall distributions against one oracle | `retrieval/` | Measure every query/family, publish the full distribution, establish thresholds only from the cross-adapter baseline. |
| Complete backend opacity | `security/012`, receipt token fixtures, forbidden escape-hatch exact fixture | Inject physical-name canaries into all agent-facing surfaces and operator-routing paths. |
| Runtime overhead isolated and small | No static data can establish latency | Measure auth, validation/policy, embedding, adapter compile, backend, and fusion/release separately under a documented harness. The RFC does not quantify “small.” |
| MCP/HTTP protocol equivalence | Every exact and retrieval query is reusable | Execute via both profiles and compare semantics plus all three identities. |
| Complete retrieval provenance | Exact retrieval fixtures, retrieval manifest/certification, migration/embedding probes | Validate every required provenance member and channel policy in the actual response envelope. |

## Normative gaps exposed by the oracle

The gaps below are deliberately not filled by fixture-author convention. The
exact files carry the local detail and adversarial examples.

### Language, schemas, and results

- RFC §5 says `version: "0"`, while the preserved encoding fixtures use
  `version: "1"`. The accepted version and migration rule conflict.
- RFC §§4–5 provide no normative JSON Schema for catalog, policy, scope, query,
  aggregate dimensions/metrics/having, result rows/groups, or defaults. RFC §3
  therefore cannot yet determine default-materialized canonical bytes for the
  general case. RFC §8 describes an envelope but does not define its canonical
  object shape, caps, or omission/null rules, so byte-identical full responses
  cannot yet be golden files.
- RFC §5 calls structural ceilings “spec constants” but supplies no values and
  does not define depth/node counting. RFC §2 calls the integer range safe and
  interoperable but supplies no numeric endpoints. Instant precision syntax,
  comparison details, leap seconds, and precision mismatch behavior are absent.
- RFC §5 requires a stable-id final tie-break but does not define its implicit
  direction, id ordering relation, or whether users must spell it. It defines no
  pagination/cursor request or snapshot-binding semantics.
- RFC §§1 and 10 require `UNSUPPORTED_IN_V0` for deferred constructs but reserve
  no recognizable v0 wire spellings for most of them, leaving a structural
  unknown-member versus normative-deferral conflict and unspecified paths.

### Scalar and aggregate semantics

- RFC §§2 and 11 require portable null behavior but do not define null ordering,
  equality/`in` behavior with null, aggregate null elimination, empty aggregate
  results, or selectable NULLS FIRST/LAST behavior.
- RFC §2 gives no grammar for a canonical decimal string, including leading or
  trailing zeros, scale preservation, exponent notation, and negative zero. It
  does not normatively put precision/scale in catalog fields or define maximums,
  validation stage, overflow, widening, rounding, or arithmetic result scale.
- RFC §§2 and 5 mandate cross-currency `sum`/`avg` refusal but do not name its
  code, say whether it is compile- or execution-time, define grouping by
  currency, or define same-currency money aggregate output scale. ISO-4217
  revision and currency minor-unit interaction are also absent.
- RFC §5 fixes ratio divide-by-zero to null but not the metric wire syntax,
  integer promotion, decimal result kind/scale/precision/rounding, null
  propagation, or numerator/denominator filter alignment.
- RFC §2 says enum labels are not values but does not define ordering as code
  collation, declaration order, declared rank, or forbidden operation.
- RFC §11 names half-open ranges without defining a range construct. The exact
  fixture can only express the determined behavior as an explicit `gte`/`lt`
  conjunction.

### Text, calendar, and relative time

- RFC §§2 and 4 require an NFC, versioned collation but define no collation ids,
  comparison algorithm, Unicode/CLDR version, adapter refusal behavior, or the
  boundary at which stored/query text is normalized. Empty-needle and null
  behavior for `contains`/`startsWith` is unspecified.
- RFC §§2 and 5 do not define calendar catalog members, supported grains, bucket
  label types, tzdb version, week start, fiscal-day boundary, ambiguous or
  nonexistent local-time handling, or fiscal/ISO week-year labeling. Fiscal-day
  and week-start requirements currently occur only in the non-normative brief.
- RFC §5 does not define `inLast`, `inCurrent`, or `inPrevious` unit vocabularies,
  rolling-versus-calendar interpretation, inclusivity, future-row handling, or
  the request/execution mechanism for the mandatory explicit anchor.

### Errors, aliases, policy, and safety

- RFC §10 promises a normative error catalog but supplies only
  `UNSUPPORTED_IN_V0` here (plus encoding codes in the existing corpus). Codes,
  exact sentences, pointer rules, alternative ordering, repair shapes, and the
  cost/capability/freshness/timeout/permission codes are missing.
- “All structural errors, then the first semantic error in document order” in
  RFC §10 does not say whether structural errors are batched, how they are
  ordered, or whether object document order means input order, schema traversal,
  or JCS key order.
- RFC §§5 and 10 do not define output-id grammar, namespace uniqueness,
  dimension/metric collision paths, or prototype-sensitive aliases. The brief
  and task require grouping ambiguity and `__proto__` refusal, but the normative
  code/path remains absent.
- RFC §6 does not define catalog/policy/scope wire forms, scope fingerprinting,
  alternatives disclosure order, release-policy vocabulary, minimum-cohort
  suppression shape, channel interaction, or timing side-channel requirements.
  It does determine that empty partitions reveal nothing.
- The no-write, no-native-passthrough, and no-evaluable-language invariants are
  normative, but RFC §10 does not state whether hostile spellings are structural
  errors, unsupported constructs, or distinct safety codes.

### Retrieval, certification, and receipts

- RFC §§4–5 do not enumerate metric/vector encodings, define exact metric
  arithmetic and tie normalization, specify query-vector digest bytes, or give
  the numeric distance tolerance mentioned for exact search. `rrf-v0` is named
  as a fixed formula and constant but neither is provided.
- RFC §§5 and 11 do not define the quality-profile catalog/registration shape,
  recall denominator for fewer-than-k eligible rows, empirical quantile method,
  certification schema/expiry/staleness representation, or precise drift
  triggers. The retrieval README pins a corpus measurement procedure while
  leaving profile thresholds null as required.
- RFC §9 does not define how an adapter proves or counts the eligible set for an
  exact-scan admission limit, whether that check may call the backend, or the
  cost refusal code/remedy schema.
- RFC §7's receipt example uses `pending`, while the stated monotonic chain uses
  `accepted`, `ready`, `failed`, and `superseded` without a transition table.
  The position of `pending`, allowed paths into `superseded`, terminal-state
  behavior, retry/new-version identity, and failed-state query result are open.
- RFC §7 does not define timeout/refusal codes, when wait versus refuse is
  selected, how visibility “to that query” is observed across routes/snapshots,
  how `require` applies to multi-record batches, or canonical names for delete
  visibility states.
- Receipt/token grammar, entropy, scoping, expiry, rotation, encryption, and an
  objective backend-identifier opacity test are not defined. The example's
  `opaque:` prefix is not stated as mandatory.

## Fixture families §11 should name explicitly

The corpus adds or recommends the following because they falsify normative
claims or §12 gates not covered by §11's named family list:

- runtime-owned embedder versus backend-native inference (`security/011`);
- backend-identifier opacity across success, error, explain, provenance, and
  receipts (`security/012`);
- principal/model channel isolation with instrumented host context
  (`security/013`);
- empty-partition scope and forbidden query/write/native/evaluable escape
  hatches (`exact/038`–`039`);
- complete provenance and all three identity vectors, including independent
  `effectivePlanHash` and `executionFingerprint` golden cases once their binding
  serialization is normative;
- byte-fixed `rrf-v0` hybrid fusion after its formula/constant are written;
- catalog-generated teaching/prompt-contract vocabulary and hidden-alternative
  disclosure;
- ingest idempotency, compare-and-swap capability, duplicate delivery, and
  per-record/batch outcome semantics beyond visibility receipts;
- explicit cost, capability, freshness, and unindexed-spec refusal families;
- protocol-equivalence and component-timing harnesses as first-class gates,
  even though they reuse queries rather than needing a second data corpus.
