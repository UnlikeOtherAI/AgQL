import assert from 'node:assert/strict';
import test from 'node:test';

import { backendRefusal } from './refusals.ts';

test('a missing PostgreSQL relation is a named provisioning refusal', () => {
  const result = backendRefusal({ code: '42P01' });
  assert.equal(result.kind, 'refusal');
  assert.deepEqual(result.refusal, {
    code: 'SCHEMA_NOT_PROVISIONED',
    message: 'The required AgQL PostgreSQL relation is not provisioned.',
    path: '',
    alternatives: ['Retry after the deployment provisioner completes.'],
    remedy: 'Run the deployment provisioner for the active catalog binding '
      + 'before accepting traffic.',
  });
});
