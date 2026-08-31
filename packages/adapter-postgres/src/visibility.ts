import { performance } from 'node:perf_hooks';

import type {
  AdapterOutcome,
  VisibilityObservation,
  WriteReceipt,
} from '@agql/contracts';
import type { PoolClient } from 'pg';

import { backendRefusal, refusal } from './refusals.ts';
import {
  loadReceipt,
  loadStoredReceiptRecords,
  receiptMatchesScope,
} from './receipt-store.ts';
import type { StoredReceiptRecord } from './receipt-store.ts';
import type { RuntimeRegistry } from './registry.ts';
import { quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import { ParameterBuilder } from './sql-parameters.ts';
import { eligibilitySql } from './sql-predicates.ts';
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
  observation: VisibilityObservation,
): Promise<boolean> {
  const parameters = new ParameterBuilder();
  const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
  const id = quoteIdentifier(dataset.idField.physical);
  const recordId = parameters.add(record.id, 'text');
  const scope = eligibilitySql({
    registry,
    dataset,
    alias: 'd',
    parameters,
  }, observation.scope);
  if (record.action === 'delete') {
    const absent = await client.query<[boolean]>({
      text: `SELECT NOT EXISTS (SELECT 1 FROM ${table} AS d WHERE d.${id} = ${recordId} `
        + `AND (${scope}))`,
      values: [...parameters.values],
      rowMode: 'array',
    });
    return absent.rows[0]?.[0] === true;
  }
  if (stateName === 'record' || stateName === 'lexical') {
    const version = parameters.add(record.version, 'bigint');
    const present = await client.query<[boolean]>({
      text: `SELECT EXISTS (SELECT 1 FROM ${table} AS d WHERE d.${id} = ${recordId} `
        + `AND d."_agql_version" = ${version} AND (${scope}))`,
      values: [...parameters.values],
      rowMode: 'array',
    });
    return present.rows[0]?.[0] === true;
  }
  const embedding = dataset.embeddings.find((candidate) => candidate.visibilityName === stateName);
  if (embedding === undefined) return false;
  const version = parameters.add(record.version, 'bigint');
  const present = await client.query<[boolean]>({
    text: `SELECT EXISTS (SELECT 1 FROM ${table} AS d WHERE d.${id} = ${recordId} `
      + `AND d."_agql_version" = ${version} `
      + `AND d.${quoteIdentifier(embedding.embedding.physical)} IS NOT NULL AND (${scope}))`,
    values: [...parameters.values],
    rowMode: 'array',
  });
  return present.rows[0]?.[0] === true;
}

interface ObservationCheck {
  readonly kind: 'ready' | 'terminal' | 'waiting' | 'invalid';
  readonly receipt?: WriteReceipt;
  readonly require?: readonly [string, ...string[]];
}

async function checkObservation(
  client: PoolClient,
  registry: RuntimeRegistry,
  observation: VisibilityObservation,
): Promise<ObservationCheck> {
  if (!await receiptMatchesScope(
    client,
    registry.config,
    observation.receipt,
    observation.scopeFingerprint,
  )) return { kind: 'invalid' };
  const receipt = await loadReceipt(client, registry.config, observation.receipt);
  const stored = await loadStoredReceiptRecords(client, registry.config, observation.receipt);
  if (receipt === undefined || receipt.records.length !== stored?.length) {
    return { kind: 'invalid' };
  }
  let waiting = false;
  const waitingNames = new Set<string>();
  for (let index = 0; index < receipt.records.length; index += 1) {
    const publicRecord = receipt.records[index];
    const storedRecord = stored[index];
    if (publicRecord === undefined || storedRecord === undefined) return { kind: 'invalid' };
    const dataset = registry.datasetByPhysical(storedRecord.datasetPhysical);
    if (dataset === undefined
      || storedRecord.datasetPhysical !== observation.dataset.physical
      || dataset.idField.physical !== observation.idField.physical) return { kind: 'invalid' };
    for (const name of observation.require) {
      const state = publicRecord.visibility[name];
      if (state === undefined) return { kind: 'invalid' };
      if (state.state === 'accepted' || state.state === 'pending') {
        waiting = true;
        waitingNames.add(name);
      } else if (state.state === 'failed' || state.state === 'superseded') {
        return { kind: 'terminal', receipt };
      } else if (!await recordVisible(
        client,
        registry,
        dataset,
        storedRecord,
        name,
        observation,
      )) {
        waiting = true;
        waitingNames.add(name);
      }
    }
  }
  const ordered = [...waitingNames].sort();
  const first = ordered[0];
  return waiting && first !== undefined
    ? { kind: 'waiting', receipt, require: [first, ...ordered.slice(1)] }
    : { kind: 'ready', receipt };
}

function timeoutRefusal(
  observation: VisibilityObservation,
  require: readonly [string, ...string[]],
): AdapterOutcome<WriteReceipt> {
  return {
    kind: 'refusal',
    refusal: {
      code: 'AFTER_WRITE_TIMEOUT',
      message: 'The afterWrite deadline elapsed before every required visibility '
        + 'state was observable.',
      path: '/afterWrite',
      alternatives: ['Retry with the same receipt and requirements.'],
      remedy: {
        action: 'retryAfterWrite',
        details: { receipt: observation.receipt, require },
      },
    },
  };
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
      if (check.kind === 'ready' && check.receipt !== undefined) {
        await client.query('COMMIT');
        return { kind: 'success', value: check.receipt };
      }
      if (check.kind === 'terminal') {
        await rollback(client);
        return refusal(
          'FRESHNESS_UNAVAILABLE',
          'A required write representation failed or was superseded.',
          '/afterWrite',
          ['Issue a new write before retrying the query.'],
          'Issue a new write before retrying the query.',
        );
      }
      if (check.kind === 'invalid') {
        await rollback(client);
        return refusal(
          'FRESHNESS_UNAVAILABLE',
          'The write receipt cannot be observed on the selected binding.',
          '/afterWrite',
          ['Use a matching unexpired receipt from this binding.'],
          'Supply a matching receipt or choose a certified binding.',
        );
      }
      if (performance.now() >= deadline) {
        await rollback(client);
        return timeoutRefusal(observation, check.require ?? observation.require);
      }
      await pause(Math.min(25, Math.max(1, deadline - performance.now())));
    }
  } catch (error: unknown) {
    await rollback(client);
    return backendRefusal(error);
  } finally {
    client.release();
  }
}
