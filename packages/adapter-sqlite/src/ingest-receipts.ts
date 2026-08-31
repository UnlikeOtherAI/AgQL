import { DatabaseSync } from 'node:sqlite';

import type {
  IngestResult,
  RecordWriteReceipt,
  VisibilityState,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import { ERROR_CODES, SafeIntegerSchema } from '@agql/schemas';
import type { AgqlError } from '@agql/schemas';

import { quoteRuntimeIdentifier } from './sql.ts';
import type { CompiledCanonicalIngest } from './types.ts';

const RECEIPTS_TABLE = '__agql_sqlite_receipts';
const IDEMPOTENCY_TABLE = '__agql_sqlite_idempotency';

type SqliteRow = Readonly<Record<string, null | number | bigint | string | Uint8Array>>;

function receiptId(value: string): WriteReceiptId {
  return value as WriteReceiptId;
}

function token(value: string): VisibilityToken {
  return value as VisibilityToken;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowValue(row: SqliteRow | undefined, column: string): unknown {
  return row?.[column];
}

function parseError(value: unknown): AgqlError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string'
    || typeof value.path !== 'string' || !Array.isArray(value.alternatives)
    || !value.alternatives.every((item) => typeof item === 'string')) return undefined;
  const code = ERROR_CODES.find((candidate) => candidate === value.code);
  if (code === undefined) return undefined;
  if (code === 'REFERENCE_NOT_AVAILABLE') {
    return value.alternatives.length === 0
      ? { code, message: value.message, path: value.path, alternatives: [] }
      : undefined;
  }
  const first = value.alternatives[0];
  return first === undefined
    ? undefined
    : {
      code,
      message: value.message,
      path: value.path,
      alternatives: [first, ...value.alternatives.slice(1)],
    };
}

function parseVisibility(value: unknown): VisibilityState | undefined {
  if (!isRecord(value) || typeof value.state !== 'string') return undefined;
  if (value.state === 'accepted' || value.state === 'pending' || value.state === 'superseded') {
    return { state: value.state };
  }
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

function parseReceipt(value: unknown): WriteReceipt | undefined {
  if (!isRecord(value) || typeof value.receipt !== 'string' || !Array.isArray(value.records)) {
    return undefined;
  }
  const records: RecordWriteReceipt[] = [];
  for (const item of value.records) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.version !== 'number'
      || !Number.isSafeInteger(item.version) || !isRecord(item.visibility)) return undefined;
    const visibility: Record<string, VisibilityState> = {};
    for (const [name, state] of Object.entries(item.visibility)) {
      const parsed = parseVisibility(state);
      if (parsed === undefined) return undefined;
      visibility[name] = parsed;
    }
    records.push({ id: item.id, version: SafeIntegerSchema.parse(item.version), visibility });
  }
  return { receipt: receiptId(value.receipt), records };
}

function parseIngestResult(serialized: string): IngestResult {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed) || !Array.isArray(parsed.outcomes)) {
    throw new TypeError('Stored ingest result is malformed.');
  }
  const writeReceipt = parseReceipt(parsed.writeReceipt);
  if (writeReceipt === undefined) throw new TypeError('Stored write receipt is malformed.');
  const outcomes = parsed.outcomes.map((outcome) => {
    if (!isRecord(outcome)
      || typeof outcome.id !== 'string'
      || typeof outcome.status !== 'string') {
      throw new TypeError('Stored ingest outcome is malformed.');
    }
    if (outcome.status === 'accepted' && typeof outcome.version === 'number'
      && Number.isSafeInteger(outcome.version) && outcome.error === null) {
      return {
        id: outcome.id,
        status: 'accepted' as const,
        version: SafeIntegerSchema.parse(outcome.version),
        error: null,
      };
    }
    const error = outcome.status === 'refused' && outcome.version === null
      ? parseError(outcome.error)
      : undefined;
    if (error === undefined) throw new TypeError('Stored refused ingest outcome is malformed.');
    return { id: outcome.id, status: 'refused' as const, version: null, error };
  });
  const first = outcomes[0];
  if (first === undefined) throw new TypeError('Stored ingest result has no outcomes.');
  return { outcomes: [first, ...outcomes.slice(1)], writeReceipt };
}

export function existingIngestResult(
  database: DatabaseSync,
  compiled: CompiledCanonicalIngest,
): IngestResult | undefined {
  const row = database.prepare(
    `SELECT receipt FROM ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)}`
      + ' WHERE dataset = ? AND scope_fingerprint = ? AND idempotency_key = ? LIMIT 1',
  ).get(
    compiled.plan.dataset.physical,
    compiled.plan.scopeFingerprint,
    compiled.plan.idempotencyKey,
  );
  const receipt = rowValue(row, 'receipt');
  if (typeof receipt !== 'string') return undefined;
  const stored = database.prepare(
    `SELECT payload FROM ${quoteRuntimeIdentifier(RECEIPTS_TABLE)} WHERE receipt = ? LIMIT 1`,
  ).get(receipt);
  const payload = rowValue(stored, 'payload');
  if (typeof payload !== 'string') throw new TypeError('Stored idempotency result is missing.');
  return parseIngestResult(payload);
}

export function storeIngestResult(
  database: DatabaseSync,
  compiled: CompiledCanonicalIngest,
  result: IngestResult,
): void {
  database.prepare(
    `INSERT INTO ${quoteRuntimeIdentifier(RECEIPTS_TABLE)} (receipt, payload) VALUES (?, ?)`,
  ).run(result.writeReceipt.receipt, JSON.stringify(result));
  database.prepare(
    `INSERT INTO ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)}`
      + ' (dataset, scope_fingerprint, idempotency_key, receipt) VALUES (?, ?, ?, ?)',
  ).run(
    compiled.plan.dataset.physical,
    compiled.plan.scopeFingerprint,
    compiled.plan.idempotencyKey,
    result.writeReceipt.receipt,
  );
}

export function loadWriteReceipt(
  database: DatabaseSync,
  receipt: string,
  dataset: string,
  scopeFingerprint: string,
): WriteReceipt | undefined {
  const row = database.prepare(
    `SELECT receipts.payload AS payload FROM ${quoteRuntimeIdentifier(RECEIPTS_TABLE)}`
      + ` AS receipts INNER JOIN ${quoteRuntimeIdentifier(IDEMPOTENCY_TABLE)} AS idempotency`
      + ' ON idempotency.receipt = receipts.receipt'
      + ' WHERE receipts.receipt = ? AND idempotency.dataset = ?'
      + ' AND idempotency.scope_fingerprint = ? LIMIT 1',
  ).get(receipt, dataset, scopeFingerprint);
  const payload = rowValue(row, 'payload');
  if (typeof payload !== 'string') return undefined;
  return parseIngestResult(payload).writeReceipt;
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
