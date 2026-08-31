import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { JsonValue } from '@agql/schemas';

import { loadJsonFixture } from './fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  jsonArray,
  jsonObject,
  member,
  numberMember,
  objectMember,
  stringMember,
} from './json-shape.ts';
import {
  blocked,
  fail,
  fixtureResult,
  pass,
} from './outcomes.ts';
import type { FixtureResult } from './outcomes.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';

const execFileAsync = promisify(execFile);

export interface RetrievalExecutionMetadata {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly bindingVersion: string;
  readonly engineVersion: string;
  readonly indexConfigurationDigest: string;
}

export type RetrievalQueryObservation =
  | {
      readonly kind: 'success';
      readonly ids: readonly string[];
      readonly metadata: RetrievalExecutionMetadata;
    }
  | { readonly kind: 'declined'; readonly reason: string };

export interface RetrievalFixtureInput {
  readonly id: string;
  readonly rule: string;
  readonly queryId: string;
  readonly k: number;
  readonly eligibleIds: readonly string[];
  readonly exactTopK: readonly string[];
  readonly value: JsonObject;
}

export interface ApproximateRetrievalExecutor {
  query(input: RetrievalFixtureInput): Promise<RetrievalQueryObservation>;
}

export interface RecallQueryMeasurement {
  readonly queryId: string;
  readonly k: number;
  readonly exactRelevantCount: number;
  readonly returnedEligibleCount: number;
  readonly relevantReturnedCount: number;
  readonly recall: string;
}

export interface RecallDistribution {
  readonly sampleCount: number;
  readonly mean: string;
  readonly median: string;
  readonly minimum: string;
  readonly p01: string;
  readonly p05: string;
  readonly p10: string;
  readonly p25: string;
}

export interface RetrievalMeasurement {
  readonly fixtureId: string;
  readonly thresholdStatus: 'awaiting-first-cross-adapter-measurement';
  readonly thresholds: null;
  readonly perQuery: readonly RecallQueryMeasurement[];
  readonly distribution: RecallDistribution;
  readonly metadata: RetrievalExecutionMetadata;
}

export interface RetrievalSuiteExecution {
  readonly report: SuiteReport;
  readonly measurements: readonly RetrievalMeasurement[];
}

interface ParsedRetrievalFixture {
  readonly value: JsonObject;
  readonly id: string;
  readonly rule: string;
  readonly k: number;
  readonly eligibleIds: readonly string[];
  readonly exactTopKByQuery: readonly {
    readonly queryId: string;
    readonly ids: readonly string[];
  }[];
}

interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const FIXTURE_FILES = [
  'filter-1.json',
  'filter-10.json',
  'filter-50.json',
  'sparse-intersection.json',
] as const;

export function unavailableRetrievalExecutor(reason: string): ApproximateRetrievalExecutor {
  return { query: () => Promise.resolve({ kind: 'declined', reason }) };
}

function stringArray(value: JsonValue, location: string): readonly string[] {
  return jsonArray(value, location).map((item, index) => {
    if (typeof item !== 'string') throw new TypeError(`${location}/${index} must be a string.`);
    return item;
  });
}

async function loadRetrievalFixture(pathname: string): Promise<ParsedRetrievalFixture> {
  const source = await loadJsonFixture(pathname);
  const root = jsonObject(source.value, pathname);
  if (stringMember(root, 'format', pathname) !== 'agql-retrieval-fixture/0.1') {
    throw new TypeError(`${pathname}/format must be agql-retrieval-fixture/0.1.`);
  }
  const query = objectMember(root, 'queryTemplate', pathname);
  const oracle = objectMember(root, 'oracle', pathname);
  return {
    value: root,
    id: stringMember(root, 'id', pathname),
    rule: stringMember(root, 'rule', pathname),
    k: numberMember(query, 'take', `${pathname}/queryTemplate`),
    eligibleIds: stringArray(member(oracle, 'eligibleIds', `${pathname}/oracle`),
      `${pathname}/oracle/eligibleIds`),
    exactTopKByQuery: arrayMember(oracle, 'exactTopKByQuery', `${pathname}/oracle`)
      .map((item, index) => {
        const expected = jsonObject(item, `${pathname}/oracle/exactTopKByQuery/${index}`);
        return {
          queryId: stringMember(
            expected,
            'queryId',
            `${pathname}/oracle/exactTopKByQuery/${index}`,
          ),
          ids: stringArray(
            member(expected, 'ids', `${pathname}/oracle/exactTopKByQuery/${index}`),
            `${pathname}/oracle/exactTopKByQuery/${index}/ids`,
          ),
        };
      }),
  };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator: number, denominator: number): Fraction {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator < 0 || denominator <= 0) {
    throw new TypeError('Recall fractions require nonnegative safe integers and a denominator.');
  }
  const divisor = gcd(BigInt(numerator), BigInt(denominator));
  return { numerator: BigInt(numerator) / divisor, denominator: BigInt(denominator) / divisor };
}

