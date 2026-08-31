import { createHmac, randomBytes } from 'node:crypto';

import type {
  CatalogPhysicalIdentifier,
  IngestResult,
  VisibilityState,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import { ERROR_CODES, SafeIntegerSchema } from '@agql/schemas';
import type { AgqlError } from '@agql/schemas';
import type { PoolClient } from 'pg';

import { quoteQualified } from './sql-identifiers.ts';
import type { PostgresAdapterConfig, PostgresDatasetBinding } from './types.ts';

const IDEMPOTENCY = '_agql_idempotency' as CatalogPhysicalIdentifier;
const RECEIPT_RECORDS = '_agql_receipt_records' as CatalogPhysicalIdentifier;
const VISIBILITY = '_agql_visibility' as CatalogPhysicalIdentifier;
const INGEST_RESULTS = '_agql_ingest_results' as CatalogPhysicalIdentifier;

export type ReceiptAction = 'upsert' | 'delete' | 'embedding';

export interface StoredReceiptRecord {
  readonly receipt: WriteReceiptId;
  readonly datasetPhysical: string;
  readonly id: string;
  readonly version: ReturnType<typeof SafeIntegerSchema.parse>;
  readonly action: ReceiptAction;
}

export function newReceiptId(): WriteReceiptId {
  return `wr_${randomBytes(24).toString('base64url')}` as WriteReceiptId;
}

export function newVisibilityToken(
  config: PostgresAdapterConfig,
  receipt: WriteReceiptId,
  recordId: string,
  version: number,
  name: string,
): VisibilityToken {
  const nonce = randomBytes(24).toString('base64url');
  const message = `${receipt}\u0000${recordId}\u0000${version}\u0000${name}\u0000${nonce}`;
  const digest = createHmac('sha256', config.tokenSecret)
    .update(message, 'utf8')
    .digest('base64url');
  return `opaque:${nonce}${digest}` as VisibilityToken;
}

export async function reserveIdempotency(
  client: PoolClient,
  config: PostgresAdapterConfig,
  scope: string,
  key: string,
  digest: string,
  receipt: WriteReceiptId,
): Promise<{ readonly inserted: true } | {
  readonly inserted: false;
  readonly digest: string;
  readonly receipt: WriteReceiptId;
}> {
  const table = quoteQualified(config.namespace, IDEMPOTENCY);
  const inserted = await client.query<[string]>({
    text: `INSERT INTO ${table} `
      + '(scope_key, idempotency_key, operation_digest, receipt_id) '
      + 'VALUES ($1::text, $2::text, $3::text, $4::text) '
      + 'ON CONFLICT (scope_key, idempotency_key) DO NOTHING RETURNING receipt_id',
    values: [scope, key, digest, receipt],
    rowMode: 'array',
  });
  if (inserted.rowCount === 1) return { inserted: true };
  const existing = await client.query<[string, string]>({
    text: `SELECT operation_digest, receipt_id FROM ${table} `
      + 'WHERE scope_key = $1::text AND idempotency_key = $2::text FOR UPDATE',
    values: [scope, key],
    rowMode: 'array',
  });
  const row = existing.rows[0];
  if (row === undefined) throw new Error('Idempotency reservation disappeared.');
  return { inserted: false, digest: row[0], receipt: row[1] as WriteReceiptId };
}

export async function insertReceiptRecord(
  client: PoolClient,
  config: PostgresAdapterConfig,
  record: StoredReceiptRecord,
): Promise<void> {
  const table = quoteQualified(config.namespace, RECEIPT_RECORDS);
  await client.query(
    `INSERT INTO ${table} (receipt_id, dataset_physical, record_id, version, action) `
      + 'VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::text)',
    [record.receipt, record.datasetPhysical, record.id, record.version, record.action],
  );
}

export async function supersedeVisibility(
  client: PoolClient,
  config: PostgresAdapterConfig,
  dataset: PostgresDatasetBinding,
  recordId: string,
): Promise<void> {
  const table = quoteQualified(config.namespace, VISIBILITY);
  await client.query(
    `UPDATE ${table} SET state = 'superseded', token = NULL, code = NULL, message = NULL `
      + `WHERE dataset_physical = $1::text AND record_id = $2::text `
      + `AND state <> 'superseded'`,
    [dataset.dataset.physical, recordId],
  );
}

export async function upsertVisibility(
  client: PoolClient,
  config: PostgresAdapterConfig,
  dataset: PostgresDatasetBinding,
  recordId: string,
  version: number,
  name: string,
  state: VisibilityState,
): Promise<void> {
  const table = quoteQualified(config.namespace, VISIBILITY);
  const token = state.state === 'ready' ? state.token : null;
  const code = state.state === 'failed' ? state.code : null;
  const message = state.state === 'failed' ? state.message : null;
  await client.query(
    `INSERT INTO ${table} `
      + '(dataset_physical, record_id, version, state_name, state, token, code, message) '
      + 'VALUES ($1::text, $2::text, $3::bigint, $4::text, $5::text, '
      + '$6::text, $7::text, $8::text) '
      + 'ON CONFLICT (dataset_physical, record_id, version, state_name) DO UPDATE SET '
      + 'state = EXCLUDED.state, token = EXCLUDED.token, code = EXCLUDED.code, '
      + 'message = EXCLUDED.message',
    [dataset.dataset.physical, recordId, version, name, state.state, token, code, message],
  );
}

function decodeVisibility(
  state: string,
  token: string | null,
  code: string | null,
  message: string | null,
): VisibilityState | undefined {
  if (state === 'accepted' || state === 'pending') return { state };
  if (state === 'superseded') return { state };
  if (state === 'ready' && token !== null) return { state, token: token as VisibilityToken };
  if (state === 'failed' && code !== null && message !== null) {
    return { state, code, message };
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeError(value: unknown): AgqlError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string'
    || typeof value.path !== 'string' || !Array.isArray(value.alternatives)
    || !value.alternatives.every((item) => typeof item === 'string')) return undefined;
  const code = ERROR_CODES.find((candidate) => candidate === value.code);
  if (code === undefined) return undefined;
  if (code === 'REFERENCE_NOT_AVAILABLE') {
    return { code, message: value.message, path: value.path, alternatives: value.alternatives };
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

function decodeIngestResult(value: string): IngestResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.outcomes) || !isRecord(parsed.writeReceipt)) {
    return undefined;
  }
  const receiptValue = parsed.writeReceipt.receipt;
  if (typeof receiptValue !== 'string'
    || !Array.isArray(parsed.writeReceipt.records)) return undefined;
  const records = parsed.writeReceipt.records;
  const receiptRecords = [];
  for (const record of records) {
    if (!isRecord(record) || typeof record.id !== 'string' || typeof record.version !== 'number'
      || !Number.isSafeInteger(record.version) || !isRecord(record.visibility)) return undefined;
    const visibility: Record<string, VisibilityState> = Object.create(null) as
      Record<string, VisibilityState>;
    for (const [name, state] of Object.entries(record.visibility)) {
      if (!isRecord(state) || typeof state.state !== 'string') return undefined;
      const decoded = decodeVisibility(
        state.state,
        typeof state.token === 'string' ? state.token : null,
        typeof state.code === 'string' ? state.code : null,
        typeof state.message === 'string' ? state.message : null,
      );
      if (decoded === undefined) return undefined;
      visibility[name] = decoded;
    }
    receiptRecords.push({
      id: record.id,
      version: SafeIntegerSchema.parse(record.version),
      visibility,
    });
  }
  const outcomes = [];
  for (const outcome of parsed.outcomes) {
    if (!isRecord(outcome) || typeof outcome.id !== 'string') return undefined;
    if (outcome.status === 'accepted' && typeof outcome.version === 'number'
      && Number.isSafeInteger(outcome.version) && outcome.error === null) {
      outcomes.push({
        id: outcome.id,
        status: 'accepted' as const,
        version: SafeIntegerSchema.parse(outcome.version),
        error: null,
      });
      continue;
    }
    const error = outcome.status === 'refused' && outcome.version === null
      ? decodeError(outcome.error)
      : undefined;
    if (error === undefined) return undefined;
    outcomes.push({
      id: outcome.id,
      status: 'refused' as const,
      version: null,
      error,
    });
  }
  const first = outcomes[0];
  if (first === undefined) return undefined;
  return {
    outcomes: [first, ...outcomes.slice(1)],
    writeReceipt: { receipt: receiptValue as WriteReceiptId, records: receiptRecords },
  };
}

