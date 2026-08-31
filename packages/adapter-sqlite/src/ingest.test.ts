import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type {
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  ExpandedScope,
  ResolvedDatasetBinding,
  ResolvedFieldBinding,
} from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import type { SafeInteger, ScopeFingerprint } from '@agql/schemas';

import { createSqliteAdapter, provisionSqliteAdapterStorage } from './index.ts';

const tableName = 'r"; DROP TABLE sentinel; --';
const idName = 'id"; DROP TABLE sentinel; --';
const tenantName = 'tenant" OR 1 = 1 --';
const amountName = 'amount"; DROP TABLE sentinel; --';
const bodyName = 'body"; DROP TABLE sentinel; --';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const dataset: ResolvedDatasetBinding = {
  logicalId: 'records',
  physical: physical(tableName),
  bindingVersion: 'binding-test-v1',
};

const idField: ResolvedFieldBinding = {
  logicalId: 'records.id',
  physical: physical(idName),
  type: { kind: 'id' },
  nullable: false,
};

const tenantField: ResolvedFieldBinding = {
  logicalId: 'records.tenant',
  physical: physical(tenantName),
  type: { kind: 'enum', codes: ['north', 'south'] },
  nullable: false,
};

const amountField: ResolvedFieldBinding = {
  logicalId: 'records.amount',
  physical: physical(amountName),
  type: { kind: 'decimal' },
  nullable: false,
};

const bodyField: ResolvedFieldBinding = {
  logicalId: 'records.body',
  physical: physical(bodyName),
  type: { kind: 'text', collation: { id: 'unicode-codepoint-v0', version: '1' } },
  nullable: false,
};

type PredicateScope = Extract<ExpandedScope, { readonly visibility: 'predicate' }>;
type InsertIngestPlan = Extract<CanonicalIngestPlan, { readonly mode: 'insertOnly' }>;

function scope(tenant: 'north' | 'south'): PredicateScope {
  return {
    visibility: 'predicate',
    enforcement: 'mandatoryPushdown',
    predicates: [{
      kind: 'comparison',
      field: tenantField,
      op: 'eq',
      value: { kind: 'enum', value: tenant },
    }],
  };
}

