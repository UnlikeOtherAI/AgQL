import { canonicalizeJcs } from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

import { compareCanonical } from './canonical-diff.ts';
import type {
  ExactAdapterDriver,
  ExactAdapterRun,
  ExactQueryObservation,
} from './exact-driver.ts';
import { loadExactFixtures } from './exact-fixtures.ts';
import { runExactSuite } from './exact.ts';
import type { ExactSuiteExecution } from './exact.ts';
import {
  blocked,
  fail,
  fixtureResult,
  pass,
  undetermined,
} from './outcomes.ts';
import type { FixtureDiagnostic, FixtureResult } from './outcomes.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';

export interface PortabilitySkip {
  readonly fixtureId: string;
  readonly adapterId: string;
  readonly profile: string;
  readonly reason: string;
}

export interface PortabilityComparison {
  readonly fixtureId: string;
  readonly leftAdapter: string;
  readonly rightAdapter: string;
  readonly status: 'equal' | 'different' | 'not-compared';
  readonly leftCanonicalBytes?: string;
  readonly rightCanonicalBytes?: string;
  readonly reason?: string;
}

export interface PortabilitySuiteExecution {
  readonly report: SuiteReport;
  readonly comparisons: readonly PortabilityComparison[];
  readonly skips: readonly PortabilitySkip[];
  readonly exactReports: readonly [ExactSuiteExecution, ExactSuiteExecution];
}

function observationSurface(observation: ExactQueryObservation): JsonValue {
  switch (observation.kind) {
    case 'success':
      return { kind: 'success', semantic: observation.semantic };
    case 'refusal':
      return { kind: 'refusal', errors: observation.errors };
    case 'exception':
      return { kind: 'exception', message: observation.message };
    case 'declined':
      return { kind: 'declined', reason: observation.reason };
  }
}

function adapterSurface(run: ExactAdapterRun): JsonValue {
  return Object.fromEntries(Object.entries(run.observations).map(([name, observed]) => [
    name,
    observationSurface(observed),
  ]));
}

function fixtureById(execution: ExactSuiteExecution, fixtureId: string): FixtureResult {
  const fixture = execution.report.fixtures.find(({ id }) => id === fixtureId);
  if (fixture === undefined) throw new TypeError(`Exact report omitted ${fixtureId}.`);
  return fixture;
}

function diagnostic(
  fixture: FixtureResult,
  expected: string,
  actual: string,
  diff: string,
): FixtureDiagnostic {
  return { id: fixture.id, rule: fixture.rule, expected, actual, diff };
}

function firstDecline(run: ExactAdapterRun | undefined): string | undefined {
  if (run === undefined) return undefined;
  for (const observation of Object.values(run.observations)) {
    if (observation.kind === 'declined') return observation.reason;
  }
  return undefined;
}

function blockedCapability(fixture: FixtureResult): string | undefined {
  return fixture.outcome.status === 'blocked' ? fixture.outcome.capability : undefined;
}

