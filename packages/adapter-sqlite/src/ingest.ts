import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  AdapterOutcome,
  AdapterRefusal,
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  IngestRecordOutcome,
  IngestResult,
  RecordWriteReceipt,
  ResolvedCanonicalFieldValue,
  VisibilityObservation,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { SafeInteger } from '@agql/schemas';

import { existingIngestResult, loadWriteReceipt, storeIngestResult } from './ingest-receipts.ts';
import {
  DELETED_COLUMN,
  VERSION_COLUMN,
  quoteIdentifier,
  quoteRuntimeIdentifier,
  scopeAndFilterSql,
} from './sql.ts';
import { scalarForWrite } from './scalars.ts';
import type { CompiledCanonicalIngest, SqliteParameter } from './types.ts';

type SqliteRow = Readonly<Record<string, null | number | bigint | string | Uint8Array>>;
interface CanonicalRecord {
  readonly id: string;
  readonly values: readonly ResolvedCanonicalFieldValue[];
}

function receiptId(value: string): WriteReceiptId {
  return value as WriteReceiptId;
}

function token(value: string): VisibilityToken {
  return value as VisibilityToken;
}

function runtimeReceiptId(): WriteReceiptId {
  return receiptId(`wr_${randomBytes(24).toString('base64url')}`);
}

function opaqueToken(): VisibilityToken {
  return token(`opaque:${randomBytes(24).toString('base64url')}`);
}

function rowValue(
  row: SqliteRow | undefined,
  column: string,
): null | number | bigint | string | Uint8Array | undefined {
  if (row === undefined) return undefined;
  return row[column];
}

function currentVersion(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  id: string,
): SafeInteger | undefined {
  const scope = scopeAndFilterSql(plan.scope, undefined);
  const row = database.prepare(
    `SELECT ${quoteRuntimeIdentifier(VERSION_COLUMN)} AS version`
      + ` FROM ${quoteIdentifier(plan.dataset.physical)}`
      + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ? AND (${scope.sql}) LIMIT 1`,
  ).get(id, ...scope.parameters);
  const raw = rowValue(row, 'version');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError('Stored canonical record version is malformed.');
  }
  return SafeIntegerSchema.parse(raw);
}

function refusedOutcome(
  id: string,
  index: number,
): IngestRecordOutcome {
  return {
    id,
    status: 'refused',
    version: null,
    error: {
      code: 'SEMANTIC_INVALID',
      message: 'The canonical write precondition was not satisfied.',
      path: `/records/${index}`,
      alternatives: [
        'Retry with the current record version or choose insertOnly/replace deliberately.',
      ],
    },
  };
}

function acceptedOutcome(id: string, version: SafeInteger): IngestRecordOutcome {
  return { id, status: 'accepted', version, error: null };
}

function readyRecord(id: string, version: SafeInteger): RecordWriteReceipt {
  return {
    id,
    version,
    visibility: { record: { state: 'ready', token: opaqueToken() } },
  };
}

function nextVersion(version: SafeInteger): SafeInteger {
  if (version >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Canonical record version exceeds safe range.');
  }
  return SafeIntegerSchema.parse(version + 1);
}

function assertWritableFields(
  plan: CanonicalIngestPlan,
  values: readonly ResolvedCanonicalFieldValue[],
): void {
  for (const item of values) {
    if (item.field.physical === VERSION_COLUMN || item.field.physical === DELETED_COLUMN) {
      throw new TypeError(
        'Catalog fields must not use SQLite adapter reserved metadata identifiers.',
      );
    }
    if (item.field.logicalId === plan.idField.logicalId
      && (item.value.kind !== 'id' || item.value.value === '')) {
      throw new TypeError('The canonical id field must carry the stable record id.');
    }
  }
}

function recordColumns(
  plan: CanonicalIngestPlan,
  record: CanonicalRecord,
): {
  readonly columns: readonly CatalogPhysicalIdentifier[];
  readonly values: readonly SqliteParameter[];
} {
  assertWritableFields(plan, record.values);
  const fields = new Map<CatalogPhysicalIdentifier, SqliteParameter>();
  for (const item of record.values) {
    if (fields.has(item.field.physical)) {
      throw new TypeError('Canonical record repeats one physical field.');
    }
    if (item.field.logicalId === plan.idField.logicalId
      && (item.value.kind !== 'id' || item.value.value !== record.id)) {
      throw new TypeError('Canonical record id and id field disagree.');
    }
    fields.set(item.field.physical, scalarForWrite(item.value));
  }
  fields.set(plan.idField.physical, record.id);
  return { columns: [...fields.keys()], values: [...fields.values()] };
}

function insertRecord(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  record: CanonicalRecord,
  version: SafeInteger,
): boolean {
  const recordValues = recordColumns(plan, record);
  const columns = [...recordValues.columns];
  const parameters: SqliteParameter[] = [...recordValues.values, version, 0];
  const storedColumns: CatalogPhysicalIdentifier[] = [
    ...columns,
    VERSION_COLUMN as CatalogPhysicalIdentifier,
    DELETED_COLUMN as CatalogPhysicalIdentifier,
  ];
  const scope = scopeAndFilterSql(plan.scope, undefined);
  const source = storedColumns.map((column) => `? AS ${quoteIdentifier(column)}`);
  const sql = `INSERT INTO ${quoteIdentifier(plan.dataset.physical)}`
    + ` (${storedColumns.map(quoteIdentifier).join(', ')})`
    + ` SELECT ${storedColumns.map((column) => quoteIdentifier(column)).join(', ')}`
    + ` FROM (SELECT ${source.join(', ')}) WHERE ${scope.sql}`
    + ` ON CONFLICT (${quoteIdentifier(plan.idField.physical)}) DO NOTHING`;
  return database.prepare(sql).run(...parameters, ...scope.parameters).changes === 1;
}

function recordInScope(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  record: CanonicalRecord,
): boolean {
  const source = recordColumns(plan, record);
  const scope = scopeAndFilterSql(plan.scope, undefined);
  const columns = source.columns.map((column) => `? AS ${quoteIdentifier(column)}`);
  return database.prepare(
    `SELECT EXISTS (SELECT 1 FROM (SELECT ${columns.join(', ')}) WHERE ${scope.sql}) AS visible`,
  ).get(...source.values, ...scope.parameters)?.visible === 1;
}

function replaceRecord(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  record: CanonicalRecord,
  version: SafeInteger,
): boolean {
  if (!recordInScope(database, plan, record)) return false;
  const scope = scopeAndFilterSql(plan.scope, undefined);
  const deleted = database.prepare(
    `DELETE FROM ${quoteIdentifier(plan.dataset.physical)}`
      + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ? AND (${scope.sql})`,
  ).run(record.id, ...scope.parameters).changes;
  if (deleted !== 1) return false;
  if (!insertRecord(database, plan, record, version)) {
    throw new TypeError('A scoped replace could not restore its validated whole record.');
  }
  return true;
}

