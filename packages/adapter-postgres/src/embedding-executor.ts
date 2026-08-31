import type { AdapterOutcome, WriteReceipt } from '@agql/contracts';
import type { PoolClient } from 'pg';

import { backendRefusal, refusal } from './refusals.ts';
import {
  insertReceiptRecord,
  loadReceipt,
  newReceiptId,
  newVisibilityToken,
  reserveIdempotency,
  upsertVisibility,
} from './receipt-store.ts';
import { quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import type {
  CompiledPostgresEmbeddingMutation,
  PostgresAdapterConfig,
  PostgresDatasetBinding,
} from './types.ts';
import { pgvectorParameter } from './vector.ts';

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
  return row?.[0] === config.writerRole && row[1] && row[2] && row[3] && !row[4];
}

function conflictRefusal<T>(): AdapterOutcome<T> {
  return refusal(
    'COST_GATE_REFUSAL',
    'The embedding write precondition was not satisfied.',
    '/sourceVersion',
    ['Retry from the current canonical record version.'],
    'Regenerate the embedding for the current canonical record version.',
  );
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
