# AgQL v0 — Normative Contract (DRAFT)

Status: **draft for implementation**. This is the small normative companion to
[brief.md](brief.md), which supplies rationale. Where they disagree, this
document wins for v0. `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.
Backends are identified by capability, never by brand.

---

## 1. Scope and version

v0 defines the kinds and wire forms (§2), identities (§3), catalog (§4), three
single-dataset query modes (§5), policy (§6), ingestion receipts (§7), result
channels (§8), adapter profiles (§9), errors (§10), and conformance (§11).

The only accepted query-language version is the JSON string `"0"`. A numeric
`0`, `"1"`, an omitted version, and every other value are structural errors;
there is no implicit migration. A future language version requires an explicit
translator whose output is then validated as v0. This chooses the version
already named by this RFC; preserved encoding fixtures that said `"1"` were
stale examples, not a second accepted language.

v0 does **not** define query-authored joins or edges, nested queries, `derive`,
`merge`, percentile, rerank pipelines, multi-vector retrieval, materialized
datasets, artifacts, publication, federation, attenuable credential formats,
differential privacy, or derived-policy propagation. Deferral is normative:
these exact reserved probe spellings are recognized before generic
unknown-member validation and refused with `UNSUPPORTED_IN_V0`:

| Deferred construct | Reserved probe location |
|---|---|
| join, edge, derive | `/joins`, `/edges`, `/derive` |
| nested query | `/where/query` |
| merge, artifact | `/mode` values `merge`, `artifact` |
| percentile | `/metrics/<i>/op` value `percentile` |
| rerank, multi-vector | `/search/rerank`, array-valued `/search/using` |
| materialization, publication | `/materialize`, `/publish` |
| federation | array-valued `/from` |
| attenuable credential, DP | `/credential`, `/privacy` |

The spellings reserve only deterministic rejection paths. They do not promise
future syntax. Derived-policy probes use `/derive` and receive the same refusal.

## 2. Kinds and exact scalar semantics

### 2.1 Closed kinds and identifiers

| Kind | Canonical wire form | Rules |
|---|---|---|
| `id` | JSON string | non-empty Unicode scalar sequence, at most 256 UTF-8 bytes; no normalization |
| `boolean` | JSON boolean | no coercion |
| `integer` | JSON integer | `-9007199254740991` through `9007199254740991` inclusive |
| `decimal` | decimal string | §2.2; never a JSON number or binary float |
| `money` | `{ "amount": Decimal, "currency": Currency }` | §2.3 |
| `text` | JSON string | NFC and `unicode-codepoint-v0`, §2.5 |
| `enum` | stable code string | labels are metadata; ordering is code ordering |
| `date` | `YYYY-MM-DD` | Gregorian year `0001` through `9999` |
| `instant` | UTC string | §2.4 |
| `null` | JSON `null` | §2.6 |

JSON strings MUST contain Unicode scalar values: unpaired surrogates are
structural errors. Stable-id ascending order is lexicographic order of the
unmodified UTF-8 bytes; a shorter equal prefix sorts first. This order does not
normalize or locale-fold ids and is also the final retrieval tie-break.

Catalog ids use `[A-Za-z][A-Za-z0-9_]{0,62}`. Vocabulary ids (quality profiles,
transforms, and model ids) use `[a-z][a-z0-9_-]{0,63}`. Capability ids use
`[A-Za-z][A-Za-z0-9_.:@-]{0,127}`. A field id is
`<dataset-id>.<local-id>` with the same grammar for each component. An
EmbeddingSpec id is `<catalog-id>@<positive-decimal-version>`. Output ids use
`[A-Za-z][A-Za-z0-9_]{0,63}`. Output ids share one namespace across dimensions
and metrics and MUST be unique. `__proto__`, `prototype`, and `constructor`
are forbidden as output ids even where a future grammar might otherwise admit
them. Maps MUST be implemented without prototype lookup.

`Scalar` means one canonical value of the table above, including null but
excluding vectors and result-only calendar periods. Within one field, ascending
order is: id by its UTF-8 rule; false before true; integer/decimal by exact
numeric value; money by currency code then exact amount; text/enum by §2.5;
date or instant chronologically; then null last under §2.6. Descending reverses
the non-null relation and still leaves null last. Predicate operands must match
the field kind; money equality includes currency and amount.

### 2.2 Decimal grammar and arithmetic

An input decimal lexical form is
`[+-]?(0|[0-9]+)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, with no whitespace. The
boundary expands the exponent exactly, removes a leading `+`, removes redundant
integer zeros, removes trailing fractional zeros for a variable-scale decimal,
and maps every negative zero to zero. The canonical variable-scale form is
`0` or `-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`; it has no exponent.

A catalog decimal field either declares both `precision` and `scale`, or
neither. Both omitted means variable scale with maximum precision 38. Otherwise
`1 <= precision <= 38` and `0 <= scale <= precision`. A fixed-scale canonical
value has exactly `scale` fractional digits. Boundary normalization MAY remove
only fractional zeros beyond that scale and MUST pad missing fractional zeros;
discarding a non-zero digit is `NUMERIC_SCALE_MISMATCH`, never rounding.
Precision counts digits in the fixed-point unscaled coefficient, ignoring a
sign and redundant leading zeros; zero has precision one. Overflow is
`NUMERIC_OVERFLOW` at the boundary where it occurs. Stored values are validated
at ingest and never deferred until a read.

Arithmetic uses unbounded integer coefficients internally and checks the result
kind only at the operation boundary. No intermediate binary float is permitted.
The result rules are:

| Operation/input | Result |
|---|---|
| `sum(integer)` | integer; overflow if outside the integer endpoints |
| `sum(decimal(p,s))` | `decimal(38,s)`, exact |
| `sum(variable decimal)` | variable decimal, precision 38, exact |
| `avg(integer)` | `decimal(38,9)` |
| `avg(decimal)` | `decimal(38,max(input scale,9))`; variable input uses scale 9 |
| `min`/`max` | input kind and scale |
| `ratio` | `decimal(38,9)` |

`avg` and `ratio` are rounded only when their result scale is exceeded, using
round-to-nearest, ties-to-even. Thus one divided by three is `"0.333333333"`.
There is no implicit integer-to-decimal widening except for `avg` and `ratio`.
This fixed nine-place division rule is deliberately bounded and testable.

### 2.3 Money

Currency codes are the alphabetic codes in ISO 4217:2015, pinned without later
amendments for v0. A later currency-table revision requires a new catalog and
language version; an unknown code is `ENUM_VALUE_INVALID`. A money field either
declares precision and scale under §2.2 plus a non-empty sorted `currencies`
array, or omits all three. The omitted form is variable scale with precision 38
and accepts any code in the pinned table. A declared field scale, not the ISO
minor-unit column, controls wire digits; this permits governed sub-minor-unit
accounting without changing the currency identity.

`sum` and `avg` ignore nulls, then require one currency in each output group.
If more than one remains, execution returns `MONEY_CURRENCY_MIXED` at the metric
path after the backend has computed only authorized per-currency partials. A
`moneyCurrency` dimension explicitly groups by the value's currency and makes
that group single-currency. A separate enum field that happens to contain a
currency code does not prove this property. Same-currency fixed-field `sum`
keeps the field scale and `avg` uses `max(field scale,9)` with ties-to-even.
Variable-field `sum` uses minimal canonical scale and `avg` uses scale 9. `min`
and `max` keep the selected value's canonical scale. A money result always
retains its currency object.

The pinned table and explicit field scale are chosen so a minor-unit database
update cannot silently change old query bytes or arithmetic.

