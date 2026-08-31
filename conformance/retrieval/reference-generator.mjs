import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEED = 0xa6c1e57d;
const RECORD_COUNT = 1024;
const DIMENSION = 8;
const QUERY_COUNT = 64;
const K = 10;
const CORPUS_RELATIVE_PATH = "corpora/deterministic-v1-seed-a6c1e57d.json";

class XorShift32 {
  constructor(seed) {
    if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff) {
      throw new Error("xorshift32 seed must be a non-zero unsigned 32-bit integer");
    }
    this.state = seed >>> 0;
  }

  nextU32() {
    let value = this.state;
    value = (value ^ ((value << 13) >>> 0)) >>> 0;
    value = (value ^ (value >>> 17)) >>> 0;
    value = (value ^ ((value << 5) >>> 0)) >>> 0;
    this.state = value;
    return value;
  }
}

const pad = (value, width) => String(value).padStart(width, "0");
const component = (word) => (word % 2001) - 1000;
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
const compareId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function assignBySelector(rows, selector, emittedField, take) {
  const selected = new Set(
    [...rows]
      .sort((left, right) => left[selector] - right[selector] || compareId(left.id, right.id))
      .slice(0, take)
      .map((row) => row.id),
  );
  for (const row of rows) row[emittedField] = selected.has(row.id);
}

function generateCorpus() {
  const random = new XorShift32(SEED);
  const provisional = [];
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const id = `r${pad(index, 4)}`;
    const selector50 = random.nextU32();
    const selector10 = random.nextU32();
    const selector1 = random.nextU32();
    const selectorSparseA = random.nextU32();
    const selectorSparseB = random.nextU32();
    const tenant = `t${pad(random.nextU32() % 16, 2)}`;
    const topic = `topic${random.nextU32() % 8}`;
    const vector = Array.from({ length: DIMENSION }, () => component(random.nextU32()));
    provisional.push({ id, selector50, selector10, selector1, selectorSparseA, selectorSparseB, tenant, topic, vector });
  }

  assignBySelector(provisional, "selector50", "filter50", 512);
  assignBySelector(provisional, "selector10", "filter10", 102);
  assignBySelector(provisional, "selector1", "filter1", 10);
  assignBySelector(provisional, "selectorSparseA", "sparseA", 64);
  assignBySelector(provisional, "selectorSparseB", "sparseB", 64);

  const records = provisional.map((row) => ({
    id: row.id,
    tenant: row.tenant,
    topic: row.topic,
    filter50: row.filter50,
    filter10: row.filter10,
    filter1: row.filter1,
    sparseA: row.sparseA,
    sparseB: row.sparseB,
    text: `document ${row.id} ${row.topic}`,
    vector: row.vector,
  }));

  const queries = Array.from({ length: QUERY_COUNT }, (_, index) => ({
    id: `q${pad(index, 3)}`,
    text: `fixture query q${pad(index, 3)}`,
    vector: Array.from({ length: DIMENSION }, () => component(random.nextU32())),
  }));

  return {
    format: "agql-retrieval-corpus/1",
    generator: {
      algorithm: "xorshift32-v1",
      seedHex: "a6c1e57d",
      recordCount: RECORD_COUNT,
      queryCount: QUERY_COUNT,
      dimension: DIMENSION,
    },
    embedding: {
      specReference: "fixture-body@1",
      metric: "dot-product-descending-int-v1",
      vectorEncoding: "signed-integer-json-array-v1",
      note: "Corpus-oracle representation; the adapter binding maps it to its certified runtime vector encoding.",
    },
    records,
    queries,
  };
}

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);

function makeFixture(corpus, corpusDigest, definition) {
  const eligible = corpus.records.filter(definition.eligible).map((record) => record.id);
  const exactTopKByQuery = corpus.queries.map((query) => ({
    queryId: query.id,
    ids: corpus.records
      .filter(definition.eligible)
      .map((record) => ({ id: record.id, score: dot(record.vector, query.vector) }))
      .sort((left, right) => right.score - left.score || compareId(left.id, right.id))
      .slice(0, K)
      .map((entry) => entry.id),
  }));

  return {
    format: "agql-retrieval-fixture/0.1",
    id: definition.id,
    rfc: ["§5", "§6", "§9", "§11"],
    rule: definition.rule,
    corpus: { path: CORPUS_RELATIVE_PATH, sha256: corpusDigest },
    catalog: {
      dataset: "retrieval_items",
      idField: "retrieval_items.id",
      embeddingSpec: "fixture-body@1",
      fields: ["retrieval_items.id", "retrieval_items.tenant", "retrieval_items.topic", "retrieval_items.filter50", "retrieval_items.filter10", "retrieval_items.filter1", "retrieval_items.sparseA", "retrieval_items.sparseB", "retrieval_items.text"],
    },
    scope: { principal: "fixture:retrieval-reader", partitions: { "retrieval_items.tenant": Array.from({ length: 16 }, (_, index) => `t${pad(index, 2)}`) }, capabilities: ["retrieve.semantic.v0", "semanticSearch:fixture-body@1"] },
    family: { selectivityClass: definition.selectivityClass, predicate: definition.predicate, queryIds: corpus.queries.map((query) => query.id), take: K, accuracy: "approximate", qualityProfile: "baseline-unset-v0" },
    queryTemplate: { version: "0", mode: "retrieve", from: "retrieval_items", select: ["retrieval_items.id"], search: { kind: "semantic", using: "fixture-body@1", textFromCorpusQuery: true, accuracy: "approximate", quality: "baseline-unset-v0" }, where: definition.predicate, take: K },
    oracle: { eligibleCount: eligible.length, eligibleIds: eligible, exactMetric: "dot-product-descending-int-v1", exactTieBreak: "stable id ascending", exactTopKByQuery },
    invariant: "Every returned id is in eligibleIds; no duplicate or padding id is permitted. Recall is measured only after this zero-tolerance invariant passes.",
  };
}

