import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  AdapterOutcome,
  AdapterRefusal,
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  RecordWriteReceipt,
  ResolvedCanonicalFieldValue,
  VisibilityObservation,
  VisibilityState,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { SafeInteger } from '@agql/schemas';

import { DELETED_COLUMN, VERSION_COLUMN, quoteIdentifier, quoteRuntimeIdentifier } from './sql.ts';
import { scalarForWrite } from './scalars.ts';
import type { CompiledCanonicalIngest, SqliteParameter } from './types.ts';

const RECEIPTS_TABLE = '__agql_sqlite_receipts';
const IDEMPOTENCY_TABLE = '__agql_sqlite_idempotency';

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
  return receiptId(`wr_${randomUUID()}`);
}

function opaqueToken(): VisibilityToken {
  return token(`opaque:${randomUUID()}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parsedVisibility(value: unknown): VisibilityState | undefined {
  if (!isRecord(value) || typeof value.state !== 'string') return undefined;
  if (value.state === 'accepted' || value.state === 'superseded') return { state: value.state };
  if (value.state === 'ready' && typeof value.token === 'string') {
    return { state: 'ready', token: token(value.token) };
  }
  if (value.state === 'failed'
    && typeof value.code === 'string'
    && typeof value.message === 'string') {
    return { state: 'failed', code: value.code, message: value.message };
  }
  return undefined;
}

function parseReceipt(serialized: string): WriteReceipt {
  const parsed = parsedJson(serialized);
  if (!isRecord(parsed) || typeof parsed.receipt !== 'string' || !Array.isArray(parsed.records)) {
    throw new TypeError('Stored receipt is malformed.');
  }
  const records: RecordWriteReceipt[] = [];
  for (const item of parsed.records) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.version !== 'number'
      || !Number.isSafeInteger(item.version) || !isRecord(item.visibility)) {
      throw new TypeError('Stored receipt record is malformed.');
    }
    const visibility: Record<string, VisibilityState> = {};
    for (const [name, state] of Object.entries(item.visibility)) {
      const parsedState = parsedVisibility(state);
      if (parsedState === undefined) throw new TypeError('Stored receipt visibility is malformed.');
      visibility[name] = parsedState;
    }
    records.push({
      id: item.id,
      version: SafeIntegerSchema.parse(item.version),
      visibility,
    });
  }
  return { receipt: receiptId(parsed.receipt), records };
}

function rowValue(
  row: SqliteRow | undefined,
  column: string,
): null | number | bigint | string | Uint8Array | undefined {
  if (row === undefined) return undefined;
  return row[column];
}

function existingReceipt(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
): WriteReceipt | undefined {
  const row = database.prepare(
    `SELECT receipt FROM ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)}`
      + ' WHERE dataset = ? AND scope_fingerprint = ? AND idempotency_key = ? LIMIT 1',
  ).get(plan.dataset.physical, plan.scopeFingerprint, plan.idempotencyKey);
  const id = rowValue(row, 'receipt');
  if (id === undefined) return undefined;
  if (typeof id !== 'string') {
    throw new TypeError('Stored idempotency receipt id is malformed.');
  }
  const receiptRow = database.prepare(
    `SELECT payload FROM ${quoteRuntimeIdentifier(RECEIPTS_TABLE)} WHERE receipt = ? LIMIT 1`,
  ).get(id);
  const payload = rowValue(receiptRow, 'payload');
  if (typeof payload !== 'string') {
    throw new TypeError('Stored idempotency receipt payload is missing.');
  }
  return parseReceipt(payload);
}

function currentVersion(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  id: string,
): SafeInteger | undefined {
  const row = database.prepare(
    `SELECT ${quoteRuntimeIdentifier(VERSION_COLUMN)} AS version`
      + ` FROM ${quoteIdentifier(plan.dataset.physical)}`
      + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ? LIMIT 1`,
  ).get(id);
  const raw = rowValue(row, 'version');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError('Stored canonical record version is malformed.');
  }
  return SafeIntegerSchema.parse(raw);
}

function failedRecord(
  id: string,
  version: SafeInteger,
  code: string,
  message: string,
): RecordWriteReceipt {
  return {
    id,
    version,
    visibility: { record: { state: 'failed', code, message } },
  };
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
): void {
  const recordValues = recordColumns(plan, record);
  const columns = [...recordValues.columns];
  const parameters: SqliteParameter[] = [...recordValues.values, version, 0];
  const sql = `INSERT INTO ${quoteIdentifier(plan.dataset.physical)}`
    + ` (${columns.map(quoteIdentifier).join(', ')}, ${quoteRuntimeIdentifier(VERSION_COLUMN)},`
    + ` ${quoteRuntimeIdentifier(DELETED_COLUMN)})`
    + ` VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`;
  database.prepare(sql).run(...parameters);
}