### 2.4 Instants

Catalog precision is `second`, `millisecond`, or `microsecond`. Canonical
instants are respectively `YYYY-MM-DDTHH:mm:ssZ`, the same with exactly three
fractional digits, or exactly six fractional digits. Offsets other than `Z`,
`24:00:00`, leap-second `:60`, invalid Gregorian dates, and a value whose
precision differs from its field are rejected. Comparisons are chronological
over the exact represented instant. An execution anchor accepts any of the
three canonical precisions and is compared without lossy conversion.

### 2.5 Text, enum, and collation

v0 has one collation id: `unicode-codepoint-v0`. It pins Unicode 15.1.0 and
uses no CLDR tailoring. At ingest and query-scalar boundaries text is normalized
to NFC; result text is NFC. Equality, ordering, `contains`, and `startsWith`
then compare Unicode scalar sequences case-sensitively. Ordering is
lexicographic by numeric scalar value, shorter equal prefix first. Enum codes
use the same ordering; declaration order and labels do not participate.

`contains` and `startsWith` treat the needle literally, never as regex, glob,
SQL `LIKE`, or an expression. An empty needle matches every non-null text value.
A null haystack does not match. A null needle is a type error. An adapter that
cannot reproduce this collation returns `COLLATION_UNAVAILABLE`; it MUST NOT
substitute a host or backend locale.

### 2.6 Nulls and aggregates

AgQL predicates are two-valued. `eq` treats two nulls as equal; a null and a
non-null value are unequal, and `ne` is its complement. `in` is the disjunction
of this equality over its values and `notIn` is the complement; their lists may
contain null only for a nullable field. Ordered comparisons and text predicates
are false when either operand is null. `isNull` and `isNotNull` are the direct
tests. Boolean `and`, `or`, and `not` use these two-valued results.

Nulls sort last for both `asc` and `desc`. v0 has no selectable
`NULLS FIRST/LAST` member. `count` counts rows; `countDistinct(field)` excludes
null; `sum`, `avg`, `min`, and `max` eliminate null. Over an empty input,
`count` and `countDistinct` are `0`, while the other aggregates are null. With
no dimensions, an empty input still emits one aggregate group; with dimensions
it emits none. `ratio` is null if either operand is null or the denominator is
zero, and its group is retained. Null dimension values compare equal for
grouping and form one null group.

## 3. Canonicalization, operation context, and identities

### 3.1 Normative schema notation and defaults

The compact schemas in §§3–8 are normative. `T?` means an optional member,
`[T]` an array, `{K:T}` a JSON object map, and `A | B` a discriminated union.
Every listed object is closed: unknown members are structural errors. Required
means present, not inferred. Arrays retain document order unless a rule says
they are set-like. A conforming published JSON Schema MUST accept exactly these
trees; schema-constrained generation is not a substitute for server validation.

v0 query schemas define **no defaults**. Optional absence remains absence; no
member is inserted before `sourceQueryHash`. In particular `take`, record
`select`, aggregate `dimensions`, aggregate `metrics`, and aggregate `order`
are required. Retrieve `select` is optional and means no additional projected
fields: stable id and rank are always present. Catalog default filters are
resolved only into the effective plan. This no-default decision keeps the
source identity independent of catalog state and preserves the published hash
vectors.

Input JSON is decoded strictly: UTF-8, no BOM, no duplicate keys. AgQL-YAML is
YAML 1.2 core only, with no anchors/aliases, merge keys, custom tags, or
multi-document streams. Encoding normalization precedes schema validation.
Decimal and NFC normalization then precede JCS.

### 3.2 Request and operation context

The transport-independent run input is:

```text
RunRequest = {
  query: Query,
  execution: {
    anchor: Instant?,
    pageSize: Integer?,
    pageCursor: Cursor?
  },
  channel: "model" | "principal" | "operator"
}
```

`anchor` is REQUIRED if any relative-time predicate occurs and MUST be absent
otherwise. It is supplied explicitly by the authenticated caller or replay
record; the runtime never fills it from a clock. `pageSize` and `pageCursor`
are execution controls, not query semantics, and do not enter
`sourceQueryHash`. A server-resolved Scope and Policy (§6), selected binding,
and authenticated channel are operation context; a model cannot provide or
widen them.

### 3.3 Canonical bytes and exact hash preimages

The canonical query is RFC 8785 JCS over the structurally valid query after its
field references have been type-bound and its scalar values normalized. A
reference/type refusal therefore has no source hash yet, but catalog version,
policy, and scope never enter this preimage. Reference binding uses the
operation-specific scope-filtered vocabulary; unavailable and unauthorized
references both stop before hashing. `sourceQueryHash` is `"sha256:"`
plus lower-case hexadecimal SHA-256 over those UTF-8 bytes.

`scopeFingerprint` is the same digest form over JCS of the normalized Scope:
capabilities are sorted and deduplicated; partition keys use JCS key order;
each partition array is sorted by the value's kind ordering and deduplicated.
The principal, budgets, and expiry remain in the preimage.

`effectivePlanHash` hashes JCS of exactly:

```json
{"catalogVersion":"…","languageVersion":"0","policyVersion":"…",
 "scopeFingerprint":"sha256:…","sourceQueryHash":"sha256:…"}
```

Catalog and policy versions are immutable content identities; changing either
for any reason requires a new version. This makes their inclusion sufficient to
bind all catalog resolution, default filters, policy expansion, and release
rules without standardizing a backend plan serialization.

`executionFingerprint` hashes JCS of exactly these always-present members
(inapplicable values are JSON null):

```json
{"adapterVersion":"…","anchor":null,"bindingVersion":"…",
 "channel":"model","channelPolicyHash":"sha256:…",
 "effectivePlanHash":"sha256:…","embeddingSpec":null,
 "engineVersion":"…","pageSnapshot":null,"qualityCertification":null,
 "qualityProfile":null,"snapshotOrWatermark":null}
```

For retrieval, `embeddingSpec` is `{id,modelRevision}`; for relative time the
anchor is the exact supplied string. `pageSnapshot` binds the immutable
pagination snapshot. Caches key on `executionFingerprint`; audit stores all
three identities and every preimage member.

`channelPolicyHash` is the §3 digest over JCS of `{channel,datasetPolicy}` after
scope filtering, including the channel's field, embedding, and release entries.
It changes whenever an information-flow decision changes.

## 4. Catalog and calendar schema

The catalog wire shape is:

```text
Catalog = {
  version: String, languageVersion: "0",
  unicodeVersion: "15.1.0", currencyTable: "ISO-4217:2015",
  calendar: Calendar,
  qualityProfiles: [QualityProfile],
  embeddingSpecs: [EmbeddingSpec],
  datasets: [Dataset]
}
Calendar = {
  timezone: TimeZone, timezoneDatabase: "2024a" | "fixed-offset",
  weekStart: Weekday, fiscalDayStart: "HH:mm:ss"
}
Dataset = {
  id: CatalogId, description: NonEmptyString, idField: FieldId,
  profiles: [Profile], fields: [Field],
  embeddings: {CatalogId: EmbeddingSpecId},
  defaultFilters: [Predicate]?, rowScope: RowScope,
  capabilityTags: [CatalogId]
}
RowScope = {kind:"partition", dimensions:[FieldId]}
         | {kind:"none", reason:NonEmptyString}
```

