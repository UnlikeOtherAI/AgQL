import { createHmac, randomBytes } from 'node:crypto';

import type {
  CatalogPhysicalIdentifier,
  VisibilityState,
  VisibilityToken,
  WriteReceipt,
  WriteReceiptId,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { PoolClient } from 'pg';

import { quoteQualified } from './sql-identifiers.ts';
import type { PostgresAdapterConfig, PostgresDatasetBinding } from './types.ts';

const IDEMPOTENCY = '_agql_idempotency' as CatalogPhysicalIdentifier;
const RECEIPT_RECORDS = '_agql_receipt_records' as CatalogPhysicalIdentifier;
const VISIBILITY = '_agql_visibility' as CatalogPhysicalIdentifier;

export type ReceiptAction = 'upsert' | 'delete' | 'embedding';

export interface StoredReceiptRecord {
  readonly receipt: WriteReceiptId;
  readonly datasetPhysical: string;
  readonly id: string;
  readonly version: ReturnType<typeof SafeIntegerSchema.parse>;
  readonly action: ReceiptAction;
}

function randomOpaque(prefix: string): string {
  return `${prefix}.${randomBytes(24).toString('base64url')}`;
}

export function newReceiptId(): WriteReceiptId {
  return randomOpaque('wr.v1') as WriteReceiptId;
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
  return `visibility.v1.${nonce}.${digest}` as VisibilityToken;
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
  if (state === 'accepted') return { state };
  if (state === 'superseded') return { state };
  if (state === 'ready' && token !== null) return { state, token: token as VisibilityToken };
  if (state === 'failed' && code !== null && message !== null) {
    return { state, code, message };
  }
  return undefined;
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