function replaceRecord(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  record: CanonicalRecord,
  version: SafeInteger,
): void {
  database.prepare(
    `DELETE FROM ${quoteIdentifier(plan.dataset.physical)}`
      + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ?`,
  ).run(record.id);
  insertRecord(database, plan, record, version);
}

function processInsert(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'insertOnly' }>,
): readonly RecordWriteReceipt[] {
  return plan.records.map((record) => {
    const existing = currentVersion(database, plan, record.id);
    if (existing !== undefined) {
      return failedRecord(
        record.id,
        existing,
        'INSERT_CONFLICT',
        'insertOnly does not replace an existing id.',
      );
    }
    const version = SafeIntegerSchema.parse(1);
    insertRecord(database, plan, record, version);
    return readyRecord(record.id, version);
  });
}

function processReplace(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'replace' }>,
): readonly RecordWriteReceipt[] {
  return plan.records.map((record) => {
    const existing = currentVersion(database, plan, record.id);
    if (record.ifVersion !== undefined && record.ifVersion !== existing) {
      if (existing === undefined) {
        throw new TypeError('The frozen receipt contract has no version for a missing CAS record.');
      }
      return failedRecord(
        record.id,
        existing,
        'CAS_MISMATCH',
        'ifVersion did not match the current record.',
      );
    }
    if (existing === undefined) {
      const version = SafeIntegerSchema.parse(1);
      insertRecord(database, plan, record, version);
      return readyRecord(record.id, version);
    }
    const version = nextVersion(existing);
    replaceRecord(database, plan, record, version);
    return readyRecord(record.id, version);
  });
}

function processDelete(
  database: DatabaseSync,
  plan: Extract<CanonicalIngestPlan, { readonly mode: 'delete' }>,
): readonly RecordWriteReceipt[] {
  return plan.records.map((record) => {
    const existing = currentVersion(database, plan, record.id);
    if (existing === undefined) {
      throw new TypeError(
        'The frozen receipt contract has no version for a missing delete record.',
      );
    }
    if (record.ifVersion !== undefined && record.ifVersion !== existing) {
      return failedRecord(
        record.id,
        existing,
        'CAS_MISMATCH',
        'ifVersion did not match the current record.',
      );
    }
    const version = nextVersion(existing);
    database.prepare(
      `UPDATE ${quoteIdentifier(plan.dataset.physical)}`
        + ` SET ${quoteRuntimeIdentifier(DELETED_COLUMN)} = 1,`
        + ` ${quoteRuntimeIdentifier(VERSION_COLUMN)} = ?`
        + ` WHERE ${quoteIdentifier(plan.idField.physical)} = ?`,
    ).run(version, record.id);
    return readyRecord(record.id, version);
  });
}

function writeReceipt(
  database: DatabaseSync,
  plan: CanonicalIngestPlan,
  records: readonly RecordWriteReceipt[],
): WriteReceipt {
  const receipt: WriteReceipt = { receipt: runtimeReceiptId(), records };
  const payload = JSON.stringify(receipt);
  database.prepare(
    `INSERT INTO ${quoteRuntimeIdentifier(RECEIPTS_TABLE)} (receipt, payload) VALUES (?, ?)`,
  ).run(receipt.receipt, payload);
  database.prepare(
    `INSERT INTO ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)}`
      + ' (dataset, scope_fingerprint, idempotency_key, receipt) VALUES (?, ?, ?, ?)',
  ).run(plan.dataset.physical, plan.scopeFingerprint, plan.idempotencyKey, receipt.receipt);
  return receipt;
}

export function provisionSqliteAdapterStorage(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false, defensive: true });
  try {
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteRuntimeIdentifier(RECEIPTS_TABLE)} (`
        + 'receipt TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT',
    );
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)} (`
        + 'dataset TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, idempotency_key TEXT NOT NULL,'
        + 'receipt TEXT NOT NULL, '
        + 'PRIMARY KEY (dataset, scope_fingerprint, idempotency_key)) STRICT',
    );
  } finally {
    database.close();
  }
}

export function executeCanonicalIngest(
  databasePath: string,
  compiled: CompiledCanonicalIngest,
): AdapterOutcome<WriteReceipt> {
  const database = new DatabaseSync(databasePath, { allowExtension: false, defensive: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    const existing = existingReceipt(database, compiled.plan);
    if (existing !== undefined) {
      database.exec('COMMIT');
      return { kind: 'success', value: existing };
    }
    const records = compiled.plan.mode === 'insertOnly'
      ? processInsert(database, compiled.plan)
      : compiled.plan.mode === 'replace'
        ? processReplace(database, compiled.plan)
        : processDelete(database, compiled.plan);
    const receipt = writeReceipt(database, compiled.plan, records);
    database.exec('COMMIT');
    return { kind: 'success', value: receipt };
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
    const row = database.prepare(
      `SELECT payload FROM ${quoteRuntimeIdentifier(RECEIPTS_TABLE)}`
        + ' WHERE receipt = ? LIMIT 1',
    ).get(requirement.receipt);
    const payload = rowValue(row, 'payload');
    if (typeof payload !== 'string') {
      return freshnessRefusal('The requested receipt is not visible to this SQLite source.',
        'Use a receipt returned by this source.');
    }
    const receipt = parseReceipt(payload);
    for (const record of receipt.records) {
      for (const name of requirement.require) {
        const state = record.visibility[name];
        if (state?.state !== 'ready') {
          return freshnessRefusal(
            'The requested receipt representation is not ready for this source.',
            'Require record visibility only, or wait through a host-level visibility scheduler.',
          );
        }
      }
    }
    return { kind: 'success', value: receipt };
  } finally {
    database.close();
  }
}
