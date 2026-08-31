import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { expandSecurityCases } from './security-expansion.ts';
import { loadSecurityFixtures } from './security-fixtures.ts';
import { blockedSecurityExecutor, runSecuritySuite } from './security.ts';

const corpusRoot = path.resolve(import.meta.dirname, '../../../conformance');

test('xorshift expansion is deterministic and an indexed replay consumes the same stream',
  async () => {
  const fixture = (await loadSecurityFixtures(corpusRoot))[0];
  if (fixture === undefined) assert.fail('Expected a security fixture.');
  const first = [...expandSecurityCases(fixture, 4)];
  const repeated = [...expandSecurityCases(fixture, 4)];
  assert.deepEqual(first, repeated);
  const replay = [...expandSecurityCases(fixture, fixture.caseCount, 3)];
  assert.deepEqual(replay, [first[3]]);
  assert.equal(first[0]?.seedHex, '91e10da5');
});

test('fast security tier expands and explicitly blocks all thirteen unconfigured matrices',
  async () => {
  const report = await runSecuritySuite(corpusRoot, blockedSecurityExecutor(), {
    tier: 'fast',
  });
  assert.deepEqual(report.totals, {
    total: 13,
    pass: 0,
    fail: 0,
    blocked: 13,
    undetermined: 0,
  });
  for (const fixture of report.fixtures) {
    assert.equal(fixture.outcome.status, 'blocked');
  }
});
