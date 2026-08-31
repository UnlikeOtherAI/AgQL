import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type {
  AdapterOutcome,
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  LogicalFilter,
  LogicalPlanForProfile,
  QueryVectorDigest,
  ResolvedFieldBinding,
  ResolvedPredicate,
  RuntimeOwnedVector,
} from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
  compareDecimal,
} from '@agql/schemas';
import type {
  EffectivePlanHash,
  SafeInteger,
  ScopeFingerprint,
  SourceQueryHash,
} from '@agql/schemas';

import { createSqliteAdapter, provisionSqliteAdapterStorage } from './index.ts';

const scopeValue = "tenant' OR 1=1 --";

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

function decimal(value: string) {
  return CanonicalDecimalSchema.parse(value);
}

function success<T>(outcome: AdapterOutcome<T>): T {
  assert.equal(outcome.kind, 'success');
  if (outcome.kind !== 'success') throw new Error('Expected adapter success.');
  return outcome.value;
}

const dataset = {
  logicalId: 'records',
  physical: physical('records'),
  bindingVersion: 'binding-v1',
} as const;

const idField: ResolvedFieldBinding = {
  logicalId: 'records.id',
  physical: physical('id'),
  type: { kind: 'id' },
  nullable: false,
};

const tenantField: ResolvedFieldBinding = {
  logicalId: 'records.tenant',
  physical: physical('tenant'),
  type: { kind: 'enum', codes: [scopeValue, 'other'] },
  nullable: false,
};

const amountField: ResolvedFieldBinding = {
  logicalId: 'records.amount',
  physical: physical('amount'),
  type: { kind: 'decimal' },
  nullable: false,
};

const noteField: ResolvedFieldBinding = {
  logicalId: 'records.note',
  physical: physical('note'),
  type: { kind: 'text', collation: { id: 'unicode-codepoint-v0', version: '1' } },
  nullable: true,
};

const instantField: ResolvedFieldBinding = {
  logicalId: 'records.at',
  physical: physical('at'),
  type: { kind: 'instant', precision: 'second' },
  nullable: false,
};

function sourceHash(): SourceQueryHash {
  return 'source-exact-corners' as SourceQueryHash;
}

function planHash(): EffectivePlanHash {
  return 'plan-exact-corners' as EffectivePlanHash;
}

function scopeHash(): ScopeFingerprint {
  return 'scope-exact-corners' as ScopeFingerprint;
}

function scope() {
  return {
    visibility: 'predicate',
    enforcement: 'mandatoryPushdown',
    predicates: [{
      kind: 'comparison',
      field: tenantField,
      op: 'eq',
      value: { kind: 'enum', value: scopeValue },
    }],
  } as const;
}

function recordsPlan(
  filter?: LogicalFilter<ResolvedPredicate>,
): LogicalPlanForProfile<'records.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: sourceHash(),
    effectivePlanHash: planHash(),
    dataset,
    scope: scope(),
    ...(filter === undefined ? {} : { filter }),
    hardRowLimit: safe(100),
    take: safe(50),
    mode: 'records',
    profile: 'records.v0',
    projection: [{ output: { logicalId: 'id', slot: safe(0) }, field: idField }],
    order: [{ field: amountField, direction: 'asc' }],
    tieBreak: {
      kind: 'recordId',
      order: { field: idField, direction: 'asc' },
    },
  };
}

function bytes(values: readonly number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true);
  return output;
}

function queryVector(): RuntimeOwnedVector {
  return {
    bytes: bytes([1, 0]),
    encoding: 'float32',
    dimension: safe(2),
    digest: 'vector-exact-corners' as QueryVectorDigest,
  };
}