Catalog arrays whose elements have ids MUST have unique ids and are canonical
in id order. Descriptions are required on datasets and fields. `idField` MUST
name a non-null `id` field. Every profile, field reference, embedding reference,
scope dimension, default filter, and source field MUST resolve within the
catalog. Default filters are always conjoined with query `where`; v0 has no
query opt-out.

`Field` has common members `{id, description, kind, nullable}` and exactly the
kind-specific members below:

| Kind | Additional members |
|---|---|
| `decimal` | either no additions (variable, precision 38) or `precision`, `scale` |
| `money` | either `precision`, `scale`, `currencies`, or none for variable money |
| `text` | `normalization:"NFC"`, `collation:"unicode-codepoint-v0"` |
| `enum` | `values:[{code, label}]`, unique codes |
| `instant` | `precision:"second"|"millisecond"|"microsecond"` |
| all others | none |

An EmbeddingSpec is closed and exact:

```text
EmbeddingSpec = {
  id: EmbeddingSpecId, sourceFields: [FieldId],
  inputTransform: VocabularyId,
  model: {id: VocabularyId, revision: NonEmptyString},
  dimension: Integer, metric: "cosine" | "dotProduct" | "squaredEuclidean",
  vectorEncoding: "float32", chunking: "none",
  privacyClass: "public" | "internal" | "restricted"
}
```

`dimension` is 1 through 4096. Model revision is its strongest immutable
provider identifier; a marketing name is invalid. The runtime alone generates
embeddings and supplies vectors to adapters. A model revision change creates a
new EmbeddingSpec id/version.

### 4.1 Calendar periods

`TimeZone` is `UTC`, an IANA name present in tzdb 2024a, or a fixed offset
`+HH:MM`/`-HH:MM`. IANA names require `timezoneDatabase:"2024a"`; UTC or a
fixed offset may use `fixed-offset`. A deployment lacking the pinned data
refuses `CALENDAR_UNAVAILABLE`, never substitutes newer local tzdb data.

`Weekday` is `monday` through `sunday`. Supported grains are `day`,
`fiscalDay`, `week`, `month`, `quarter`, and `year`. A bucket value is:

```text
CalendarPeriod = {
  start: Instant, endExclusive: Instant, timezone: TimeZone,
  grain: Grain, label: String
}
```

The boundary instants use the smallest precision needed, normally seconds,
and define a half-open interval. Labels are `YYYY-MM-DD` for day/fiscalDay,
`YYYY-Www` for week, `YYYY-MM` for month, `YYYY-Qn` for quarter, and `YYYY`
for year. Week 1 is the declared-week-start period containing at least four
days of the new calendar year; its `YYYY` is that week-year. This generalizes
ISO week numbering without consulting locale.

Calendar periods order by `start`, then `endExclusive`, then timezone, grain,
and label under §2.5. In a well-formed time-bucket dimension the first key alone
distinguishes buckets; the remaining keys make the result relation total.

A civil day begins at local midnight. A fiscal day begins at the catalog's
`fiscalDayStart` and its label is the local date on which that start occurs.
Week boundaries use `weekStart` and `fiscalDayStart`; month, quarter, and year
boundaries use `fiscalDayStart`. Each next boundary is computed in civil time,
not by adding elapsed hours. If a boundary local time is nonexistent, use the
first valid instant after the gap; if repeated, use the earlier instant.
Records are instants, so both occurrences of a repeated local time remain
distinct and appear exactly once.

The 2024a pin was selected because the v0 corpus is dated in 2024; freezing a
known dataset is more reproducible than following the host's current tzdb.

## 5. Query schema and semantics

### 5.1 Closed query grammar

```text
RecordsQuery = {
  version:"0", mode:"records", from:DatasetId,
  select:[FieldId], where:Predicate?, order:[Order],
  afterWrite:AfterWrite?, take:Integer
}
AggregateQuery = {
  version:"0", mode:"aggregate", from:DatasetId,
  where:Predicate?, dimensions:[Dimension], metrics:[Metric],
  having:Having?, order:[Order], afterWrite:AfterWrite?, take:Integer
}
RetrieveQuery = {
  version:"0", mode:"retrieve", from:DatasetId,
  select:[FieldId]?, where:Predicate?, search:Search,
  afterWrite:AfterWrite?, take:Integer
}
Query = RecordsQuery | AggregateQuery | RetrieveQuery
Order = {by:FieldId|OutputId, dir:"asc"|"desc"}
```

`records.select` is non-empty. Retrieve always emits stable id and `rank`; its
optional `select` adds fields and MUST NOT repeat the id field. Aggregate output
is its dimensions and metrics. A field/output reference is matched only against
the scope-filtered catalog/namespace appropriate to that position.

Predicates are the following closed union:

```text
{kind:"predicate", field:FieldId,
 op:"eq"|"ne"|"lt"|"lte"|"gt"|"gte", value:Scalar}
{kind:"predicate", field:FieldId, op:"in"|"notIn", values:[Scalar]}
{kind:"predicate", field:FieldId, op:"isNull"|"isNotNull"}
{kind:"predicate", field:FieldId, op:"contains"|"startsWith", value:Text}
{kind:"range", field:FieldId, start:Scalar, endExclusive:Scalar}
{kind:"predicate", field:InstantField,
 op:"inLast", amount:PositiveInteger, unit:RelativeUnit}
{kind:"predicate", field:InstantField,
 op:"inCurrent"|"inPrevious", unit:CalendarUnit}
{kind:"and"|"or", items:[Predicate]}
{kind:"not", item:Predicate}
```

`range` is exactly `field >= start AND field < endExclusive`; null is false,
and start MUST compare below end. This is the half-open range construct named
by conformance. Adapters MUST NOT replace an explicit `gte`/`lt` pair with a
backend `BETWEEN` whose upper bound is inclusive.

`RelativeUnit` is `second`, `minute`, `hour`, `day`, `week`, `month`,
`quarter`, or `year`; `CalendarUnit` is `day`, `fiscalDay`, `week`, `month`,
`quarter`, or `year`. `inLast` is a rolling interval ending at the anchor:
`[anchor - amount*unit, anchor]`, both endpoints included, and future rows are
excluded. Seconds/minutes/hours subtract elapsed SI time; larger units subtract
civil calendar units in the catalog timezone while preserving local time,
clamping an unavailable day-of-month to that month's last day, and using §4.1
gap/repeat resolution. One week is seven civil days and one quarter is three
civil months. `inCurrent` selects the anchor's entire
calendar period and `inPrevious` the immediately preceding one, both as
`[start,endExclusive)`. The compiler records the anchor and expanded UTC
boundaries in plan audit data and the anchor in result provenance.

### 5.2 Ordering, aliases, and pagination

Records ordering is total. If the final explicit order item is not the dataset
id field, the engine appends that field ascending. If the id field occurs
earlier, compilation refuses rather than creating contradictory duplicates.
An explicitly final id direction is honored. The implicit ascending decision
is stable across all modes and is part of the effective plan.

Aggregate order references the single shared output namespace. The engine
appends every dimension id not already present, in declaration order,
ascending; an identical dimension tuple denotes one group. Retrieve order is
metric rank followed by stable id ascending and has no user `order` member.
Nulls obey §2.6.

Cursor pagination is available only on the separately authenticated principal
channel. `take` is the maximum number of logical results for the whole query,
not a per-page escape from the bound. `pageSize` defaults at execution to
`min(take,100)` and must be 1 through 100. The first page has no cursor. If more
of the bounded result remains, it returns a cursor; the next request supplies
the identical query and that cursor.