function add(left: Fraction, right: Fraction): Fraction {
  const numerator = left.numerator * right.denominator + right.numerator * left.denominator;
  const denominator = left.denominator * right.denominator;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function compareFraction(left: Fraction, right: Fraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function decimal(fractionValue: Fraction): string {
  let denominator = fractionValue.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) throw new TypeError('Recall fraction has no finite decimal form.');
  const scale = Math.max(twos, fives);
  const scaled = fractionValue.numerator
    * (2n ** BigInt(scale - twos))
    * (5n ** BigInt(scale - fives));
  if (scale === 0) return String(scaled);
  const digits = scaled.toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, -scale);
  const fractional = digits.slice(-scale).replace(/0+$/u, '');
  return fractional.length === 0 ? integer : `${integer}.${fractional}`;
}

function quantile(sorted: readonly Fraction[], probabilityPercent: number): Fraction {
  const index = Math.floor((probabilityPercent / 100) * (sorted.length - 1));
  const value = sorted[index];
  if (value === undefined) throw new TypeError('Recall distribution cannot be empty.');
  return value;
}

function distribution(values: readonly Fraction[]): RecallDistribution {
  if (values.length === 0) throw new TypeError('Recall distribution cannot be empty.');
  const sorted = [...values].sort(compareFraction);
  const total = values.reduce(add, { numerator: 0n, denominator: 1n });
  const mean = {
    numerator: total.numerator,
    denominator: total.denominator * BigInt(values.length),
  };
  return {
    sampleCount: values.length,
    mean: decimal(mean),
    median: decimal(quantile(sorted, 50)),
    minimum: decimal(quantile(sorted, 0)),
    p01: decimal(quantile(sorted, 1)),
    p05: decimal(quantile(sorted, 5)),
    p10: decimal(quantile(sorted, 10)),
    p25: decimal(quantile(sorted, 25)),
  };
}

function eligibilityViolation(
  returned: readonly string[],
  eligible: ReadonlySet<string>,
  k: number,
): string | undefined {
  if (returned.length > k) return `returned ${returned.length} ids for take=${k}`;
  if (new Set(returned).size !== returned.length) return 'returned duplicate stable ids';
  const ineligible = returned.find((id) => !eligible.has(id));
  return ineligible === undefined ? undefined : `returned ineligible id ${ineligible}`;
}

async function measureFixture(
  fixture: ParsedRetrievalFixture,
  executor: ApproximateRetrievalExecutor,
): Promise<{ readonly result: FixtureResult; readonly measurement?: RetrievalMeasurement }> {
  const eligible = new Set(fixture.eligibleIds);
  const perQuery: RecallQueryMeasurement[] = [];
  const fractions: Fraction[] = [];
  let metadata: RetrievalExecutionMetadata | undefined;
  for (const oracle of fixture.exactTopKByQuery) {
    const observed = await executor.query({
      id: fixture.id,
      rule: fixture.rule,
      queryId: oracle.queryId,
      k: fixture.k,
      eligibleIds: fixture.eligibleIds,
      exactTopK: oracle.ids,
      value: fixture.value,
    });
    if (observed.kind === 'declined') {
      return { result: fixtureResult(fixture.id, fixture.rule, blocked(
        'approximate-retrieval-driver',
        [{
          id: fixture.id,
          rule: fixture.rule,
          expected: `${fixture.exactTopKByQuery.length} approximate query measurements`,
          actual: observed.reason,
          diff: 'Thresholds remain null and no quality claim is made.',
        }],
      )) };
    }
    const violation = eligibilityViolation(observed.ids, eligible, fixture.k);
    if (violation !== undefined) {
      return { result: fixtureResult(fixture.id, fixture.rule, fail([{
        id: fixture.id,
        rule: fixture.rule,
        expected: `zero eligibility violations for ${oracle.queryId}`,
        actual: violation,
        diff: 'Recall was not computed because eligibility is a zero-tolerance prerequisite.',
      }])) };
    }
    metadata = observed.metadata;
    const relevant = new Set(oracle.ids);
    const relevantReturned = observed.ids.filter((id) => relevant.has(id)).length;
    const value = fraction(relevantReturned, oracle.ids.length);
    fractions.push(value);
    perQuery.push({
      queryId: oracle.queryId,
      k: fixture.k,
      exactRelevantCount: oracle.ids.length,
      returnedEligibleCount: observed.ids.length,
      relevantReturnedCount: relevantReturned,
      recall: decimal(value),
    });
  }
  if (metadata === undefined) throw new TypeError(`${fixture.id} produced no metadata.`);
  return {
    result: fixtureResult(fixture.id, fixture.rule, pass()),
    measurement: {
      fixtureId: fixture.id,
      thresholdStatus: 'awaiting-first-cross-adapter-measurement',
      thresholds: null,
      perQuery,
      distribution: distribution(fractions),
      metadata,
    },
  };
}