function semanticPlan(
  table: string,
  embedding: string,
  candidateLimit: number,
  emptyScope = false,
): LogicalPlanForProfile<'retrieve.semantic.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: sourceHash(),
    effectivePlanHash: planHash(),
    dataset: { ...dataset, physical: physical(table) },
    scope: emptyScope ? { visibility: 'nothing' } : scope(),
    hardRowLimit: safe(100),
    take: safe(candidateLimit),
    mode: 'retrieve',
    profile: 'retrieve.semantic.v0',
    projection: [{ output: { logicalId: 'id', slot: safe(0) }, field: idField }],
    stableId: idField,
    search: {
      kind: 'semantic',
      embedding: {
        name: 'body',
        specReference: 'body@1',
        specVersion: '1',
        physical: physical(embedding),
        dimension: safe(2),
        metric: 'cosine',
        vectorEncoding: 'float32',
        model: { id: 'fixture', revision: 'sha256:fixture' },
        inputTransformId: 'fixture-v1',
        privacyClass: 'internal',
      },
      vector: queryVector(),
      accuracy: 'exact',
      qualityProfile: 'exact-reference',
      hardCandidateLimit: safe(candidateLimit),
    },
  };
}

async function temporaryDatabase(): Promise<{
  readonly path: string;
  readonly dispose: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agql-sqlite-corners-'));
  return {
    path: join(directory, 'reference.sqlite'),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

function createDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      'CREATE TABLE records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, amount TEXT NOT NULL,'
        + ' note TEXT, at TEXT NOT NULL, vector BLOB, __agql_version INTEGER NOT NULL,'
        + ' __agql_deleted INTEGER NOT NULL) STRICT',
    );
    const insert = database.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, 1, 0)');
    const rows: readonly [string, string, string, string | null, string][] = [
      ['d-neg-ten', scopeValue, '-10', null, '2024-01-01T00:00:00Z'],
      ['d-neg-two', scopeValue, '-2', 'literal %_[]', '2024-01-01T00:30:00Z'],
      ['d-neg-half', scopeValue, '-0.5', 'prefix%_ tail', '2024-01-01T01:00:00Z'],
      ['d-zero', scopeValue, '0', 'end', '2024-01-01T02:00:00Z'],
      ['d-two', scopeValue, '2', 'Case', '2024-01-01T03:00:00Z'],
      ['d-ten', scopeValue, '10', 'case', '2024-01-01T04:00:00Z'],
      ['hidden', 'other', '-100', 'literal %_[]', '2024-01-01T00:30:00Z'],
    ];
    for (const row of rows) insert.run(...row, bytes([1, 0]));
    database.exec(
      'CREATE TABLE semantic_records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, vector BLOB,'
        + ' __agql_version INTEGER NOT NULL, __agql_deleted INTEGER NOT NULL) STRICT',
    );
    const semantic = database.prepare('INSERT INTO semantic_records VALUES (?, ?, ?, 1, 0)');
    semantic.run('\uE000', scopeValue, bytes([1, 0]));
    semantic.run('😀', scopeValue, bytes([1, 0]));
  } finally {
    database.close();
  }
}

function adapter(path: string) {
  return createSqliteAdapter({
    databasePath: path,
    exactScanAdmissionLimit: safe(100),
    supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '1' }],
    id: 'sqlite-reference',
    version: 'test-v1',
  });
}

function ids(rows: readonly (readonly { readonly kind: string; readonly value: unknown }[])[]) {
  return rows.map((row) => row[0]?.value);
}

