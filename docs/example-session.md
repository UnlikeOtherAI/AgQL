# AgQL by example: one agent session, end to end

A worked session showing every call an agent makes. Scenario: a restaurant
group's COO asks their assistant:

> "How did waste look last month across our London venues? Are there
> recurring causes? Put a chart on the ops dashboard for the team."

The deployment: inventory and orders live in Postgres; incident notes are
embedded under an EmbeddingSpec (`incident_body@2`). The assistant's session
scope, resolved server-side from its MCP authentication:

```json
{ "capabilities": ["inventory", "orders", "incidents"],
  "partitions": { "region": ["london"] },
  "budgets": { "queries": 40, "rows": 50000 },
  "expiry": "2026-08-25T18:00:00Z" }
```

Everything below is the **model channel** — note how little data ever enters
it.

---

## 1. Discover: `describe_catalog`

```json
{ "source": "ops", "refs": ["inventory"] }
```

→ (condensed)

```json
{ "datasets": [
    { "name": "wasteEvents",
      "description": "One row per recorded stock write-off.",
      "fields": [
        { "name": "occurredAt", "kind": "timestamp" },
        { "name": "value", "kind": "money", "description": "Cost of goods written off." },
        { "name": "reason", "kind": "enum", "values": ["spoilage", "damage", "prep_error", "theft", "other"] },
        { "name": "venueId", "kind": "id" } ],
      "edges": [ { "name": "venue", "target": "venues", "cardinality": "one" } ],
      "defaults": [ "excludes voided events (wasteEvents.voidedAt is null)" ] },
    { "name": "incidentNotes",
      "description": "Free-text incident reports from venue staff.",
      "fields": [
        { "name": "body", "kind": "text", "semanticSearch": true },
        { "name": "occurredAt", "kind": "timestamp" },
        { "name": "venueId", "kind": "id" } ] } ] }
```

The index only ever contains what this scope may see. Datasets behind
capabilities the agent lacks are not listed, not nameable, not discoverable
through errors.

## 2. First attempt — and the repair loop

The agent emits an aggregate query with a mistake:

```json
{ "version": "1", "mode": "aggregate", "from": "wasteEvents",
  "where": { "kind": "predicate", "field": "wasteEvents.occurredAt",
             "op": "inPrevious", "unit": "month" },
  "metrics": [ { "kind": "aggregate", "op": "sum", "field": "wasteEvents.value", "id": "wasted" } ],
  "dimensions": [ { "kind": "timeBucket", "field": "wasteEvents.occurredAt",
                    "grain": "week", "id": "week" } ],
  "order": [ { "by": "wastedValue", "dir": "asc" } ],
  "take": 10 }
```

→ `explain_query` rejects, deterministically, with the alternatives:

```json
{ "status": "rejected",
  "errors": [ { "code": "unknown_order_alias", "path": "order[0].by",
    "message": "order entry \"wastedValue\" must be one of the query's output ids: \"week\", \"wasted\"." } ] }
```

One round-trip, one fix (`"by": "week"`). No SQL error archaeology.

## 3. Verify: `explain_query` (fixed)

→

```json
{ "status": "accepted",
  "effectivePlanHash": "sha256:9f2c…",
  "resultSchema": [ { "id": "week", "kind": "timestamp" },
                    { "id": "wasted", "kind": "money", "currency": "GBP" } ],
  "determinism": { "query": "exact", "snapshot": "readYourWrites" },
  "projection": "from wasteEvents | where occurredAt inPrevious month | group week(occurredAt) | sum(value) as wasted | order week asc | take 10",
  "pushdown": ["filter", "group", "aggregate", "order", "limit"],
  "compensation": [],
  "cost": { "verdict": "ok", "estimatedRows": 5 },
  "notes": [ "scope filter applied: venues.region in ['london']",
             "default filter applied: wasteEvents.voidedAt is null",
             "anchor: 2026-08-25T12:04:11Z (calendar month = July, Europe/London)" ] }
```

The scope filter and the calendar math are visible, not folklore. The
`exact` declaration means: this exact query, this anchor, this snapshot —
byte-identical result on any conforming backend.

## 4. Run: `run_query`

→

```json
{ "status": "ok",
  "schema": [ { "id": "week", "kind": "timestamp" }, { "id": "wasted", "kind": "money", "currency": "GBP" } ],
  "previewRows": [
    { "week": "2026-06-29T00:00:00Z", "wasted": "2101.40" },
    { "week": "2026-07-06T00:00:00Z", "wasted": "1873.15" },
    { "week": "2026-07-13T00:00:00Z", "wasted": "4310.02" },
    { "week": "2026-07-20T00:00:00Z", "wasted": "4589.77" },
    { "week": "2026-07-27T00:00:00Z", "wasted": "1204.90" } ],
  "previewTruncated": false,
  "executionReceipt": "er_v1.eyJwbGFuIjoi…",
  "principalResultAvailable": true }
```

Waste doubled mid-month. The agent digs into causes — first structurally:

```json
{ "version": "1", "mode": "aggregate", "from": "wasteEvents",
  "where": { "kind": "and", "items": [
    { "kind": "predicate", "field": "wasteEvents.occurredAt", "op": "inPrevious", "unit": "month" } ] },
  "dimensions": [ { "kind": "field", "field": "wasteEvents.reason", "id": "reason" } ],
  "metrics": [ { "kind": "aggregate", "op": "sum", "field": "wasteEvents.value", "id": "wasted" },
               { "kind": "aggregate", "op": "count", "id": "events" } ],
  "order": [ { "by": "wasted", "dir": "desc" } ], "take": 5 }
```

→ preview shows `spoilage` at £6.9k of the £14k. Now semantically:

## 5. Retrieve: semantic search over incident notes

