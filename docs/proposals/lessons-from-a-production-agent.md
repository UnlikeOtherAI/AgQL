# Lessons from a production analytics agent

**Status: non-normative.** This document proposes nothing that is in force. It
records gaps found by comparing RFC v0 against a shipped analytics agent built
on a different closed query language, and proposes rules for a future version.
`docs/rfc-v0.md` remains the only normative contract; where this document and
the RFC disagree, the RFC wins, and nothing here changes v0 behaviour.

## Provenance

The comparison source is a production system that answers natural-language
questions about a hospitality business. It is the same architecture AgQL
describes and reaches most of the same conclusions independently: a closed JSON
query specification validated against a catalog, compiled to SQL with every
model-produced string either matched to a catalog key or bound as a parameter,
no query-authored SQL, a caller scope that is applied unconditionally, and a
reference corpus that replays recorded results.

It has been in front of real users long enough to have made the mistakes.
Every claim below is a mechanism that system got wrong first and then encoded;
no customer data, figures, or code are reproduced here.

Two of its rules were examined and are **not** proposed, because the RFC is
already right and deliberately different:

- **Rounding mode.** That system rounds half away from zero, because its
  storage layer and its predecessor's decimal library both do. RFC §2.2 fixes
  round-to-nearest-ties-to-even. The transferable lesson is not the mode but
  the two properties around it: the mode is *declared* rather than inherited
  from whatever computes the division, and it is applied *once*, to the result,
  never to an operand. §2.2 has both. Fixture `042` pins them.
- **Forward-unbounded rolling windows.** That system shipped a
  week-over-week widget whose "this week" bucket had no upper bound. In
  production this is invisible, because nothing is dated after now. Replayed
  against a past anchor over data that continues past it, every later week
  piled into "this week". RFC §5.1 already resolves this by splitting the two
  behaviours explicitly: `inLast` caps at the anchor and `inCurrent` covers the
  whole calendar period *including* rows after the anchor. Fixture `041` pins
  the distinction in both directions.

## 1. What this change already pins

These needed fixtures, not spec text. They are listed so the proposals below
are read against what is now covered.

| Fixture | Rule | Production failure it answers |
|---|---|---|
| `040` | `inLast` subtracts civil units on the catalog wall clock | An offset applied to an absolute timestamp moved the day boundary by the DST delta on transition days |
| `041` | only `inLast` caps at the anchor | A forward-unbounded "current period" absorbed the future when replayed against a past anchor |
| `042` | money and average scale, exact decimals, one half-to-even rounding | Money read through a binary float lost sub-unit precision |
| `043` | scope is conjoined outside a user disjunction | A filter that can widen a caller's scope is a data breach, not a bug |
| `044` | empty input: counts are `0`, other aggregates are null, group retention | "No rows" and "zero" were conflated at the surface |
| `045` | a `date` field is a calendar day, never shifted | A day-typed column shifted by a day-boundary offset moves whole rows between days |
| `016`–`018` | civil day, fiscal day, and week-start buckets (previously blocked) | The same fiscal-day arithmetic, at bucket granularity |

## 2. Proposed constructs

Each proposal states how it preserves the §1 invariants, because a construct
that cannot is not worth specifying.

### 2.1 A declared totals row

**Problem.** An aggregate answer of *n* groups almost always needs its total,
and the model cannot compute it: summing the released groups is wrong whenever
`take` truncates, whenever a release policy suppresses a group, and — most
often — whenever the metric is a ratio, because the total of a ratio is the
ratio of the totals, not the average of the rows' ratios. Today the only way
to get it is a second query, which is a second scope evaluation, a second
snapshot, and two answers that can disagree.

**Production evidence.** That system added a `totals` flag after its agent
repeatedly produced a "total" by adding up the rows it had been shown. Its
average-order-value figure was wrong by construction whenever channels had
different order counts. Two properties turned out to be load-bearing: the total
is computed over the *same filtered source* (same scope, same default filters,
same joins) with no `GROUP BY`, `ORDER BY` or `LIMIT`; and it is executed in
the *same snapshot* as the rows, because under a weaker isolation level the
total drifts from the rows it totals on a live replica.