test('bound predicates preserve exact decimal, null, literal text, and range semantics',
  async () => {
  const temporary = await temporaryDatabase();
  try {
    createDatabase(temporary.path);
    const sqlite = adapter(temporary.path);
    const values = ['-10', '-2', '-0.5', '0', '2', '10'].map(decimal);
    const rowIds = ['d-neg-ten', 'd-neg-two', 'd-neg-half', 'd-zero', 'd-two', 'd-ten'];
    for (const op of ['lt', 'lte', 'gt', 'gte'] as const) {
      const threshold = decimal('-2');
      const compiled = success(await sqlite.query.compile(recordsPlan({
        kind: 'comparison', field: amountField, op, value: { kind: 'decimal', value: threshold },
      })));
      assert.equal(compiled.kind, 'records');
      if (compiled.kind === 'records') assert.equal(compiled.sql.includes(scopeValue), false);
      const expected = rowIds.filter((_, index) => {
        const comparison = compareDecimal(values[index] ?? decimal('0'), threshold);
        if (op === 'lt') return comparison < 0;
        if (op === 'lte') return comparison <= 0;
        if (op === 'gt') return comparison > 0;
        return comparison >= 0;
      });
      assert.deepEqual(ids(success(await sqlite.query.execute(compiled)).rows), expected);
    }
    const literal = success(await sqlite.query.execute(success(await sqlite.query.compile(
      recordsPlan({
        kind: 'substring',
        field: noteField,
        op: 'contains',
        value: NormalizedTextSchema.parse('%_[]'),
        semantics: 'escaped-case-sensitive-substring',
      }),
    ))));
    assert.deepEqual(ids(literal.rows), ['d-neg-two']);
    const nullOnly = success(await sqlite.query.execute(success(await sqlite.query.compile(
      recordsPlan({
        kind: 'list',
        field: noteField,
        op: 'in',
        values: [{ kind: 'null', value: null }],
      }),
    ))));
    assert.deepEqual(ids(nullOnly.rows), ['d-neg-ten']);
    const range = success(await sqlite.query.execute(success(await sqlite.query.compile(
      recordsPlan({
        kind: 'instantRange',
        field: instantField,
        startInclusive: InstantValueSchema.parse('2024-01-01T00:30:00Z'),
        endExclusive: InstantValueSchema.parse('2024-01-01T02:00:00Z'),
        anchor: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
      }),
    ))));
    assert.deepEqual(ids(range.rows), ['d-neg-two', 'd-neg-half']);
  } finally {
    await temporary.dispose();
  }
});

test('semantic execution bounds admission, types missing indexes, and uses stable binary ids',
  async () => {
  const temporary = await temporaryDatabase();
  try {
    createDatabase(temporary.path);
    const sqlite = adapter(temporary.path);
    const plan = semanticPlan('semantic_records', 'vector', 2);
    const compiled = success(await sqlite.query.compile(plan));
    assert.equal(compiled.kind, 'semantic');
    if (compiled.kind === 'semantic') {
      assert.match(compiled.countSql, /SELECT 1[\s\S]*LIMIT \?/u);
      assert.equal(compiled.countParameters.at(-1), 3n);
    }
    const result = success(await sqlite.query.execute(compiled));
    assert.deepEqual(ids(result.rows), ['\uE000', '😀']);
    const missing = await sqlite.query.execute(success(await sqlite.query.compile(
      semanticPlan('records', 'missing_vector', 20),
    )));
    assert.equal(missing.kind, 'refusal');
    if (missing.kind === 'refusal') assert.equal(missing.refusal.code, 'EMBEDDING_NOT_INDEXED');
    const empty = success(await sqlite.query.execute(success(await sqlite.query.compile(
      semanticPlan('records', 'missing_vector', 20, true),
    ))));
    assert.deepEqual(empty.rows, []);
  } finally {
    await temporary.dispose();
  }
});

