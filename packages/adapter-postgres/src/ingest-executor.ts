import type {
  AdapterOutcome,
  IngestRecordOutcome,
  IngestResult,
  ResolvedCanonicalFieldValue,
  VisibilityState,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { PoolClient } from 'pg';

import { backendRefusal, refusal } from './refusals.ts';
import {
  insertReceiptRecord,
  loadIngestResult,
  loadReceipt,
  newReceiptId,
  newVisibilityToken,
  reserveIdempotency,
  supersedeVisibility,
  storeIngestResult,
  upsertVisibility,
} from './receipt-store.ts';
import { quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import { encodeScalar, ParameterBuilder } from './sql-parameters.ts';
import { eligibilitySql } from './sql-predicates.ts';
import type {
  CompiledPostgresIngest,
  PostgresAdapterConfig,
  PostgresDatasetBinding,
} from './types.ts';

interface CanonicalValueRecord {
  readonly id: string;
  readonly values: readonly ResolvedCanonicalFieldValue[];
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original typed public refusal.
  }
}

async function verifyWriterRole(
  client: PoolClient,
  dataset: PostgresDatasetBinding,
  config: PostgresAdapterConfig,
): Promise<boolean> {
  const relation = quoteQualified(config.namespace, dataset.dataset.physical);
  const result = await client.query<[string, boolean, boolean, boolean, boolean]>({
    text: 'SELECT current_user::text, '
      + 'has_table_privilege(current_user, $1::text, \'INSERT\'), '
      + 'has_table_privilege(current_user, $1::text, \'UPDATE\'), '
      + 'has_table_privilege(current_user, $1::text, \'DELETE\'), '
      + 'has_schema_privilege(current_user, $2::text, \'CREATE\')',
    values: [relation, config.namespace],
    rowMode: 'array',
  });
  const row = result.rows[0];
  return row?.[0] === config.writerRole
    && row[1] && row[2] && row[3] && !row[4];
}

function conflictRefusal<T>(): AdapterOutcome<T> {
  return refusal(
    'COST_GATE_REFUSAL',
    'The canonical write precondition was not satisfied.',
    '/records',
    ['Retry with the current record version or choose insertOnly/replace deliberately.'],
    'Retry with a new idempotency key and the current record version.',
  );
}

function refusedOutcome(id: string, index: number): IngestRecordOutcome {
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

function acceptedOutcome(
  id: string,
  version: ReturnType<typeof SafeIntegerSchema.parse>,
): IngestRecordOutcome {
  return { id, status: 'accepted', version, error: null };
}

function scopeSql(
  compiled: CompiledPostgresIngest,
  parameters: ParameterBuilder,
  alias: string,
): string {
  return eligibilitySql({
    registry: compiled.registry,
    dataset: compiled.dataset,
    alias,
    parameters,
  }, compiled.plan.scope);
}

function recordValues(
  values: readonly ResolvedCanonicalFieldValue[],
): ReadonlyMap<string, ResolvedCanonicalFieldValue> {
  return new Map(values.map((item) => [item.field.physical, item]));
}

async function currentVersion(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  id: string,
): Promise<ReturnType<typeof SafeIntegerSchema.parse> | undefined> {
  const parameters = new ParameterBuilder();
  const table = quoteQualified(
    compiled.registry.config.namespace,
    compiled.dataset.dataset.physical,
  );
  const idColumn = quoteIdentifier(compiled.dataset.idField.physical);
  const recordId = parameters.add(id, 'text');
  const scope = scopeSql(compiled, parameters, 'd');
  const result = await client.query<[string]>({
    text: `SELECT "_agql_version"::text FROM ${table} AS d `
      + `WHERE d.${idColumn} = ${recordId} AND (${scope}) FOR UPDATE`,
    values: [...parameters.values],
    rowMode: 'array',
  });
  const raw = result.rows[0]?.[0];
  if (raw === undefined) return undefined;
  const parsed = SafeIntegerSchema.safeParse(Number(raw));
  if (!parsed.success) throw new Error('Stored version is outside the interoperable range.');
  return parsed.data;
}

async function newRecordVisibleToScope(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  record: CanonicalValueRecord,
): Promise<boolean> {
  const parameters = new ParameterBuilder();
  const byPhysical = recordValues(record.values);
  const columns: string[] = [];
  for (const field of compiled.dataset.fields) {
    if (field.physical === compiled.dataset.idField.physical) {
      columns.push(`${parameters.add(record.id, 'text')} AS ${quoteIdentifier(field.physical)}`);
      continue;
    }
    const item = byPhysical.get(field.physical);
    if (item === undefined) throw new Error('Compiled whole record lost a field.');
    const encoded = encodeScalar(field, item.value);
    if (encoded === undefined) throw new Error('Compiled whole record changed type.');
    columns.push(
      `${parameters.add(encoded.parameter, encoded.cast)} AS ${quoteIdentifier(field.physical)}`,
    );
  }
  const scope = scopeSql(compiled, parameters, 'd');
  const result = await client.query<[boolean]>({
    text: `SELECT EXISTS (SELECT 1 FROM (SELECT ${columns.join(', ')}) AS d WHERE ${scope})`,
    values: [...parameters.values],
    rowMode: 'array',
  });
  return result.rows[0]?.[0] === true;
}

async function insertRecord(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  record: CanonicalValueRecord,
  version: ReturnType<typeof SafeIntegerSchema.parse>,
): Promise<void> {
  const parameters = new ParameterBuilder();
  const columns = [quoteIdentifier(compiled.dataset.idField.physical)];
  const values = [parameters.add(record.id, 'text')];
  const byPhysical = recordValues(record.values);
  for (const field of compiled.dataset.fields) {
    if (field.physical === compiled.dataset.idField.physical) continue;
    const item = byPhysical.get(field.physical);
    if (item === undefined) throw new Error('Compiled whole record lost a field.');
    const encoded = encodeScalar(field, item.value);
    if (encoded === undefined) throw new Error('Compiled whole record changed type.');
    columns.push(quoteIdentifier(field.physical));
    values.push(parameters.add(encoded.parameter, encoded.cast));
  }
  columns.push('"_agql_version"', '"_agql_scope_fingerprint"', '"_agql_updated_at"');
  values.push(
    parameters.add(version, 'bigint'),
    parameters.add(compiled.plan.scopeFingerprint, 'text'),
    'statement_timestamp()',
  );
  const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
    [...parameters.values],
  );
}

async function replaceRecord(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  record: CanonicalValueRecord,
  version: ReturnType<typeof SafeIntegerSchema.parse>,
): Promise<void> {
  const parameters = new ParameterBuilder();
  const assignments: string[] = [];
  const byPhysical = recordValues(record.values);
  for (const field of compiled.dataset.fields) {
    if (field.physical === compiled.dataset.idField.physical) continue;
    const item = byPhysical.get(field.physical);
    if (item === undefined) throw new Error('Compiled whole record lost a field.');
    const encoded = encodeScalar(field, item.value);
    if (encoded === undefined) throw new Error('Compiled whole record changed type.');
    assignments.push(
      `${quoteIdentifier(field.physical)} = ${parameters.add(encoded.parameter, encoded.cast)}`,
    );
  }
  for (const embedding of compiled.dataset.embeddings) {
    assignments.push(`${quoteIdentifier(embedding.embedding.physical)} = NULL`);
  }
  assignments.push(
    `"_agql_version" = ${parameters.add(version, 'bigint')}`,
    `"_agql_scope_fingerprint" = ${parameters.add(compiled.plan.scopeFingerprint, 'text')}`,
    '"_agql_updated_at" = statement_timestamp()',
  );
  const id = parameters.add(record.id, 'text');
  const scope = scopeSql(compiled, parameters, 'd');
  const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  await client.query(
    `UPDATE ${table} AS d SET ${assignments.join(', ')} `
      + `WHERE d.${quoteIdentifier(compiled.dataset.idField.physical)} = ${id} AND (${scope})`,
    [...parameters.values],
  );
}

async function deleteRecord(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  id: string,
): Promise<void> {
  const parameters = new ParameterBuilder();
  const recordId = parameters.add(id, 'text');
  const scope = scopeSql(compiled, parameters, 'd');
  const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  await client.query(
    `DELETE FROM ${table} AS d WHERE d.${quoteIdentifier(compiled.dataset.idField.physical)} = `
      + `${recordId} AND (${scope})`,
    [...parameters.values],
  );
}

async function writeVisibility(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  receipt: ReturnType<typeof newReceiptId>,
  id: string,
  version: ReturnType<typeof SafeIntegerSchema.parse>,
  deleting: boolean,
): Promise<void> {
  await insertReceiptRecord(client, config, {
    receipt,
    datasetPhysical: compiled.dataset.dataset.physical,
    id,
    version,
    action: deleting ? 'delete' : 'upsert',
  });
  for (const name of ['record', 'lexical']) {
    const state: VisibilityState = {
      state: 'ready',
      token: newVisibilityToken(config, receipt, id, version, name),
    };
    await upsertVisibility(client, config, compiled.dataset, id, version, name, state);
  }
  for (const embedding of compiled.dataset.embeddings) {
    const state: VisibilityState = deleting
      ? {
        state: 'ready',
        token: newVisibilityToken(config, receipt, id, version, embedding.visibilityName),
      }
      : { state: 'pending' };
    await upsertVisibility(
      client,
      config,
      compiled.dataset,
      id,
      version,
      embedding.visibilityName,
      state,
    );
  }
}

function recordConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === '23505' || code === '23514' || code === '23502';
}