function processInsert(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'insertOnly' }>,
): readonly IngestRecordOutcome[] {
  return plan.records.map((record, index) => {
    const existing = currentVersion(database, plan, record.id);
    if (existing !== undefined) {
      return refusedOutcome(record.id, index);
    }
    const version = SafeIntegerSchema.parse(1);
    return insertRecord(database, plan, record, version)
      ? acceptedOutcome(record.id, version)
      : refusedOutcome(record.id, index);
  });
}

function processReplace(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'replace' }>,
): readonly IngestRecordOutcome[] {
  return plan.records.map((record, index) => {
    const existing = currentVersion(database, plan, record.id);
    if (record.ifVersion !== undefined && record.ifVersion !== existing) {
      return refusedOutcome(record.id, index);
    }
    if (existing === undefined) {
      const version = SafeIntegerSchema.parse(1);
      return insertRecord(database, plan, record, version)
        ? acceptedOutcome(record.id, version)
        : refusedOutcome(record.id, index);
    }
    const version = nextVersion(existing);
    return replaceRecord(database, plan, record, version)
      ? acceptedOutcome(record.id, version)
      : refusedOutcome(record.id, index);
  });
}

function processDelete(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'delete' }>,
): readonly IngestRecordOutcome[] {
  return plan.records.map((record, index) => {
    const existing = currentVersion(database, plan, record.id);
    if (existing === undefined) {
      return refusedOutcome(record.id, index);
    }
    if (record.ifVersion !== undefined && record.ifVersion !== existing) {
      return refusedOutcome(record.id, index);
    }
    const version = nextVersion(existing);
    const scope = scopeAndFilterSql(plan.scope, undefined);
    const changed = database.prepare(
      `UPDATE ${quoteIdentifier(plan.dataset.physical)}`
        + ` SET ${quoteRuntimeIdentifier(DELETED_COLUMN)} = 1,`
        + ` ${quoteRuntimeIdentifier(VERSION_COLUMN)} = ?`
        + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ? AND (${scope.sql})`,
    ).run(version, record.id, ...scope.parameters).changes;
    return changed === 1 ? acceptedOutcome(record.id, version) : refusedOutcome(record.id, index);
  });
}

function ingestResult(outcomes: readonly IngestRecordOutcome[]): IngestResult {
  const first = outcomes[0];
  if (first === undefined) throw new TypeError('Canonical ingest requires a record outcome.');
    const accepted = outcomes.filter(
    (outcome): outcome is Extract<IngestRecordOutcome, { readonly status: 'accepted' }> =>
      outcome.status === 'accepted',
  );
  return {
    outcomes: [first, ...outcomes.slice(1)],
    writeReceipt: {
      receipt: runtimeReceiptId(),
      records: accepted.map(({ id, version }) => readyRecord(id, version)),
    },
  };
}

export function executeCanonicalIngest(
  databasePath: string,
  compiled: CompiledCanonicalIngest,
): AdapterOutcome<IngestResult> {
  const database = new DatabaseSync(databasePath, { allowExtension: false, defensive: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    const existing = existingIngestResult(database, compiled);
    if (existing !== undefined) {
      database.exec('COMMIT');
      return { kind: 'success', value: existing };
    }
    const outcomes = compiled.plan.mode === 'insertOnly'
      ? processInsert(database, compiled.plan)
      : compiled.plan.mode === 'replace'
        ? processReplace(database, compiled.plan)
        : processDelete(database, compiled.plan);
    const result = ingestResult(outcomes);
    storeIngestResult(database, compiled, result);
    database.exec('COMMIT');
    return { kind: 'success', value: result };
  } catch (caught: unknown) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The initial BEGIN can fail before opening a transaction.
    }
    throw caught;
  } finally {
    database.close();
  }
}

function freshnessRefusal(message: string, remedy: string): AdapterOutcome<never> {
  const refusal: AdapterRefusal = {
    code: 'FRESHNESS_UNAVAILABLE',
    message,
    path: '/afterWrite',
    alternatives: [remedy],
    remedy,
  };
  return { kind: 'refusal', refusal };
}

function timeoutRefusal(
  requirement: VisibilityObservation,
  require: readonly [string, ...string[]],
): AdapterOutcome<never> {
  const refusal: AdapterRefusal = {
    code: 'AFTER_WRITE_TIMEOUT',
    message: 'The afterWrite deadline elapsed before every required visibility '
      + 'state was observable.',
    path: '/afterWrite',
    alternatives: ['Retry with the same receipt and requirements.'],
    remedy: {
      action: 'retryAfterWrite',
      details: { receipt: requirement.receipt, require },
    },
  };
  return { kind: 'refusal', refusal };
}

export function observeVisibility(
  databasePath: string,
  requirement: VisibilityObservation,
): AdapterOutcome<WriteReceipt> {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    readOnly: true,
    defensive: true,
  });
  try {
    const receipt = loadWriteReceipt(
      database,
      requirement.receipt,
      requirement.dataset.physical,
      requirement.scopeFingerprint,
    );
    if (receipt === undefined) {
      return freshnessRefusal('The requested receipt is not visible to this SQLite source.',
        'Use a receipt returned by this source.');
    }
    if (receipt.records.length === 0) {
      return freshnessRefusal(
        'The write receipt contains no accepted record outcome to observe.',
        'Issue a write with at least one accepted record.',
      );
    }
    const waiting = new Set<string>();
    for (const record of receipt.records) {
      const scope = scopeAndFilterSql(requirement.scope, undefined);
      const observable = database.prepare(
        `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(requirement.dataset.physical)}`
          + ` WHERE ${quoteIdentifier(requirement.idField.physical)} = ?`
          + ` AND ${quoteRuntimeIdentifier(VERSION_COLUMN)} = ? AND (${scope.sql})) AS visible`,
      ).get(record.id, record.version, ...scope.parameters)?.visible === 1;
      for (const name of requirement.require) {
        const state = record.visibility[name];
        if (state === undefined) {
          return freshnessRefusal(
            'The requested representation is absent from this write receipt.',
            'Require only representations named by this receipt.',
          );
        }
        if (state.state === 'failed' || state.state === 'superseded') {
          return freshnessRefusal(
            state.state === 'failed'
              ? 'A required write representation failed.'
              : 'A required write representation was superseded.',
            'Issue a new write before retrying the query.',
          );
        }
        if (state.state !== 'ready' || !observable) waiting.add(name);
      }
    }
    const ordered = [...waiting].sort();
    const first = ordered[0];
    if (first !== undefined) return timeoutRefusal(requirement, [first, ...ordered.slice(1)]);
    return { kind: 'success', value: receipt };
  } finally {
    database.close();
  }
}