async function generatorResult(retrievalRoot: string): Promise<FixtureResult> {
  const id = 'retrieval.generator-byte-integrity';
  const rule = 'The checked-in retrieval corpus and oracle reproduce byte-for-byte.';
  try {
    await execFileAsync(process.execPath, [path.join(retrievalRoot, 'reference-generator.mjs'),
      '--check']);
    return fixtureResult(id, rule, pass());
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    return fixtureResult(id, rule, fail([{ id, rule, expected: 'generator --check succeeds',
      actual, diff: 'Regenerate only after reviewing the independent oracle change.' }]));
  }
}

async function contractResults(retrievalRoot: string): Promise<readonly FixtureResult[]> {
  const reporting = await loadJsonFixture(path.join(retrievalRoot, 'reporting-contract.json'));
  const reportingRoot = jsonObject(reporting.value, reporting.path);
  const profiles = arrayMember(reportingRoot, 'namedQualityProfiles', reporting.path);
  const thresholdsNull = profiles.every((item, index) =>
    jsonObject(item, `${reporting.path}/namedQualityProfiles/${index}`).thresholds === null);
  const reportId = stringMember(reportingRoot, 'id', reporting.path);
  const reportRule = stringMember(reportingRoot, 'rule', reporting.path);
  const reportResult = thresholdsNull
    ? fixtureResult(reportId, reportRule, pass())
    : fixtureResult(reportId, reportRule, fail([{
        id: reportId,
        rule: reportRule,
        expected: 'all named-profile thresholds are null',
        actual: 'a threshold was populated before cross-adapter measurement',
        diff: 'Remove the fabricated threshold from the reporting contract.',
      }]));
  const certification = await loadJsonFixture(path.join(retrievalRoot,
    'certification-record.json'));
  const certificationRoot = jsonObject(certification.value, certification.path);
  const certificationId = stringMember(certificationRoot, 'id', certification.path);
  const certificationRule = stringMember(certificationRoot, 'rule', certification.path);
  const certificationShape = objectMember(certificationRoot, 'certification', certification.path);
  const certificationResult = certificationShape.thresholds === null
    && certificationShape.status === 'measurement-required'
    ? fixtureResult(certificationId, certificationRule, pass())
    : fixtureResult(certificationId, certificationRule, fail([{
        id: certificationId,
        rule: certificationRule,
        expected: 'thresholds=null and status=measurement-required',
        actual: 'certification template makes an unmeasured quality claim',
        diff: 'Restore the measurement-required certification state.',
      }]));
  return [reportResult, certificationResult];
}

export async function runRetrievalSuite(
  corpusRoot: string,
  executor: ApproximateRetrievalExecutor,
): Promise<RetrievalSuiteExecution> {
  const retrievalRoot = path.join(corpusRoot, 'retrieval');
  const fixtures = await Promise.all(FIXTURE_FILES.map((name) =>
    loadRetrievalFixture(path.join(retrievalRoot, 'fixtures', name))));
  const results: FixtureResult[] = [
    await generatorResult(retrievalRoot),
    ...await contractResults(retrievalRoot),
  ];
  const measurements: RetrievalMeasurement[] = [];
  for (const fixture of fixtures) {
    const measured = await measureFixture(fixture, executor);
    results.push(measured.result);
    if (measured.measurement !== undefined) measurements.push(measured.measurement);
  }
  return { report: createSuiteReport('retrieval', results), measurements };
}
