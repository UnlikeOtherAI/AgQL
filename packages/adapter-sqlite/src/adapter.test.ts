import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteAdapter,
  provisionSqliteAdapterStorage,
} from './index.ts';
import type {
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  LogicalPlanForProfile,
  QueryVectorDigest,
  ResolvedDatasetBinding,
  ResolvedFieldBinding,
  RuntimeOwnedVector,
} from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import type {
  EffectivePlanHash,
  SafeInteger,
  ScopeFingerprint,
  SourceQueryHash,
} from '@agql/schemas';

const tableName = 'r"; DROP TABLE sentinel; --';
const idName = 'id"; DROP TABLE sentinel; --';
const tenantName = 'tenant" OR 1 = 1 --';
const amountName = 'amount"; DROP TABLE sentinel; --';
const bodyName = 'body"; DROP TABLE sentinel; --';
const vectorName = 'vector"; DROP TABLE sentinel; --';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function dataset(): ResolvedDatasetBinding {
  return { logicalId: 'records', physical: physical(tableName), bindingVersion: 'binding-test-v1' };
}

const idField: ResolvedFieldBinding = {
  logicalId: 'records.id',
  physical: physical(idName),
  type: { kind: 'id' },
  nullable: false,
};

const tenantField: ResolvedFieldBinding = {
  logicalId: 'records.tenant',
  physical: physical(tenantName),
  type: { kind: 'enum', codes: ['north', 'south'] },
  nullable: false,
};

const amountField: ResolvedFieldBinding = {
  logicalId: 'records.amount',
  physical: physical(amountName),
  type: { kind: 'decimal' },
  nullable: false,
};

const bodyField: ResolvedFieldBinding = {
  logicalId: 'records.body',
  physical: physical(bodyName),
  type: { kind: 'text', collation: { id: 'unicode-codepoint-v0', version: '1' } },
  nullable: false,
};

function vectorField(): CatalogPhysicalIdentifier {
  return physical(vectorName);
}

function sourceHash(): SourceQueryHash {
  return 'source-test' as SourceQueryHash;
}

function planHash(): EffectivePlanHash {
  return 'plan-test' as EffectivePlanHash;
}

function scopeHash(): ScopeFingerprint {
  return 'scope-test' as ScopeFingerprint;
}

function decimal(value: string) {
  return CanonicalDecimalSchema.parse(value);
}

function recordsPlan(tenant: 'north' | 'south'): LogicalPlanForProfile<'records.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: sourceHash(),
    effectivePlanHash: planHash(),
    dataset: dataset(),
    scope: {
      visibility: 'predicate',
      enforcement: 'mandatoryPushdown',
      predicates: [{
        kind: 'comparison',
        field: tenantField,
        op: 'eq',
        value: { kind: 'enum', value: tenant },
      }],
    },
    filter: {
      kind: 'substring',
      field: bodyField,
      op: 'contains',
      value: NormalizedTextSchema.parse('note'),
      semantics: 'escaped-case-sensitive-substring',
    },
    hardRowLimit: safe(100),
    take: safe(20),
    mode: 'records',
    profile: 'records.v0',
    projection: [
      { output: { logicalId: 'id', slot: safe(0) }, field: idField },
      { output: { logicalId: 'amount', slot: safe(1) }, field: amountField },
      { output: { logicalId: 'tenant', slot: safe(2) }, field: tenantField },
    ],
    order: [{ field: amountField, direction: 'asc', nulls: 'last' }],
    tieBreak: {
      kind: 'recordId',
      order: { field: idField, direction: 'asc', nulls: 'last' },
    },
  };
}

function aggregatePlan(): LogicalPlanForProfile<'aggregate.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: sourceHash(),
    effectivePlanHash: planHash(),
    dataset: dataset(),
    scope: {
      visibility: 'predicate',
      enforcement: 'mandatoryPushdown',
      predicates: [{
        kind: 'list',
        field: tenantField,
        op: 'in',
        values: [{ kind: 'enum', value: 'north' }, { kind: 'enum', value: 'south' }],
      }],
    },
    hardRowLimit: safe(100),
    take: safe(10),
    mode: 'aggregate',
    profile: 'aggregate.v0',
    dimensions: [{
      kind: 'field',
      output: { logicalId: 'tenant', slot: safe(0) },
      field: tenantField,
    }],
    metrics: [
      {
        kind: 'aggregate',
        output: { logicalId: 'sum', slot: safe(1) },
        aggregate: { op: 'sum', field: amountField },
      },
      {
        kind: 'aggregate',
        output: { logicalId: 'count', slot: safe(2) },
        aggregate: { op: 'count' },
      },
    ],
    order: [{ output: { logicalId: 'tenant', slot: safe(0) }, direction: 'asc', nulls: 'last' }],
    tieBreak: { kind: 'dimensionTuple', fields: [tenantField] },
  };
}