A cursor is an opaque `cursor:<base64url-no-padding>` string of 8 through 512
encoded characters. It binds issuer, principal channel, source/effective plan
hashes, scope fingerprint, execution fingerprint inputs, total order key,
emitted count, `take`, and a request/transaction/historical snapshot. Its
maximum lifetime is 15 minutes. A server MUST refuse before returning page one
if it cannot preserve one of those snapshot tiers for all pages. Cursor
mismatch, expiry, and unavailable snapshot use the catalog in §10; an invalid
cursor never restarts at page one. Concatenated pages therefore equal the
one-shot bounded result without skip or duplication under concurrent writes.
Model responses never contain a cursor. Cursor issuance and stateless payloads
obey the entropy, AEAD, rotation, one-layer decoding, and canary rules of §7.2.

### 5.3 Aggregate grammar

```text
Dimension = {kind:"field", field:FieldId, id:OutputId}
          | {kind:"timeBucket", field:InstantField, grain:Grain, id:OutputId}
          | {kind:"moneyCurrency", field:MoneyField, id:OutputId}
Metric = {id:OutputId, op:"count", where:Predicate?}
       | {id:OutputId, op:"countDistinct"|"sum"|"avg"|"min"|"max",
          field:FieldId, where:Predicate?}
       | {id:OutputId, op:"ratio", numerator:OutputId, denominator:OutputId}
Having = predicate tree whose leaves use `metric:OutputId` instead of `field`
```

Ratio operands MUST name earlier non-ratio numeric metrics. Each operand uses
its own metric filter; no filter is copied or aligned implicitly. Both are
computed over the same base `where`, scope, and dimension group, then §2.2 and
§2.6 apply. Output-id collisions are reported at the later declaration, so a
dimension/metric collision points at the metric id.

### 5.4 Retrieval grammar, vectors, and fusion

```text
Search = {kind:"semantic", using:EmbeddingSpecId, text:Text,
          accuracy:"exact"|"approximate", quality:QualityProfileId}
       | {kind:"hybrid",
          semantic:{using:EmbeddingSpecId,text:Text,accuracy:"approximate"},
          lexical:{field:TextFieldId,text:Text},
          fusion:"rrf-v0", quality:QualityProfileId}
```

There is no `topK`, index name, physical knob, vector literal, native score, or
backend inference. `take` is the requested k. Scope and query predicates define
the eligible set before rank. Results never pad with ineligible rows.
`exact-oracle-v0` is the only legal quality id with `accuracy:"exact"` and is a
built-in declaration, not a recall profile. Approximate quality ids MUST resolve
to a catalog `QualityProfile`.

`vectorEncoding:"float32"` means each runtime vector component is rounded once
to IEEE 754 binary32, round-to-nearest ties-to-even; NaN and infinities are
invalid and negative zero is normalized to positive zero. The query-vector
digest is SHA-256 over ASCII `agql-vector-f32le-v0` followed by one NUL byte,
the dimension as an unsigned 32-bit big-endian integer, then components in
index order as IEEE 754 little-endian bytes. This digest, not a JSON rendering,
appears in provenance.

Reference metric ordering is exact over the decoded binary32 dyadic rationals:

- `dotProduct`: larger exact dot product first;
- `squaredEuclidean`: smaller exact sum of squared differences first;
- `cosine`: larger exact `dot/(|q||v|)` first; zero vectors are invalid, and
  comparison is performed by sign plus squared rational cross-products, not a
  rounded square root.

Equal reference values tie by stable id ascending. An adapter's normalized
diagnostic distance, where inspected by conformance, must differ from the
reference by no more than `max(0.000001, abs(reference)*0.000001)`. Tolerance
never permits different membership or order for exact retrieval.

`rrf-v0` uses rank starting at one and constant 60:
`score(d) = sum(channel in {semantic,lexical}) 1/(60 + rank_channel(d))`;
missing documents contribute zero. Each input is truncated to
`min(4*take,400)` eligible rows. Scores are compared as exact rational numbers,
then stable id ascending. The result is truncated to `take`. This fixes fusion
bytes while allowing the two approximate input rankers to differ.

### 5.5 Structural constants

These are spec maxima. A deployment may advertise and enforce a lower value,
never a higher one; lowering is bound into policy/binding identity and returns
a repairable limit refusal, never truncation.

| Constant | v0 maximum | Rationale |
|---|---:|---|
| decoded query UTF-8 bytes | 65,536 | bounds parser and hash work |
| JSON tree depth | 32 | blocks pathological containers |
| predicate nodes (`where` or `having`) | 64 | bounds compile/backend expression size |
| boolean nesting | 2 below the root boolean node | keeps generated logic reviewable |
| `and`/`or` items | 16 | bounds fan-out |
| `in`/`notIn` values | 100 | avoids parameter/query explosions |
| selected fields | 64 | bounds result width |
| dimensions | 16 | bounds grouping width |
| metrics | 32 | bounds aggregate work and result width |
| order items before implicit keys | 16 | bounds sort vocabulary |
| records/aggregate `take` | 1,000 | bounds exact result materialization |
| retrieval `take` | 100 | bounds candidate and fusion work |
| text predicate/search UTF-8 bytes | 4,096 | bounds parameter and embedding input |
| `afterWrite.require` entries | 32 | bounds visibility fan-out |
| `afterWrite.timeoutMs` | 1 through 30,000 | avoids unbounded request occupancy |

Predicate-node count includes every leaf and boolean node. Boolean root depth is
zero; each boolean child increments it, while a leaf does not. Structural tree
depth counts root as one and every array/object child edge. Limits are checked
after encoding normalization and before catalog/policy semantics.

## 6. Scope, policy, release, and disclosure

### 6.1 Wire schemas and fingerprinting

Scope is server-resolved and closed:

```text
Scope = {
  version:"0", principal:NonEmptyString,
  capabilities:[CapabilityId], partitions:{FieldId:[Scalar]},
  budgets:{queries:PositiveInteger, rows:PositiveInteger,
           intermediateBytes:PositiveInteger,
           exactEligibleRecords:PositiveInteger},
  expiresAt:Instant
}
```

Capabilities and partition values are sets and canonicalize as §3.3 states.
Every partition dimension declared by the dataset MUST appear. An empty array
means an unsatisfiable scope and therefore no visible rows, never all rows.
Extra dimensions do not widen scope and are rejected. Expired scope is refused
before catalog disclosure or backend access.

Policy is:

```text
Policy = {version:String, datasets:{DatasetId:DatasetPolicy}}
DatasetPolicy = {
  visible:Boolean,
  fields:{FieldId:{model:FieldOps,principal:FieldOps,operator:FieldOps}},
  embeddings:{EmbeddingSpecId:{model:Boolean,principal:Boolean,operator:Boolean}},
  release:{model:[ReleasePolicy],principal:[ReleasePolicy],operator:[ReleasePolicy]}
}
FieldOps = {select:Boolean,filter:Boolean,group:Boolean,order:Boolean,
            aggregate:["count"|"countDistinct"|"sum"|"avg"|"min"|"max"],
            lexicalSearch:Boolean}
ReleasePolicy = {kind:"minimumCohort", minimum:Integer}
```

`minimum` is 2 through 1,000,000. Every dataset, field, channel, and operation
entry is explicit; there is no inheritance between channels. Semantic search
permission is on EmbeddingSpecs. An embedding inherits the most restrictive
source-field search permission unless an explicit reviewed policy entry grants
it; the review is part of the immutable policy version.

Release arrays contain at most one `minimumCohort` in v0. If independently
composed policy layers contribute several before normalization, the immutable
resolved Policy retains only their maximum; that effective value is the result
envelope's `minimumCohort`, or null when absent.