async function processCanonicalRecord(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  receiptId: ReturnType<typeof newReceiptId>,
  index: number,
): Promise<IngestRecordOutcome> {
  const record = compiled.plan.records[index];
  if (record === undefined) throw new TypeError('Canonical ingest record index is invalid.');
  const savepoint = `agql_record_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const current = await currentVersion(client, compiled, record.id);
    const preconditionFailed = (compiled.plan.mode === 'insertOnly' && current !== undefined)
      || ('ifVersion' in record && current !== record.ifVersion)
      || (compiled.plan.mode === 'delete' && current === undefined);
    if (preconditionFailed) {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return refusedOutcome(record.id, index);
    }
    if ('values' in record && !await newRecordVisibleToScope(client, compiled, record)) {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return refusedOutcome(record.id, index);
    }
    const version = SafeIntegerSchema.safeParse(current === undefined ? 1 : current + 1);
    if (!version.success) {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return refusedOutcome(record.id, index);
    }
    await supersedeVisibility(client, config, compiled.dataset, record.id);
    if (compiled.plan.mode === 'insertOnly') {
      if (!('values' in record)) throw new TypeError('Insert plan lost canonical values.');
      await insertRecord(client, compiled, config, record, version.data);
    } else if (compiled.plan.mode === 'replace') {
      if (!('values' in record)) throw new TypeError('Replace plan lost canonical values.');
      if (current === undefined) {
        await insertRecord(client, compiled, config, record, version.data);
      } else {
        await replaceRecord(client, compiled, config, record, version.data);
      }
    } else {
      await deleteRecord(client, compiled, config, record.id);
    }
    await writeVisibility(
      client,
      compiled,
      config,
      receiptId,
      record.id,
      version.data,
      compiled.plan.mode === 'delete',
    );
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return acceptedOutcome(record.id, version.data);
  } catch (error: unknown) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    if (recordConflict(error)) return refusedOutcome(record.id, index);
    throw error;
  }
}

export async function executeCanonicalIngest(
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
): Promise<AdapterOutcome<IngestResult>> {
  const client = await config.writerPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
    await client.query('SELECT set_config($1::text, $2::text, true)', [
      'statement_timeout',
      `${config.statementTimeoutMs}ms`,
    ]);
    if (!await verifyWriterRole(client, compiled.dataset, config)) {
      await rollback(client);
      return refusal(
        'SCOPE_UNENFORCEABLE',
        'The configured PostgreSQL writer role is not confined to data mutation.',
        '/scope',
        ['Use a writer role with DML but no CREATE privilege in the runtime namespace.'],
        'Correct the deployment grants and writer-role configuration.',
      );
    }
    const receiptId = newReceiptId();
    const reserved = await reserveIdempotency(
      client,
      config,
      compiled.plan.scopeFingerprint,
      compiled.plan.idempotencyKey,
      compiled.operationDigest,
      receiptId,
    );
    if (!reserved.inserted) {
      if (reserved.digest !== compiled.operationDigest) {
        await rollback(client);
        return conflictRefusal();
      }
      const replay = await loadIngestResult(client, config, reserved.receipt);
      if (replay === undefined) {
        await rollback(client);
        return backendRefusal();
      }
      await client.query('COMMIT');
      return { kind: 'success', value: replay };
    }
    const outcomes: IngestRecordOutcome[] = [];
    for (let index = 0; index < compiled.plan.records.length; index += 1) {
      outcomes.push(await processCanonicalRecord(client, compiled, config, receiptId, index));
    }
    const first = outcomes[0];
    if (first === undefined) throw new TypeError('Canonical ingest requires at least one record.');
    const accepted = outcomes.filter(
      (outcome): outcome is Extract<IngestRecordOutcome, { readonly status: 'accepted' }> =>
        outcome.status === 'accepted',
    );
    const writeReceipt = accepted.length === 0
      ? { receipt: receiptId, records: [] }
      : await loadReceipt(client, config, receiptId);
    if (writeReceipt === undefined) {
      await rollback(client);
      return backendRefusal();
    }
    const result: IngestResult = {
      outcomes: [first, ...outcomes.slice(1)],
      writeReceipt,
    };
    await storeIngestResult(client, config, result);
    await client.query('COMMIT');
    return { kind: 'success', value: result };
  } catch (error: unknown) {
    await rollback(client);
    return backendRefusal(error);
  } finally {
    client.release();
  }
}