function buildOutputs() {
  const corpus = generateCorpus();
  const corpusBytes = jsonBytes(corpus);
  const corpusDigest = sha256(corpusBytes);
  const definitions = [
    { path: "fixtures/filter-50.json", id: "retrieval.filter-selectivity-50", selectivityClass: "approximately-50-percent", predicate: { kind: "predicate", field: "retrieval_items.filter50", op: "eq", value: true }, eligible: (row) => row.filter50, rule: "Approximate retrieval is measured over an exactly known half-corpus eligible set." },
    { path: "fixtures/filter-10.json", id: "retrieval.filter-selectivity-10", selectivityClass: "approximately-10-percent", predicate: { kind: "predicate", field: "retrieval_items.filter10", op: "eq", value: true }, eligible: (row) => row.filter10, rule: "Approximate retrieval is measured over an exactly known ten-percent eligible set." },
    { path: "fixtures/filter-1.json", id: "retrieval.filter-selectivity-1", selectivityClass: "approximately-1-percent", predicate: { kind: "predicate", field: "retrieval_items.filter1", op: "eq", value: true }, eligible: (row) => row.filter1, rule: "Approximate retrieval is measured over an exactly known one-percent eligible set without padding." },
    { path: "fixtures/sparse-intersection.json", id: "retrieval.filter-sparse-intersection", selectivityClass: "sparse-independent-intersection", predicate: { kind: "and", items: [{ kind: "predicate", field: "retrieval_items.sparseA", op: "eq", value: true }, { kind: "predicate", field: "retrieval_items.sparseB", op: "eq", value: true }] }, eligible: (row) => row.sparseA && row.sparseB, rule: "A sparse conjunction has an exact eligible set and is never padded with near but ineligible neighbours." },
  ];
  const outputs = new Map([[CORPUS_RELATIVE_PATH, corpusBytes]]);
  const fixtureManifest = [];
  for (const definition of definitions) {
    const fixture = makeFixture(corpus, corpusDigest, definition);
    const bytes = jsonBytes(fixture);
    outputs.set(definition.path, bytes);
    fixtureManifest.push({ path: definition.path, sha256: sha256(bytes), eligibleCount: fixture.oracle.eligibleCount, queryCount: fixture.family.queryIds.length, k: K });
  }
  const manifest = {
    format: "agql-retrieval-manifest/1",
    rule: "These exact bytes are the pinned retrieval corpus and eligible-set/top-k oracle for RFC §11.",
    generatorSpec: "generator-spec.json",
    generator: "reference-generator.mjs",
    corpus: { path: CORPUS_RELATIVE_PATH, sha256: corpusDigest, records: RECORD_COUNT, queries: QUERY_COUNT, dimension: DIMENSION },
    fixtures: fixtureManifest,
  };
  outputs.set("manifest.json", jsonBytes(manifest));
  return outputs;
}

function write(outputs) {
  for (const [relativePath, bytes] of outputs) {
    const absolutePath = join(ROOT, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, bytes, "utf8");
  }
}

function check(outputs) {
  const mismatches = [];
  for (const [relativePath, expected] of outputs) {
    let actual;
    try {
      actual = readFileSync(join(ROOT, relativePath), "utf8");
    } catch {
      mismatches.push(`${relativePath}: missing`);
      continue;
    }
    if (actual !== expected) mismatches.push(`${relativePath}: bytes differ`);
  }
  if (mismatches.length > 0) throw new Error(`Retrieval corpus check failed:\n${mismatches.join("\n")}`);
}

const mode = process.argv[2];
const outputs = buildOutputs();
if (mode === "--write") {
  write(outputs);
  process.stdout.write(`wrote ${outputs.size} deterministic files\n`);
} else if (mode === "--check") {
  check(outputs);
  process.stdout.write(`verified ${outputs.size} deterministic files\n`);
} else {
  throw new Error("usage: node conformance/retrieval/reference-generator.mjs --write|--check");
}