### 6.2 Evaluation and channel interaction

Dataset visibility, scope, every field operation, embedding search, budgets,
and release policy are evaluated before backend compilation. Scope predicates
are mandatory pushdown. No logical content from an ineligible row may cross the
backend/adapter trust boundary; internal traversal of an ineligible index node
is allowed.

A query is compiled for exactly one authenticated channel. Filtering a field
requires `filter`; dimension use requires `group`; ordering requires `order`;
projection requires `select`; each aggregate requires its named permission;
lexical and semantic channels require their separate permissions. Principal
execution is a new authenticated operation and re-evaluates the same query; it
does not inherit a model compile. Operator has no implicit principal rights.

`minimumCohort` applies to aggregate groups after metric computation and before
channel release, using the distinct stable records contributing to the group.
A group below the minimum is omitted as a whole. The envelope reports only
`suppressed:true`; it reports neither suppressed group count nor cohort size.
The policy is an inference dampener, not differential privacy.

An unauthorized and a nonexistent reference use byte-identical
`REFERENCE_NOT_AVAILABLE` results. Paths identify only the syntactic slot, and
alternatives contain only ids visible for that operation/channel/scope. Model
and principal result/error envelopes contain no component timing. Operator
timings are optional, require explicit operator authorization, and MUST NOT
contain physical names. Implementations SHOULD use the same validation path for
hidden and nonexistent references; response latency itself is not an AgQL
semantic value.

A false field or EmbeddingSpec operation permission removes that id from the
operation-specific vocabulary and therefore uses `REFERENCE_NOT_AVAILABLE`,
not `POLICY_DENIED`. `POLICY_DENIED` is limited to non-reference actions whose
logical existence the caller already knows; it never distinguishes a hidden
catalog member from a nonexistent one.

`principalResultAvailable` is computed only from authenticated host capability
and whether principal policy could expose an additional channel. It MUST NOT
depend on row existence, count, suppression, or hidden catalog membership.

## 7. Ingestion, receipt states, and freshness

Ingest is a separate, non-query contract. Its operations are `insertOnly`,
whole-record `replace`, and `delete`, with stable ids, a required idempotency
key, per-record outcomes, and one batch receipt. `ifVersion` compare-and-swap is
a declared canonical-store capability. No update operator, expression, query,
or `merge` is reachable from ingest; no mutation is reachable from Query.

### 7.1 Receipt wire form and state machine

```text
WriteReceipt = {
  receipt:ReceiptToken, operation:"insertOnly"|"replace"|"delete",
  issuedAt:Instant, expiresAt:Instant,
  records:[{id:Id, version:Integer,
            visibility:{Representation:Visibility}}]
}
Visibility = {state:"accepted"|"pending"|"ready"|"failed"|"superseded",
              token:VisibilityToken?, failureCode:String?}
Representation = "record" | "lexical" | "embedding:" + EmbeddingSpecId
AfterWrite = {receipt:ReceiptToken, require:[Representation], timeoutMs:Integer}
```

`require` is non-empty, unique, and preserves input order in the source hash;
observation and error lists sort first by stable record id and then by
representation under §2.5.

`token` is present only for `ready`; `failureCode` only for `failed`.
State identity is `(receipt, record id, record version, representation)`. The
only valid transitions are:

| From | To |
|---|---|
| `accepted` | `pending`, `ready`, `failed`, `superseded` |
| `pending` | `ready`, `failed`, `superseded` |
| `ready` | `superseded` |
| `failed` | `superseded` |
| `superseded` | none |

`accepted` means the durable write/outbox accepted responsibility; `pending`
means representation work has been scheduled or started. Neither satisfies a
query. `ready` and `failed` are terminal outcomes for that generation except
that a newer version may mark either `superseded`; `superseded` is terminal.
Internal retry stays `pending`. Once exposed as `failed`, the same idempotency
key and receipt return the same failure. A caller retry that may create work
uses a new idempotency key and therefore a new receipt/version; states never
revive.

For delete receipts the same representation names mean absence is visible:
ready `record` means no records query returns the version; ready `lexical` or
`embedding:<spec>` means that representation cannot return it. No separate,
backend-shaped delete-state vocabulary exists.

### 7.2 Token requirements

Receipt tokens use `wr_<base64url-no-padding>` and visibility tokens use
`opaque:<base64url-no-padding>`, each with 8 through 512 encoded characters.
Production issuance MUST draw at least 128 unpredictable bits from a CSPRNG.
Tokens bind server-side to issuer, catalog/source, dataset, operation, record
versions, authenticated principal authority, and the write scope; they are
invalid under a wider or unrelated query scope. Receipt expiry is explicit and
no more than 24 hours after issue. Rotation MUST keep an issued token usable
until its expiry or return `RECEIPT_EXPIRED`; it may not silently reinterpret it.

An opaque token is either a random lookup handle or an authenticated-encrypted
payload. If stateless, it MUST use an AEAD construction with a rotating key and
at least 128-bit authentication; encoding, signing, or obfuscation alone is not
encryption. No token may contain a backend identifier, dialect, table,
collection, index, shard, host, offset, LSN, or native URI in plaintext or in a
single hex/base64/base64url decoding. Conformance injects canaries in each such
identifier and fails if the canary appears in the token, any one-layer decode,
or any agent-facing surface. Tokens are otherwise uninterpreted outside their
issuer.

### 7.3 Wait, refuse, timeout, and visibility observation

The engine selects the binding/route/snapshot first, then checks every required
representation for every record in the batch **through the same query-visible
route**. A global control-plane watermark, primary route, or batch-ready bit is
not proof. Required observation tokens and route/snapshot identity enter the
execution fingerprint.

Selection is deterministic:

1. malformed, expired, wrong-scope, or mismatched receipts refuse immediately;
2. a binding not certified for `afterWrite` returns `FRESHNESS_UNAVAILABLE`;
3. a required representation absent from the receipt/catalog or an unindexed
   EmbeddingSpec returns `EMBEDDING_UNINDEXED` or `FRESHNESS_UNAVAILABLE`;
4. required `failed` or `superseded` states refuse immediately with their
   receipt code;
5. only `accepted`/`pending` on a certified route waits; all requirements ready
   succeeds, otherwise the deadline returns `AFTER_WRITE_TIMEOUT`.

Timeout is a normal structured result, never a transport failure. A query may
not downgrade accuracy, EmbeddingSpec, route, scope, or freshness while waiting.
During migration a `spec@2` requirement never accepts `spec@1`. Success before
all states for all batch records are query-visible is a conformance failure.

## 8. Result channels and canonical envelopes

### 8.1 Success envelope

Every successful data-plane result has exactly:

```text
Success = {
  version:"0", status:"success", mode:"records"|"aggregate"|"retrieve",
  channel:"model"|"principal"|"operator",
  schema:[ResultColumn],
  data:{rows:[ResultRow]} | {groups:[ResultRow]},
  page:{returned:Integer,truncated:Boolean,nextCursor:Cursor|null},
  determinism:{semantics:"exact"|"approximate",
    writeVisibility:"unconstrained"|"afterWrite",
    executionSnapshot:"none"|"request"|"transaction"|"historicalPinned",
    replay:"auditable"|"reevaluable"|"exactReplay"},
  provenance:Provenance,
  release:{minimumCohort:Integer|null,suppressed:Boolean},
  principalResultAvailable:Boolean,
  timings:{auth:Integer,validationPolicy:Integer,queryEmbedding:Integer,
           adapterCompile:Integer,backend:Integer,fusionRelease:Integer}|null
}
ResultColumn = {id:String,kind:Kind|"calendarPeriod"|"rank",nullable:Boolean,
                precision:Integer|null,scale:Integer|null}
```

