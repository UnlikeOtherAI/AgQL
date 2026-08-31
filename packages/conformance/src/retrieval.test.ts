import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { ApproximateRetrievalExecutor } from './retrieval.ts';
import { runRetrievalSuite, unavailableRetrievalExecutor } from './retrieval.ts';

const corpusRoot = path.resolve(import.meta.dirname, '../../../conformance');

const perfectExecutor: ApproximateRetrievalExecutor = {
  query(input) {
    return Promise.resolve({
      kind: 'success',
      ids: input.exactTopK,
      metadata: {
        adapterId: 'perfect-test-adapter',
        adapterVersion: '1',
        bindingVersion: '1',
        engineVersion: '1',
        indexConfigurationDigest: 'sha256:test',
      },
    });
  },
};

test('retrieval suite keeps unset thresholds explicit when no approximate adapter exists',
  async () => {
  const execution = await runRetrievalSuite(
    corpusRoot,
    unavailableRetrievalExecutor('test deployment absent'),
  );
  assert.deepEqual(execution.report.totals, {
    total: 7,
    pass: 3,
    fail: 0,
    blocked: 4,
    undetermined: 0,
  });
  assert.deepEqual(execution.measurements, []);
});

test('retrieval distribution reports every query and lower-tail statistic', async () => {
  const execution = await runRetrievalSuite(corpusRoot, perfectExecutor);
  assert.equal(execution.report.totals.pass, 7);
  assert.equal(execution.measurements.length, 4);
  for (const measurement of execution.measurements) {
    assert.equal(measurement.thresholds, null);
    assert.equal(measurement.perQuery.length, 64);
    assert.deepEqual(measurement.distribution, {
      sampleCount: 64,
      mean: '1',
      median: '1',
      minimum: '1',
      p01: '1',
      p05: '1',
      p10: '1',
      p25: '1',
    });
  }
});