export async function storeIngestResult(
  client: PoolClient,
  config: PostgresAdapterConfig,
  result: IngestResult,
): Promise<void> {
  const table = quoteQualified(config.namespace, INGEST_RESULTS);
  await client.query(
    `INSERT INTO ${table} (receipt_id, payload) VALUES ($1::text, $2::jsonb)`,
    [result.writeReceipt.receipt, JSON.stringify(result)],
  );
}

export async function loadIngestResult(
  client: PoolClient,
  config: PostgresAdapterConfig,
  receipt: string,
): Promise<IngestResult | undefined> {
  const table = quoteQualified(config.namespace, INGEST_RESULTS);
  const result = await client.query<[string]>({
    text: `SELECT payload::text FROM ${table} WHERE receipt_id = $1::text`,
    values: [receipt],
    rowMode: 'array',
  });
  const payload = result.rows[0]?.[0];
  return payload === undefined ? undefined : decodeIngestResult(payload);
}

export async function loadStoredReceiptRecords(
  client: PoolClient,
  config: PostgresAdapterConfig,
  receipt: string,
): Promise<readonly StoredReceiptRecord[] | undefined> {
  const table = quoteQualified(config.namespace, RECEIPT_RECORDS);
  const result = await client.query<[string, string, string, string]>({
    text: 'SELECT dataset_physical, record_id, version::text, action '
      + `FROM ${table} WHERE receipt_id = $1::text ORDER BY record_ordinal ASC`,
    values: [receipt],
    rowMode: 'array',
  });
  if (result.rows.length === 0) return undefined;
  const records: StoredReceiptRecord[] = [];
  for (const row of result.rows) {
    const parsed = SafeIntegerSchema.safeParse(Number(row[2]));
    if (!parsed.success || (row[3] !== 'upsert' && row[3] !== 'delete'
      && row[3] !== 'embedding')) return undefined;
    records.push({
      receipt: receipt as WriteReceiptId,
      datasetPhysical: row[0],
      id: row[1],
      version: parsed.data,
      action: row[3],
    });
  }
  return records;
}

