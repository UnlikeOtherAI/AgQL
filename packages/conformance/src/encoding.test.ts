import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverEncodingFixtures, runEncodingSuite } from './encoding.ts';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const encodingDirectory = path.resolve(sourceDirectory, '../../../conformance/encoding');

test(
  'discovers every checked-in encoding pair and rejection fixture in lexical order',
  async () => {
  const fixtures = await discoverEncodingFixtures({ fixtureDirectory: encodingDirectory });

  assert.deepEqual(
    fixtures.pairs.map((fixture) => fixture.id),
    [
      'encoding/pairs/001-aggregate',
      'encoding/pairs/002-retrieve',
      'encoding/pairs/003-boolean-tree',
      'encoding/pairs/004-tricky-scalars',
      'encoding/pairs/005-ingest-put',
      'encoding/pairs/006-flow-style',
    ],
  );
  assert.deepEqual(
    fixtures.rejects.map((fixture) => fixture.id),
    [
      'encoding/reject/alias-bomb',
      'encoding/reject/anchors-aliases',
      'encoding/reject/custom-tags',
      'encoding/reject/duplicate-keys',
      'encoding/reject/merge-keys',
      'encoding/reject/multi-document',
    ],
  );
  },
);

test('the encoding suite passes every corpus pair and fixed rejection', async () => {
  const report = await runEncodingSuite({ fixtureDirectory: encodingDirectory });

  assert.equal(report.name, 'encoding');
  assert.deepEqual(report.totals, {
    total: 12,
    pass: 12,
    fail: 0,
    blocked: 0,
    undetermined: 0,
  });
  assert.equal(report.fixtures.length, 12);
  for (const fixture of report.fixtures) assert.equal(fixture.outcome.status, 'pass');
});
