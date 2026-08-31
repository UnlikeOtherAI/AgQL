import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AdapterExecutionResult,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import {
  canonicalizeJcs,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';

import { compileQuery } from './compile.ts';
import type { EngineQueryAdapter } from './execution.ts';
import { executeQuery } from './execution.ts';
import {
  evaluateAfterWrite,
  validateVisibilityTransition,
} from './receipts.ts';
import { assembleResult } from './results.ts';
import { fuseRrfV0 } from './rrf.ts';
import {
  adapterDescriptor,
  compileInput,
  recordsQuery,
  scope,
  vector,
} from './test-fixtures.ts';
import type {
  ComponentTimings,
  EngineResult,
} from './types.ts';
function success<T>(result: EngineResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function errorCode<T>(result: EngineResult<T>): string {
  if (result.ok) assert.fail('Expected a refusal.');
  return result.errors[0]?.code ?? 'missing';
}
const timings: ComponentTimings = {
  authMs: SafeIntegerSchema.parse(1),
  validationPolicyMs: SafeIntegerSchema.parse(2),
  queryEmbeddingMs: SafeIntegerSchema.parse(0),
  adapterCompileMs: SafeIntegerSchema.parse(3),
  backendMs: SafeIntegerSchema.parse(4),
  fusionReleaseMs: SafeIntegerSchema.parse(1),
};
function adapter(
  calls: { compile: number; execute: number },
  execution: AdapterExecutionResult = {
    rows: [],
    truncated: false,
    snapshot: { kind: 'none' },
  },
): EngineQueryAdapter<string> {
  return {
    descriptor: adapterDescriptor,
    query: {
      compile() {
        calls.compile += 1;
        return Promise.resolve({ kind: 'success', value: 'native' });
      },
      execute() {
        calls.execute += 1;
        return Promise.resolve({ kind: 'success', value: execution });
      },
    },
  };
}
test('compile-time policy refusal never invokes the adapter', async () => {
  const calls = { compile: 0, execute: 0 };
  const result = await executeQuery(
    compileInput({ ...recordsQuery, select: ['docs.secret'] }),
    adapter(calls),
  );
  assert.equal(errorCode(result), 'REFERENCE_NOT_AVAILABLE');
  assert.deepEqual(calls, { compile: 0, execute: 0 });
});
test('empty partitions mean nothing visible and require no backend call', async () => {
  const calls = { compile: 0, execute: 0 };
  const result = success(await executeQuery({
    ...compileInput(recordsQuery),
    scope: { ...scope, partitions: { kind: 'nothing' } },
  }, adapter(calls)));
  assert.deepEqual(calls, { compile: 0, execute: 0 });
  assert.deepEqual(result.execution.rows, []);
  assert.equal(result.compiled.plan.scope.visibility, 'nothing');
});

test('rrf-v0 uses exact rank arithmetic and stable-id tie breaks', () => {
  const fused = success(fuseRrfV0(
    [
      { id: 'b', rank: SafeIntegerSchema.parse(1) },
      { id: 'a', rank: SafeIntegerSchema.parse(2) },
      { id: 'c', rank: SafeIntegerSchema.parse(3) },
    ],
    [
      { id: 'a', rank: SafeIntegerSchema.parse(1) },
      { id: 'b', rank: SafeIntegerSchema.parse(2) },
      { id: 'd', rank: SafeIntegerSchema.parse(3) },
    ],
    SafeIntegerSchema.parse(4),
    SafeIntegerSchema.parse(10_000),
  ));
  assert.equal(
    canonicalizeJcs(fused),
    '[{"id":"a","rank":1},{"id":"b","rank":2},'
      + '{"id":"c","rank":3},{"id":"d","rank":4}]',
  );
  const repeated = success(fuseRrfV0(
    [
      { id: 'b', rank: SafeIntegerSchema.parse(1) },
      { id: 'a', rank: SafeIntegerSchema.parse(2) },
      { id: 'c', rank: SafeIntegerSchema.parse(3) },
    ],
    [
      { id: 'a', rank: SafeIntegerSchema.parse(1) },
      { id: 'b', rank: SafeIntegerSchema.parse(2) },
      { id: 'd', rank: SafeIntegerSchema.parse(3) },
    ],
    SafeIntegerSchema.parse(4),
    SafeIntegerSchema.parse(10_000),
  ));
  assert.equal(canonicalizeJcs(repeated), canonicalizeJcs(fused));
});

test('rrf-v0 refuses an unbounded intermediate result', () => {
  const result = fuseRrfV0(
    [{ id: 'large-id', rank: SafeIntegerSchema.parse(1) }],
    [{ id: 'other-id', rank: SafeIntegerSchema.parse(1) }],
    SafeIntegerSchema.parse(2),
    SafeIntegerSchema.parse(1),
  );
  assert.equal(errorCode(result), 'COST_GATE_REFUSAL');
});

test('receipt states are monotonic and afterWrite requires every named state', () => {
  const compiled = success(compileQuery(compileInput(recordsQuery)));
  if (compiled.plan.mode !== 'records') throw new Error('Expected a records plan.');
  const token = 'opaque-token' as VisibilityToken;
  assert.equal(success(validateVisibilityTransition(
    { state: 'accepted' },
    { state: 'pending' },
  )), true);
  assert.equal(success(validateVisibilityTransition(
    { state: 'pending' },
    { state: 'ready', token },
  )), true);
  assert.equal(errorCode(validateVisibilityTransition(
    { state: 'ready', token },
    { state: 'accepted' },
  )), 'SEMANTIC_INVALID');
  const receipt: WriteReceipt = {
    receipt: 'wr-1' as WriteReceiptId,
    records: [{
      id: 'one',
      version: SafeIntegerSchema.parse(1),
      visibility: {
        record: { state: 'ready', token },
        'embedding:body@2': { state: 'pending' },
      },
    }],
  };
  const observation = {
    receipt: 'wr-1',
    require: ['record', 'embedding:body@2'] as const,
    timeoutMs: SafeIntegerSchema.parse(50),
    anchor: compileInput(recordsQuery).anchor,
    scopeFingerprint: compiled.scopeFingerprint,
    scope: compiled.plan.scope,
    dataset: compiled.plan.dataset,
    idField: compiled.plan.projection[0].field,
  };
  const timeout = evaluateAfterWrite(observation, receipt);
  assert.equal(errorCode(timeout), 'AFTER_WRITE_TIMEOUT');
  if (!timeout.ok) {
    assert.deepEqual(timeout.errors[0]?.remedy, {
      action: 'retryAfterWrite',
      details: { receipt: 'wr-1', require: ['embedding:body@2'] },
    });
  }
  const ready: WriteReceipt = {
    ...receipt,
    records: [{
      id: 'one',
      version: SafeIntegerSchema.parse(1),
      visibility: {
        record: { state: 'ready', token },
        'embedding:body@2': { state: 'ready', token },
      },
    }],
  };
  assert.equal(success(evaluateAfterWrite(observation, ready)), ready);
});

test('result assembly releases only the model preview and keeps freshness axes separate', () => {
  const compiled = success(compileQuery(compileInput(recordsQuery)));
  const execution: AdapterExecutionResult = {
    rows: [
      [
        { kind: 'id', value: 'one' },
        { kind: 'text', value: NormalizedTextSchema.parse('First') },
      ],
      [
        { kind: 'id', value: 'two' },
        { kind: 'text', value: NormalizedTextSchema.parse('Second') },
      ],
    ],
    truncated: false,
    snapshot: { kind: 'snapshot', value: 'snapshot-1' },
  };
  const output = success(assembleResult({
    compiled,
    execution,
    engineVersion: 'engine-1',
    adapterVersion: adapterDescriptor.version,
    release: {
      policies: [],
      previewRowLimit: SafeIntegerSchema.parse(1),
      channelPolicyFingerprint: 'channel-policy-1',
    },
    replayTier: 'exactReplay',
    principalResultAvailable: true,
    timings,
    executionSnapshotTier: 'request',
  }));
  assert.equal(output.result.preview.length, 1);
  assert.equal(output.result.truncated, true);
  assert.deepEqual(output.result.freshness, {
    writeVisibility: { kind: 'unconstrained' },
    executionSnapshot: { kind: 'request', snapshot: 'snapshot-1' },
  });
  assert.equal(output.result.principalResultAvailable, true);
  assert.equal('principalRows' in output.result, false);
  assert.equal(JSON.stringify(output.result).includes('principalRows'), false);
  assert.equal(output.result.provenance.catalogVersion, 'catalog-1');
  assert.deepEqual(output.timings, timings);
});

test('minimumCohort suppresses rows per channel as an inference dampener', () => {
  const compiled = success(compileQuery(compileInput(recordsQuery)));
  const output = success(assembleResult({
    compiled,
    execution: {
      rows: [[
        { kind: 'id', value: 'one' },
        { kind: 'text', value: NormalizedTextSchema.parse('First') },
      ]],
      truncated: false,
      snapshot: { kind: 'none' },
    },
    engineVersion: 'engine-1',
    adapterVersion: adapterDescriptor.version,
    release: {
      policies: [{
        kind: 'minimumCohort',
        channel: 'model',
        minimum: SafeIntegerSchema.parse(5),
      }],
      previewRowLimit: SafeIntegerSchema.parse(10),
      channelPolicyFingerprint: 'channel-policy-1',
    },
    replayTier: 'auditable',
    principalResultAvailable: true,
    timings,
    executionSnapshotTier: 'none',
    cohortCounts: [SafeIntegerSchema.parse(4)],
  }));
  assert.deepEqual(output.result.preview, []);
});

test('aggregate result assembly releases calendar-period dimensions and their null group', () => {
  const compiled = success(compileQuery(compileInput({
    version: '0',
    mode: 'aggregate',
    from: 'docs',
    dimensions: [{
      kind: 'timeBucket',
      field: 'docs.created',
      grain: 'week',
      timezone: 'UTC',
      id: 'week',
    }],
    metrics: [{ op: 'count', id: 'count' }],
    order: [{ by: 'week', dir: 'asc' }],
    take: 10,
  })));
  const period = {
    start: InstantValueSchema.parse('2024-03-04T00:00:00Z'),
    endExclusive: InstantValueSchema.parse('2024-03-11T00:00:00Z'),
    timezone: 'UTC',
    grain: 'week' as const,
    label: '2024-W10',
  };
  const output = success(assembleResult({
    compiled,
    execution: {
      rows: [
        [
          { kind: 'calendarPeriod', value: period },
          { kind: 'integer', value: SafeIntegerSchema.parse(2) },
        ],
        [{ kind: 'null', value: null }, { kind: 'integer', value: SafeIntegerSchema.parse(1) }],
      ],
      truncated: false,
      snapshot: { kind: 'none' },
    },
    engineVersion: 'engine-1',
    adapterVersion: adapterDescriptor.version,
    release: {
      policies: [],
      previewRowLimit: SafeIntegerSchema.parse(10),
      channelPolicyFingerprint: 'channel-policy-1',
    },
    replayTier: 'auditable',
    principalResultAvailable: false,
    timings,
    executionSnapshotTier: 'none',
  }));
  assert.deepEqual(output.result.preview, [
    { week: period, count: 2 },
    { week: null, count: 1 },
  ]);
});

test('approximate retrieval result carries complete certified provenance and rank only', () => {
  const compiled = success(compileQuery(compileInput({
    version: '0',
    mode: 'retrieve',
    from: 'docs',
    select: ['docs.id'],
    search: {
      kind: 'semantic',
      using: 'body@2',
      text: 'query',
      accuracy: 'approximate',
      quality: 'certified-high',
    },
    take: 1,
  })));
  const output = success(assembleResult({
    compiled,
    execution: {
      rows: [[{ kind: 'id', value: 'one' }]],
      ranks: [SafeIntegerSchema.parse(1)],
      truncated: false,
      snapshot: { kind: 'watermark', value: 'watermark-1' },
    },
    engineVersion: 'engine-1',
    adapterVersion: adapterDescriptor.version,
    release: {
      policies: [],
      previewRowLimit: SafeIntegerSchema.parse(1),
      channelPolicyFingerprint: 'channel-policy-1',
    },
    replayTier: 'reevaluable',
    principalResultAvailable: false,
    timings,
    executionSnapshotTier: 'request',
  }));
  assert.deepEqual(output.result.determinism, { retrieval: 'approximate' });
  assert.equal(output.result.preview[0]?.rank, 1);
  assert.equal('score' in (output.result.preview[0] ?? {}), false);
  const retrieval = output.result.provenance.retrieval;
  if (retrieval === undefined) assert.fail('Expected retrieval provenance.');
  assert.equal(retrieval.qualityCertificationReference,
    'certification-1');
  assert.equal(retrieval.embeddingSpec, 'body@2');
});

test('principal compilation cannot cross into the model result envelope', () => {
  const compiled = success(compileQuery({ ...compileInput(recordsQuery), channel: 'principal' }));
  const result = assembleResult({
    compiled,
    execution: { rows: [], truncated: false, snapshot: { kind: 'none' } },
    engineVersion: 'engine-1',
    adapterVersion: adapterDescriptor.version,
    release: {
      policies: [],
      previewRowLimit: SafeIntegerSchema.parse(1),
      channelPolicyFingerprint: 'principal-policy',
    },
    replayTier: 'auditable',
    principalResultAvailable: true,
    timings,
    executionSnapshotTier: 'none',
  });
  assert.equal(errorCode(result), 'SEMANTIC_INVALID');
});

test('afterWrite observes first and cannot falsely succeed', async () => {
  const token = 'opaque-token' as VisibilityToken;
  const calls = { compile: 0, execute: 0 };
  const base = adapter(calls);
  const query = {
    ...recordsQuery,
    afterWrite: {
      receipt: 'wr-after',
      require: ['record', 'embedding:body@2'],
      timeoutMs: 10,
    },
  };
  const pending: EngineQueryAdapter<string> = {
    ...base,
    visibility: {
      observe() {
        return Promise.resolve({
          kind: 'success',
          value: {
            receipt: 'wr-after' as WriteReceiptId,
            records: [{
              id: 'one',
              version: SafeIntegerSchema.parse(1),
              visibility: {
                record: { state: 'ready', token },
                'embedding:body@2': { state: 'accepted' },
              },
            }],
          },
        });
      },
    },
  };
  const timeout = await executeQuery(compileInput(query), pending);
  assert.equal(errorCode(timeout), 'AFTER_WRITE_TIMEOUT');
  assert.deepEqual(calls, { compile: 0, execute: 0 });

  const ready: EngineQueryAdapter<string> = {
    ...base,
    visibility: {
      observe() {
        return Promise.resolve({
          kind: 'success',
          value: {
            receipt: 'wr-after' as WriteReceiptId,
            records: [{
              id: 'one',
              version: SafeIntegerSchema.parse(1),
              visibility: {
                record: { state: 'ready', token },
                'embedding:body@2': { state: 'ready', token },
              },
            }],
          },
        });
      },
    },
  };
  const executed = success(await executeQuery(compileInput(query), ready));
  assert.equal(executed.observedReceipt?.receipt, 'wr-after');
  assert.deepEqual(calls, { compile: 1, execute: 1 });
});

test('semantic adapters receive vectors, not semantic source text', async () => {
  let inspected = false;
  const semanticAdapter: EngineQueryAdapter<string> = {
    descriptor: adapterDescriptor,
    query: {
      compile(plan) {
        assert.equal(plan.mode, 'retrieve');
        if (plan.mode !== 'retrieve') assert.fail('Expected retrieval plan.');
        assert.equal(plan.search.vector, vector);
        assert.equal('text' in plan.search, false);
        inspected = true;
        return Promise.resolve({ kind: 'success', value: 'native' });
      },
      execute() {
        return Promise.resolve({
          kind: 'success',
          value: {
            rows: [[{ kind: 'id', value: 'one' }]],
            ranks: [SafeIntegerSchema.parse(1)],
            truncated: false,
            snapshot: { kind: 'none' },
          },
        });
      },
    },
  };
  const result = await executeQuery(compileInput({
    version: '0',
    mode: 'retrieve',
    from: 'docs',
    select: ['docs.id'],
    search: {
      kind: 'semantic',
      using: 'body@2',
      text: 'runtime only',
      accuracy: 'approximate',
      quality: 'certified-high',
    },
    take: 1,
  }), semanticAdapter);
  success(result);
  assert.equal(inspected, true);
});