```json
{ "version": "1", "mode": "retrieve", "from": "incidentNotes",
  "search": { "kind": "semantic", "field": "body",
              "text": "spoiled stock, fridge or refrigeration problems",
              "accuracy": "approximate", "topK": 10 },
  "where": { "kind": "predicate", "field": "incidentNotes.occurredAt",
             "op": "inPrevious", "unit": "month" },
  "take": 10 }
```

→

```json
{ "status": "ok",
  "previewRows": [
    { "id": "in_9412", "occurredAt": "2026-07-14T07:20:00Z", "venueId": "ven_soho",
      "body": "Walk-in fridge 2 reading 9°C again overnight, dairy delivery moved to fridge 1, some cream discarded.",
      "rankScore": 0.94, "taint": "untrusted_evidence" },
    { "id": "in_9433", "occurredAt": "2026-07-16T06:55:00Z", "venueId": "ven_soho",
      "body": "Fridge 2 compressor icing over. Engineer booked. Lost the fish prepped Friday.",
      "rankScore": 0.91, "taint": "untrusted_evidence" } ],
  "previewTruncated": true,
  "retrieval": { "semantics": "approximate", "embeddingSpec": "incident_body@2",
                 "queryVectorDigest": "sha256:41ab…", "indexWatermark": "opaque:wm_88213",
                 "qualityProfile": "high-recall-v1" },
  "executionReceipt": "er_v1.eyJwbGFuIjoi…" }
```

Approximate, and honest about it: the provenance names the embedding
version, the index state, and the quality promise. Every note is labeled
`untrusted_evidence` — staff free-text is data to reason about, never
instructions. And the eligibility filters (July, London scope) were applied
in candidate selection, not trimmed afterwards — the conformance suite's
adversarial probes exist to keep adapters honest about exactly this.

## 6. Remember: `put_records` + read-your-writes

The agent stores what it learned, through the Storage API (not AgQL — the
query language cannot write):

```json
{ "source": "ops", "dataset": "agent_memory", "mode": "replace",
  "records": [ { "id": "memory:venue:soho:fridge2",
    "value": { "text": "Walk-in fridge 2 at Soho has a failing compressor; caused the mid-July spoilage spike (~£6.9k month waste, spoilage-led).",
               "venueId": "ven_soho", "topic": "equipment" } } ],
  "embeddingPolicy": "catalog",
  "idempotencyKey": "task-311:memory-1" }
```

→

```json
{ "status": "accepted",
  "writeReceipt": { "recordVersion": 1, "watermark": "opaque:wm_88291", "embeddingState": "pending" } }
```

Any later query — this turn or next week — can pass
`"afterWrite": "opaque:wm_88291"` and is guaranteed to see this memory,
embedding included, or receive a structured timeout. No sleep-and-retry.

## 7. Materialize + chart + publish — zero rows through the model

The weekly aggregate should live on the team dashboard. The agent holds only
a receipt, and that is all it needs:

```json
{ "source": "ops", "name": "wasteWeeklyLondonJul2026",
  "fromReceipt": "er_v1.eyJwbGFuIjoi…",
  "description": "Weekly waste value, London venues, July 2026 snapshot.",
  "idempotencyKey": "task-311:mat-1" }
```

→ `{ "dataset": "wasteWeeklyLondonJul2026", "version": 1, "rows": 5,
     "provenance": { "plan": "sha256:9f2c…", "anchor": "…", "scopeFingerprint": "sha256:…" } }`

The rows moved server-side. The derived dataset inherits the
most-restrictive policies of its sources — it cannot launder anything the
sources protected. Then the chart, a spec of a few hundred bytes:

```json
{ "source": "ops", "artifact": {
    "name": "Weekly waste — London",
    "dataset": "wasteWeeklyLondonJul2026",
    "presentation": { "type": "bar", "x": "week", "y": ["wasted"], "format": "money" } },
  "idempotencyKey": "task-311:art-1" }
```

The mapping (`x`, `y`) is validated against the dataset's result schema —
the same contract `explain_query` returned. Finally:

```json
{ "source": "ops", "dataset": "wasteWeeklyLondonJul2026",
  "artifacts": ["Weekly waste — London"], "audience": { "team": "ops" } }
```

→ `{ "status": "pending_principal_confirmation", "proposal": "pub_5521" }`

The COO sees the proposal in their UI — *what* would be shared, with *whom*,
computed under *which* scope — and approves. A model can propose
publication; only a principal completes it. From then on, teammates' agents
query `wasteWeeklyLondonJul2026` under their own scopes, and the dashboard
renders through the principal channel at view time.

## 8. Delegate: the attenuated follow-up

The COO asks for a deeper dive on Soho. The assistant spawns a sub-agent and
hands it a *narrowed* scope token derived offline from its own:

```text
partitions.venue = {ven_soho}   (was: region london)
capabilities     = {inventory, incidents}   (orders dropped)
budgets.queries  = 8
expiry           = +20 minutes
```

The sub-agent can be prompt-injected by anything in those incident notes —
and still cannot read another venue, touch orders, or outlive its window.
Widening the token is cryptographically impossible; the engine, not the
prompt, enforces it.

---

## The tally

What the model's context carried across the whole session: catalog snippets,
two 5-row previews, one truncated 10-row preview, receipts, names, and one
error message. What the system moved and produced: two aggregate scans, a
semantic search, a durable memory with a freshness guarantee, a materialized
versioned dataset, a published chart, and a scoped delegation — all logged,
all replayable (query + anchor + embedding version + watermark), none of it
trusting the agent's own account of what happened.

The same session compiles unchanged against any conforming adapter stack:
the queries name no tables, no SQL, no index, no embedding model, no vendor.