**Proposed rule.** An optional `totals: true` member on `AggregateQuery`. When
present, the result carries one additional group in a separate `data.totals`
member — not in `data.groups`, so existing row handling is unchanged. Every
metric is evaluated exactly as declared, over the eligible set after scope,
default filters and query `where`, with no dimension grouping. Dimension
outputs read null in that group. `ratio` is computed from its own operands'
totals. `take` and ordering do not apply to it. The totals group is released
under the same channel policy as any group, and `minimumCohort` gates it by its
own contributor count.

*Invariants.* No new vocabulary reaches the model beyond one boolean; the total
is a pure function of the same resolved plan, so `effectivePlanHash` covers it;
scope is unchanged, so pushdown is unaffected.

**Conformance test.** An aggregate fixture with `take` smaller than the group
count and a ratio metric, asserting that the totals group is the ratio of the
summed operands rather than the mean of the released groups' ratios, and that
it counts the truncated groups. A scope fixture asserting the totals group
reflects only in-scope rows. A `minimumCohort` fixture asserting a
below-minimum totals group is emitted exactly like an empty one.

### 2.2 Calendar-part predicates and dimensions

**Problem.** "Which weekday is busiest" and "what happens on Friday nights" are
the two most common questions a business analytics agent is asked, and v0
cannot express either: `timeBucket` produces contiguous periods, not
day-of-week or hour-of-day classes. Without them an agent either asks for every
row and reduces client-side — which breaches the bounded-result contract — or
issues one query per weekday.

**Production evidence.** That system implements both a filter operator and a
projection over calendar parts, and deliberately derives them from **one**
expression builder, so that a chart of "Friday" and a filter on "Friday" count
the same rows. Its sharpest finding is an exception: weekday, day-of-month,
month and week are read on the *fiscal* wall clock, because a 02:00 order
belongs to the previous business day; but **hour-of-day is read on the plain
local clock**, because the hour of day is a reading of the clock, and shifting
it by the fiscal offset relabels 04:00 as "hour 0" and silently rotates every
busiest-hours answer. It also found that a wrapping range (hours 22 through 1)
must be expressed as a disjunction, and that displaying such an axis needs a
declared rotation so a late-opening venue reads 04…23, 00…03.

**Proposed rule.** A `calendarPart` vocabulary of `weekday`, `hourOfDay`,
`dayOfMonth`, `monthOfYear`, with:

- a dimension `{kind:"calendarPart", field:InstantField, part:CalendarPart,
  id:OutputId}` producing a closed result kind with a stable code and an
  ordinal, not a localized label;
- a predicate `{kind:"predicate", field:InstantField, op:"inPart",
  part:CalendarPart, values:[Code]}` over that same closed code set.

Both MUST compile from one resolution so the filter and the dimension always
agree. `weekday`, `dayOfMonth` and `monthOfYear` are evaluated on the fiscal
day defined by the catalog's `fiscalDayStart`; `hourOfDay` is evaluated on the
catalog timezone's civil clock and is explicitly **not** shifted by
`fiscalDayStart`. Weekday codes are `monday`…`sunday` and order by the
catalog's `weekStart`; `hourOfDay` codes are `0`…`23` and order from
`fiscalDayStart`'s hour when one is declared, so the axis is contiguous for the
business that declared it.

*Invariants.* The operand is a closed enum, so nothing evaluable or
model-authored reaches the backend; the mapping is a pure function of the
catalog calendar, so compilation stays deterministic.

**Conformance test.** A paired fixture asserting that `inPart weekday=friday`
and a `weekday` dimension select exactly the same rows for a catalog with a
non-midnight `fiscalDayStart`, with a seeded row in the small hours that
belongs to the previous weekday. A second fixture asserting `hourOfDay` is
*not* shifted by the same `fiscalDayStart` — the inverse assertion — which is
the case that is easy to get wrong in the direction that looks consistent. A
third asserting a wrapping range and the declared ordering.

### 2.3 Dense buckets over a bounded window

