# Receipt and visibility conformance corpus

These JSON timelines make RFC §7's freshness contract executable without a
wall clock. `step` is a fixture-controlled logical scheduler position. The
runner injects each visibility observation, issues the declared query attempt,
and compares the outcome. It MUST NOT replace steps with sleeps or assume that
a globally ready index is visible to the tested query route.

Each fixture contains the write/delete setup, receipt identity, monotonic state
timeline, query with `afterWrite`, and expected outcomes at named steps. A
success is valid only when every required state for every required record is
visible to that query. A deadline reached first returns a structured timeout as
a normal result. The runner itself must report a conformance failure if an
implementation returns success too early.

The literal `UNDETERMINED_BY_RFC_V0` marks a missing normative field or value;
it is not a runtime code. The sibling assertions remain mandatory. RFC §10 has
not published the timeout/freshness error codes, messages, paths, alternatives,
or remedy schema, so the corpus does not invent them.

Receipt and visibility tokens are treated as uninterpreted bytes by the
runner. The runner may compare equality and pass a token back to its issuing
component, but may not parse it to discover a table, collection, shard, offset,
LSN, document id, or index. File `008` supplies blatant counterexamples; the RFC
still needs a precise opacity test and token grammar.

Files `001`–`004` cover positive, timeout, false-success, and multi-record
`afterWrite`; `005`–`006` cover delete ordering; `007` pins the state-machine
question; `008` covers token opacity; `009` covers an unsupported freshness
tier; `010` covers an embedding migration; and `011` distinguishes global
readiness from visibility to the exact query.
