import assert from 'node:assert/strict';
import test from 'node:test';

import { InstantValueSchema } from '@agql/schemas';
import type { CapabilityProfile } from '@agql/schemas';

import type {
  AdapterContract,
  AdapterRefusal,
  AdapterResultValue,
  LogicalPlanForProfile,
  ModelReleasedValue,
  ResultValue,
  ResultEnvelope,
  VisibilityTransition,
} from './index.ts';

test('a retrieval-index adapter can honestly omit canonical and tabular operations', () => {
  const profiles = ['retrieval-index.v0'] as const satisfies readonly CapabilityProfile[];
  const refusal = {
    code: 'FILTER_SHAPE_UNCERTIFIED',
    message: 'The retrieval index has not certified this filter shape.',
    path: '/filter',
    alternatives: ['Use a certified filter shape.'],
    remedy: 'Use a filter shape named by the index certification.',
  } as const satisfies AdapterRefusal;
  const adapter = {
    descriptor: {
      id: 'index-only',
      version: '1',
      profiles,
      consistency: {
        afterWrite: 'unsupported',
        snapshots: ['none'],
        compareAndSwap: false,
      },
    },
    retrievalIndex: {
      compile() {
        return Promise.resolve({ kind: 'refusal', refusal } as const);
      },
      execute() {
        return Promise.resolve({ kind: 'refusal', refusal } as const);
      },
    },
  } satisfies AdapterContract<typeof profiles, never, never, string>;
  assert.equal(adapter.descriptor.profiles[0], 'retrieval-index.v0');
  assert.equal('canonicalIngest' in adapter, false);
});

test('profile-to-plan selection preserves semantic and hybrid discrimination', () => {
  type SemanticPlan = LogicalPlanForProfile<'retrieve.semantic.v0'>;
  type HybridPlan = LogicalPlanForProfile<'retrieve.hybrid.v0'>;
  type SemanticMissing = [SemanticPlan] extends [never] ? true : false;
  type HybridMissing = [HybridPlan] extends [never] ? true : false;
  const semanticMissing: SemanticMissing = false;
  const hybridMissing: HybridMissing = false;
  assert.equal(semanticMissing, false);
  assert.equal(hybridMissing, false);
});

test('receipt transitions and model result keys preserve the shared boundaries', () => {
  const transition: VisibilityTransition = { from: 'accepted', to: 'ready' };
  assert.deepEqual(transition, { from: 'accepted', to: 'ready' });

  type HasPrincipalRows = 'principalRows' extends keyof ResultEnvelope ? true : false;
  const hasPrincipalRows: HasPrincipalRows = false;
  assert.equal(hasPrincipalRows, false);
});

test('calendar periods cross adapter results and model null remains valid', () => {
  const period: AdapterResultValue = {
    kind: 'calendarPeriod',
    value: {
      start: InstantValueSchema.parse('2024-01-01T00:00:00Z'),
      endExclusive: InstantValueSchema.parse('2024-01-08T00:00:00Z'),
      timezone: 'UTC',
      grain: 'week',
      label: '2024-W01',
    },
  };
  assert.equal(period.kind, 'calendarPeriod');

  const releasedNull: ModelReleasedValue = null;
  assert.equal(releasedNull, null);

  const unreleasedValue: ResultValue = 'principal-only';
  // @ts-expect-error Model release branding is required for every non-null value.
  const cannotCrossChannel: ModelReleasedValue = unreleasedValue;
  void cannotCrossChannel;
});
