import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AdapterDescriptor,
  CanonicalIngestPlan,
  VisibilityToken,
  WriteReceiptId,
} from '@agql/contracts';
import type { CapabilityProfile } from '@agql/schemas';
import {
  CatalogDocumentSchema,
  InstantValueSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import { ScopeSchema } from '@agql/catalog';

import type { EngineIngestAdapter } from './ingest-execution.ts';
import { executeIngest } from './ingest-execution.ts';
import { compileIngest } from './ingest.ts';
import {
  binding,
  catalog,
  scope,
} from './test-fixtures.ts';
import type {
  CompileIngestInput,
  EngineResult,
} from './types.ts';

const profiles = ['ingest.canonical.v0'] as const satisfies readonly CapabilityProfile[];

const descriptor: AdapterDescriptor<typeof profiles> = {
  id: 'ingest-adapter',
  version: '1',
  profiles,
  consistency: {
    afterWrite: 'certified',
    snapshots: ['none'],
    compareAndSwap: true,
  },
};

const completeValue = {
  'docs.tenant': 'a',
  'docs.title': 'Title',
  'docs.body': 'Body',
  'docs.secret': 'Secret',
  'docs.created': '2024-01-01T00:00:00Z',
  'docs.qty': 2,
  'docs.amount': { amount: '10.5', currency: 'USD' },
} as const;

const insert = {
  dataset: 'docs',
  mode: 'insertOnly',
  idempotencyKey: 'idem-1',
  embeddingPolicy: 'catalog',
  records: [{ id: 'doc-1', value: completeValue }],
} as const;

function input(document: unknown): CompileIngestInput {
  return {
    document,
    catalog,
    scope,
    anchor: InstantValueSchema.parse('2024-01-01T00:00:00Z'),
    binding,
    adapter: descriptor,
  };
}

function success<T>(result: EngineResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

function firstError<T>(result: EngineResult<T>) {
  if (result.ok) assert.fail('Expected a refusal.');
  return result.errors[0];
}

test('insertOnly compiles a complete typed record and preserves idempotency', () => {
  const compiled = success(compileIngest(input(insert)));
  assert.equal(compiled.plan.mode, 'insertOnly');
  assert.equal(compiled.plan.idempotencyKey, 'idem-1');
  assert.equal(compiled.plan.embeddingPolicy, 'catalog');
  assert.equal(compiled.plan.records[0].id, 'doc-1');
  assert.equal(compiled.plan.records[0].values.length, 8);
  const stableId = compiled.plan.records[0].values.find(({ field }) =>
    field.logicalId === 'docs.id');
  assert.deepEqual(stableId?.value, { kind: 'id', value: 'doc-1' });
  const amount = compiled.plan.records[0].values.find(({ field }) =>
    field.logicalId === 'docs.amount');
  assert.deepEqual(amount?.value, {
    kind: 'money',
    value: { amount: '10.5', currency: 'USD' },
  });
});

test('whole-record replace rejects missing fields and unsupported compare-and-swap', () => {
  const missing = compileIngest(input({
    dataset: 'docs',
    mode: 'replace',
    idempotencyKey: 'idem-2',
    embeddingPolicy: 'catalog',
    records: [{ id: 'doc-1', value: { 'docs.tenant': 'a' } }],
  }));
  assert.equal(firstError(missing)?.code, 'SEMANTIC_INVALID');
  assert.match(firstError(missing)?.message ?? '', /Whole-record/u);

  const noCas = compileIngest({
    ...input({
      dataset: 'docs',
      mode: 'replace',
      idempotencyKey: 'idem-3',
      embeddingPolicy: 'catalog',
      records: [{ id: 'doc-1', ifVersion: 1, value: completeValue }],
    }),
    adapter: {
      ...descriptor,
      consistency: { ...descriptor.consistency, compareAndSwap: false },
    },
  });
  assert.equal(firstError(noCas)?.code, 'UNSUPPORTED_PROFILE');
});

test('partitioned deletes carry adapter predicates while out-of-scope writes refuse', () => {
  const outside = compileIngest(input({
    ...insert,
    records: [{ id: 'doc-2', value: { ...completeValue, 'docs.tenant': 'b' } }],
  }));
  assert.equal(firstError(outside)?.code, 'SCOPE_UNENFORCEABLE');

  const deletion = compileIngest(input({
    dataset: 'docs',
    mode: 'delete',
    idempotencyKey: 'idem-delete',
    embeddingPolicy: 'catalog',
    records: [{ id: 'doc-1', ifVersion: 2 }],
  }));
  const compiledDelete = success(deletion);
  assert.equal(compiledDelete.plan.mode, 'delete');
  assert.equal(compiledDelete.plan.scope.visibility, 'predicate');
  if (compiledDelete.plan.scope.visibility === 'predicate') {
    assert.equal(compiledDelete.plan.scope.enforcement, 'mandatoryPushdown');
  }
});

test('delete compiles when its unpartitioned scope is enforceable and merge is rejected', () => {
  const docs = catalog.datasets.docs;
  if (docs === undefined) assert.fail('Fixture catalog is missing docs.');
  const unpartitionedCatalog = CatalogDocumentSchema.parse({
    ...catalog,
    datasets: {
      docs: {
        ...docs,
        rowScope: { kind: 'none', reason: 'Unpartitioned deletion fixture.' },
      },
    },
  });
  const unpartitionedScope = ScopeSchema.parse({
    ...scope,
    partitions: { kind: 'unpartitioned' },
  });
  const deletion = success(compileIngest({
    ...input({
      dataset: 'docs',
      mode: 'delete',
      idempotencyKey: 'idem-delete',
      embeddingPolicy: 'catalog',
      records: [{ id: 'doc-1', ifVersion: 2 }],
    }),
    catalog: unpartitionedCatalog,
    scope: unpartitionedScope,
  }));
  assert.equal(deletion.plan.mode, 'delete');
  assert.equal(deletion.plan.records[0].ifVersion, 2);

  const merge = compileIngest(input({
    dataset: 'docs',
    mode: 'merge',
    idempotencyKey: 'idem-merge',
    embeddingPolicy: 'catalog',
    records: [],
  }));
  assert.equal(firstError(merge)?.code, 'UNSUPPORTED_IN_V0');
});

test('ingest execution returns one validated record outcome plus the batch receipt', async () => {
  const token = 'opaque-token' as VisibilityToken;
  const adapter: EngineIngestAdapter<string> = {
    descriptor,
    canonicalIngest: {
      compile(plan: CanonicalIngestPlan) {
        assert.equal(plan.mode, 'insertOnly');
        return Promise.resolve({ kind: 'success', value: 'native-write' });
      },
      execute(compiled: string) {
        assert.equal(compiled, 'native-write');
        return Promise.resolve({
          kind: 'success',
          value: {
            outcomes: [{
              id: 'doc-1', status: 'accepted', version: SafeIntegerSchema.parse(1), error: null,
            }],
            writeReceipt: {
              receipt: 'wr-insert' as WriteReceiptId,
              records: [{
                id: 'doc-1',
                version: SafeIntegerSchema.parse(1),
                visibility: {
                  record: { state: 'ready', token },
                  lexical: { state: 'accepted' },
                  'embedding:body@2': { state: 'pending' },
                },
              }],
            },
          },
        });
      },
    },
  };
  const result = success(await executeIngest(input(insert), adapter));
  assert.equal(result.writeReceipt.receipt, 'wr-insert');
  assert.equal(result.writeReceipt.records[0]?.visibility.record?.state, 'ready');
});
