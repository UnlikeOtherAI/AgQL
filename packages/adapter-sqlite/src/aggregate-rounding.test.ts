import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type {
  CatalogPhysicalIdentifier,
  LogicalPlanForProfile,
  ResolvedDatasetBinding,
  ResolvedFieldBinding,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type {
  EffectivePlanHash,
  SafeInteger,
  SourceQueryHash,
} from '@agql/schemas';

import { createSqliteAdapter } from './adapter.ts';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

const dataset: ResolvedDatasetBinding = {
  logicalId: 'samples',
  physical: physical('samples'),
  bindingVersion: 'rounding-v1',
};

const idField: ResolvedFieldBinding = {
  logicalId: 'samples.id',
  physical: physical('id'),
  type: { kind: 'id' },
  nullable: false,
};

const quantityField: ResolvedFieldBinding = {
  logicalId: 'samples.quantity',
  physical: physical('quantity'),
  type: { kind: 'integer' },
  nullable: false,
};

function plan(): LogicalPlanForProfile<'aggregate.v0'> {
  return {
    languageVersion: '0',
    sourceQueryHash: 'rounding-source' as SourceQueryHash,
    effectivePlanHash: 'rounding-plan' as EffectivePlanHash,
    dataset,
    scope: {
      visibility: 'predicate',
      enforcement: 'mandatoryPushdown',
      predicates: [{ kind: 'null', field: idField, op: 'isNotNull' }],
    },
    hardRowLimit: safe(10),
    take: safe(1),
    mode: 'aggregate',
    profile: 'aggregate.v0',
    dimensions: [],
    metrics: [{
      kind: 'aggregate',
      output: { logicalId: 'average', slot: safe(0) },
      aggregate: { op: 'avg', field: quantityField },
    }, {
      kind: 'ratio',
      output: { logicalId: 'ratio', slot: safe(1) },
      numerator: { op: 'sum', field: quantityField },
      denominator: { op: 'count' },
      divideByZero: 'null',
    }],
    order: [{
      output: { logicalId: 'average', slot: safe(0) },
      direction: 'asc',
      nulls: 'last',
    }],
    tieBreak: { kind: 'singleAggregateRow' },
  };
}

test('integer averages and ratios round nonterminating division half-even to nine places',
  async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agql-sqlite-rounding-'));
  const path = join(directory, 'rounding.sqlite');
  try {
    const database = new DatabaseSync(path);
    try {
      database.exec(
        'CREATE TABLE samples (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL,'
          + ' __agql_version INTEGER NOT NULL, __agql_deleted INTEGER NOT NULL) STRICT',
      );
      const insert = database.prepare('INSERT INTO samples VALUES (?, ?, 1, 0)');
      insert.run('one', 1);
      insert.run('zero-a', 0);
      insert.run('zero-b', 0);
    } finally {
      database.close();
    }
    const adapter = createSqliteAdapter({
      databasePath: path,
      exactScanAdmissionLimit: safe(10),
      supportedTextCollations: [],
      id: 'sqlite-rounding',
      version: '1',
    });
    const compiled = await adapter.query.compile(plan());
    if (compiled.kind === 'refusal') assert.fail(compiled.refusal.message);
    const result = await adapter.query.execute(compiled.value);
    if (result.kind === 'refusal') assert.fail(result.refusal.message);
    assert.deepEqual(result.value.rows[0], [{
      kind: 'decimal',
      value: '0.333333333',
    }, {
      kind: 'decimal',
      value: '0.333333333',
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
