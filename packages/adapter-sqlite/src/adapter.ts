import type {
  AdapterContract,
  AdapterExecutionResult,
  AdapterOutcome,
  CanonicalIngestPlan,
  IngestResult,
  LogicalPlanForProfile,
  VisibilityObservation,
  WriteReceipt,
} from '@agql/contracts';
import type { CapabilityProfile } from '@agql/schemas';

import { compileSqlitePlan } from './compile.ts';
import { executeAggregate } from './aggregate.ts';
import { executeRecords, executeSemantic } from './execute.ts';
import { executeCanonicalIngest, observeVisibility } from './ingest.ts';
import type {
  CompiledCanonicalIngest,
  SqliteAdapterOptions,
  SqliteQueryCompiled,
} from './types.ts';

export const SQLITE_PROFILES = [
  'records.v0',
  'aggregate.v0',
  'retrieve.semantic.v0',
  'ingest.canonical.v0',
] as const satisfies readonly CapabilityProfile[];

type SupportedQueryPlan = LogicalPlanForProfile<(typeof SQLITE_PROFILES)[number]>;

function compileQuery(
  plan: SupportedQueryPlan,
  options: SqliteAdapterOptions,
): Promise<AdapterOutcome<SqliteQueryCompiled>> {
  return Promise.resolve(compileSqlitePlan(plan, options));
}

function executeQuery(
  compiled: SqliteQueryCompiled,
  options: SqliteAdapterOptions,
): Promise<AdapterOutcome<AdapterExecutionResult>> {
  switch (compiled.kind) {
    case 'records':
      return Promise.resolve(executeRecords(options.databasePath, compiled));
    case 'aggregate':
      return Promise.resolve(executeAggregate(options.databasePath, compiled));
    case 'semantic':
      return Promise.resolve(executeSemantic(options.databasePath, compiled));
  }
}

function compileIngest(
  plan: CanonicalIngestPlan,
): Promise<AdapterOutcome<CompiledCanonicalIngest>> {
  if (plan.scope.visibility === 'predicate' && plan.scope.predicates.length === 0) {
    return Promise.resolve({
      kind: 'refusal',
      refusal: {
        code: 'SCOPE_UNENFORCEABLE',
        message: 'Canonical ingest requires an expanded mandatory-pushdown scope.',
        path: '/scope',
        alternatives: ['Compile ingest with every resolved scope predicate.'],
        remedy: 'Preserve the expanded write scope through adapter compilation.',
      },
    });
  }
  return Promise.resolve({ kind: 'success', value: { kind: 'ingest', plan } });
}

function executeIngest(
  compiled: CompiledCanonicalIngest,
  options: SqliteAdapterOptions,
): Promise<AdapterOutcome<IngestResult>> {
  return Promise.resolve(executeCanonicalIngest(options.databasePath, compiled));
}

function observe(
  requirement: VisibilityObservation,
  options: SqliteAdapterOptions,
): Promise<AdapterOutcome<WriteReceipt>> {
  return Promise.resolve(observeVisibility(options.databasePath, requirement));
}

function assertOptions(options: SqliteAdapterOptions): void {
  if (options.databasePath === '' || options.databasePath === ':memory:'
    || options.databasePath.startsWith('file::memory:')) {
    throw new TypeError('SQLite reference execution requires a non-empty file-backed path.');
  }
  if (!Number.isSafeInteger(options.exactScanAdmissionLimit)
    || options.exactScanAdmissionLimit <= 0) {
    throw new TypeError('exactScanAdmissionLimit must be a positive safe integer.');
  }
  if (options.id === '' || options.version === '') {
    throw new TypeError('SQLite adapter id and version must be non-empty.');
  }
  for (const collation of options.supportedTextCollations) {
    if (collation.id === '' || collation.version === '') {
      throw new TypeError('Declared SQLite text collations must have an id and version.');
    }
  }
}

/**
 * Embedded reference binding. It is intentionally an exact-only retrieval adapter: it never
 * approximates or fuses results behind the caller's back.
 */
export function createSqliteAdapter(
  options: SqliteAdapterOptions,
): AdapterContract<typeof SQLITE_PROFILES, SqliteQueryCompiled, CompiledCanonicalIngest> {
  assertOptions(options);
  return {
    descriptor: {
      id: options.id,
      version: options.version,
      profiles: SQLITE_PROFILES,
      consistency: {
        afterWrite: 'certified',
        snapshots: ['none'],
        compareAndSwap: true,
      },
    },
    query: {
      compile(plan) {
        return compileQuery(plan, options);
      },
      execute(compiled) {
        return executeQuery(compiled, options);
      },
    },
    canonicalIngest: {
      compile(plan) {
        return compileIngest(plan);
      },
      execute(compiled) {
        return executeIngest(compiled, options);
      },
    },
    visibility: {
      observe(requirement) {
        return observe(requirement, options);
      },
    },
  };
}
