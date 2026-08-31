import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeJcs, SafeIntegerSchema } from '@agql/schemas';

import { compileQuery } from './compile.ts';
import {
  adapterDescriptor,
  binding,
  compileInput,
  recordsQuery,
  scope,
  vector,
} from './test-fixtures.ts';
import type { EngineResult } from './types.ts';

function success<T>(result: EngineResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

function firstError<T>(result: EngineResult<T>) {
  if (result.ok) assert.fail('Expected a refusal.');
  return result.errors[0];
}

test('records compilation is deterministic, typed, scoped, and totally ordered', () => {
  const first = success(compileQuery(compileInput(recordsQuery)));
  const second = success(compileQuery(compileInput(recordsQuery)));
  assert.equal(canonicalizeJcs(first.plan), canonicalizeJcs(second.plan));
  assert.deepEqual(first.plan, second.plan);
  assert.equal(first.plan.mode, 'records');
  if (first.plan.mode !== 'records') assert.fail('Expected records plan.');
  assert.equal(first.plan.scope.visibility, 'predicate');
  if (first.plan.scope.visibility !== 'predicate') assert.fail('Expected scope predicates.');
  assert.equal(first.plan.scope.enforcement, 'mandatoryPushdown');
  assert.equal(first.plan.scope.predicates[0].kind, 'list');
  assert.equal(first.plan.order.at(-1)?.field.logicalId, 'docs.id');
  assert.equal(first.plan.tieBreak.order.direction, 'asc');
  assert.equal(first.plan.filter?.kind, 'and');
  if (first.plan.filter?.kind !== 'and') assert.fail('Expected combined filters.');
  const relative = first.plan.filter.items[1];
  if (relative?.kind !== 'instantRange') assert.fail('Expected lowered range.');
  assert.equal(relative.startInclusive, '2024-02-26T00:00:00.000Z');
  assert.equal(relative.endExclusive, '2024-03-04T00:00:00.000Z');
  assert.equal(relative.anchor, '2024-03-06T12:34:56Z');
  assert.deepEqual(first.explain.compensation, [
    'finalProjectionAndRedaction',
    'canonicalScalarConversion',
  ]);
});

test('hidden and nonexistent references have byte-identical refusal shapes', () => {
  const query = (field: string) => ({
    version: '0',
    mode: 'records',
    from: 'docs',
    select: [field],
    order: [{ by: 'docs.id', dir: 'asc', nulls: 'last' }],
    take: 1,
  });
  const hidden = compileQuery(compileInput(query('docs.secret')));
  const missing = compileQuery(compileInput(query('docs.absent')));
  const hiddenError = firstError(hidden);
  const missingError = firstError(missing);
  assert.equal(canonicalizeJcs(hiddenError), canonicalizeJcs(missingError));
  assert.deepEqual(hiddenError, {
    code: 'REFERENCE_NOT_AVAILABLE',
    message: 'The referenced item is not available in the effective catalog.',
    path: '/select/0',
    alternatives: [],
  });
});

test('deployment limits lower but cannot raise the v0 constants', () => {
  const lowered = compileQuery({
    ...compileInput(recordsQuery),
    limits: {
      ...compileInput(recordsQuery).limits,
      take: {
        ...compileInput(recordsQuery).limits.take,
        records: SafeIntegerSchema.parse(5),
      },
    },
  });
  assert.equal(firstError(lowered)?.code, 'STRUCTURAL_INVALID');
  assert.equal(firstError(lowered)?.path, '/take');

  const raised = compileQuery({
    ...compileInput(recordsQuery),
    limits: {
      ...compileInput(recordsQuery).limits,
      select: SafeIntegerSchema.parse(101),
    },
  });
  assert.equal(firstError(raised)?.code, 'STRUCTURAL_INVALID');
  assert.equal(firstError(raised)?.path, '/limits/select');
});

test('deferred constructs and physical knobs are rejected structurally before planning', () => {
  const deferred = compileQuery(compileInput({ ...recordsQuery, joins: [{ from: 'other' }] }));
  assert.equal(firstError(deferred)?.code, 'UNSUPPORTED_IN_V0');

  const physicalKnob = compileQuery(compileInput({ ...recordsQuery, topK: 99 }));
  assert.equal(firstError(physicalKnob)?.code, 'STRUCTURAL_INVALID');
});

test('enum labels are not accepted as enum values', () => {
  const result = compileQuery(compileInput({
    ...recordsQuery,
    where: {
      kind: 'predicate',
      field: 'docs.tenant',
      op: 'eq',
      value: 'Tenant A',
    },
  }));
  assert.equal(firstError(result)?.code, 'SEMANTIC_INVALID');
  assert.equal(firstError(result)?.path, '/where/value');
});

test('aggregate plans resolve ids, filters, ratio null semantics, and dimension tie-breaks', () => {
  const result = success(compileQuery(compileInput({
    version: '0',
    mode: 'aggregate',
    from: 'docs',
    dimensions: [{ kind: 'field', field: 'docs.tenant', id: 'tenant' }],
    metrics: [
      { kind: 'aggregate', op: 'sum', field: 'docs.amount', id: 'total' },
      {
        kind: 'ratio',
        id: 'ratio',
        numerator: { kind: 'aggregate', op: 'count' },
        denominator: { kind: 'aggregate', op: 'sum', field: 'docs.qty' },
      },
    ],
    having: { kind: 'predicate', field: 'total', op: 'gt', value: {
      amount: '0',
      currency: 'USD',
    } },
    order: [{ by: 'total', dir: 'desc', nulls: 'last' }],
    take: 20,
  })));
  assert.equal(result.plan.mode, 'aggregate');
  if (result.plan.mode !== 'aggregate') assert.fail('Expected aggregate plan.');
  assert.equal(result.plan.tieBreak.kind, 'dimensionTuple');
  assert.equal(result.plan.metrics[1]?.kind, 'ratio');
  const ratio = result.plan.metrics[1];
  if (ratio?.kind !== 'ratio') assert.fail('Expected ratio metric.');
  assert.equal(ratio.divideByZero, 'null');
  const having = result.plan.having;
  if (having === undefined || 'kind' in having) assert.fail('Expected output predicate.');
  assert.equal(having.op, 'gt');
  assert.equal(result.explain.pushdown.includes('aggregate'), true);
});

test('prototype-style aggregate aliases and output collisions are refused', () => {
  const result = compileQuery(compileInput({
    version: '0',
    mode: 'aggregate',
    from: 'docs',
    dimensions: [],
    metrics: [{ kind: 'aggregate', op: 'count', id: '__proto__' }],
    order: [{ by: '__proto__', dir: 'asc', nulls: 'last' }],
    take: 1,
  }));
  assert.equal(firstError(result)?.code, 'SEMANTIC_INVALID');
  assert.equal(firstError(result)?.path, '/metrics/0/id');
});

test('semantic and hybrid retrieval emit vectors, rank shape, and no backend scores', () => {
  const semantic = success(compileQuery(compileInput({
    version: '0',
    mode: 'retrieve',
    from: 'docs',
    select: ['docs.id', 'docs.title'],
    search: {
      kind: 'semantic',
      using: 'body@2',
      text: 'query',
      accuracy: 'exact',
      quality: 'certified-high',
    },
    take: 3,
  })));
  assert.equal(semantic.plan.mode, 'retrieve');
  if (semantic.plan.mode !== 'retrieve') assert.fail('Expected retrieve plan.');
  assert.equal(semantic.plan.search.vector, vector);
  assert.equal(semantic.explain.resultShape.at(-1)?.kind, 'rank');
  assert.equal('score' in semantic.plan.search, false);
  assert.deepEqual(semantic.explain.determinism, { query: 'exact' });

  const hybrid = success(compileQuery(compileInput({
    version: '0',
    mode: 'retrieve',
    from: 'docs',
    select: ['docs.id'],
    search: {
      kind: 'hybrid',
      semantic: { using: 'body@2', text: 'query', accuracy: 'approximate' },
      lexical: { field: 'docs.body', text: 'query' },
      fusion: 'rrf-v0',
      quality: 'certified-high',
    },
    take: 3,
  })));
  assert.deepEqual(hybrid.explain.determinism, { retrieval: 'approximate' });
  assert.equal(hybrid.explain.pushdown.includes('retrieval'), true);
});

test('semantic permission is checked independently of selected columns', () => {
  const deniedScope = {
    ...scope,
    capabilities: scope.capabilities.filter((capability) => capability !== 'semantic'),
  };
  const result = compileQuery({
    ...compileInput({
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
      take: 3,
    }),
    scope: deniedScope,
  });
  assert.equal(firstError(result)?.code, 'REFERENCE_NOT_AVAILABLE');
  assert.equal(firstError(result)?.path, '/search/using');
});

test('exact retrieval never silently downgrades when its scan budget is exceeded', () => {
  const base = compileInput({
    version: '0',
    mode: 'retrieve',
    from: 'docs',
    select: ['docs.id'],
    search: {
      kind: 'semantic',
      using: 'body@2',
      text: 'query',
      accuracy: 'exact',
      quality: 'certified-high',
    },
    take: 3,
  });
  const result = compileQuery({
    ...base,
    scope: {
      ...scope,
      budgets: { ...scope.budgets, maximumExactScanRecords: SafeIntegerSchema.parse(2) },
    },
  });
  assert.equal(firstError(result)?.code, 'EXACT_SCAN_BUDGET_EXCEEDED');
  assert.equal(firstError(result)?.path, '/search/accuracy');
  const resultRemedy = firstError(result)?.remedy;
  assert.equal(typeof resultRemedy, 'string');
  if (typeof resultRemedy === 'string') assert.match(resultRemedy, /Narrow/u);
});

test('field policy is enforced independently for every operation surface', () => {
  const cases = [
    {
      ...recordsQuery,
      where: { kind: 'predicate', field: 'docs.secret', op: 'eq', value: 'x' },
    },
    {
      ...recordsQuery,
      order: [{ by: 'docs.secret', dir: 'asc', nulls: 'last' }],
    },
    {
      version: '0',
      mode: 'aggregate',
      from: 'docs',
      dimensions: [{ kind: 'field', field: 'docs.secret', id: 'secret' }],
      metrics: [{ kind: 'aggregate', op: 'count', id: 'count' }],
      order: [{ by: 'count', dir: 'asc', nulls: 'last' }],
      take: 1,
    },
    {
      version: '0',
      mode: 'aggregate',
      from: 'docs',
      dimensions: [],
      metrics: [{
        kind: 'aggregate',
        op: 'countDistinct',
        field: 'docs.secret',
        id: 'secretCount',
      }],
      order: [{ by: 'secretCount', dir: 'asc', nulls: 'last' }],
      take: 1,
    },
    {
      version: '0',
      mode: 'retrieve',
      from: 'docs',
      select: ['docs.id'],
      search: {
        kind: 'hybrid',
        semantic: { using: 'body@2', text: 'query', accuracy: 'approximate' },
        lexical: { field: 'docs.secret', text: 'query' },
        fusion: 'rrf-v0',
        quality: 'certified-high',
      },
      take: 1,
    },
  ];
  for (const query of cases) {
    const result = compileQuery(compileInput(query));
    assert.equal(firstError(result)?.code, 'REFERENCE_NOT_AVAILABLE');
  }
});

test('substring predicates compile as escaped case-sensitive text, never regex', () => {
  const result = success(compileQuery(compileInput({
    ...recordsQuery,
    where: {
      kind: 'predicate',
      field: 'docs.title',
      op: 'contains',
      value: '[.*]',
    },
  })));
  assert.equal(result.plan.filter?.kind, 'and');
  if (result.plan.filter?.kind !== 'and') assert.fail('Expected combined filter.');
  const substring = result.plan.filter.items[1];
  if (substring?.kind !== 'substring') assert.fail('Expected substring predicate.');
  assert.equal(substring.value, '[.*]');
  assert.equal(substring.semantics, 'escaped-case-sensitive-substring');
});

test('profile, binding, scope, and cost admission fail with repairable codes', () => {
  const retrievalQuery = {
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
  };
  const unsupported = compileQuery({
    ...compileInput(retrievalQuery),
    adapter: { ...adapterDescriptor, profiles: ['records.v0'] },
  });
  assert.equal(firstError(unsupported)?.code, 'UNSUPPORTED_PROFILE');

  const docsBinding = binding.datasets.docs;
  if (docsBinding === undefined) assert.fail('Fixture binding is missing docs.');
  const bodyBinding = docsBinding.embeddings.body;
  if (bodyBinding === undefined) assert.fail('Fixture binding is missing body.');
  const unindexed = compileQuery({
    ...compileInput(retrievalQuery),
    binding: {
      ...binding,
      datasets: {
        ...binding.datasets,
        docs: {
          ...docsBinding,
          embeddings: {
            body: { ...bodyBinding, indexed: false },
          },
        },
      },
    },
  });
  assert.equal(firstError(unindexed)?.code, 'EMBEDDING_NOT_INDEXED');

  const badScope = compileQuery({
    ...compileInput(recordsQuery),
    scope: {
      ...scope,
      partitions: { kind: 'values', values: { 'docs.other': ['a'] } },
    },
  });
  assert.equal(firstError(badScope)?.code, 'SCOPE_UNENFORCEABLE');

  const costly = compileQuery({
    ...compileInput(recordsQuery),
    costGate: {
      ...compileInput(recordsQuery).costGate,
      maximumEstimatedRows: SafeIntegerSchema.parse(5),
    },
  });
  assert.equal(firstError(costly)?.code, 'COST_GATE_REFUSAL');
});

test('afterWrite refuses uncertified adapters and embedding-version mismatches', () => {
  const afterWriteQuery = {
    ...recordsQuery,
    afterWrite: { receipt: 'wr-1', require: ['record'], timeoutMs: 50 },
  };
  const unsupported = compileQuery({
    ...compileInput(afterWriteQuery),
    adapter: {
      ...adapterDescriptor,
      consistency: { ...adapterDescriptor.consistency, afterWrite: 'unsupported' },
    },
  });
  assert.equal(firstError(unsupported)?.code, 'FRESHNESS_UNAVAILABLE');

  const migration = compileQuery(compileInput({
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
    afterWrite: {
      receipt: 'wr-2',
      require: ['record', 'embedding:body@1'],
      timeoutMs: 50,
    },
    take: 1,
  }));
  assert.equal(firstError(migration)?.code, 'FRESHNESS_UNAVAILABLE');
  const migrationRemedy = firstError(migration)?.remedy;
  assert.equal(typeof migrationRemedy, 'string');
  if (typeof migrationRemedy === 'string') {
    assert.match(migrationRemedy, /exact EmbeddingSpec/u);
  }
});