function littleEndianFloat32(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true);
  return bytes;
}

function runtimeVector(values: readonly number[]): RuntimeOwnedVector {
  return {
    bytes: littleEndianFloat32(values),
    encoding: 'float32',
    dimension: safe(values.length),
    digest: 'query-vector-test' as QueryVectorDigest,
  };
}

function semanticPlan(tenant: 'north' | 'south'): LogicalPlanForProfile<'retrieve.semantic.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: sourceHash(),
    effectivePlanHash: planHash(),
    dataset: dataset(),
    scope: {
      visibility: 'predicate',
      enforcement: 'mandatoryPushdown',
      predicates: [{
        kind: 'comparison',
        field: tenantField,
        op: 'eq',
        value: { kind: 'enum', value: tenant },
      }],
    },
    hardRowLimit: safe(100),
    take: safe(2),
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
        physical: vectorField(),
        dimension: safe(2),
        metric: 'cosine',
        vectorEncoding: 'float32',
        model: { id: 'fixture', revision: 'sha256:fixture' },
        inputTransformId: 'fixture-v1',
        privacyClass: 'internal',
      },
      vector: runtimeVector([1, 0]),
      accuracy: 'exact',
      qualityProfile: 'exact-reference',
      hardCandidateLimit: safe(20),
    },
  };
}

async function temporaryDatabase(): Promise<{
  readonly path: string;
  readonly dispose: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agql-sqlite-'));
  const path = join(directory, 'reference.sqlite');
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}

