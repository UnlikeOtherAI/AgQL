import path from 'node:path';

import type { JsonValue } from '@agql/schemas';

import { discoverFiles, loadJsonFixture } from './fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  jsonObject,
  member,
  numberMember,
  objectMember,
  stringMember,
} from './json-shape.ts';

export interface SecurityDimension {
  readonly name: string;
  readonly values: readonly [JsonValue, ...JsonValue[]];
}

export interface SecurityFixture {
  readonly sourcePath: string;
  readonly id: string;
  readonly rule: string;
  readonly value: JsonObject;
  readonly setup: JsonValue;
  readonly invariant: JsonObject;
  readonly seedHex: string;
  readonly seed: number;
  readonly caseCount: number;
  readonly dimensions: readonly SecurityDimension[];
}

function nonEmptyValues(
  values: readonly JsonValue[],
  location: string,
): readonly [JsonValue, ...JsonValue[]] {
  const first = values[0];
  if (first === undefined) throw new TypeError(`${location} must not be empty.`);
  return [first, ...values.slice(1)];
}

function parseSeed(seedHex: string, location: string): number {
  if (!/^[0-9a-f]{8}$/u.test(seedHex)) {
    throw new TypeError(`${location} must be eight lowercase hexadecimal digits.`);
  }
  const seed = Number.parseInt(seedHex, 16) >>> 0;
  if (seed === 0) throw new TypeError(`${location} must be nonzero.`);
  return seed;
}

function parseSecurityFixture(sourcePath: string, value: JsonValue): SecurityFixture {
  const root = jsonObject(value, sourcePath);
  if (stringMember(root, 'format', sourcePath) !== 'agql-security-probe/0.1') {
    throw new TypeError(`${sourcePath}/format must be agql-security-probe/0.1.`);
  }
  const expansion = objectMember(root, 'expansion', sourcePath);
  const prng = stringMember(expansion, 'prng', `${sourcePath}/expansion`);
  if (prng !== 'xorshift32-v1') {
    throw new TypeError(`${sourcePath}/expansion/prng must be xorshift32-v1.`);
  }
  const caseCount = numberMember(expansion, 'caseCount', `${sourcePath}/expansion`);
  if (!Number.isSafeInteger(caseCount) || caseCount < 20_000) {
    throw new TypeError(`${sourcePath}/expansion/caseCount must be at least 20000.`);
  }
  const seedHex = stringMember(expansion, 'seedHex', `${sourcePath}/expansion`);
  const invariant = objectMember(root, 'invariant', sourcePath);
  if (numberMember(invariant, 'maximumViolations', `${sourcePath}/invariant`) !== 0
    || stringMember(invariant, 'failure', `${sourcePath}/invariant`) !== 'fail-build') {
    throw new TypeError(`${sourcePath}/invariant must be zero-tolerance and fail-build.`);
  }
  return {
    sourcePath,
    id: stringMember(root, 'id', sourcePath),
    rule: stringMember(root, 'rule', sourcePath),
    value: root,
    setup: member(root, 'setup', sourcePath),
    invariant,
    seedHex,
    seed: parseSeed(seedHex, `${sourcePath}/expansion/seedHex`),
    caseCount,
    dimensions: arrayMember(expansion, 'dimensions', `${sourcePath}/expansion`)
      .map((item, index) => {
        const dimension = jsonObject(item, `${sourcePath}/expansion/dimensions/${index}`);
        return {
          name: stringMember(
            dimension,
            'name',
            `${sourcePath}/expansion/dimensions/${index}`,
          ),
          values: nonEmptyValues(
            arrayMember(dimension, 'values', `${sourcePath}/expansion/dimensions/${index}`),
            `${sourcePath}/expansion/dimensions/${index}/values`,
          ),
        };
      }),
  };
}

export async function loadSecurityFixtures(
  corpusRoot: string,
): Promise<readonly SecurityFixture[]> {
  const files = (await discoverFiles(path.join(corpusRoot, 'security')))
    .filter((pathname) => pathname.endsWith('.json'));
  return Promise.all(files.map(async (pathname) => {
    const fixture = await loadJsonFixture(pathname);
    return parseSecurityFixture(pathname, fixture.value);
  }));
}