function compareFixture(
  fixtureId: string,
  left: ExactSuiteExecution,
  right: ExactSuiteExecution,
  leftDriver: ExactAdapterDriver,
  rightDriver: ExactAdapterDriver,
  requiredProfile: string,
  skips: PortabilitySkip[],
  comparisons: PortabilityComparison[],
): FixtureResult {
  const leftFixture = fixtureById(left, fixtureId);
  const rightFixture = fixtureById(right, fixtureId);
  const leftRun = left.adapterRuns[fixtureId];
  const rightRun = right.adapterRuns[fixtureId];
  const blocker = blockedCapability(leftFixture) ?? blockedCapability(rightFixture);
  if (leftRun === undefined || rightRun === undefined) {
    const capability = blocker ?? 'exact-fixture-extension';
    comparisons.push({
      fixtureId,
      leftAdapter: leftDriver.id,
      rightAdapter: rightDriver.id,
      status: 'not-compared',
      reason: `fixture blocked by ${capability}`,
    });
    return fixtureResult(fixtureId, leftFixture.rule, blocked(capability, [diagnostic(
      leftFixture,
      'both adapters execute the stable fixture',
      `fixture blocked by ${capability}`,
      'The comparison remains explicit and makes no portability claim.',
    )]));
  }
  const leftDecline = firstDecline(leftRun);
  const rightDecline = firstDecline(rightRun);
  if (leftDecline !== undefined || rightDecline !== undefined) {
    if (leftDecline !== undefined) skips.push({
      fixtureId,
      adapterId: leftDriver.id,
      profile: requiredProfile,
      reason: leftDecline,
    });
    if (rightDecline !== undefined) skips.push({
      fixtureId,
      adapterId: rightDriver.id,
      profile: requiredProfile,
      reason: rightDecline,
    });
    const reason = [leftDecline, rightDecline].filter((value) => value !== undefined).join('; ');
    comparisons.push({
      fixtureId,
      leftAdapter: leftDriver.id,
      rightAdapter: rightDriver.id,
      status: 'not-compared',
      reason,
    });
    return fixtureResult(fixtureId, leftFixture.rule, blocked(
      'portability-adapter-declined',
      [diagnostic(
        leftFixture,
        'two adapter results available for comparison',
        reason,
        'The adapter-specific decline is a recorded skip, not a failure or pass.',
      )],
    ));
  }
  const leftSurface = adapterSurface(leftRun);
  const rightSurface = adapterSurface(rightRun);
  const compared = compareCanonical(leftSurface, rightSurface);
  comparisons.push({
    fixtureId,
    leftAdapter: leftDriver.id,
    rightAdapter: rightDriver.id,
    status: compared.equal ? 'equal' : 'different',
    leftCanonicalBytes: compared.expectedBytes,
    rightCanonicalBytes: compared.actualBytes,
  });
  if (leftFixture.outcome.status === 'undetermined'
    || rightFixture.outcome.status === 'undetermined') {
    return fixtureResult(fixtureId, leftFixture.rule, undetermined([diagnostic(
      leftFixture,
      'RFC-determined portability oracle',
      'at least one exact result is undetermined by RFC v0',
      'Adapter bytes are recorded, but no acceptance claim is made.',
    )]));
  }
  const oraclePass = leftFixture.outcome.status === 'pass'
    && rightFixture.outcome.status === 'pass';
  if (!compared.equal || !oraclePass) {
    const actual = canonicalizeJcs({
      leftExactOutcome: leftFixture.outcome.status,
      rightExactOutcome: rightFixture.outcome.status,
      leftBytes: compared.expectedBytes,
      rightBytes: compared.actualBytes,
    });
    return fixtureResult(fixtureId, leftFixture.rule, fail([diagnostic(
      leftFixture,
      'both adapters match the oracle and each other byte-for-byte',
      actual,
      compared.equal
        ? 'The adapters agree with each other but at least one disagrees with the oracle.'
        : compared.diff,
    )]));
  }
  return fixtureResult(fixtureId, leftFixture.rule, pass());
}

export async function runPortabilitySuite(
  corpusRoot: string,
  leftDriver: ExactAdapterDriver,
  rightDriver: ExactAdapterDriver,
): Promise<PortabilitySuiteExecution> {
  const [left, right] = await Promise.all([
    runExactSuite(corpusRoot, leftDriver),
    runExactSuite(corpusRoot, rightDriver),
  ]);
  const fixtures = await loadExactFixtures(corpusRoot);
  const profiles = new Map(fixtures.map((fixture) => [
    fixture.id,
    fixture.requiresProfile,
  ]));
  const skips: PortabilitySkip[] = [];
  const comparisons: PortabilityComparison[] = [];
  const results = left.report.fixtures.map((fixture) => {
    const requiredProfile = profiles.get(fixture.id);
    if (requiredProfile === undefined) {
      throw new TypeError(`Exact corpus omitted profile for ${fixture.id}.`);
    }
    return compareFixture(
      fixture.id,
      left,
      right,
      leftDriver,
      rightDriver,
      requiredProfile,
      skips,
      comparisons,
    );
  });
  return {
    report: createSuiteReport(`portability:${leftDriver.id}:${rightDriver.id}`, results),
    comparisons,
    skips,
    exactReports: [left, right],
  };
}
