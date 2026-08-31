import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteAdapter } from '@agql/adapter-sqlite';
import type { CatalogPhysicalIdentifier, RecordsLogicalPlan } from '@agql/contracts';
import {
  effectivePlanHash,
  fingerprintScope,
  SafeIntegerSchema,
  sourceQueryHash,
} from '@agql/schemas';

import type {
  SecurityCaseObservation,
  SecurityExecutionMetadata,
  SecurityProbeExecutor,
} from './security.ts';
import type { SecurityCase } from './security-expansion.ts';
import type { SecurityFixture } from './security-fixtures.ts';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function metadata(state: string): SecurityExecutionMetadata {
  return {
    adapterVersion: '0.1',
    bindingVersion: 'security-probe-v1',
    engineVersion: '0.0.0',
    state: { adapter: 'sqlite-conformance', state },
  };
}

function planFor(probe: SecurityCase): RecordsLogicalPlan {
  const scopeFingerprint = fingerprintScope({ fixture: probe.fixtureId, case: probe.caseIndex });
  const source = sourceQueryHash({ fixture: probe.fixtureId, case: probe.caseIndex });
  const id = {
    logicalId: 'probe_data.id',
    physical: physical('id'),
    type: { kind: 'id' as const },
    nullable: false,
  };
  const output = { logicalId: 'probe_data.id', slot: SafeIntegerSchema.parse(0) };
  const order = { field: id, direction: 'asc' as const, nulls: 'last' as const };
  return {
    languageVersion: '0',
    sourceQueryHash: source,
    effectivePlanHash: effectivePlanHash({
      sourceQueryHash: source,
      languageVersion: '0',
      catalogVersion: 'security-probe-v1',
      policyVersion: 'security-probe-v1',
      scopeFingerprint,
    }),
    dataset: {
      logicalId: 'probe_data',
      physical: physical('probe_data'),
      bindingVersion: 'security-probe-v1',
    },
    scope: { visibility: 'nothing' },
    hardRowLimit: SafeIntegerSchema.parse(2),
    take: SafeIntegerSchema.parse(1),
    mode: 'records',
    profile: 'records.v0',
    projection: [{ output, field: id }],
    order: [order],
    tieBreak: { kind: 'recordId', order },
  };
}

export function createSqliteSecurityProbeExecutor(): SecurityProbeExecutor {
  let databasePath: string | undefined;
  return {
    async execute(
      _fixture: SecurityFixture,
      probe: SecurityCase,
    ): Promise<SecurityCaseObservation> {
      try {
        if (databasePath === undefined) {
          const directory = await mkdtemp(path.join(tmpdir(), 'agql-security-'));
          databasePath = path.join(directory, 'security.sqlite');
          const database = new DatabaseSync(databasePath);
          try {
            database.exec('CREATE TABLE "probe_data" ('
              + '"id" TEXT NOT NULL, "__agql_version" INTEGER NOT NULL, '
              + '"__agql_deleted" INTEGER NOT NULL) STRICT');
          } finally {
            database.close();
          }
        }
        const adapter = createSqliteAdapter({
          databasePath,
          exactScanAdmissionLimit: SafeIntegerSchema.parse(1),
          supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '0' }],
          id: 'sqlite-conformance',
          version: '0.1',
        });
        const compiled = await adapter.query.compile(planFor(probe));
        if (compiled.kind === 'refusal') {
          return {
            kind: 'violation',
            actual: `${compiled.refusal.code}: ${compiled.refusal.message}`,
            diff: 'The SQLite security probe plan was refused before its trust-boundary execution.',
            metadata: metadata('compile-refusal'),
          };
        }
        const executed = await adapter.query.execute(compiled.value);
        if (executed.kind === 'refusal') {
          return {
            kind: 'violation',
            actual: `${executed.refusal.code}: ${executed.refusal.message}`,
            diff: 'The SQLite security probe plan did not execute through the adapter.',
            metadata: metadata('execution-refusal'),
          };
        }
        return { kind: 'pass', metadata: metadata('executed') };
      } catch (error) {
        return {
          kind: 'violation',
          actual: error instanceof Error ? error.message : String(error),
          diff: 'The live SQLite security probe driver threw instead of returning a typed result.',
          metadata: metadata('exception'),
        };
      }
    },
  };
}
