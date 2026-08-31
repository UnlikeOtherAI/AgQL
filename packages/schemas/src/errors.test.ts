import assert from 'node:assert/strict';
import test from 'node:test';

import { RecordsQuerySchema } from './query.ts';
import { referenceNotAvailable, structuralErrors } from './errors.ts';
import { validateQueryDocument } from './language-validation.ts';

test('structural validation reports all issues in deterministic document order', () => {
  const result = RecordsQuerySchema.safeParse({ version: '1', mode: 'records' });
  assert.equal(result.success, false);
  if (result.success) return;
  const errors = structuralErrors(result.error);
  assert.ok(errors.length > 1);
  assert.equal(errors[0].path, '/version');
  assert.equal(errors[0].code, 'STRUCTURAL_INVALID');
  assert.deepEqual(errors[0].alternatives, ['0']);
});

test('unavailable references cannot carry hidden-name alternatives', () => {
  assert.deepEqual(referenceNotAvailable('/select/0'), {
    code: 'REFERENCE_NOT_AVAILABLE',
    message: 'The referenced item is not available in the effective catalog.',
    path: '/select/0',
    alternatives: [],
  });
});

test('deferred constructs refuse with UNSUPPORTED after all structural errors', () => {
  const result = validateQueryDocument({
    version: '1',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order: [{ by: 'orders.id', dir: 'asc', nulls: 'last' }],
    take: 10,
    join: { from: 'customers' },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0].code, 'STRUCTURAL_INVALID');
  assert.equal(result.errors.at(-1)?.code, 'UNSUPPORTED_IN_V0');
  assert.equal(result.errors.at(-1)?.path, '/join');
});

test('a deferred construct in an otherwise valid query has one typed refusal', () => {
  const result = validateQueryDocument({
    version: '0',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order: [{ by: 'orders.id', dir: 'asc', nulls: 'last' }],
    take: 10,
    derive: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'UNSUPPORTED_IN_V0');
  }
});
