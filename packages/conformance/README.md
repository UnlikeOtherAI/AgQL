# AgQL conformance runner

`@agql/conformance` turns the independent fixture corpora in the repository's
`conformance/` directory into explicit `pass`, `fail`, `blocked`, and
`undetermined` outcomes. A blocked result always names the missing capability;
an RFC gap is reported separately as undetermined. Neither is a pass.

Run the fast deterministic tier from the repository root:

```sh
pnpm conformance
```

The default runs encoding, exact, security, retrieval reporting, and the
two-adapter portability report. SQLite is provisioned per exact fixture.
PostgreSQL is reported as an adapter skip until a complete live deployment
configuration (roles, namespace, collations, bindings, and connection) is
provided; a URL alone is deliberately insufficient.

Useful selections:

```sh
pnpm conformance --suite encoding
pnpm conformance --suite exact --adapter sqlite
pnpm conformance --suite security --tier fast
pnpm conformance --suite security --seed 91e10da5:42
pnpm conformance:exhaustive
pnpm conformance --json
```

`fast` expands 256 pinned xorshift32 cases for each of the 13 security
matrices. `exhaustive` expands every checked-in case: 260,000 deterministic
executions at the current corpus size. The exhaustive tier is intentionally not
part of `pnpm test`.

Security execution is an injected `SecurityProbeExecutor`: every generated
case carries its seed, index, selected dimensions, expanded setup, and runtime
metadata. A single violation fails its matrix and prints a one-command replay.
Without a live implementation probe driver, matrices are `blocked` after their
deterministic expansions are validated and digested; they are never skipped or
passed.

Approximate retrieval uses an injected `ApproximateRetrievalExecutor`. The
runner enforces eligibility before recall, then emits every per-query recall
and the required mean, median, minimum, p01, p05, p10, and p25 distribution.
Named-profile thresholds remain `null` until cross-adapter measurements exist.

Receipts are deliberately deferred while their visibility contract changes.
The report names all receipt fixture files as deferred coverage and exports the
typed `ReceiptSuiteExtension`. Exact calendar fixtures are explicit blockers at
`CalendarBucketExtension`; no superseded calendar-period representation is
encoded in the runner.
