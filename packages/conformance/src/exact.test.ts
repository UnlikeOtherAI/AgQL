import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { runExactSuite } from './exact.ts';
import { createSqliteExactDriver } from './sqlite-exact-driver.ts';

const corpusRoot = path.resolve(import.meta.dirname, '../../../conformance');

test('exact suite accounts for every fixture and preserves explicit extension blockers',
  async () => {
  const execution = await runExactSuite(corpusRoot, createSqliteExactDriver());

  assert.equal(execution.report.totals.total, 39);
  assert.equal(
    execution.report.totals.pass
      + execution.report.totals.fail
      + execution.report.totals.blocked
      + execution.report.totals.undetermined,
    39,
  );
  const calendar = execution.report.fixtures.find((fixture) =>
    fixture.id === 'exact.aggregate.calendar-day-dst-spring');
  assert.equal(calendar?.outcome.status, 'blocked');
  if (calendar?.outcome.status !== 'blocked') assert.fail('Expected calendar blocker.');
  assert.equal(calendar.outcome.capability, 'calendar-period-adapter-values');
  const receiptContract = execution.report.fixtures.find((fixture) =>
    fixture.id === 'exact.records.decimal-precision-scale-boundaries');
  assert.equal(receiptContract?.outcome.status, 'blocked');
  if (receiptContract?.outcome.status !== 'blocked') assert.fail('Expected CAS blocker.');
  assert.equal(receiptContract.outcome.capability, 'per-record-cas-outcomes');
});
