import { performance } from 'node:perf_hooks';

import type {
  AdapterOutcome,
  VisibilityObservation,
  WriteReceipt,
} from '@agql/contracts';
import type { PoolClient } from 'pg';

import { backendRefusal, refusal } from './refusals.ts';
import { loadReceipt, loadStoredReceiptRecords } from './receipt-store.ts';
import type { StoredReceiptRecord } from './receipt-store.ts';
import type { RuntimeRegistry } from './registry.ts';
import { quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import type { PostgresDatasetBinding } from './types.ts';

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original refusal.
  }
}

async function queryRoleIsReadOnly(
  client: PoolClient,
  registry: RuntimeRegistry,
): Promise<boolean> {
  const result = await client.query<[string, string, boolean]>({
    text: 'SELECT current_user::text, current_setting(\'transaction_read_only\')::text, '
      + 'has_schema_privilege(current_user, $1::text, \'CREATE\')',
    values: [registry.config.namespace],
    rowMode: 'array',
  });
  const row = result.rows[0];
  return row?.[0] === registry.config.queryRole
    && row[1] === 'on' && !row[2];
}

async function recordVisible(
  client: PoolClient,
  registry: RuntimeRegistry,
  dataset: PostgresDatasetBinding,
  record: StoredReceiptRecord,
  stateName: string,
): Promise<boolean> {
  const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
  const id = quoteIdentifier(dataset.idField.physical);
  if (record.action === 'delete') {
    const absent = await client.query<[boolean]>({
      text: `SELECT NOT EXISTS (SELECT 1 FROM ${table} WHERE ${id} = $1::text)`,
      values: [record.id],
      rowMode: 'array',
    });
    return absent.rows[0]?.[0] === true;
  }
  if (stateName === 'record' || stateName === 'lexical') {
    const present = await client.query<[boolean]>({
      text: `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${id} = $1::text `
        + 'AND "_agql_version" = $2::bigint)',
      values: [record.id, record.version],
      rowMode: 'array',
    });
    return present.rows[0]?.[0] === true;
  }
  const embedding = dataset.embeddings.find((candidate) => candidate.visibilityName === stateName);
  if (embedding === undefined) return false;
  const present = await client.query<[boolean]>({
    text: `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${id} = $1::text `
      + `AND "_agql_version" = $2::bigint `
      + `AND ${quoteIdentifier(embedding.embedding.physical)} IS NOT NULL)`,
    values: [record.id, record.version],
    rowMode: 'array',
  });
  return present.rows[0]?.[0] === true;
}

interface ObservationCheck {
  readonly kind: 'ready' | 'terminal' | 'waiting' | 'invalid';
  readonly receipt?: WriteReceipt;
}

async function checkObservation(
  client: PoolClient,
  registry: RuntimeRegistry,
  observation: VisibilityObservation,
): Promise<ObservationCheck> {
  const receipt = await loadReceipt(client, registry.config, observation.receipt);
  const stored = await loadStoredReceiptRecords(client, registry.config, observation.receipt);
  if (receipt === undefined || receipt.records.length !== stored?.length) {
    return { kind: 'invalid' };
  }
  let waiting = false;
  for (let index = 0; index < receipt.records.length; index += 1) {
    const publicRecord = receipt.records[index];
    const storedRecord = stored[index];
    if (publicRecord === undefined || storedRecord === undefined) return { kind: 'invalid' };
    const dataset = registry.datasetByPhysical(storedRecord.datasetPhysical);
    if (dataset === undefined) return { kind: 'invalid' };
    for (const name of observation.require) {
      const state = publicRecord.visibility[name];
      if (state === undefined) return { kind: 'invalid' };
      if (state.state === 'accepted') {
        waiting = true;
      } else if (state.state === 'failed' || state.state === 'superseded') {
        return { kind: 'terminal', receipt };
      } else if (!await recordVisible(client, registry, dataset, storedRecord, name)) {
        return { kind: 'invalid' };
      }
    }
  }
  return waiting ? { kind: 'waiting', receipt } : { kind: 'ready', receipt };
}

function freshnessRefusal(): AdapterOutcome<WriteReceipt> {
  return refusal(
    'FRESHNESS_UNAVAILABLE',
    'The required receipt visibility was not observed before the bounded wait ended.',
    '/afterWrite',
    ['Retry afterWrite with the same receipt or require fewer named states.'],
    'Retry the bounded wait; do not treat this result as visibility success.',
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function observeVisibility(
  observation: VisibilityObservation,
  registry: RuntimeRegistry,
): Promise<AdapterOutcome<WriteReceipt>> {
  const client = await registry.config.queryPool.connect();
  const deadline = performance.now() + observation.timeoutMs;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1::text, $2::text, true)', [
      'statement_timeout',
      `${registry.config.statementTimeoutMs}ms`,
    ]);
    if (!await queryRoleIsReadOnly(client, registry)) {
      await rollback(client);
      return refusal(
        'SCOPE_UNENFORCEABLE',
        'Receipt observation is not running on the verified read-only query role.',
        '/scope',
        ['Use the configured read-only query role.'],
        'Correct the query-role deployment grants.',
      );
    }
    for (;;) {
      const check = await checkObservation(client, registry, observation);
      if ((check.kind === 'ready' || check.kind === 'terminal')
        && check.receipt !== undefined) {
        await client.query('COMMIT');
        return { kind: 'success', value: check.receipt };
      }
      if (check.kind === 'invalid' || performance.now() >= deadline) {
        await rollback(client);
        return freshnessRefusal();
      }
      await pause(Math.min(25, Math.max(1, deadline - performance.now())));
    }
  } catch {
    await rollback(client);
    return backendRefusal();
  } finally {
    client.release();
  }
}