Every listed member is present; JSON null is used only where shown. Result rows
are closed objects containing exactly the schema ids. Records and aggregate
rows preserve total query order; retrieval rows additionally carry one-based
integer `rank`. Raw scores/distances never appear. Model data is capped at
`min(take,20)` rows/groups and `nextCursor` is null. Principal data uses §5.2
pagination. Operator data is capped at `min(take,100)` and has no cursor.
`truncated` is true exactly when additional results within the query's bounded
`take` were omitted from this channel/page. Suppression can make it true without
revealing a count.

`Provenance` is closed and always contains:

```text
{
  sourceQueryHash, effectivePlanHash, executionFingerprint,
  catalogVersion, policyVersion, bindingVersion, adapterVersion, engineVersion,
  scopeFingerprint, anchor:Instant|null, snapshotOrWatermark:String|null,
  afterWrite:{receipt:ReceiptToken,require:[Representation],
              observed:[{recordId:Id,representation:Representation,
                         token:VisibilityToken}]}|null,
  retrieval:{embeddingSpec,modelRevision,metric,queryVectorDigest,
             qualityProfile,qualityCertification,indexWatermark,
             fusion:"rrf-v0"|null}|null,
  replayTier
}
```

All hashes use §3. `qualityCertification` is a certification reference or null
only for exact retrieval; approximate retrieval always carries a reference,
including one whose status is `measurementRequired` or `stale`.

Principal results are served only by a separately authenticated endpoint and
MUST never appear in a model payload. `principalResultAvailable` is
non-authoritative under §6.2, is false outside the model channel, and is never a
bearer handle. `timings` is null on model/principal channels. It MAY be populated
with non-negative integer milliseconds on the operator channel, which contains
no result data unless operator policy authorizes it.

### 8.2 Refusal and timeout envelopes

```text
Refusal = {version:"0",status:"refused",channel:Channel,
           errors:[Error],identities:{sourceQueryHash:String|null,
                                     effectivePlanHash:String|null}}
Timeout = {version:"0",status:"timeout",channel:Channel,
           errors:[Error],identities:{sourceQueryHash:String,
                                     effectivePlanHash:String}}
```

These objects have no schema, data, page, determinism, release, principal
availability, or timings. Structural refusal may have multiple errors; semantic
refusal and timeout have exactly one. An identity is null until its validation
stage has completed. Transport profiles wrap but do not alter these objects.

## 9. Capability profiles, retrieval quality, and adapters

Profiles are `records.v0`, `aggregate.v0`, `retrieve.semantic.v0`,
`retrieve.hybrid.v0`, `ingest.canonical.v0`, and `retrieval-index.v0`. A query
is portable between sources iff both advertise the required profile and every
required capability. Declining is conformant; silent downgrade is not.

Adapters receive a resolved, typed, scope-expanded logical plan, never the model
AST. Model scalars use native parameters/typed API values; physical identifiers
come only from binding/catalog resolution. Adapters have hard row/candidate
limits and read-only query credentials. Bounded compensation is limited to
projection/redaction, canonical scalar conversion, total tie ordering over a
bounded result, `rrf-v0`, and exact distance-convention normalization. There is
no engine-side authorization filtering, join, grouping, or vector search.

### 9.1 Exact-scan admission

A binding advertising exact retrieval declares
`exactEligibleSetMaximum` from 1 through the scope budget maximum. Admission
counts distinct stable ids after scope, default filters, and query `where`, but
before vector distance and `take`. The adapter may issue one pushed-down scalar
count query; no row payload may cross the trust boundary, and vector search does
not run if the count exceeds the limit. Unknown/unprovable counts are refused,
not guessed below the limit. Exceeding either binding or scope limit returns
`EXACT_SCAN_LIMIT_EXCEEDED` at `/search/accuracy` with narrowing and explicit
approximate-request remedies.

### 9.2 Quality profiles and certification

```text
QualityProfile = {
  id:VocabularyId, searchKinds:["semantic"|"hybrid"],
  measurementProcedure:"recall-at-k-distribution-v1",
  thresholds:null | {mean:Decimal,median:Decimal,minimum:Decimal,
                     p01:Decimal,p05:Decimal,p10:Decimal,p25:Decimal},
  certificationMaxAgeDays:Integer
}
```

`certificationMaxAgeDays` is 1 through 30. `thresholds:null` means the profile
is measurement-only and its certification status is `measurementRequired`; it
is not a claimed recall floor. v0's initial `baseline-unset-v0` has null
thresholds. Values MUST remain null until the first common corpus has been run
across adapters. This is the one intentional open product value: inventing a
threshold before measurement would create a false conformance promise.

For eligible ids `E`, requested `k`, exact top set `T` of size
`min(k,|E|)`, and returned eligible ids `R`, recall is `|R intersect T|/|T|`.
If `T` is empty, the query is reported separately as `emptyEligible` and is not
assigned a numeric recall; it still must return no ids. Missing approximate
results count as zero relevant returned, not as omitted samples. Sort per-query
recalls ascending; empirical quantile `p` is element
`floor(p*(n-1))`. Reports include every per-query value, count, mean, median,
minimum, p01, p05, p10, and p25 using §2.2 division rules.

The certification and result reference schemas are:

```text
QualityCertification = {
  certificationId:String, version:String,
  corpus:{manifestPath:String,corpusSha256:Hash,oracleFixtureSha256:Hash},
  configuration:{adapterId:String,adapterVersion:String,bindingVersion:String,
    engineVersion:String,embeddingSpec:{id:EmbeddingSpecId,modelRevision:String},
    indexConfigurationDigest:Hash,dataDistributionDigest:Hash,
    filterFamily:String,qualityProfile:VocabularyId,
    measurementProcedure:"recall-at-k-distribution-v1"},
  measurement:{measuredAt:Instant,expiresAt:Instant,queryCount:Integer,k:Integer,
    eligibilityViolations:0,report:{perQuery:[{queryId:String,k:Integer,
      exactRelevantCount:Integer,returnedEligibleCount:Integer,
      relevantReturnedCount:Integer,recall:Decimal|"emptyEligible"}],
      sampleCount:Integer,mean:Decimal,median:Decimal,minimum:Decimal,
      p01:Decimal,p05:Decimal,p10:Decimal,p25:Decimal}},
  thresholds:QualityProfile.thresholds,
  status:"valid"|"stale"|"measurementRequired"
}
QualityCertificationRef = {certificationId:String,version:String,
                           status:"valid"|"stale"|"measurementRequired"}
```

A certification contains id/version; corpus and oracle digests; adapter,
binding, engine, EmbeddingSpec/model revision, index-configuration,
filter-family, quality-profile, measurement-procedure, and data-distribution
digests; measuredAt/expiresAt; k/query count; zero eligibility violations; full
report; thresholds; and status `valid`, `stale`, or `measurementRequired`.
Expiry or any change to a bound digest/version/profile/procedure makes it stale.
Any index watermark or data distribution not explicitly covered by its bound
digest/range also makes it stale; v0 defines no unmeasured drift tolerance.
Stale status remains visible and triggers remeasurement, never silent trust.

Canonical-store and retrieval bindings may be separate; the runtime durable
outbox and embedding worker connect them. Runtime embedding authority and
receipt visibility are unchanged by that split.

## 10. Normative error catalog

### 10.1 Error object, selection, paths, and alternatives

