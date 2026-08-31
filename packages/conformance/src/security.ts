import { createHash } from 'node:crypto';

import { canonicalizeJcs } from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

import {
  blocked,
  fail,
  fixtureResult,
  pass,
} from './outcomes.ts';
import type { FixtureResult } from './outcomes.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';
import { expandSecurityCases } from './security-expansion.ts';
import type { SecurityCase } from './security-expansion.ts';
import { loadSecurityFixtures } from './security-fixtures.ts';
import type { SecurityFixture } from './security-fixtures.ts';

export type SecurityTier = 'fast' | 'exhaustive';

export interface SecurityReplay {
  readonly seedHex: string;
  readonly caseIndex: number;
}

export interface SecurityExecutionMetadata {
  readonly adapterVersion: string;
  readonly bindingVersion: string;
  readonly engineVersion: string;
  readonly state: JsonValue;
}

export type SecurityCaseObservation =
  | { readonly kind: 'pass'; readonly metadata: SecurityExecutionMetadata }
  | {
      readonly kind: 'violation';
      readonly actual: string;
      readonly diff: string;
      readonly metadata: SecurityExecutionMetadata;
    }
  | {
      readonly kind: 'blocked';
      readonly capability: string;
      readonly reason: string;
      readonly metadata: SecurityExecutionMetadata;
    };

export interface SecurityProbeExecutor {
  execute(
    fixture: SecurityFixture,
    probe: SecurityCase,
  ): Promise<SecurityCaseObservation>;
}

export interface SecurityRunOptions {
  readonly tier: SecurityTier;
  readonly replay?: SecurityReplay;
  readonly fastCasesPerFixture?: number;
}

interface FirstBlocked {
  readonly capability: string;
  readonly reason: string;
  readonly probe: SecurityCase;
  readonly metadata: SecurityExecutionMetadata;
}

interface FirstViolation {
  readonly actual: string;
  readonly diff: string;
  readonly probe: SecurityCase;
  readonly metadata: SecurityExecutionMetadata;
}

function defaultMetadata(): SecurityExecutionMetadata {
  return {
    adapterVersion: 'not-configured',
    bindingVersion: 'not-configured',
    engineVersion: 'not-configured',
    state: { kind: 'not-executed' },
  };
}

const RECEIPT_SECURITY = new Set([
  'security.write-to-search',
  'security.delete-to-search',
  'security.embedding-migration-split',
]);

export function blockedSecurityExecutor(): SecurityProbeExecutor {
  return {
    execute(fixture) {
      const receipt = RECEIPT_SECURITY.has(fixture.id);
      return Promise.resolve({
        kind: 'blocked',
        capability: receipt
          ? 'receipt-visibility-state-machine'
          : `live-security-probe:${fixture.id}`,
        reason: receipt
          ? 'Receipt security execution is reserved for the concurrent contract task.'
          : 'No live implementation probe driver is configured for this matrix.',
        metadata: defaultMetadata(),
      });
    },
  };
}

function caseLimit(fixture: SecurityFixture, options: SecurityRunOptions): number {
  if (options.replay !== undefined) return fixture.caseCount;
  if (options.tier === 'exhaustive') return fixture.caseCount;
  const configured = options.fastCasesPerFixture ?? 256;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new TypeError('fastCasesPerFixture must be a positive safe integer.');
  }
  return Math.min(configured, fixture.caseCount);
}

function fixtureSelected(fixture: SecurityFixture, replay: SecurityReplay | undefined): boolean {
  return replay === undefined || replay.seedHex === fixture.seedHex;
}

function reproduction(probe: SecurityCase): string {
  return `pnpm conformance --suite security --seed ${probe.seedHex}:${probe.caseIndex}`;
}

function resultFor(
  fixture: SecurityFixture,
  executed: number,
  expansionDigest: string,
  violation: FirstViolation | undefined,
  blocker: FirstBlocked | undefined,
): FixtureResult {
  if (violation !== undefined) {
    return fixtureResult(fixture.id, fixture.rule, fail([{
      id: fixture.id,
      rule: fixture.rule,
      expected: `zero violations across ${executed} deterministic cases`,
      actual: `${violation.actual}; seed=${violation.probe.seedHex}; `
        + `case=${violation.probe.caseIndex}; dimensions=`
        + canonicalizeJcs(violation.probe.selected)
        + `; metadata=${canonicalizeJcs(violation.metadata)}`,
      diff: `${violation.diff}; reproduce: ${reproduction(violation.probe)}`,
    }]));
  }
  if (blocker !== undefined) {
    return fixtureResult(fixture.id, fixture.rule, blocked(blocker.capability, [{
      id: fixture.id,
      rule: fixture.rule,
      expected: `${executed} live deterministic executions with zero violations`,
      actual: `${blocker.reason}; expanded=${executed}; expansionDigest=${expansionDigest}; `
        + `firstCase=${blocker.probe.caseIndex}; metadata=${canonicalizeJcs(blocker.metadata)}`,
      diff: `Capability ${blocker.capability} is absent; reproduce expansion with `
        + reproduction(blocker.probe),
    }]));
  }
  return fixtureResult(fixture.id, fixture.rule, pass());
}

async function runFixture(
  fixture: SecurityFixture,
  executor: SecurityProbeExecutor,
  options: SecurityRunOptions,
): Promise<FixtureResult> {
  const digest = createHash('sha256');
  let executed = 0;
  let firstViolation: FirstViolation | undefined;
  let firstBlocked: FirstBlocked | undefined;
  const onlyCase = options.replay?.caseIndex;
  for (const probe of expandSecurityCases(fixture, caseLimit(fixture, options), onlyCase)) {
    executed += 1;
    digest.update(
      canonicalizeJcs({ caseIndex: probe.caseIndex, selected: probe.selected }),
      'utf8',
    );
    const observed = await executor.execute(fixture, probe);
    if (observed.kind === 'violation' && firstViolation === undefined) {
      firstViolation = {
        actual: observed.actual,
        diff: observed.diff,
        probe,
        metadata: observed.metadata,
      };
    } else if (observed.kind === 'blocked' && firstBlocked === undefined) {
      firstBlocked = {
        capability: observed.capability,
        reason: observed.reason,
        probe,
        metadata: observed.metadata,
      };
    }
  }
  if (executed === 0) throw new TypeError(`${fixture.id} expansion executed no cases.`);
  return resultFor(
    fixture,
    executed,
    `sha256:${digest.digest('hex')}`,
    firstViolation,
    firstBlocked,
  );
}

export async function runSecuritySuite(
  corpusRoot: string,
  executor: SecurityProbeExecutor,
  options: SecurityRunOptions,
): Promise<SuiteReport> {
  const fixtures = await loadSecurityFixtures(corpusRoot);
  const selected = fixtures.filter((fixture) => fixtureSelected(fixture, options.replay));
  if (selected.length === 0) {
    throw new TypeError(`No security fixture uses replay seed ${options.replay?.seedHex}.`);
  }
  const results: FixtureResult[] = [];
  for (const fixture of selected) results.push(await runFixture(fixture, executor, options));
  return createSuiteReport(`security:${options.tier}`, results);
}
