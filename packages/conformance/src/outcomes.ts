/** The four states that a conformance fixture can report. */
export type OutcomeStatus = 'pass' | 'fail' | 'blocked' | 'undetermined';

export type NonPassStatus = Exclude<OutcomeStatus, 'pass'>;

/**
 * A comparison explanation intended for both humans and machine-readable report output.
 * Each diagnostic repeats its fixture identity so a flattened report remains actionable.
 */
export interface FixtureDiagnostic {
  readonly id: string;
  readonly rule: string;
  readonly expected: string;
  readonly actual: string;
  readonly diff: string;
}

export interface PassOutcome {
  readonly status: 'pass';
}

export interface FailOutcome {
  readonly status: 'fail';
  readonly diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]];
}

export interface BlockedOutcome {
  readonly status: 'blocked';
  /** Stable capability key naming the implementation surface which is absent. */
  readonly capability: string;
  readonly diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]];
}

export interface UndeterminedOutcome {
  readonly status: 'undetermined';
  readonly diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]];
}

export type ConformanceOutcome =
  | PassOutcome
  | FailOutcome
  | BlockedOutcome
  | UndeterminedOutcome;

export type NonPassOutcome = Exclude<ConformanceOutcome, PassOutcome>;

export interface FixtureResult {
  readonly id: string;
  readonly rule: string;
  readonly outcome: ConformanceOutcome;
}

export function pass(): PassOutcome {
  return { status: 'pass' };
}

export function fail(
  diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]],
): FailOutcome {
  return { status: 'fail', diagnostics };
}

export function blocked(
  capability: string,
  diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]],
): BlockedOutcome {
  if (capability.length === 0) {
    throw new TypeError('A blocked outcome requires a named capability.');
  }
  return { status: 'blocked', capability, diagnostics };
}

export function undetermined(
  diagnostics: readonly [FixtureDiagnostic, ...FixtureDiagnostic[]],
): UndeterminedOutcome {
  return { status: 'undetermined', diagnostics };
}

export function fixtureResult(
  id: string,
  rule: string,
  outcome: ConformanceOutcome,
): FixtureResult {
  if (id.length === 0) throw new TypeError('A fixture result requires a non-empty id.');
  if (rule.length === 0) throw new TypeError('A fixture result requires a non-empty rule.');
  if (outcome.status !== 'pass') {
    for (const diagnostic of outcome.diagnostics) {
      if (diagnostic.id !== id) {
        throw new TypeError('Each diagnostic id must match its fixture result id.');
      }
      if (diagnostic.rule !== rule) {
        throw new TypeError('Each diagnostic rule must match its fixture result rule.');
      }
    }
  }
  return { id, rule, outcome };
}

export function isNonPassOutcome(outcome: ConformanceOutcome): outcome is NonPassOutcome {
  return outcome.status !== 'pass';
}

export function nonEmptyDiagnostics(
  diagnostics: readonly FixtureDiagnostic[],
): readonly [FixtureDiagnostic, ...FixtureDiagnostic[]] {
  const first = diagnostics[0];
  if (first === undefined) throw new TypeError('A non-pass outcome requires a diagnostic.');
  return [first, ...diagnostics.slice(1)];
}
