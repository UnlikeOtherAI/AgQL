import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeJcs,
  effectivePlanHash,
  executionFingerprint,
  fingerprintScope,
  sourceQueryHash,
} from './index.ts';
import { InstantValueSchema } from './values.ts';

test('JCS matches the RFC 8785 serialization fixture', () => {
  const value = {
    numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
    string: '€$\u000f\nA\'B"\\"/',
    literals: [null, true, false],
  };
  assert.equal(
    canonicalizeJcs(value),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,'
      + '0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\"/"}',
  );
});

test('JCS sorts by UTF-16 code units and rejects invalid JSON-domain values', () => {
  assert.equal(canonicalizeJcs({ z: 1, a: 2, '😀': 3, '\ufffd': 4 }),
    '{"a":2,"z":1,"😀":3,"�":4}');
  assert.throws(() => canonicalizeJcs(Number.NaN), /non-finite/u);
  assert.throws(() => canonicalizeJcs(String.fromCharCode(0xd800)), /unpaired/u);
  assert.throws(() => canonicalizeJcs({ value: undefined }), /JSON values/u);
  assert.throws(() => canonicalizeJcs(new Array(1)), /sparse/u);
});

test('identities bind named compositions without semantic-equivalence rewriting', () => {
  const left = { version: '0', where: { kind: 'and', items: ['a', 'b'] } };
  const sameBytesDifferentPropertyOrder = {
    where: { items: ['a', 'b'], kind: 'and' },
    version: '0',
  };
  const semanticallyEquivalent = { version: '0', where: { kind: 'and', items: ['b', 'a'] } };
  assert.equal(sourceQueryHash(left), sourceQueryHash(sameBytesDifferentPropertyOrder));
  assert.notEqual(sourceQueryHash(left), sourceQueryHash(semanticallyEquivalent));

  const scope = fingerprintScope({ principal: 'p', partitions: { region: ['north'] } });
  const first = effectivePlanHash({
    sourceQueryHash: sourceQueryHash(left),
    languageVersion: '0',
    catalogVersion: 'cat-1',
    policyVersion: 'policy-1',
    scopeFingerprint: scope,
  });
  const second = effectivePlanHash({
    sourceQueryHash: sourceQueryHash(left),
    languageVersion: '0',
    catalogVersion: 'cat-2',
    policyVersion: 'policy-1',
    scopeFingerprint: scope,
  });
  assert.notEqual(first, second);

  const execution = executionFingerprint({
    effectivePlanHash: first,
    bindingVersion: 'binding-1',
    engineVersion: 'engine-1',
    adapterVersion: 'adapter-1',
    anchor: InstantValueSchema.parse('2026-01-01T00:00:00Z'),
    snapshot: { kind: 'watermark', value: 'watermark-9' },
    embeddingSpec: {
      reference: 'body@1',
      specVersion: '1',
      model: { id: 'embed', revision: 'provider:immutable-123' },
      inputTransformId: 'nfc-v1',
    },
    qualityProfile: 'certified-high',
    channelPolicyFingerprint: 'channel-policy-1',
  });
  const changedPolicy = executionFingerprint({
    effectivePlanHash: first,
    bindingVersion: 'binding-1',
    engineVersion: 'engine-1',
    adapterVersion: 'adapter-1',
    anchor: InstantValueSchema.parse('2026-01-01T00:00:00Z'),
    snapshot: { kind: 'watermark', value: 'watermark-9' },
    embeddingSpec: {
      reference: 'body@1',
      specVersion: '1',
      model: { id: 'embed', revision: 'provider:immutable-123' },
      inputTransformId: 'nfc-v1',
    },
    qualityProfile: 'certified-high',
    channelPolicyFingerprint: 'channel-policy-2',
  });
  assert.notEqual(execution, changedPolicy);
});
