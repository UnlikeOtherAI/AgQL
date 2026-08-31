import type {
  AdapterOutcome,
  ResolvedCanonicalFieldValue,
  VisibilityState,
  WriteReceipt,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { PoolClient } from 'pg';

import { backendRefusal, refusal } from './refusals.ts';
import {
  insertReceiptRecord,
  loadReceipt,
  newReceiptId,
  newVisibilityToken,
  reserveIdempotency,
  supersedeVisibility,
  upsertVisibility,
} from './receipt-store.ts';
import { quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import { encodeScalar, ParameterBuilder } from './sql-parameters.ts';
import type {
  CompiledPostgresEmbeddingMutation,
  CompiledPostgresIngest,
  PostgresAdapterConfig,
  PostgresDatasetBinding,
} from './types.ts';
import { pgvectorParameter } from './vector.ts';

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
    'Resolve the record-version conflict and submit a new idempotency key.',
  );
}

function recordValues(
  values: readonly ResolvedCanonicalFieldValue[],
): ReadonlyMap<string, ResolvedCanonicalFieldValue> {
  return new Map(values.map((item) => [item.field.physical, item]));
}

async function currentVersion(
  client: PoolClient,
  config: PostgresAdapterConfig,
  dataset: PostgresDatasetBinding,
  id: string,
): Promise<ReturnType<typeof SafeIntegerSchema.parse> | undefined> {
  const table = quoteQualified(config.namespace, dataset.dataset.physical);
  const idColumn = quoteIdentifier(dataset.idField.physical);
  const result = await client.query<[string]>({
    text: `SELECT "_agql_version"::text FROM ${table} `
      + `WHERE ${idColumn} = $1::text FOR UPDATE`,
    values: [id],
    rowMode: 'array',
  });
  const raw = result.rows[0]?.[0];
  if (raw === undefined) return undefined;
  const parsed = SafeIntegerSchema.safeParse(Number(raw));
  if (!parsed.success) throw new Error('Stored version is outside the interoperable range.');
  return parsed.data;
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
  const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  await client.query(
    `UPDATE ${table} SET ${assignments.join(', ')} `
      + `WHERE ${quoteIdentifier(compiled.dataset.idField.physical)} = ${id}`,
    [...parameters.values],
  );
}

async function deleteRecord(
  client: PoolClient,
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
  id: string,
): Promise<void> {
  const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  await client.query(
    `DELETE FROM ${table} WHERE ${quoteIdentifier(compiled.dataset.idField.physical)} = $1::text`,
    [id],
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
      : { state: 'accepted' };
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

export async function executeCanonicalIngest(
  compiled: CompiledPostgresIngest,
  config: PostgresAdapterConfig,
): Promise<AdapterOutcome<WriteReceipt>> {
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
      const replay = await loadReceipt(client, config, reserved.receipt);
      if (replay === undefined) {
        await rollback(client);
        return backendRefusal();
      }
      await client.query('COMMIT');
      return { kind: 'success', value: replay };
    }
    for (const record of compiled.plan.records) {
      const current = await currentVersion(client, config, compiled.dataset, record.id);
      if (compiled.plan.mode === 'insertOnly' && current !== undefined) {
        await rollback(client);
        return conflictRefusal();
      }
      if ('ifVersion' in record && current !== record.ifVersion) {
        await rollback(client);
        return conflictRefusal();
      }
      if (compiled.plan.mode === 'delete' && current === undefined) {
        await rollback(client);
        return conflictRefusal();
      }
      const numericVersion = current === undefined ? 1 : current + 1;
      const parsedVersion = SafeIntegerSchema.safeParse(numericVersion);
      if (!parsedVersion.success) {
        await rollback(client);
        return conflictRefusal();
      }
      await supersedeVisibility(client, config, compiled.dataset, record.id);
      if (compiled.plan.mode === 'insertOnly') {
        if (!('values' in record)) throw new Error('Insert plan lost canonical values.');
        await insertRecord(client, compiled, config, record, parsedVersion.data);
      } else if (compiled.plan.mode === 'replace') {
        if (!('values' in record)) throw new Error('Replace plan lost canonical values.');
        if (current === undefined) {
          await insertRecord(client, compiled, config, record, parsedVersion.data);
        } else {
          await replaceRecord(client, compiled, config, record, parsedVersion.data);
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
        parsedVersion.data,
        compiled.plan.mode === 'delete',
      );
    }
    const receipt = await loadReceipt(client, config, receiptId);
    if (receipt === undefined) {
      await rollback(client);
      return backendRefusal();
    }
    await client.query('COMMIT');
    return { kind: 'success', value: receipt };
  } catch {
    await rollback(client);
    return backendRefusal();
  } finally {
    client.release();
  }
}

export async function executeEmbeddingMutation(
  compiled: CompiledPostgresEmbeddingMutation,
  config: PostgresAdapterConfig,
): Promise<AdapterOutcome<WriteReceipt>> {
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
        ['Use the configured runtime writer role.'],
        'Correct the deployment writer role.',
      );
    }
    const receiptId = newReceiptId();
    const scope = `embedding:${compiled.embedding.embedding.specReference}`;
    const reserved = await reserveIdempotency(
      client,
      config,
      scope,
      compiled.mutation.idempotencyKey,
      compiled.operationDigest,
      receiptId,
    );
    if (!reserved.inserted) {
      if (reserved.digest !== compiled.operationDigest) {
        await rollback(client);
        return conflictRefusal();
      }
      const replay = await loadReceipt(client, config, reserved.receipt);
      if (replay === undefined) {
        await rollback(client);
        return backendRefusal();
      }
      await client.query('COMMIT');
      return { kind: 'success', value: replay };
    }
    const table = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
    const idColumn = quoteIdentifier(compiled.dataset.idField.physical);
    const vectorColumn = quoteIdentifier(compiled.embedding.embedding.physical);
    const vector = compiled.mutation.kind === 'put'
      ? pgvectorParameter(compiled.mutation.vector, config.vectorByteOrder)
      : null;
    const result = await client.query<[string]>({
      text: `UPDATE ${table} SET ${vectorColumn} = $1::vector `
        + `WHERE ${idColumn} = $2::text AND "_agql_version" = $3::bigint `
        + 'RETURNING "_agql_version"::text',
      values: [vector, compiled.mutation.recordId, compiled.mutation.sourceVersion],
      rowMode: 'array',
    });
    if (result.rowCount !== 1 || vector === undefined) {
      await rollback(client);
      return conflictRefusal();
    }
    const token = newVisibilityToken(
      config,
      receiptId,
      compiled.mutation.recordId,
      compiled.mutation.sourceVersion,
      compiled.embedding.visibilityName,
    );
    await upsertVisibility(
      client,
      config,
      compiled.dataset,
      compiled.mutation.recordId,
      compiled.mutation.sourceVersion,
      compiled.embedding.visibilityName,
      { state: 'ready', token },
    );
    await insertReceiptRecord(client, config, {
      receipt: receiptId,
      datasetPhysical: compiled.dataset.dataset.physical,
      id: compiled.mutation.recordId,
      version: compiled.mutation.sourceVersion,
      action: 'embedding',
    });
    const receipt = await loadReceipt(client, config, receiptId);
    if (receipt === undefined) {
      await rollback(client);
      return backendRefusal();
    }
    await client.query('COMMIT');
    return { kind: 'success', value: receipt };
  } catch {
    await rollback(client);
    return backendRefusal();
  } finally {
    client.release();
  }
}