test('count-only aggregates compile and whole-record replacement clears derived vectors',
  async () => {
  const temporary = await temporaryDatabase();
  try {
    createDatabase(temporary.path);
    provisionSqliteAdapterStorage(temporary.path);
    const sqlite = adapter(temporary.path);
    const aggregate: LogicalPlanForProfile<'aggregate.v0'> = {
      languageVersion: '0',
      sourceQueryHash: sourceHash(),
      effectivePlanHash: planHash(),
      dataset,
      scope: scope(),
      hardRowLimit: safe(100),
      take: safe(1),
      mode: 'aggregate',
      profile: 'aggregate.v0',
      dimensions: [],
      metrics: [{
        kind: 'aggregate',
        output: { logicalId: 'count', slot: safe(0) },
        aggregate: { op: 'count' },
      }],
      order: [{ output: { logicalId: 'count', slot: safe(0) }, direction: 'asc' }],
      tieBreak: { kind: 'singleAggregateRow' },
    };
    const counted = success(await sqlite.query.execute(
      success(await sqlite.query.compile(aggregate)),
    ));
    assert.equal(counted.rows[0]?.[0]?.value, 6);
    const replace: CanonicalIngestPlan = {
      dataset,
      idField,
      scopeFingerprint: scopeHash(),
      scope: scope(),
      idempotencyKey: 'replace-clears-derived',
      embeddingPolicy: 'catalog',
      mode: 'replace',
      records: [{
        id: 'd-neg-two',
        ifVersion: safe(1),
        values: [
          { field: idField, value: { kind: 'id', value: 'd-neg-two' } },
          { field: tenantField, value: { kind: 'enum', value: scopeValue } },
          { field: amountField, value: { kind: 'decimal', value: decimal('-2') } },
          {
            field: noteField,
            value: { kind: 'text', value: NormalizedTextSchema.parse('replacement') },
          },
          {
            field: instantField,
            value: { kind: 'instant', value: InstantValueSchema.parse('2024-01-01T00:30:00Z') },
          },
        ],
      }],
    };
    success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(replace)),
    ));
    const database = new DatabaseSync(temporary.path, { readOnly: true });
    try {
      const row = database.prepare(
        'SELECT vector, __agql_version AS version FROM records WHERE id = ? LIMIT 1',
      ).get('d-neg-two');
      assert.equal(row?.vector, null);
      assert.equal(row?.version, 2);
    } finally {
      database.close();
    }
  } finally {
    await temporary.dispose();
  }
});

test('integer aggregation remains exact across unsafe intermediate mathematical sums',
  async () => {
  const temporary = await temporaryDatabase();
  try {
    createDatabase(temporary.path);
    const database = new DatabaseSync(temporary.path);
    try {
      database.exec(
        'CREATE TABLE integer_records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL,'
          + ' quantity INTEGER NOT NULL, __agql_version INTEGER NOT NULL,'
          + ' __agql_deleted INTEGER NOT NULL) STRICT',
      );
      const insert = database.prepare('INSERT INTO integer_records VALUES (?, ?, ?, 1, 0)');
      insert.run('maximum', scopeValue, Number.MAX_SAFE_INTEGER);
      insert.run('plus-one', scopeValue, 1);
      insert.run('minus-one', scopeValue, -1);
    } finally {
      database.close();
    }
    const quantity: ResolvedFieldBinding = {
      logicalId: 'integer_records.quantity',
      physical: physical('quantity'),
      type: { kind: 'integer' },
      nullable: false,
    };
    const plan: LogicalPlanForProfile<'aggregate.v0'> = {
      languageVersion: '0',
      sourceQueryHash: sourceHash(),
      effectivePlanHash: planHash(),
      dataset: { ...dataset, physical: physical('integer_records') },
      scope: scope(),
      hardRowLimit: safe(10),
      take: safe(1),
      mode: 'aggregate',
      profile: 'aggregate.v0',
      dimensions: [],
      metrics: [{
        kind: 'aggregate',
        output: { logicalId: 'sum', slot: safe(0) },
        aggregate: { op: 'sum', field: quantity },
      }],
      order: [{ output: { logicalId: 'sum', slot: safe(0) }, direction: 'asc' }],
      tieBreak: { kind: 'singleAggregateRow' },
    };
    const result = success(await adapter(temporary.path).query.execute(
      success(await adapter(temporary.path).query.compile(plan)),
    ));
    assert.equal(result.rows[0]?.[0]?.value, Number.MAX_SAFE_INTEGER);
  } finally {
    await temporary.dispose();
  }
});
