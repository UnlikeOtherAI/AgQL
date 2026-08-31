import path from 'node:path';

import {
  canonicalizeJcs,
  decodeAgqlYaml,
  sourceQueryHash,
} from '@agql/schemas';

import {
  type FixtureDiagnostic,
  type FixtureResult,
  fail,
  fixtureResult,
  nonEmptyDiagnostics,
  pass,
} from './outcomes.ts';
import {
  FixtureLoadError,
  discoverFiles,
  loadFixtureSource,
  loadJsonFixture,
} from './fixtures.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';

const PAIR_FILE = /^(\d{3}-[a-z0-9-]+)\.(json|yaml)$/u;
const REJECT_FILE = /^([a-z0-9-]+)\.yaml$/u;
const EXPECT_HEADER = /^# EXPECT: (ENCODING_[A-Z_]+)$/u;

const PAIR_RULE = 'RFC §11 encoding suite: JSON and AgQL-YAML normalize to identical JCS bytes '
  + 'and sourceQueryHash values.';
const REJECT_RULE = 'RFC §11 encoding suite: each forbidden AgQL-YAML feature returns its '
  + 'declared ENCODING_* rejection.';

export interface EncodingSuiteInput {
  readonly fixtureDirectory: string;
}

interface EncodingPairFixture {
  readonly id: string;
  readonly jsonPath: string;
  readonly yamlPath: string;
}

interface EncodingRejectFixture {
  readonly id: string;
  readonly path: string;
}