**Problem.** A time series with missing buckets is read wrong by models and
humans alike: a quiet day is absent rather than zero, so a line chart connects
across it and a "worst day" question returns the wrong day. v0's §2.6 rule —
correctly — emits no group for a dimension value with no contributing rows, so
the gap cannot be closed inside the current aggregate.

**Production evidence.** That system generates the bucket series and left-joins
the grouped query onto it. Three constraints came out of shipping it. The
window must be **bounded**, and bounded by the query's own conditions rather
than by anything the caller invents, or the series is unbounded. Conditions
inside a disjunction do not establish a window — a disjunction is not a window.
And the generated buckets must be produced on the same wall clock as the data
buckets, or a filled bucket and a real bucket fail to compare equal on DST
days, which reintroduces the gap it was added to close.

**Proposed rule.** An optional `dense: true` on a `timeBucket` dimension.
Compilation resolves the bucket window from the conjunctive time predicates on
that dimension's field in the query's `where` — a half-open `gte`/`lt` pair, or
an `inLast`/`inCurrent`/`inPrevious` predicate. If no such conjunctive bound
exists, or the only bound occurs inside an `or`, the query is refused with a
repairable error naming the missing bound; it is never silently sparse and
never unbounded. The bucket count is bounded by a structural constant in §5.5.
Generated buckets carry the same `CalendarPeriod` value the grain would
produce. Every metric in a generated bucket is null unless §2.4 applies.

*Invariants.* The window is derived from the already-resolved plan, so no new
model-authored value crosses the boundary; the refusal path keeps the
"no silent downgrade" rule.

**Conformance test.** An aggregate fixture over a catalog day grain with a
seeded gap, asserting the gap appears as a group whose metrics are null and
whose `CalendarPeriod` is byte-identical to a non-generated bucket of the same
grain. A DST fixture asserting a generated bucket on a 23-hour civil day
matches the period a seeded row in that day produces. A refusal fixture with
the only time bound inside an `or`.

### 2.4 A declared empty value

**Problem.** §2.6 is right that `count` over an empty input is `0` and `sum` is
null, and fixture `044` pins it. But whether a *presented* answer should read
`0` or "no data" is a property of the question, not of the aggregate, and v0
gives the caller no way to say so. This matters most alongside §2.3: a dense
series of null-metric buckets is rarely what the asker meant by a chart of
daily sales.

**Production evidence.** That system makes zero-filling strictly opt-in, per
selected column, and its test suite pins both directions — that the coalesce is
emitted when asked for, and that it is *absent* when not, so the column can
still be null. Two details matter: the fill is applied outside the metric's own
filter, because a filter matching nothing is exactly the empty set it answers
for; and a ratio's zero denominator produces an empty cell rather than an error
or a zero, with any declared empty value applied outside that.

**Proposed rule.** An optional `emptyAs: Scalar` on a `Metric`. When present
and the metric would be null *because its input was empty* (not because its
operands were null), the released value is that scalar, whose kind MUST match
the metric's result kind under §2.2. It is applied once, after the metric and
before any release policy, and never to an operand of a `ratio`. Absent, §2.6
is unchanged. It does not affect `having`, ordering, or the totals group of
§2.1, all of which see the §2.6 value.

*Invariants.* The scalar is a typed catalog-checked value bound as a parameter;
it changes a released value, not eligibility, so no authorization surface
moves.

**Conformance test.** A paired aggregate fixture over an emptied eligible set,
one query with `emptyAs` and one without, asserting `0` and null respectively
for the same metric, and that `having` and `order` see the null in both. A
fixture asserting `emptyAs` on a ratio applies to the ratio and not to its
operands.

### 2.5 Personal-data marking on result columns

**Problem.** AgQL's §6 policy decides whether a field may be selected at all,
per channel, which is the right primitive for access. It has no way to say "the
authenticated principal may see this value, and it must not enter model
context" *for a value that is legitimately released*. Since §8.1 releases model
data and principal data through different channels, the distinction exists in
the architecture but not in the schema.