function createSchema(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE ${sqlIdentifier('sentinel')} (value TEXT) STRICT`);
    database.exec(
      `CREATE TABLE ${sqlIdentifier(tableName)} (`
        + `${sqlIdentifier(idName)} TEXT PRIMARY KEY, `
        + `${sqlIdentifier(tenantName)} TEXT NOT NULL, `
        + `${sqlIdentifier(amountName)} TEXT NOT NULL, `
        + `${sqlIdentifier(bodyName)} TEXT NOT NULL, `
        + `${sqlIdentifier(vectorName)} BLOB, `
        + '"__agql_version" INTEGER NOT NULL, '
        + '"__agql_deleted" INTEGER NOT NULL) STRICT',
    );
  } finally {
    database.close();
  }
}

function seed(path: string): ReadonlyMap<string, 'north' | 'south'> {
  const database = new DatabaseSync(path);
  const tenancy = new Map<string, 'north' | 'south'>();
  try {
    const insert = database.prepare(
      `INSERT INTO ${sqlIdentifier(tableName)} VALUES (?, ?, ?, ?, ?, 1, 0)`,
    );
    const rows: readonly [string, 'north' | 'south', string, string, readonly number[]][] = [
      ["x'); DROP TABLE sentinel; --", 'north', '-10', 'literal [note] one', [5, 0]],
      ['north-two', 'north', '-2', 'literal [note] two', [4, 3]],
      ['north-three', 'north', '-0.5', 'literal [note] three', [4, -3]],
      ['south-one', 'south', '0.25', 'literal [note] four', [0, 5]],
      ['south-two', 'south', '2', 'other sentence', [-5, 0]],
    ];
    for (const [id, tenant, amount, body, vector] of rows) {
      insert.run(id, tenant, amount, body, littleEndianFloat32(vector));
      tenancy.set(id, tenant);
    }
  } finally {
    database.close();
  }
  return tenancy;
}

function adapter(path: string) {
  return createSqliteAdapter({
    databasePath: path,
    exactScanAdmissionLimit: safe(20),
    supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '1' }],
    id: 'sqlite-reference',
    version: 'test-v1',
  });
}

function success<T>(outcome: { readonly kind: string; readonly value?: T }): T {
  assert.equal(outcome.kind, 'success');
  if (outcome.kind !== 'success' || outcome.value === undefined) {
    throw new Error('Expected success.');
  }
  return outcome.value;
}

test('records and aggregate quote identifiers, bind values, and keep exact decimals', async () => {
  const temporary = await temporaryDatabase();
  try {
    createSchema(temporary.path);
    seed(temporary.path);
    const sqlite = adapter(temporary.path);
    const compiled = success(await sqlite.query.compile(recordsPlan('north')));
    const records = success(await sqlite.query.execute(compiled));
    assert.deepEqual(records.rows.map((row) => row.map((value) => value.value)), [
      ["x'); DROP TABLE sentinel; --", '-10', 'north'],
      ['north-two', '-2', 'north'],
      ['north-three', '-0.5', 'north'],
    ]);
    const aggregate = success(await sqlite.query.compile(aggregatePlan()));
    const grouped = success(await sqlite.query.execute(aggregate));
    assert.deepEqual(grouped.rows.map((row) => row.map((value) => value.value)), [
      ['north', '-12.5', 3],
      ['south', '2.25', 2],
    ]);
    const database = new DatabaseSync(temporary.path, { readOnly: true });
    try {
      const sentinel = database.prepare(
        `SELECT COUNT(*) AS count FROM ${sqlIdentifier('sentinel')}`,
      ).get();
      assert.equal(sentinel?.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await temporary.dispose();
  }
});

test('randomized records and semantic scopes never return another partition', async () => {
  const temporary = await temporaryDatabase();
  try {
    createSchema(temporary.path);
    const tenancy = seed(temporary.path);
    const sqlite = adapter(temporary.path);
    let state = 0x6d2b79f5;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const tenant: 'north' | 'south' = (state >>> 0) % 2 === 0 ? 'north' : 'south';
      const records = success(await sqlite.query.execute(
        success(await sqlite.query.compile(recordsPlan(tenant))),
      ));
      for (const row of records.rows) {
        const id = row[0];
        assert.equal(id?.kind, 'id');
        if (id?.kind === 'id') assert.equal(tenancy.get(id.value), tenant);
      }
      const retrieval = success(await sqlite.query.execute(
        success(await sqlite.query.compile(semanticPlan(tenant))),
      ));
      for (const row of retrieval.rows) {
        const id = row[0];
        assert.equal(id?.kind, 'id');
        if (id?.kind === 'id') assert.equal(tenancy.get(id.value), tenant);
      }
    }
    const narrow = semanticPlan('north');
    const overAdmission: LogicalPlanForProfile<'retrieve.semantic.v0'> = {
      ...narrow,
      search: { ...narrow.search, hardCandidateLimit: safe(2) },
    };
    const admission = await sqlite.query.execute(
      success(await sqlite.query.compile(overAdmission)),
    );
    assert.equal(admission.kind, 'refusal');
    if (admission.kind === 'refusal') {
      assert.equal(admission.refusal.code, 'EXACT_SCAN_BUDGET_EXCEEDED');
    }
  } finally {
    await temporary.dispose();
  }
});

test('canonical ingest provides CAS, idempotency, opaque receipts, and delete visibility',
  async () => {
  const temporary = await temporaryDatabase();
  try {
    createSchema(temporary.path);
    provisionSqliteAdapterStorage(temporary.path);
    const sqlite = adapter(temporary.path);
    const id = `new-${randomUUID()}`;
    const insert: CanonicalIngestPlan = {
      dataset: dataset(),
      idField,
      scopeFingerprint: scopeHash(),
      idempotencyKey: 'write-once',
      embeddingPolicy: 'catalog',
      mode: 'insertOnly',
      records: [{
        id,
        values: [
          { field: idField, value: { kind: 'id', value: id } },
          { field: tenantField, value: { kind: 'enum', value: 'north' } },
          { field: amountField, value: { kind: 'decimal', value: decimal('1.25') } },
          {
            field: bodyField,
            value: { kind: 'text', value: NormalizedTextSchema.parse('new note') },
          },
        ],
      }],
    };
    const first = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(insert)),
    ));
    const repeated = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(insert)),
    ));
    assert.deepEqual(repeated, first);
    assert.match(first.receipt, /^wr_/u);
    const state = first.records[0]?.visibility.record;
    assert.equal(state?.state, 'ready');
    if (state?.state === 'ready') assert.doesNotMatch(state.token, /DROP|sqlite|table/u);
    const visibility = sqlite.visibility;
    if (visibility === undefined) {
      throw new Error('SQLite adapter must expose visibility observation.');
    }
    const observed = success(await visibility.observe({
      receipt: first.receipt,
      require: ['record'],
      timeoutMs: safe(0),
      anchor: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
    }));
    assert.equal(observed.receipt, first.receipt);
    const replace: CanonicalIngestPlan = {
      ...insert,
      mode: 'replace',
      idempotencyKey: 'replace',
      records: [{
        id,
        ifVersion: safe(1),
        values: [
          { field: idField, value: { kind: 'id', value: id } },
          { field: tenantField, value: { kind: 'enum', value: 'north' } },
          { field: amountField, value: { kind: 'decimal', value: decimal('2.5') } },
          {
            field: bodyField,
            value: { kind: 'text', value: NormalizedTextSchema.parse('replaced note') },
          },
        ],
      }],
    };
    const replaced = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(replace)),
    ));
    assert.equal(replaced.records[0]?.version, 2);
    const deleted: CanonicalIngestPlan = {
      ...insert,
      mode: 'delete',
      idempotencyKey: 'delete',
      records: [{ id, ifVersion: safe(2) }],
    };
    success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(deleted)),
    ));
    const north = success(await sqlite.query.execute(
      success(await sqlite.query.compile(recordsPlan('north'))),
    ));
    assert.equal(north.rows.some((row) => row[0]?.kind === 'id' && row[0].value === id), false);
  } finally {
    await temporary.dispose();
  }
});
