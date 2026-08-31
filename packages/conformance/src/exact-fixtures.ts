import path from 'node:path';

import type { JsonValue } from '@agql/schemas';

import { discoverFiles, loadJsonFixture } from './fixtures.ts';
import {
  type JsonObject,
  jsonObject,
  member,
  stringMember,
} from './json-shape.ts';

export interface ExactFixture {
  readonly sourcePath: string;
  readonly id: string;
  readonly rule: string;
  readonly requiresProfile: string;
  readonly value: JsonObject;
  readonly expected: JsonObject;
}

function parseExactFixture(sourcePath: string, value: JsonValue): ExactFixture {
  const root = jsonObject(value, sourcePath);
  const format = stringMember(root, 'format', sourcePath);
  if (format !== 'agql-exact-fixture/0.1') {
    throw new TypeError(`${sourcePath}/format must be agql-exact-fixture/0.1.`);
  }
  return {
    sourcePath,
    id: stringMember(root, 'id', sourcePath),
    rule: stringMember(root, 'rule', sourcePath),
    requiresProfile: stringMember(root, 'requiresProfile', sourcePath),
    value: root,
    expected: jsonObject(member(root, 'expected', sourcePath), `${sourcePath}/expected`),
  };
}

export async function loadExactFixtures(
  corpusRoot: string,
): Promise<readonly ExactFixture[]> {
  const files = (await discoverFiles(path.join(corpusRoot, 'exact')))
    .filter((pathname) => pathname.endsWith('.json'));
  const fixtures = await Promise.all(files.map(async (pathname) => {
    const source = await loadJsonFixture(pathname);
    return parseExactFixture(pathname, source.value);
  }));
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new TypeError(`Duplicate exact fixture id ${fixture.id}.`);
    ids.add(fixture.id);
  }
  return fixtures;
}