**Production evidence.** That system marks catalog fields as carrying personal
data and strips those cells from anything serialized into the model
conversation, while the authorized user's own view is untouched. The mechanism
that made it correct — and the regression that proved it necessary — is
propagation: the mark must survive aggregation, because a wage or a name
reaches a model gateway just as easily wrapped in `max()`. Its rule is that an
aggregate over a marked field stays marked, *except* `count` and
`countDistinct`, which reveal no value. It also refuses a marked field as a
subquery join key, on the grounds that personal data is not a key to match on.

**Proposed rule.** An optional `privacyClass` on a catalog `Field`, reusing the
`EmbeddingSpec` vocabulary (`public` | `internal` | `restricted`). A
`ResultColumn` in §8.1 gains the resolved class. A column resolving to
`restricted` MUST NOT appear on the model channel even where field policy
permits `select`; it is removed from the schema without reordering, exactly as
a channel-filtered column is today. Propagation is normative: `min`, `max`,
`sum`, `avg` and a `ratio` with a restricted operand inherit the class;
`count` and `countDistinct` do not. A restricted field MUST NOT be a lexical
search field or an `EmbeddingSpec` source field.

*Invariants.* This is a release rule, not an eligibility rule, so it does not
weaken §6.2; a restricted column removed from a model result is indistinguishable
from a channel-filtered one, so it does not become a catalog oracle.

**Conformance test.** A fixture asserting a restricted column is absent from a
model-channel schema and present on the principal channel for the same query
and scope. A fixture asserting `max` over a restricted field is restricted and
`count` over it is not. A probe in the security suite injecting a canary into a
restricted field and failing if it appears in any model-channel surface,
including errors and previews.

## 3. Under-specified in v0

### 3.1 Relative-time and time-bucket operands on a `date` field

§5.1 types the relative-time predicates' operand as `InstantField`, and §5.3
types a `timeBucket` dimension's operand the same way. The RFC does not say
what happens when the referenced field is a `date`, and it names no code for an
operator/field-kind mismatch: §10.2's `SCHEMA_INVALID_VALUE` is about closed
vocabularies and `REFERENCE_NOT_AVAILABLE` would wrongly imply the field is
hidden. §2.1's "predicate operands must match the field kind" is stated without
a code. The implementation currently admits a `date` field in `timeBucket` and
performs no kind check at all for `inLast`/`inCurrent`/`inPrevious`.

