#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeJcs } from '@agql/schemas';

import { runEncodingSuite } from './encoding.ts';
import { runExactSuite } from './exact.ts';
import { blocked, fixtureResult } from './outcomes.ts';
import { runPortabilitySuite } from './portability.ts';
import type { PortabilitySuiteExecution } from './portability.ts';
import {
  createConformanceReport,
  createSuiteReport,
  renderTextReport,
} from './report.ts';
import type { SuiteReport } from './report.ts';
import {
  runRetrievalSuite,
  unavailableRetrievalExecutor,
} from './retrieval.ts';
import type { RetrievalMeasurement } from './retrieval.ts';
import {
  blockedSecurityExecutor,
  runSecuritySuite,
} from './security.ts';
import type { SecurityReplay, SecurityTier } from './security.ts';
import { createSqliteExactDriver } from './sqlite-exact-driver.ts';
import { createPostgresExactDriver } from './postgres-exact-driver.ts';
import { runReceiptSuite } from './receipts.ts';

type SuiteName = 'encoding' | 'exact' | 'security' | 'retrieval' | 'portability' | 'receipts';
type AdapterSelection = 'sqlite' | 'postgres' | 'both';

interface CliOptions {
  readonly suites: ReadonlySet<SuiteName>;
  readonly tier: SecurityTier;
  readonly adapter: AdapterSelection;
  readonly replay?: SecurityReplay;
  readonly json: boolean;
  readonly help: boolean;
}

const ALL_SUITES: readonly SuiteName[] = [
  'encoding',
  'exact',
  'security',
  'retrieval',
  'portability',
  'receipts',
];

const USAGE = `AgQL conformance runner

Usage: pnpm conformance [options]

  --suite <name[,name]>       encoding, exact, security, retrieval, portability, receipts, or all
  --tier <fast|exhaustive>    security cases: 256/matrix or all 20,000/matrix
  --adapter <sqlite|postgres|both>
  --seed <8hex:caseIndex>     replay one security case exactly
  --json                      emit one canonical JSON artifact
  --help                      show this help
`;

function optionValue(args: readonly string[], index: number, name: string): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new TypeError(`${name} requires a value.`);
  }
  return next;
}

function parseSuites(value: string, output: Set<SuiteName>): void {
  if (value === 'all') {
    for (const suite of ALL_SUITES) output.add(suite);
    return;
  }
  for (const part of value.split(',')) {
    const suite = ALL_SUITES.find((candidate) => candidate === part);
    if (suite === undefined) {
      throw new TypeError(`Unknown suite ${part}.`);
    }
    output.add(suite);
  }
}

function parseReplay(value: string): SecurityReplay {
  const match = /^([0-9a-f]{8}):(0|[1-9]\d*)$/u.exec(value);
  const seedHex = match?.[1];
  const indexText = match?.[2];
  if (seedHex === undefined || indexText === undefined) {
    throw new TypeError('--seed must use 8hex:caseIndex, for example 91e10da5:42.');
  }
  const caseIndex = Number(indexText);
  if (!Number.isSafeInteger(caseIndex)) throw new TypeError('--seed case index is too large.');
  return { seedHex, caseIndex };
}

function parseOptions(args: readonly string[]): CliOptions {
  const suites = new Set<SuiteName>();
  let tier: SecurityTier = 'fast';
  let adapter: AdapterSelection = 'both';
  let replay: SecurityReplay | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') json = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--suite') {
      parseSuites(optionValue(args, index, '--suite'), suites);
      index += 1;
    } else if (argument?.startsWith('--suite=')) {
      parseSuites(argument.slice('--suite='.length), suites);
    } else if (argument === '--tier') {
      const value = optionValue(args, index, '--tier');
      if (value !== 'fast' && value !== 'exhaustive') throw new TypeError(`Unknown tier ${value}.`);
      tier = value;
      index += 1;
    } else if (argument === '--adapter') {
      const value = optionValue(args, index, '--adapter');
      if (value !== 'sqlite' && value !== 'postgres' && value !== 'both') {
        throw new TypeError(`Unknown adapter ${value}.`);
      }
      adapter = value;
      index += 1;
    } else if (argument === '--seed') {
      replay = parseReplay(optionValue(args, index, '--seed'));
      index += 1;
    } else {
      throw new TypeError(`Unknown argument ${argument ?? '<missing>'}.`);
    }
  }
  if (suites.size === 0) for (const suite of ALL_SUITES) suites.add(suite);
  return {
    suites,
    tier,
    adapter,
    ...(replay === undefined ? {} : { replay }),
    json,
    help,
  };
}

