import path from 'node:path';

import {
  canonicalizeJcs,
  sourceQueryHash,
} from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

import { compareCanonical } from './canonical-diff.ts';
import type {
  ExactAdapterDriver,
  ExactAdapterRun,
  ExactQueryObservation,
  NamedExactQuery,
} from './exact-driver.ts';
import { loadExactFixtures } from './exact-fixtures.ts';
import type { ExactFixture } from './exact-fixtures.ts';
import {
  type JsonObject,
  containsMarker,
  jsonArray,
  jsonObject,
  member,
  objectMember,
  optionalObject,
  stringMember,
} from './json-shape.ts';
import {
  blocked,
  fail,
  fixtureResult,
  nonEmptyDiagnostics,
  pass,
  undetermined,
} from './outcomes.ts';
import type { FixtureDiagnostic, FixtureResult } from './outcomes.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';

const RFC_UNDETERMINED = 'UNDETERMINED_BY_RFC_V0';

interface ExactBlocker {
  readonly capability: string;
  readonly reason: string;
}

const BLOCKERS: Readonly<Record<string, ExactBlocker>> = {
  'exact.records.pagination-reproducibility': {
    capability: 'cursor-pagination-harness',
    reason: 'The current engine API has no cursor-page execution surface.',
  },
  'exact.records.decimal-precision-scale-boundaries': {
    capability: 'per-record-cas-outcomes',
    reason: 'Per-record ingest outcomes are owned by the concurrent contract task.',
  },
  'exact.aggregate.money-cross-currency-sum-refusal': {
    capability: 'multi-currency-money-field',
    reason: 'The current catalog contract requires one fixed currency per money field.',
  },
  'exact.aggregate.money-cross-currency-avg-refusal': {
    capability: 'multi-currency-money-field',
    reason: 'The current catalog contract requires one fixed currency per money field.',
  },
  'exact.aggregate.calendar-day-dst-spring': {
    capability: 'calendar-period-adapter-values',
    reason: 'Calendar-period adapter values are owned by the concurrent contract task.',
  },
  'exact.aggregate.calendar-fiscal-day-dst-fall': {
    capability: 'calendar-period-adapter-values',
    reason: 'Calendar-period adapter values are owned by the concurrent contract task.',
  },
  'exact.aggregate.calendar-week-start': {
    capability: 'calendar-period-adapter-values',
    reason: 'Calendar-period adapter values are owned by the concurrent contract task.',
  },
  'exact.records.relative-in-current-explicit-anchor': {
    capability: 'non-utc-calendar-policy',
    reason: 'The current engine calendar boundary accepts UTC only.',
  },
};

export interface ExactSuiteExecution {
  readonly report: SuiteReport;
  readonly adapterRuns: Readonly<Record<string, ExactAdapterRun>>;
}

function queriesFor(fixture: ExactFixture): readonly NamedExactQuery[] {
  const single = fixture.value.query;
  if (single !== undefined) return [{ name: 'query', query: single }];
  const paired = optionalObject(fixture.value, 'queries', fixture.sourcePath);
  if (paired !== undefined) {
    return Object.entries(paired).map(([name, query]) => ({ name, query }));
  }
  const cases = fixture.value.cases;
  if (cases !== undefined) {
    return jsonArray(cases, `${fixture.sourcePath}/cases`).map((item, index) => {
      const value = jsonObject(item, `${fixture.sourcePath}/cases/${index}`);
      return {
        name: stringMember(value, 'name', `${fixture.sourcePath}/cases/${index}`),
        query: member(value, 'query', `${fixture.sourcePath}/cases/${index}`),
      };
    });
  }
  throw new TypeError(`${fixture.sourcePath} has no query, queries, or cases member.`);
}

function diagnostic(
  fixture: ExactFixture,
  label: string,
  expected: JsonValue,
  actual: JsonValue,
): FixtureDiagnostic {
  const comparison = compareCanonical(expected, actual);
  return {
    id: fixture.id,
    rule: fixture.rule,
    expected: `${label} JCS bytes: ${comparison.expectedBytes}`,
    actual: `${label} JCS bytes: ${comparison.actualBytes}`,
    diff: comparison.diff,
  };
}

function compareMember(
  fixture: ExactFixture,
  label: string,
  expected: JsonValue,
  actual: JsonValue,
  output: FixtureDiagnostic[],
): void {
  if (!compareCanonical(expected, actual).equal) {
    output.push(diagnostic(fixture, label, expected, actual));
  }
}