This is worth resolving rather than leaving to implementations, because both
available answers are defensible and they differ by a whole day. That system
supports date columns on a time axis and specifies, per operator, that a date
is compared as a day — both ends inclusive, no timezone conversion, no
day-boundary offset — because a date column *already names* a business day and
its midnight is not an instant anything happened at. Its test suite names both
failure modes it hit: admitting the day before (the instant's UTC date) and
admitting the day after (where an offset-shifted end lands).

**Either** v0 says a `date` operand is refused at those slots, and names the
code; **or** it says a `date` operand is compared as a calendar day under §2.1
with no calendar conversion, and defines the relative window's endpoints in
days. Fixture `045` pins the half of this the RFC does determine — that a
`date` field compared with `date` scalars is a calendar day and is not shifted
by the catalog timezone or `fiscalDayStart`. No fixture is proposed for the
relative-time case until the RFC decides, because writing one would launder an
implementation's choice into the oracle.

### 3.2 Repairable errors: ranking, and why a result is empty

§10 is already most of what a model needs to repair its own call: a code, an
exact message, an RFC 6901 pointer, an alternatives array, and a closed remedy
vocabulary. Two pieces are missing.

**Ranking.** §10.1 fixes the *order* of alternatives (by collation, or fixed
table order) but not their *selection* when the visible vocabulary is larger
than a useful list. That system ranks by edit distance with a bounded budget
and a shared-stem bonus, and goes further: when a field belongs to a dataset
that is reachable but not in the query, it returns the path to reach it rather
than a spelling suggestion. Under AgQL's §6.2 the ranking function is also a
disclosure decision — it chooses which visible ids to show — so leaving it
unspecified leaves implementations free to differ on a security-adjacent
surface. A future version should fix a selection rule and a maximum count, and
the fixture is a catalog with many visible fields and one near-miss reference,
asserting byte-identical alternatives across adapters.

**Why a result is empty.** That system's most-used repair affordance answers
"why is this empty" by re-running bounded count probes with each part of the
filter removed, and distinguishing *empty because of the period*, *empty
because of the other filters*, and *this dataset has nothing for the venues you
can see*. This is the one lesson that does **not** transfer unchanged. Under
§6.2 an empty result and a `minimumCohort`-suppressed result are required to be
indistinguishable, and any explanation that separates "your filter matched
nothing" from "your scope hides everything" is an oracle for exactly what §6.2
hides. A conforming version of it would have to be defined as: probes run
strictly inside the resolved scope, the scope-related branch is never
distinguishable from the filter-related one, and no branch is reachable when a
release policy applies to the query. That is a narrower and less useful
affordance than the production one, and it should be specified deliberately
rather than arrived at by an implementation that only noticed the useful half.

## 4. Implementation divergences observed but not changed here

Recorded so they are not rediscovered. None is a spec gap; each is code that
contradicts the RFC, and each is outside this change's scope.

- **Error-code vocabulary.** The engine emits `SEMANTIC_INVALID`,
  `STRUCTURAL_INVALID`, `EXACT_SCAN_BUDGET_EXCEEDED`, `EMBEDDING_NOT_INDEXED`,
  `COST_GATE_REFUSAL` and `UNSUPPORTED_PROFILE`. §10 names `SCHEMA_*`,
  `EXACT_SCAN_LIMIT_EXCEEDED`, `EMBEDDING_UNINDEXED`, `COST_LIMIT_EXCEEDED` and
  `PROFILE_UNSUPPORTED`, with exact messages. This is the largest single
  divergence and it blocks writing refusal fixtures for anything §10 covers: a
  fixture pinning today's codes would contradict the RFC, and one pinning the
  RFC's would fail everywhere at once. It should be one deliberate change that
  ports the catalog and adds the refusal fixtures together.
- **Structural constants.** §5.5 fixes predicate nodes at 64, selected fields
  at 64, `and`/`or` items at 16, records `take` at 1,000 and retrieval `take`
  at 100. `QUERY_LIMITS` uses 100, 100, no item limit at all, 10,000 and 1,000
  respectively; boolean nesting, `in`/`notIn` values and aggregate `take` do
  match. §5.5 permits a deployment to enforce *lower* values, never higher.
- **Gap and repeat resolution.** §4.1 requires a nonexistent boundary local
  time to resolve to the first valid instant after the gap and a repeated one
  to the earlier instant, and §5.1 applies the same rule to relative windows.
  The engine's wall-clock conversion probes the zone offset once and does not
  implement either rule, so a relative window whose computed start lands
  exactly in a gap or a repeat is unspecified in practice. Fixtures `016`,
  `017` and `040` exercise boundaries *near* transitions but not *in* them; a
  fixture landing a window start inside the skipped hour would pin it.

## 5. One practice worth copying wholesale

That system's strongest quality mechanism is not a rule but a habit, and AgQL's
`conformance/retrieval` corpus is the closest existing analogue: it records
real answers under a set of named, written-down scenarios and replays them.
Three properties are what make it more than a snapshot directory, and all three
are portable to AgQL's suites:

- **A declared anchor is the only clock.** Replay sets the anchor explicitly,
  so a "today"-relative query is reproducible. AgQL has this as a normative
  invariant (§3.2) rather than a harness feature, which is stronger.
- **Scenarios are chosen from measured distributions, not convenience.** Its
  named scenarios include both DST transitions, an empty period, and several
  awkward payment shapes, on the stated grounds that a corpus built from one
  busy ordinary day would agree with a reimplementation that got every
  interesting branch wrong.
- **Vacuous agreement is counted and reported, never passed.** A case whose
  every recorded value is zero agrees with any implementation that returns
  zero, so it is reported as unproven rather than counted as evidence. Runs
  that need a tolerance print the tolerance and its cause.

AgQL's report shapes already carry `pass`/`fail`/`blocked`/`undetermined`; the
missing member is the third one — a fixture that passes without discriminating.
`conformance/README.md`'s existing gap list would be the right place to say so.