interface EncodingFixtures {
  readonly pairs: readonly EncodingPairFixture[];
  readonly rejects: readonly EncodingRejectFixture[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pairId(stem: string): string {
  return `encoding/pairs/${stem}`;
}

function rejectId(stem: string): string {
  return `encoding/reject/${stem}`;
}

export async function discoverEncodingFixtures(
  input: EncodingSuiteInput,
): Promise<EncodingFixtures> {
  const pairDirectory = path.join(input.fixtureDirectory, 'pairs');
  const rejectDirectory = path.join(input.fixtureDirectory, 'reject');
  const [pairPaths, rejectPaths] = await Promise.all([
    discoverFiles(pairDirectory),
    discoverFiles(rejectDirectory),
  ]);
  const pairParts = new Map<string, { json?: string; yaml?: string }>();
  for (const fixturePath of pairPaths) {
    const name = path.basename(fixturePath);
    const match = PAIR_FILE.exec(name);
    const stem = match?.[1];
    const extension = match?.[2];
    if (stem === undefined || extension === undefined) {
      throw new FixtureLoadError(
        fixturePath,
        'pair fixtures must be named NNN-name.json or NNN-name.yaml.',
      );
    }
    const parts = pairParts.get(stem) ?? {};
    if (extension === 'json') parts.json = fixturePath;
    else parts.yaml = fixturePath;
    pairParts.set(stem, parts);
  }
  const pairs: EncodingPairFixture[] = [];
  for (const [stem, parts] of pairParts) {
    if (parts.json === undefined || parts.yaml === undefined) {
      throw new FixtureLoadError(
        path.join(pairDirectory, stem),
        'each encoding pair requires exactly one JSON file and one YAML file.',
      );
    }
    pairs.push({ id: pairId(stem), jsonPath: parts.json, yamlPath: parts.yaml });
  }
  const rejects: EncodingRejectFixture[] = [];
  for (const fixturePath of rejectPaths) {
    const match = REJECT_FILE.exec(path.basename(fixturePath));
    const stem = match?.[1];
    if (stem === undefined) {
      throw new FixtureLoadError(fixturePath, 'rejection fixtures must be named name.yaml.');
    }
    rejects.push({ id: rejectId(stem), path: fixturePath });
  }
  return {
    pairs: pairs.sort((left, right) => compareText(left.id, right.id)),
    rejects: rejects.sort((left, right) => compareText(left.id, right.id)),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return `Unexpected thrown value of type ${typeof error}.`;
}

function sourceFailure(id: string, rule: string, error: unknown): FixtureResult {
  const diagnostic: FixtureDiagnostic = {
    id,
    rule,
    expected: 'A valid, strict UTF-8/LF fixture source.',
    actual: describeError(error),
    diff: 'The fixture could not be loaded or decoded before its conformance assertion ran.',
  };
  return fixtureResult(id, rule, fail([diagnostic]));
}

function byte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

function byteDiff(expected: Uint8Array, actual: Uint8Array): string {
  const sharedLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const expectedByte = expected.at(index);
    const actualByte = actual.at(index);
    if (expectedByte === undefined || actualByte === undefined) {
      throw new TypeError('Byte comparison index was unexpectedly unavailable.');
    }
    if (expectedByte !== actualByte) {
      return `First differing UTF-8 byte at offset ${index}: expected ${byte(expectedByte)}, `
        + `actual ${byte(actualByte)}.`;
    }
  }
  return `UTF-8 byte lengths differ: expected ${expected.length}, actual ${actual.length}.`;
}

function pairDiagnostic(
  id: string,
  expectedCanonical: string,
  actualCanonical: string,
): FixtureDiagnostic {
  const expectedBytes = Buffer.from(expectedCanonical, 'utf8');
  const actualBytes = Buffer.from(actualCanonical, 'utf8');
  return {
    id,
    rule: PAIR_RULE,
    expected: `JCS bytes: ${expectedCanonical}`,
    actual: `JCS bytes: ${actualCanonical}`,
    diff: byteDiff(expectedBytes, actualBytes),
  };
}

async function runPairFixture(fixture: EncodingPairFixture): Promise<FixtureResult> {
  try {
    const [json, yaml] = await Promise.all([
      loadJsonFixture(fixture.jsonPath),
      loadFixtureSource(fixture.yamlPath),
    ]);
    const decodedYaml = decodeAgqlYaml(yaml.source);
    if (!decodedYaml.ok) {
      const actual = decodedYaml.errors.map((error) => error.code).join(', ');
      const diagnostic: FixtureDiagnostic = {
        id: fixture.id,
        rule: PAIR_RULE,
        expected: 'A valid AgQL-YAML document that normalizes with its JSON pair.',
        actual: `AgQL-YAML rejection: ${actual}.`,
        diff: 'The YAML half of the accepted pair did not reach canonical comparison.',
      };
      return fixtureResult(fixture.id, PAIR_RULE, fail([diagnostic]));
    }
    const jsonCanonical = canonicalizeJcs(json.value);
    const yamlCanonical = canonicalizeJcs(decodedYaml.value);
    const jsonHash = sourceQueryHash(json.value);
    const yamlHash = sourceQueryHash(decodedYaml.value);
    const diagnostics: FixtureDiagnostic[] = [];
    if (!Buffer.from(jsonCanonical, 'utf8').equals(Buffer.from(yamlCanonical, 'utf8'))) {
      diagnostics.push(pairDiagnostic(fixture.id, jsonCanonical, yamlCanonical));
    }
    if (jsonHash !== yamlHash) {
      diagnostics.push({
        id: fixture.id,
        rule: PAIR_RULE,
        expected: `sourceQueryHash: ${jsonHash}`,
        actual: `sourceQueryHash: ${yamlHash}`,
        diff: 'The canonical source-query identities differ.',
      });
    }
    if (diagnostics.length === 0) return fixtureResult(fixture.id, PAIR_RULE, pass());
    return fixtureResult(fixture.id, PAIR_RULE, fail(nonEmptyDiagnostics(diagnostics)));
  } catch (error: unknown) {
    return sourceFailure(fixture.id, PAIR_RULE, error);
  }
}

function expectedRejectionCode(source: string, fixturePath: string): string {
  const firstLine = source.split('\n', 1)[0];
  const expected = firstLine === undefined ? undefined : EXPECT_HEADER.exec(firstLine)?.[1];
  if (expected === undefined) {
    throw new FixtureLoadError(
      fixturePath,
      'rejection fixture must begin with a # EXPECT: ENCODING_* header.',
    );
  }
  return expected;
}

async function runRejectFixture(fixture: EncodingRejectFixture): Promise<FixtureResult> {
  try {
    const source = await loadFixtureSource(fixture.path);
    const expected = expectedRejectionCode(source.source, fixture.path);
    const decoded = decodeAgqlYaml(source.source);
    if (decoded.ok) {
      const actualCanonical = canonicalizeJcs(decoded.value);
      const diagnostic: FixtureDiagnostic = {
        id: fixture.id,
        rule: REJECT_RULE,
        expected: `Encoding rejection: ${expected}.`,
        actual: `Accepted document with JCS bytes: ${actualCanonical}`,
        diff: 'The forbidden YAML feature was accepted.',
      };
      return fixtureResult(fixture.id, REJECT_RULE, fail([diagnostic]));
    }
    const actual = decoded.errors[0].code;
    if (actual === expected) return fixtureResult(fixture.id, REJECT_RULE, pass());
    const diagnostic: FixtureDiagnostic = {
      id: fixture.id,
      rule: REJECT_RULE,
      expected: `Encoding rejection: ${expected}.`,
      actual: `Encoding rejection: ${actual}.`,
      diff: 'The rejection error code differs from the fixture header.',
    };
    return fixtureResult(fixture.id, REJECT_RULE, fail([diagnostic]));
  } catch (error: unknown) {
    return sourceFailure(fixture.id, REJECT_RULE, error);
  }
}

/** Runs the currently executable RFC §11 encoding corpus; no query engine is involved. */
export async function runEncodingSuite(input: EncodingSuiteInput): Promise<SuiteReport> {
  const fixtures = await discoverEncodingFixtures(input);
  const results = await Promise.all([
    ...fixtures.pairs.map(runPairFixture),
    ...fixtures.rejects.map(runRejectFixture),
  ]);
  return createSuiteReport('encoding', results);
}