function observationSurface(observation: ExactQueryObservation): JsonValue {
  switch (observation.kind) {
    case 'success':
      return observation.semantic;
    case 'refusal':
      return observation.errors[0] ?? { error: 'implementation returned an empty error list' };
    case 'exception':
      return { exception: observation.message };
    case 'declined':
      return { declined: observation.reason };
  }
}

function observation(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  name: string,
): ExactQueryObservation {
  const value = run.observations[name];
  if (value === undefined) {
    throw new TypeError(`${run.adapterId} omitted ${fixture.id} query ${name}.`);
  }
  return value;
}

function expectedBeforeBackend(expected: JsonObject): boolean | undefined {
  const value = expected.beforeBackend;
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError('/expected/beforeBackend must be boolean.');
  return value;
}

function checkBackendBoundary(
  fixture: ExactFixture,
  expected: JsonObject,
  observations: readonly ExactQueryObservation[],
  output: FixtureDiagnostic[],
): void {
  const beforeBackend = expectedBeforeBackend(expected);
  if (beforeBackend === undefined) return;
  const actual = observations.every(({ backendCalls }) => backendCalls === 0);
  compareMember(fixture, 'backend boundary', beforeBackend, actual, output);
}

function checkHash(
  fixture: ExactFixture,
  query: JsonValue,
  expectedHash: JsonValue | undefined,
  output: FixtureDiagnostic[],
): void {
  if (expectedHash === undefined) return;
  if (typeof expectedHash !== 'string') {
    throw new TypeError(`${fixture.sourcePath}/expected/sourceQueryHash must be a string.`);
  }
  compareMember(fixture, 'sourceQueryHash', expectedHash, sourceQueryHash(query), output);
}

function checkSingle(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  queries: readonly NamedExactQuery[],
  output: FixtureDiagnostic[],
): void {
  const query = queries[0];
  if (query === undefined) throw new TypeError(`${fixture.id} has no query.`);
  const actual = observation(fixture, run, query.name);
  const outcome = stringMember(fixture.expected, 'outcome', '/expected');
  if (outcome === 'success') {
    compareMember(
      fixture,
      'semantic result',
      member(fixture.expected, 'semantic', '/expected'),
      observationSurface(actual),
      output,
    );
    checkHash(fixture, query.query, fixture.expected.sourceQueryHash, output);
    if (actual.kind === 'success') {
      compareMember(fixture, 'determinism declaration', 'exact', actual.determinism, output);
      compareMember(fixture, 'repeated execution', true, actual.repeatedSemanticEqual, output);
    }
    return;
  }
  if (outcome !== 'refusal') {
    throw new TypeError(`${fixture.id} uses unsupported exact outcome ${outcome}.`);
  }
  const structural = fixture.expected.structuralErrors;
  const expectedError = structural === undefined
    ? member(fixture.expected, 'error', '/expected')
    : structural;
  const actualError = structural === undefined
    ? observationSurface(actual)
    : actual.kind === 'refusal' ? actual.errors : observationSurface(actual);
  compareMember(fixture, 'refusal', expectedError, actualError, output);
  checkBackendBoundary(fixture, fixture.expected, [actual], output);
}

function checkPairedSuccess(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  queries: readonly NamedExactQuery[],
  output: FixtureDiagnostic[],
): void {
  const expectedSemantic = objectMember(fixture.expected, 'semantic', '/expected');
  const expectedHashes = objectMember(fixture.expected, 'sourceQueryHashes', '/expected');
  const actualSemantic: Record<string, JsonValue> = {};
  const actualHashes: Record<string, JsonValue> = {};
  for (const query of queries) {
    actualSemantic[query.name] = observationSurface(observation(fixture, run, query.name));
    actualHashes[query.name] = sourceQueryHash(query.query);
  }
  compareMember(fixture, 'paired semantic results', expectedSemantic, actualSemantic, output);
  compareMember(fixture, 'paired sourceQueryHash values', expectedHashes, actualHashes, output);
  const hashValues = Object.values(actualHashes);
  if (hashValues.length === 2) {
    compareMember(
      fixture,
      'one-way hash implication',
      false,
      hashValues[0] === hashValues[1],
      output,
    );
  }
}