```text
Error = {code:String,message:String,path:JsonPointer,
         alternatives:[String],remedy:Remedy|null}
Remedy = {action:String, details:{String:Scalar|[Scalar]}}
```

Every member is present. `path` is an RFC 6901 pointer into the normalized input
and is `""` only when no JSON tree/location exists (encoding/document errors).
Messages below are exact sentences; templates substitute only non-secret
numbers or ids already present in the request. Alternatives are always an array.
Catalog/enum/output alternatives sort by `unicode-codepoint-v0`; remedy phrases
use the fixed table order. Structural legal-member alternatives use schema
traversal order. Hidden or unauthorized items are never included.

Validation has two phases. Structural validation batches **all** structural
errors in one `Refusal`. It traverses members in this schema order:
`version`, `mode`, `from`, `select`, `where`, `dimensions`, `metrics`, `having`,
`search`, `order`, `afterWrite`, `take`, then mode-specific remaining members;
arrays are ascending index, nested objects use their schema order, and unknown
members sort by Unicode code point after known members at that object. Error
order is traversal order. Object insertion order and JCS key order do not
participate. No semantic work or backend call occurs when structural errors
exist.

Before that batch, a closed pre-scan recognizes only the reserved deferred and
safety probe locations in §§1 and 10.3. If present, the first such location in
schema traversal returns its single normative refusal and suppresses unrelated
required/unknown-member errors. This makes `mode:delete`, `rawSql`, and reserved
future spellings fail for the invariant they test, not incidental schema shape.

After structural success, semantic validation uses the same traversal and
returns exactly the first semantic error. Reserved deferred/safety probes are
otherwise not accepted syntax. Runtime refusals and timeouts each return one
error.

### 10.2 Structural and reference codes

| Code | Exact message | Required path/alternatives |
|---|---|---|
| `ENCODING_ANCHOR_FORBIDDEN` | `AgQL-YAML anchors and aliases are forbidden.` | `""`; one plain-value repair phrase |
| `ENCODING_MERGE_KEY_FORBIDDEN` | `AgQL-YAML merge keys are forbidden.` | `""`; one plain-mapping repair phrase |
| `ENCODING_DUPLICATE_KEY` | `The input contains a duplicate object key.` | `""`; one unique-key repair phrase |
| `ENCODING_MULTIDOC_FORBIDDEN` | `AgQL accepts exactly one document.` | `""`; one single-document repair phrase |
| `ENCODING_TAG_FORBIDDEN` | `AgQL-YAML custom tags are forbidden.` | `""`; one core-scalar repair phrase |
| `SCHEMA_REQUIRED_MEMBER` | `A required member is missing.` | missing member pointer; expected member |
| `SCHEMA_UNKNOWN_MEMBER` | `This member is not part of the AgQL v0 schema.` | member pointer; visible legal member names |
| `SCHEMA_TYPE_MISMATCH` | `The value has the wrong JSON type.` | value pointer; expected type phrase |
| `SCHEMA_INVALID_VALUE` | `The value is not in the closed AgQL v0 vocabulary.` | value pointer; legal values |
| `VERSION_UNSUPPORTED` | `The query language version is not supported.` | `/version`; `["0"]` |
| `STRUCTURAL_LIMIT_EXCEEDED` | `The request exceeds an AgQL v0 structural limit.` | limited container; lower-limit phrase |
| `LIMIT_OUT_OF_RANGE` | `The bounded integer is outside the permitted range.` | integer pointer; permitted range phrase |
| `REFERENCE_NOT_AVAILABLE` | `The referenced catalog item is not available in this scope.` | syntactic reference pointer; visible legal ids |
| `ENUM_VALUE_INVALID` | `The value is not a declared enum code.` | scalar pointer; visible enum codes |
| `OUTPUT_ID_INVALID` | `The output id does not use the AgQL v0 safe identifier grammar.` | id pointer; grammar phrase |
| `OUTPUT_ID_COLLISION` | `The output id is already used by another dimension or metric.` | later id pointer; unique-id phrase |

The version type alternative is `Use the JSON string "0".`; top-level select
and order alternatives are `Use a JSON array of field ids.` and `Use a JSON
array of order items.`. Other type alternatives are `Use a JSON <type>.`, where
`<type>` is exactly `string`, `boolean`, `integer`, `array`, or `object`; a
discriminated object uses `Use one closed <SchemaName> object.`. A string version
other than `"0"` is `VERSION_UNSUPPORTED`; a non-string is the earlier type
error. Output-id alternatives are exactly `Choose an id matching
[A-Za-z][A-Za-z0-9_]{0,63} and not reserved by v0.` or, for collision, `Choose
a unique output id matching [A-Za-z][A-Za-z0-9_]{0,63}.`.

For all encoding codes the single alternative is respectively: `Inline the
value without anchors or aliases.`, `Write every mapping member explicitly.`,
`Keep exactly one occurrence of each key.`, `Submit one document.`, or `Use a
YAML 1.2 core scalar without a tag.`

`REFERENCE_NOT_AVAILABLE` never includes the submitted reference in its message.
Thus hidden/nonexistent dataset errors at `/from`, and hidden/nonexistent field
errors at the same field slot, are JCS-byte-identical.

### 10.3 Scalar, calendar, policy, and safety codes

| Code | Exact message | Remedy/alternatives rule |
|---|---|---|
| `NUMERIC_SCALE_MISMATCH` | `The decimal has non-zero digits beyond the declared scale.` | declared scale phrase |
| `NUMERIC_OVERFLOW` | `The exact numeric result exceeds the declared precision or integer range.` | narrower-value phrase |
| `INSTANT_PRECISION_MISMATCH` | `The instant does not use the field's declared precision.` | required precision |
| `COLLATION_UNAVAILABLE` | `The source cannot reproduce the catalog's pinned collation.` | source/profile change remedy |
| `CALENDAR_UNAVAILABLE` | `The source cannot reproduce the catalog's pinned calendar data.` | source/profile change remedy |
| `MONEY_CURRENCY_MIXED` | `The money aggregate contains more than one currency.` | add `moneyCurrency` dimension phrase |
| `POLICY_DENIED` | `The requested operation is not permitted in this channel.` | permitted operations visible in scope |
| `SCOPE_INVALID` | `The resolved scope cannot be applied to this dataset.` | obtain corrected scope |
| `SCOPE_EXPIRED` | `The resolved scope has expired.` | obtain a fresh scope |
| `QUERY_WRITE_FORBIDDEN` | `The AgQL Query Core cannot perform writes.` | `Use the separate Ingest contract.` |
| `NATIVE_PASSTHROUGH_FORBIDDEN` | `Native backend query passthrough is forbidden.` | `Remove the native-query member.` |
| `REGEX_FORBIDDEN` | `Regular-expression predicates are forbidden in AgQL v0.` | `Use contains or startsWith.` |
| `UDF_FORBIDDEN` | `User-defined functions are forbidden in AgQL v0.` | `Use a closed AgQL v0 predicate.` |
| `EVALUABLE_CONSTRUCT_FORBIDDEN` | `Evaluable expressions are forbidden in AgQL v0.` | `Use a closed AgQL v0 predicate.` |
| `UNSUPPORTED_IN_V0` | `This construct is reserved and unsupported in AgQL v0.` | `Remove the construct.` |

Scalar alternatives are generated exactly as follows: scale mismatch uses `Use
a decimal with at most <scale> fractional digits.`; overflow uses `Use a value
within the declared precision or integer range.`; instant mismatch names the
one required precision; mixed money uses `Add a moneyCurrency dimension for
this field.`. Collation/calendar alternatives name only logical sources
advertising the pinned profile. Safety and deferred alternatives are the exact
sentences in the table.

