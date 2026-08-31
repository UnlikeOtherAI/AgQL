import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeJcs,
  decodeAgqlYaml,
  decodeJson,
  sourceQueryHash,
  validateAndCanonicalizeQuery,
} from './index.ts';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.resolve(sourceDirectory, '../../../conformance/encoding');

test('all encoding fixture pairs produce identical canonical bytes and hashes', async () => {
  const pairDirectory = path.join(fixtureDirectory, 'pairs');
  const files = (await readdir(pairDirectory)).filter((file) => file.endsWith('.json')).sort();
  for (const jsonName of files) {
    const yamlName = jsonName.replace(/\.json$/u, '.yaml');
    const [jsonSource, yamlSource] = await Promise.all([
      readFile(path.join(pairDirectory, jsonName), 'utf8'),
      readFile(path.join(pairDirectory, yamlName), 'utf8'),
    ]);
    const json = decodeJson(jsonSource);
    const yaml = decodeAgqlYaml(yamlSource);
    assert.equal(json.ok, true, jsonName);
    assert.equal(yaml.ok, true, yamlName);
    if (!json.ok || !yaml.ok) continue;
    assert.equal(canonicalizeJcs(json.value), canonicalizeJcs(yaml.value), jsonName);
    assert.equal(sourceQueryHash(json.value), sourceQueryHash(yaml.value), jsonName);
  }
});

test('all YAML rejection fixtures return their fixed ENCODING code', async () => {
  const rejectDirectory = path.join(fixtureDirectory, 'reject');
  const files = (await readdir(rejectDirectory)).filter((file) => file.endsWith('.yaml')).sort();
  for (const file of files) {
    const source = await readFile(path.join(rejectDirectory, file), 'utf8');
    const expected = /# EXPECT: (ENCODING_[A-Z_]+)/u.exec(source)?.[1];
    assert.notEqual(expected, undefined, file);
    const result = decodeAgqlYaml(source);
    assert.equal(result.ok, false, file);
    if (!result.ok) assert.equal(result.errors[0].code, expected, file);
  }
});

test('fenced YAML, duplicate JSON keys, and deployment-lowered caps are deterministic', () => {
  const fenced = decodeAgqlYaml('```agql-yaml\nversion: "0"\n```');
  assert.deepEqual(fenced, { ok: true, value: { version: '0' } });
  const duplicate = decodeJson('{"take":1,"take":2}');
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.errors[0].code, 'ENCODING_DUPLICATE_KEY');
  const oversized = decodeJson('{"value":"long"}', { maximumBytes: 4 });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.errors[0].code, 'ENCODING_SIZE_LIMIT');
});

test('validated JSON and YAML edges produce one canonical source query identity', () => {
  const json = decodeJson(JSON.stringify({
    version: '0',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order: [{ by: 'orders.id', dir: 'asc', nulls: 'last' }],
    take: 10,
  }));
  const yaml = decodeAgqlYaml(`version: "0"
mode: records
from: orders
select: [orders.id]
order: [{by: orders.id, dir: asc, nulls: last}]
take: 10`);
  assert.equal(json.ok, true);
  assert.equal(yaml.ok, true);
  if (!json.ok || !yaml.ok) return;
  const canonicalJson = validateAndCanonicalizeQuery(json.value);
  const canonicalYaml = validateAndCanonicalizeQuery(yaml.value);
  assert.equal(canonicalJson.ok, true);
  assert.equal(canonicalYaml.ok, true);
  if (canonicalJson.ok && canonicalYaml.ok) {
    assert.equal(canonicalJson.value.canonical, canonicalYaml.value.canonical);
    assert.equal(canonicalJson.value.sourceQueryHash, canonicalYaml.value.sourceQueryHash);
  }
});