function databaseFixture(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE ${sqlIdentifier(tableName)} (`
        + `${sqlIdentifier(idName)} TEXT PRIMARY KEY, `
        + `${sqlIdentifier(tenantName)} TEXT NOT NULL, `
        + `${sqlIdentifier(amountName)} TEXT NOT NULL, `
        + `${sqlIdentifier(bodyName)} TEXT NOT NULL, `
        + '"__agql_version" INTEGER NOT NULL, "__agql_deleted" INTEGER NOT NULL) STRICT',
    );
  } finally {
    database.close();
  }
}

function adapter(path: string) {
  return createSqliteAdapter({
    databasePath: path,
    exactScanAdmissionLimit: safe(100),
    supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '1' }],
    id: 'sqlite-reference',
    version: 'test-v1',
  });
}

function success<T>(outcome: { readonly kind: string; readonly value?: T }): T {
  assert.equal(outcome.kind, 'success');
  assert.notEqual(outcome.value, undefined);
  return outcome.value as T;
}

test('canonical ingest enforces scope and returns independent CAS outcomes with one receipt',
  async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agql-sqlite-ingest-'));
  const path = join(directory, 'reference.sqlite');
  try {
    databaseFixture(path);
    provisionSqliteAdapterStorage(path);
    const sqlite = adapter(path);
    const id = 'new-fixed-record';
    const scopeFingerprint = 'scope-test' as ScopeFingerprint;
    const insert: InsertIngestPlan = {
      dataset,
      idField,
      scopeFingerprint,
      scope: scope('north'),
      idempotencyKey: 'write-once',
      embeddingPolicy: 'catalog',
      mode: 'insertOnly',
      records: [{
        id,
        values: [
          { field: idField, value: { kind: 'id', value: id } },
          { field: tenantField, value: { kind: 'enum', value: 'north' } },
          {
            field: amountField,
            value: { kind: 'decimal', value: CanonicalDecimalSchema.parse('1.25') },
          },
          {
            field: bodyField,
            value: { kind: 'text', value: NormalizedTextSchema.parse('new note') },
          },
        ],
      }],
    };
    const first = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(insert)),
    ));
    const repeated = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(insert)),
    ));
    assert.deepEqual(repeated, first);
    assert.match(first.writeReceipt.receipt, /^wr_/u);
    const state = first.writeReceipt.records[0]?.visibility.record;
    assert.equal(state?.state, 'ready');
    if (state?.state === 'ready') assert.doesNotMatch(state.token, /DROP|sqlite|table/u);
    const visibility = sqlite.visibility;
    if (visibility === undefined) throw new Error('SQLite must expose receipt observation.');
    const observed = success(await visibility.observe({
      receipt: first.writeReceipt.receipt,
      require: ['record'],
      timeoutMs: safe(0),
      anchor: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
      scopeFingerprint,
      scope: insert.scope,
      dataset,
      idField,
    }));
    assert.equal(observed.receipt, first.writeReceipt.receipt);
    const wrongReceiptScope = await visibility.observe({
      receipt: first.writeReceipt.receipt,
      require: ['record'],
      timeoutMs: safe(0),
      anchor: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
      scopeFingerprint: 'other-scope' as ScopeFingerprint,
      scope: scope('south'),
      dataset,
      idField,
    });
    assert.equal(wrongReceiptScope.kind, 'refusal');

    const siblingId = 'batch-sibling';
    const batch: InsertIngestPlan = {
      ...insert,
      idempotencyKey: 'partial-cas-batch',
      records: [insert.records[0], {
        id: siblingId,
        values: [
          { field: idField, value: { kind: 'id', value: siblingId } },
          { field: tenantField, value: { kind: 'enum', value: 'north' } },
          {
            field: amountField,
            value: { kind: 'decimal', value: CanonicalDecimalSchema.parse('3') },
          },
          {
            field: bodyField,
            value: { kind: 'text', value: NormalizedTextSchema.parse('batch note') },
          },
        ],
      }],
    };
    const partial = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(batch)),
    ));
    assert.deepEqual(partial.outcomes.map(({ id: outcomeId, status }) =>
      [outcomeId, status]), [[id, 'refused'], [siblingId, 'accepted']]);
    assert.deepEqual(partial.writeReceipt.records.map(({ id: recordId }) => recordId), [siblingId]);

    const replace: CanonicalIngestPlan = {
      ...insert,
      mode: 'replace',
      idempotencyKey: 'replace',
      records: [{ ...insert.records[0], ifVersion: safe(1) }],
    };
    const replaced = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(replace)),
    ));
    assert.equal(replaced.outcomes[0]?.version, 2);
    const wrongScopeDelete: CanonicalIngestPlan = {
      ...insert,
      scope: scope('south'),
      mode: 'delete',
      idempotencyKey: 'wrong-scope-delete',
      records: [{ id, ifVersion: safe(2) }],
    };
    const scopedDelete = success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(wrongScopeDelete)),
    ));
    assert.equal(scopedDelete.outcomes[0]?.status, 'refused');
    const deleted: CanonicalIngestPlan = {
      ...insert,
      mode: 'delete',
      idempotencyKey: 'delete',
      records: [{ id, ifVersion: safe(2) }],
    };
    success(await sqlite.canonicalIngest.execute(
      success(await sqlite.canonicalIngest.compile(deleted)),
    ));
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(database.prepare(
        `SELECT "__agql_deleted" AS deleted FROM ${sqlIdentifier(tableName)}`
          + ` WHERE ${sqlIdentifier(idName)} = ?`,
      ).get(id)?.deleted, 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
