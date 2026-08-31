import path from 'node:path';

import type { JsonValue } from '@agql/schemas';

import type { ExactFixture } from './exact-fixtures.ts';
import { discoverFiles } from './fixtures.ts';
import type { FixtureResult } from './outcomes.ts';
import { runReceiptFixture } from './receipts.ts';
import type { CoverageNotice } from './report.ts';

/**
 * Receipt execution is intentionally supplied by the contract-gap task once its visibility
 * state machine and AFTER_WRITE_TIMEOUT wire result stabilize.
 */
export interface ReceiptSuiteExtension {
  readonly capability: 'receipt-visibility-state-machine';
  runFixture(fixture: JsonValue): Promise<FixtureResult>;
}

/** The receipt fixtures exercise the shared visibility state machine directly. */
export function createReceiptSuiteExtension(): ReceiptSuiteExtension {
  return {
    capability: 'receipt-visibility-state-machine',
    runFixture(fixture) {
      return Promise.resolve(runReceiptFixture(fixture));
    },
  };
}

/**
 * Calendar buckets cross the adapter boundary in a representation currently being changed.
 * The exact runner reserves this seam without freezing the superseded representation.
 */
export interface CalendarBucketExtension {
  readonly capability: 'calendar-period-adapter-values';
  runFixture(fixture: ExactFixture): Promise<FixtureResult>;
}

export interface DeferredCoverage extends CoverageNotice {
  readonly suite: 'receipts';
  readonly capability: ReceiptSuiteExtension['capability'];
  readonly extension: 'ReceiptSuiteExtension';
}

export async function deferredReceiptCoverage(corpusRoot: string): Promise<DeferredCoverage> {
  const fixtures = (await discoverFiles(path.join(corpusRoot, 'receipts')))
    .filter((pathname) => pathname.endsWith('.json'));
  return {
    suite: 'receipts',
    fixtureCount: fixtures.length,
    capability: 'receipt-visibility-state-machine',
    extension: 'ReceiptSuiteExtension',
  };
}
