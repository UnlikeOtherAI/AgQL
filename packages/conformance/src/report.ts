import { canonicalizeJcs } from '@agql/schemas';

import {
  type ConformanceOutcome,
  type FixtureDiagnostic,
  type FixtureResult,
  type NonPassOutcome,
  isNonPassOutcome,
} from './outcomes.ts';

export interface OutcomeTotals {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly blocked: number;
  readonly undetermined: number;
}

export interface SuiteReport {
  readonly name: string;
  readonly fixtures: readonly FixtureResult[];
  readonly totals: OutcomeTotals;
}

export interface ConformanceReport {
  readonly suites: readonly SuiteReport[];
  readonly totals: OutcomeTotals;
}

interface MutableOutcomeTotals {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  undetermined: number;
}

interface RenderedDiagnostic {
  readonly id: string;
  readonly rule: string;
  readonly expected: string;
  readonly actual: string;
  readonly diff: string;
}

interface RenderedFixture {
  readonly id: string;
  readonly rule: string;
  readonly status: NonPassOutcome['status'];
  readonly capability?: string;
  readonly diagnostics: readonly RenderedDiagnostic[];
}

interface RenderedSuite {
  readonly name: string;
  readonly totals: OutcomeTotals;
  readonly nonPass: readonly RenderedFixture[];
}

interface RenderedReport {
  readonly totals: OutcomeTotals;
  readonly suites: readonly RenderedSuite[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedFixtures(fixtures: readonly FixtureResult[]): readonly FixtureResult[] {
  return [...fixtures].sort((left, right) => compareText(left.id, right.id));
}

function sortedSuites(suites: readonly SuiteReport[]): readonly SuiteReport[] {
  return [...suites].sort((left, right) => compareText(left.name, right.name));
}

function sortedDiagnostics(
  diagnostics: readonly FixtureDiagnostic[],
): readonly FixtureDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const byId = compareText(left.id, right.id);
    if (byId !== 0) return byId;
    const byRule = compareText(left.rule, right.rule);
    if (byRule !== 0) return byRule;
    const byExpected = compareText(left.expected, right.expected);
    if (byExpected !== 0) return byExpected;
    const byActual = compareText(left.actual, right.actual);
    if (byActual !== 0) return byActual;
    return compareText(left.diff, right.diff);
  });
}

function emptyTotals(): MutableOutcomeTotals {
  return { total: 0, pass: 0, fail: 0, blocked: 0, undetermined: 0 };
}

function increment(totals: MutableOutcomeTotals, outcome: ConformanceOutcome): void {
  totals.total += 1;
  switch (outcome.status) {
    case 'pass':
      totals.pass += 1;
      return;
    case 'fail':
      totals.fail += 1;
      return;
    case 'blocked':
      totals.blocked += 1;
      return;
    case 'undetermined':
      totals.undetermined += 1;
      return;
  }
}

function sumTotals(totals: MutableOutcomeTotals, next: OutcomeTotals): void {
  totals.total += next.total;
  totals.pass += next.pass;
  totals.fail += next.fail;
  totals.blocked += next.blocked;
  totals.undetermined += next.undetermined;
}

function readonlyTotals(totals: MutableOutcomeTotals): OutcomeTotals {
  return {
    total: totals.total,
    pass: totals.pass,
    fail: totals.fail,
    blocked: totals.blocked,
    undetermined: totals.undetermined,
  };
}

function assertUniqueFixtureIds(fixtures: readonly FixtureResult[]): void {
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) {
      throw new TypeError(`Suite contains duplicate fixture id ${fixture.id}.`);
    }
    ids.add(fixture.id);
  }
}

function assertUniqueSuiteNames(suites: readonly SuiteReport[]): void {
  const names = new Set<string>();
  for (const suite of suites) {
    if (names.has(suite.name)) {
      throw new TypeError(`Report contains duplicate suite name ${suite.name}.`);
    }
    names.add(suite.name);
  }
}

export function calculateTotals(fixtures: readonly FixtureResult[]): OutcomeTotals {
  const totals = emptyTotals();
  for (const fixture of fixtures) increment(totals, fixture.outcome);
  return readonlyTotals(totals);
}

export function createSuiteReport(
  name: string,
  fixtures: readonly FixtureResult[],
): SuiteReport {
  if (name.length === 0) throw new TypeError('A suite report requires a non-empty name.');
  assertUniqueFixtureIds(fixtures);
  const orderedFixtures = sortedFixtures(fixtures);
  return {
    name,
    fixtures: orderedFixtures,
    totals: calculateTotals(orderedFixtures),
  };
}

export function createConformanceReport(suites: readonly SuiteReport[]): ConformanceReport {
  assertUniqueSuiteNames(suites);
  const orderedSuites = sortedSuites(suites);
  const totals = emptyTotals();
  for (const suite of orderedSuites) sumTotals(totals, suite.totals);
  return { suites: orderedSuites, totals: readonlyTotals(totals) };
}

function isNonPassFixture(
  fixture: FixtureResult,
): fixture is FixtureResult & { readonly outcome: NonPassOutcome } {
  return isNonPassOutcome(fixture.outcome);
}

function renderedDiagnostic(diagnostic: FixtureDiagnostic): RenderedDiagnostic {
  return {
    id: diagnostic.id,
    rule: diagnostic.rule,
    expected: diagnostic.expected,
    actual: diagnostic.actual,
    diff: diagnostic.diff,
  };
}

function renderedFixture(fixture: FixtureResult & {
  readonly outcome: NonPassOutcome;
}): RenderedFixture {
  const capability = fixture.outcome.status === 'blocked'
    ? fixture.outcome.capability
    : undefined;
  return {
    id: fixture.id,
    rule: fixture.rule,
    status: fixture.outcome.status,
    ...(capability === undefined ? {} : { capability }),
    diagnostics: sortedDiagnostics(fixture.outcome.diagnostics).map(renderedDiagnostic),
  };
}

function renderedReport(report: ConformanceReport): RenderedReport {
  return {
    totals: report.totals,
    suites: sortedSuites(report.suites).map((suite): RenderedSuite => ({
      name: suite.name,
      totals: suite.totals,
      nonPass: sortedFixtures(suite.fixtures)
        .filter(isNonPassFixture)
        .map(renderedFixture),
    })),
  };
}

function formatTotals(totals: OutcomeTotals): string {
  return `total=${totals.total} pass=${totals.pass} fail=${totals.fail} blocked=${totals.blocked} `
    + `undetermined=${totals.undetermined}`;
}

export function renderTextReport(report: ConformanceReport): string {
  const lines = ['AgQL conformance report', `totals ${formatTotals(report.totals)}`];
  for (const suite of sortedSuites(report.suites)) {
    lines.push(`suite ${suite.name} ${formatTotals(suite.totals)}`);
    for (const fixture of sortedFixtures(suite.fixtures).filter(isNonPassFixture)) {
      lines.push(`  ${fixture.outcome.status.toUpperCase()} ${fixture.id}`);
      if (fixture.outcome.status === 'blocked') {
        lines.push(`    capability: ${fixture.outcome.capability}`);
      }
      for (const diagnostic of sortedDiagnostics(fixture.outcome.diagnostics)) {
        lines.push(`    id: ${diagnostic.id}`);
        lines.push(`    rule: ${diagnostic.rule}`);
        lines.push(`    expected: ${diagnostic.expected}`);
        lines.push(`    actual: ${diagnostic.actual}`);
        lines.push(`    diff: ${diagnostic.diff}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderJsonReport(report: ConformanceReport): string {
  return `${canonicalizeJcs(renderedReport(report))}\n`;
}