export async function receiptMatchesScope(
  client: PoolClient,
  config: PostgresAdapterConfig,
  receipt: string,
  scopeFingerprint: string,
): Promise<boolean> {
  const table = quoteQualified(config.namespace, IDEMPOTENCY);
  const result = await client.query<[boolean]>({
    text: `SELECT EXISTS (SELECT 1 FROM ${table} WHERE receipt_id = $1::text `
      + 'AND scope_key = $2::text)',
    values: [receipt, scopeFingerprint],
    rowMode: 'array',
  });
  return result.rows[0]?.[0] === true;
}

export async function loadReceipt(
  client: PoolClient,
  config: PostgresAdapterConfig,
  receipt: string,
): Promise<WriteReceipt | undefined> {
  const records = await loadStoredReceiptRecords(client, config, receipt);
  if (records === undefined) return undefined;
  const table = quoteQualified(config.namespace, VISIBILITY);
  const decoded = [];
  for (const record of records) {
    type VisibilityRow = [string, string, string | null, string | null, string | null];
    const result = await client.query<VisibilityRow>({
      text: 'SELECT state_name, state, token, code, message '
        + `FROM ${table} WHERE dataset_physical = $1::text AND record_id = $2::text `
        + 'AND version = $3::bigint ORDER BY state_name ASC',
      values: [record.datasetPhysical, record.id, record.version],
      rowMode: 'array',
    });
    const visibility: Record<string, VisibilityState> = Object.create(null) as
      Record<string, VisibilityState>;
    for (const row of result.rows) {
      const state = decodeVisibility(row[1], row[2], row[3], row[4]);
      if (state === undefined) return undefined;
      visibility[row[0]] = state;
    }
    decoded.push({ id: record.id, version: record.version, visibility });
  }
  return { receipt: receipt as WriteReceiptId, records: decoded };
}
