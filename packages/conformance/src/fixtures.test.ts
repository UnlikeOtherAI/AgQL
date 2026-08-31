import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import {
  FixtureLoadError,
  discoverFiles,
  loadFixtureSource,
  loadJsonFixture,
} from './fixtures.ts';

test('fixture loading accepts strict UTF-8 and LF and sorts discoveries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agql-conformance-'));
  try {
    const later = path.join(directory, 'b.json');
    const earlier = path.join(directory, 'a.json');
    await Promise.all([
      writeFile(later, '{"name":"Zürich"}\n'),
      writeFile(earlier, '{"name":"London"}\n'),
    ]);

    const source = await loadFixtureSource(later);
    assert.equal(source.source, '{"name":"Zürich"}\n');
    assert.deepEqual(await discoverFiles(directory), [earlier, later]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixture loading rejects BOM, CR line endings, malformed UTF-8, and invalid strict JSON',
  async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agql-conformance-'));
  try {
    const crlf = path.join(directory, 'crlf.yaml');
    const bom = path.join(directory, 'bom.yaml');
    const malformedUtf8 = path.join(directory, 'malformed.yaml');
    const duplicateJson = path.join(directory, 'duplicate.json');
    await Promise.all([
      writeFile(crlf, 'version: "0"\r\n'),
      writeFile(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])),
      writeFile(malformedUtf8, Buffer.from([0xc3, 0x28])),
      writeFile(duplicateJson, '{"take":1,"take":2}\n'),
    ]);

    await assert.rejects(loadFixtureSource(crlf), FixtureLoadError);
    await assert.rejects(loadFixtureSource(bom), /byte-order mark/u);
    await assert.rejects(loadFixtureSource(malformedUtf8), FixtureLoadError);
    await assert.rejects(loadJsonFixture(duplicateJson), /ENCODING_DUPLICATE_KEY/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
