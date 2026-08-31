# Retrieval conformance corpus

This suite changes the conformance question for approximate retrieval. It does
not require identical neighbours. It requires exact eligibility, a reproducible
ground-truth corpus, recall reported as a distribution, and a versioned quality
certification that is invalidated and re-measured when its inputs drift.

The generated corpus and every fixture are JSON. The one reference generator
is a standalone ECMAScript module in this directory; it has no package manifest,
dependencies, workspace entry, locale input, clock input, or platform-endian
operation.

## Reproducing the corpus

Run `node conformance/retrieval/reference-generator.mjs --check` to verify the
checked-in bytes or use `--write` to regenerate them. The authoritative machine
specification is `generator-spec.json`. In prose, generation is:

1. Initialize a 32-bit unsigned xorshift32 state to hexadecimal `a6c1e57d`.
   The seed is non-zero. Every shift/xor result is reduced modulo 2^32.
2. `nextU32` applies, in order, `x ^= x << 13`, `x ^= x >>> 17`, and
   `x ^= x << 5`, reducing after each operation; the new unsigned state is the
   returned word.
3. Generate 1,024 provisional records in ascending id order `r0000` through
   `r1023`. Consume five selector words, one tenant word, one topic word, then
   eight vector-component words per record. A component is
   `(word modulo 2001) - 1000`, so every component is an exactly representable
   integer in `[-1000,1000]`.
4. Independently sort records by each selector word and stable id. Mark the
   first 512 as `filter50`, first 102 as `filter10`, first 10 as `filter1`, and
   the first 64 under two independent selectors as `sparseA` and `sparseB`.
   Selector words are not emitted.
5. Continue the same PRNG stream to create 64 query vectors, `q000` through
   `q063`, consuming eight component words each.
6. Serialize the fixed property order shown in `generator-spec.json` with two
   ASCII spaces per indent and one final LF. Encode as UTF-8 with no BOM. The
   manifest's SHA-256 is over those exact corpus bytes.

There is no rejection sampling, floating point, host byte order, Unicode
collation, locale sorting, date, or clock in this algorithm. `%` in the
specification means the non-negative remainder of two unsigned integers.

## Fixtures and exact oracle

`fixtures/` declares the ≈50%, 10%, 1%, and sparse-intersection filter
families. Every fixture pins the corpus digest, query template, exact eligible
stable-id list, and exact top-k list for all 64 query vectors. Ground truth is
the descending signed-integer dot product with stable-id ascending as final
tie-break. With eight bounded integer components, every dot product is exactly
representable in the safe interoperable integer range.

For each query, an approximate adapter result first passes zero-tolerance
checks: every id is in `eligibleIds`, every id is unique, the result has no more
than `take` rows, and a sparse result is not padded with ineligible rows. Only
then is recall computed against `exactTopKByQuery`.

For eligible set `E`, requested `k`, exact top set `T` of size
`min(k, |E|)`, and returned id set `R`, `recall@k = |R ∩ T| / |T|`. These
fixtures all have non-empty `T`. Per-query recall values are sorted ascending;
the empirical quantile at probability `p` is element
`floor(p * (n - 1))`. The required report includes count, mean, median, minimum,
and lower-tail p01, p05, p10, and p25. Decimal report values travel as canonical
decimal strings.

`reporting-contract.json` fixes that measurement shape. It intentionally sets
all named-profile thresholds to `null`: RFC §11 requires the first thresholds
to come from cross-adapter measurements, so a number placed here would be a
fabricated product promise. `certification-record.json` fixes the identity and
drift fields a certification must carry. Any corpus, filter configuration,
adapter/binding/index configuration, engine, EmbeddingSpec, or measurement
procedure drift requires re-measurement rather than continued trust.

## Known normative gap

RFC v0 requires an EmbeddingSpec metric but does not enumerate metric names or
their exact arithmetic/tie normalization. `dot-product-descending-int-v1` is
therefore the corpus oracle's measurement metric, not a proposed AgQL catalog
metric spelling. The future normative metric vocabulary must map an equivalent
fixture EmbeddingSpec to these exact rankings or revise the corpus explicitly.
