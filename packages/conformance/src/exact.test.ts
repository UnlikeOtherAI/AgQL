import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { runExactSuite } from './exact.ts';
import { createSqliteExactDriver } from './sqlite-exact-driver.ts';

const corpusRoot = path.resolve(import.meta.dirname, '../../../conformance');

test('exact suite accounts for every fixture and preserves explicit extension blockers',
  async () => {
  const execution = await runExactSuite(corpusRoot, createSqliteExactDriver());

  assert.equal(execution.report.totals.total, 45);
  assert.equal(
    execution.report.totals.pass
      + execution.report.totals.fail
      + execution.report.totals.blocked
      + execution.report.totals.undetermined,
    45,
  );
  for (const id of [
    'exact.aggregate.calendar-day-dst-spring',
    'exact.aggregate.calendar-fiscal-day-dst-fall',
    'exact.aggregate.calendar-week-start',
  ]) {
    const calendar = execution.report.fixtures.find((fixture) => fixture.id === id);
    assert.equal(calendar?.outcome.status, 'pass');
  }
  const receiptContract = execution.report.fixtures.find((fixture) =>
    fixture.id === 'exact.records.decimal-precision-scale-boundaries');
  assert.equal(receiptContract?.outcome.status, 'blocked');
  if (receiptContract?.outcome.status !== 'blocked') assert.fail('Expected CAS blocker.');
  assert.equal(receiptContract.outcome.capability, 'per-record-cas-outcomes');
  for (const id of [
    'exact.retrieve.membership-and-order',
    'exact.retrieve.filter-before-rank',
  ]) {
    const fixture = execution.report.fixtures.find((item) => item.id === id);
    assert.equal(fixture?.outcome.status, 'pass');
    const observation = execution.adapterRuns[id]?.observations.query;
    assert.equal(observation?.kind, 'success');
    if (observation?.kind === 'success') assert.equal(observation.repeatedSemanticEqual, true);
  }
});