function singleAdapterPortability(adapter: AdapterSelection): SuiteReport {
  const id = 'portability.requires-two-adapters';
  const rule = 'RFC §12 gate 1 requires two materially different exact adapters.';
  return createSuiteReport(`portability:${adapter}`, [fixtureResult(id, rule, blocked(
    'second-exact-adapter',
    [{
      id,
      rule,
      expected: 'two exact adapter selections',
      actual: `--adapter ${adapter}`,
      diff: 'Select --adapter both to produce a two-adapter comparison.',
    }],
  ))]);
}

function portabilitySummary(execution: PortabilitySuiteExecution): string {
  const counts = { equal: 0, different: 0, 'not-compared': 0 };
  for (const comparison of execution.comparisons) counts[comparison.status] += 1;
  return `portability comparisons equal=${counts.equal} different=${counts.different} `
    + `not-compared=${counts['not-compared']} adapter-skips=${execution.skips.length}`;
}

async function run(options: CliOptions): Promise<number> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const corpusRoot = path.resolve(moduleDirectory, '../../../conformance');
  const suites: SuiteReport[] = [];
  let portability: PortabilitySuiteExecution | undefined;
  let retrievalMeasurements: readonly RetrievalMeasurement[] = [];

  if (options.suites.has('encoding')) {
    suites.push(await runEncodingSuite({
      fixtureDirectory: path.join(corpusRoot, 'encoding'),
    }));
  }
  if (options.suites.has('portability')) {
    if (options.adapter === 'both') {
      portability = await runPortabilitySuite(
        corpusRoot,
        createSqliteExactDriver(),
        createPostgresExactDriver(),
      );
      suites.push(portability.report);
    } else {
      suites.push(singleAdapterPortability(options.adapter));
    }
  }
  if (options.suites.has('exact')) {
    if (options.adapter === 'both' && portability !== undefined) {
      suites.push(...portability.exactReports.map(({ report }) => report));
    } else {
      if (options.adapter === 'sqlite' || options.adapter === 'both') {
        suites.push((await runExactSuite(corpusRoot, createSqliteExactDriver())).report);
      }
      if (options.adapter === 'postgres' || options.adapter === 'both') {
        suites.push((await runExactSuite(corpusRoot, createPostgresExactDriver())).report);
      }
    }
  }
  if (options.suites.has('security')) {
    suites.push(await runSecuritySuite(corpusRoot, blockedSecurityExecutor(), {
      tier: options.tier,
      ...(options.replay === undefined ? {} : { replay: options.replay }),
    }));
  }
  if (options.suites.has('retrieval')) {
    const retrieval = await runRetrievalSuite(
      corpusRoot,
      unavailableRetrievalExecutor('No approximate adapter deployment is configured.'),
    );
    suites.push(retrieval.report);
    retrievalMeasurements = retrieval.measurements;
  }
  if (options.suites.has('receipts')) suites.push(await runReceiptSuite(corpusRoot));
  const report = createConformanceReport(suites);
  if (options.json) {
    process.stdout.write(`${canonicalizeJcs({
      report,
      ...(portability === undefined ? {} : {
        portability: { comparisons: portability.comparisons, skips: portability.skips },
      }),
      retrievalMeasurements,
    })}\n`);
  } else {
    process.stdout.write(renderTextReport(report));
    if (portability !== undefined) process.stdout.write(`${portabilitySummary(portability)}\n`);
  }
  return report.totals.fail === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return;
    }
    process.exitCode = await run(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`conformance: ${message}\n\n${USAGE}`);
    process.exitCode = 2;
  }
}

void main();