Safety probe paths are `/mode` for a query write, `/rawSql` or `/rawPipeline`
for passthrough, `/where/op` for regex, and `/where/kind` for UDF/expression.
All safety and deferred errors occur before backend access.

### 10.4 Capability, cost, cursor, quality, and receipt codes

| Code | Exact message | Required remedy action |
|---|---|---|
| `PROFILE_UNSUPPORTED` | `The source does not advertise the required capability profile.` | `chooseSourceOrRemoveFeature` |
| `SCOPE_UNENFORCEABLE` | `The source cannot enforce the resolved scope before content crosses the trust boundary.` | `chooseCertifiedSource` |
| `EXACT_SCAN_LIMIT_EXCEEDED` | `The exact eligible set exceeds the admitted scan limit.` | `narrowEligibleSetOrRequestApproximate` |
| `COST_LIMIT_EXCEEDED` | `The query exceeds the resolved cost budget.` | `narrowQuery` |
| `FRESHNESS_UNAVAILABLE` | `The selected binding cannot certify the requested afterWrite guarantee.` | `chooseAfterWriteBindingOrRemoveRequirement` |
| `EMBEDDING_UNINDEXED` | `The required EmbeddingSpec is not indexed on the selected binding.` | `chooseIndexedSpecOrWaitForIndexing` |
| `QUALITY_UNCERTIFIED` | `The requested quality profile has no valid certification for this execution.` | `chooseCertifiedProfileOrMeasure` |
| `FILTER_SHAPE_UNCERTIFIED` | `The selected binding has no quality certification for this filter shape.` | `chooseCertifiedProfileOrMeasure` |
| `CURSOR_INVALID` | `The cursor does not match this query, scope, channel, or snapshot.` | `restartPagination` |
| `CURSOR_EXPIRED` | `The cursor has expired.` | `restartPagination` |
| `CURSOR_UNAVAILABLE` | `The source cannot preserve a snapshot for cursor pagination.` | `chooseSnapshotCapableSource` |
| `RECEIPT_INVALID` | `The write receipt does not match this query scope or source.` | `supplyMatchingReceipt` |
| `RECEIPT_EXPIRED` | `The write receipt has expired.` | `issueNewWriteOrRunWithoutRequirement` |
| `RECEIPT_FAILED` | `A required write representation failed.` | `issueNewWrite` |
| `RECEIPT_SUPERSEDED` | `A required write representation was superseded.` | `useNewerReceipt` |
| `AFTER_WRITE_TIMEOUT` | `The afterWrite deadline elapsed before every required visibility state was observable.` | `retryAfterWrite` |

Remedy details are closed per action. The exact-scan remedy contains
`{limit,eligibleCount,alternatives:["Add a selective where predicate.","Request
approximate accuracy if policy permits."]}`. Freshness remedy contains
`alternatives:["Choose a binding certified for afterWrite.","Remove the
freshness requirement explicitly."]`. Timeout remedy contains the submitted
receipt and the sorted unsatisfied representation names; these names were
already supplied by the caller and reveal no hidden catalog item. Cost remedies
contain only scope-visible fields/operators. No remedy names a physical source,
index, table, shard, or backend dialect.

Runtime error paths are fixed: profile `/mode` (or `/search/kind` when retrieval
kind is the missing capability), unenforceable scope `/from`, exact scan
`/search/accuracy`, cost `""`, freshness `/afterWrite`, unindexed embedding
`/search/using`, quality `/search/quality`, uncertified filter `/where` (or `""`
when no explicit filter), cursor `/execution/pageCursor`, receipt validity
`/afterWrite/receipt`, and receipt state/timeout `/afterWrite`. Runtime
alternatives and remedy `details` contain exactly the following keys:

| Remedy action | `details` members |
|---|---|
| `chooseSourceOrRemoveFeature` | `requiredProfile`, `alternatives` |
| `chooseCertifiedSource` | `requiredScopeDimensions`, `alternatives` |
| `narrowEligibleSetOrRequestApproximate` | `limit`, `eligibleCount`, `alternatives` |
| `narrowQuery` | `budgetKind`, `limit`, `estimated`, `alternatives` |
| `chooseAfterWriteBindingOrRemoveRequirement` | `alternatives` |
| `chooseIndexedSpecOrWaitForIndexing` | `embeddingSpec`, `alternatives` |
| `chooseCertifiedProfileOrMeasure` | `qualityProfile`, `status`, `alternatives` |
| `restartPagination` | `queryRequired` |
| `chooseSnapshotCapableSource` | `alternatives` |
| `supplyMatchingReceipt` | `receipt` |
| `issueNewWriteOrRunWithoutRequirement` | `receipt`, `alternatives` |
| `issueNewWrite` | `receipt`, `failedRepresentations` |
| `useNewerReceipt` | `receipt` |
| `retryAfterWrite` | `receipt`, `require` |

Every listed alternative array is in fixed table order; logical source ids, if
present, follow afterward in §2.5 order and are scope-visible. Codes not mapped
to a remedy action have `remedy:null`. `AFTER_WRITE_TIMEOUT` has exactly the
alternative `Retry with the same receipt and requirements.`.

## 11. Conformance

- **Exact suite:** byte-equivalent records, aggregate, and exact retrieval;
  stable/implicit ties, cursor pages, nulls, ranges, decimal/money/ratio,
  calendars/relative time, collation, error order, aliases, hidden references,
  identities, deferrals, and safety refusals.
- **Retrieval suite:** deterministic PRNG corpus; exact eligible/top-k oracle;
  50%, 10%, 1%, and sparse intersections; per-query recall and empirical
  distribution; versioned certifications. Initial profile thresholds remain
  null pending first cross-adapter measurement.
- **Security probes:** the ten scope/filter/receipt/migration families plus
  runtime-owned embedding, backend opacity, and principal/model channel
  isolation. Tens of thousands of randomized cases permit zero violations.
- **Encoding suite:** accepted JSON/YAML normalize identically and every fixed
  `ENCODING_*` rejection is exact.
- **Receipt suite:** logical-time transition, timeout, delete, batch,
  query-route visibility, unsupported-tier, migration, and token-opacity cases.
- **Host and protocol:** a conforming host never routes principal-only data to
  model context; MCP and HTTP yield identical identities, envelopes, semantics,
  and error results for the same channel/context.

Exact-vector diagnostics use §5.4 tolerance, but exact membership and rank have
zero tolerance. Approximate eligibility has zero tolerance before recall is
computed. Every implemented construct and every refusal code requires a
fixture. A deferred construct without its `UNSUPPORTED_IN_V0` probe is not
implemented.

## 12. Acceptance gates and explicit open value

v0 exits only after: exact portability across two canonical adapters; zero
authorization violations; receipts never falsely succeed; per-adapter recall
distributions against one oracle; complete backend opacity in all agent-facing
surfaces; component-isolated runtime overhead measurement; MCP/HTTP equivalence;
and complete retrieval provenance.

The only deliberately open normative value is the numeric threshold set for
initial approximate quality profiles. Its schema, measurement, quantile,
certification, expiry, and drift behavior are fixed in §9.2, but the threshold
members remain null until the first cross-adapter results exist. This is a
measurement dependency, not permission for implementations to choose different
hidden thresholds. Runtime “small” latency is likewise an empirical acceptance
claim, not a query semantic or adapter-selected constant.
