# Encoding-equivalence conformance suite

The first executable piece of the AgQL specification: fixtures that pin the
rule **"encodings are many, the canonical form is one."** Every accepted
input encoding (JSON, AgQL-YAML) is normalized to the canonical JSON form at
the edge, before validation, hashing, or execution — so two encodings of one
query have one `sourceQueryHash`, and the determinism machinery never sees
the surface syntax.

## The AgQL-YAML profile (what a conforming parser accepts)

- YAML **1.2 core schema only** — no 1.1 implicit booleans (`no`, `on` are
  strings), no sexagesimals, no version-dependent scalar surprises.
- **No anchors, no aliases** (this kills expansion bombs before expansion).
- **No merge keys** (`<<`).
- **No custom or application tags** (`!`, `!!` beyond core).
- **No multi-document streams** (`---` separators).
- **Duplicate mapping keys are an error** — never first-wins or last-wins.
- Depth and size caps as configured by the deployment (spec minimums apply).

Effectively: JSON wearing YAML's surface. Anything that cannot round-trip
byte-identically through the canonical form is rejected, not interpreted.

## Suite contract

### `pairs/`

Each `NNN-name.yaml` / `NNN-name.json` pair MUST normalize to **identical
canonical bytes**, and therefore identical `sourceQueryHash` values. The
`.json` file is written close to canonical form for readability, but the
comparison is always *post-normalization* (defined key order, defaults NOT
materialized here — fixture pairs are compared pre-catalog, as pure
encodings): `normalize(yaml) == normalize(json)`, byte for byte.

| Pair | What it pins |
|---|---|
| `001-aggregate` | block-style YAML ≡ JSON for a typical aggregate query |
| `002-retrieve` | search block, quoted free text |
| `003-boolean-tree` | nested `and`/`or`/`not`, mixed block and flow style |
| `004-tricky-scalars` | `"no"`, `"on"`, `"3.10"`, `"true"`, `""`, Unicode stay strings under quoting; 1.2-core scalar rules |
| `005-ingest-put` | the Ingest surface uses the same encodings as queries |
| `006-flow-style` | entirely flow-style YAML is still the same document |

### `reject/`

Each fixture MUST be refused at the encoding layer with the error code named
in its `# EXPECT:` header — a typed, deterministic rejection (same file,
same code, every implementation), never a parse that silently drops or
reinterprets the offending construct:

| Fixture | Expected code |
|---|---|
| `anchors-aliases.yaml` | `ENCODING_ANCHOR_FORBIDDEN` |
| `alias-bomb.yaml` | `ENCODING_ANCHOR_FORBIDDEN` (dies at the rule, not at expansion) |
| `merge-keys.yaml` | `ENCODING_MERGE_KEY_FORBIDDEN` |
| `duplicate-keys.yaml` | `ENCODING_DUPLICATE_KEY` |
| `multi-document.yaml` | `ENCODING_MULTIDOC_FORBIDDEN` |
| `custom-tags.yaml` | `ENCODING_TAG_FORBIDDEN` |

## Running

The reference normalizer and harness live with the engine implementation
(not yet built). A conforming implementation runs this suite in CI: all
pairs equal, all rejects refused with the expected codes. Adding an
encoding, or touching the normalizer, requires extending this corpus in the
same change.