function checkPairedRefusal(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  queries: readonly NamedExactQuery[],
  output: FixtureDiagnostic[],
): void {
  const expectedShape = member(fixture.expected, 'errorShape', '/expected');
  const observations = queries.map((query) => observation(fixture, run, query.name));
  for (const [index, actual] of observations.entries()) {
    const name = queries[index]?.name ?? String(index);
    compareMember(fixture, `${name} refusal`, expectedShape, observationSurface(actual), output);
  }
  const actualBytes = observations.map((actual) => canonicalizeJcs(observationSurface(actual)));
  compareMember(
    fixture,
    'non-disclosure error byte equality',
    true,
    actualBytes.length === 2 && actualBytes[0] === actualBytes[1],
    output,
  );
  checkBackendBoundary(fixture, fixture.expected, observations, output);
}

function checkCases(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  queries: readonly NamedExactQuery[],
  output: FixtureDiagnostic[],
): void {
  const expected = objectMember(fixture.expected, 'errorsByCase', '/expected');
  const actual: Record<string, JsonValue> = {};
  const observations: ExactQueryObservation[] = [];
  for (const query of queries) {
    const item = observation(fixture, run, query.name);
    observations.push(item);
    actual[query.name] = observationSurface(item);
  }
  compareMember(fixture, 'case refusal map', expected, actual, output);
  checkBackendBoundary(fixture, fixture.expected, observations, output);
}

function evaluateFixture(
  fixture: ExactFixture,
  run: ExactAdapterRun,
  queries: readonly NamedExactQuery[],
): FixtureResult {
  const declined = queries.map((query) => observation(fixture, run, query.name))
    .find((item) => item.kind === 'declined');
  if (declined?.kind === 'declined') {
    return fixtureResult(fixture.id, fixture.rule, blocked(
      `adapter-profile:${fixture.requiresProfile}`,
      [{
        id: fixture.id,
        rule: fixture.rule,
        expected: `adapter advertising ${fixture.requiresProfile}`,
        actual: declined.reason,
        diff: 'The adapter declined this profile; portability records the reason separately.',
      }],
    ));
  }
  const diagnostics: FixtureDiagnostic[] = [];
  const expectedOutcome = fixture.expected.outcome;
  if (expectedOutcome === 'paired-success') {
    checkPairedSuccess(fixture, run, queries, diagnostics);
  } else if (expectedOutcome === 'paired-refusal') {
    checkPairedRefusal(fixture, run, queries, diagnostics);
  } else if (fixture.expected.outcomePerCase !== undefined) {
    checkCases(fixture, run, queries, diagnostics);
  } else {
    checkSingle(fixture, run, queries, diagnostics);
  }
  if (diagnostics.length > 0) {
    return fixtureResult(fixture.id, fixture.rule, fail(nonEmptyDiagnostics(diagnostics)));
  }
  if (containsMarker(fixture.expected, RFC_UNDETERMINED)) {
    return fixtureResult(fixture.id, fixture.rule, undetermined([{
      id: fixture.id,
      rule: fixture.rule,
      expected: 'RFC v0 determination for every oracle member',
      actual: RFC_UNDETERMINED,
      diff: 'All determined sibling assertions passed; this member remains a specification gap.',
    }]));
  }
  return fixtureResult(fixture.id, fixture.rule, pass());
}

function blockedFixture(fixture: ExactFixture, blocker: ExactBlocker): FixtureResult {
  return fixtureResult(fixture.id, fixture.rule, blocked(blocker.capability, [{
    id: fixture.id,
    rule: fixture.rule,
    expected: 'fixture executed against the stable adapter contract',
    actual: `${blocker.capability}: ${blocker.reason}`,
    diff: 'A typed extension point reserves this fixture; it is neither skipped nor passed.',
  }]));
}

export async function runExactSuite(
  corpusRoot: string,
  driver: ExactAdapterDriver,
): Promise<ExactSuiteExecution> {
  const fixtures = await loadExactFixtures(corpusRoot);
  const results: FixtureResult[] = [];
  const adapterRuns: Record<string, ExactAdapterRun> = {};
  for (const fixture of fixtures) {
    const blocker = BLOCKERS[fixture.id];
    if (blocker !== undefined) {
      results.push(blockedFixture(fixture, blocker));
      continue;
    }
    const queries = queriesFor(fixture);
    const run = await driver.run(fixture, queries);
    adapterRuns[fixture.id] = run;
    results.push(evaluateFixture(fixture, run, queries));
  }
  return {
    report: createSuiteReport(`exact:${driver.id}`, results),
    adapterRuns,
  };
}

export function defaultCorpusRoot(cwd: string): string {
  return path.resolve(cwd, 'conformance');
}
