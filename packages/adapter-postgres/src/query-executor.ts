import { createHmac } from 'node:crypto';

import type { AdapterExecutionResult, AdapterOutcome } from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { PoolClient } from 'pg';

import { decodeRows } from './codec.ts';
import { backendRefusal, refusal } from './refusals.ts';
import { quoteQualified } from './sql-identifiers.ts';
import type { CompiledPostgresQuery, PostgresAdapterConfig } from './types.ts';

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original bounded-operation refusal remains the public result.
  }
}

async function verifyReadRole(
  client: PoolClient,
  compiled: CompiledPostgresQuery,
  config: PostgresAdapterConfig,
): Promise<boolean> {
  const relation = quoteQualified(config.namespace, compiled.dataset.dataset.physical);
  const result = await client.query<[string, string, boolean, boolean]>({
    text: 'SELECT current_user::text, current_setting(\'transaction_read_only\')::text, '
      + 'has_table_privilege(current_user, $1::text, '
      + '\'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER\'), '
      + 'has_schema_privilege(current_user, $2::text, \'CREATE\')',
    values: [relation, config.namespace],
    rowMode: 'array',
  });
  const row = result.rows[0];
  return row?.[0] === config.queryRole
    && row[1] === 'on'
    && !row[2]
    && !row[3];
}

function snapshotToken(snapshot: string, secret: Uint8Array): string {
  return `snapshot.v1.${createHmac('sha256', secret).update(snapshot, 'utf8').digest('base64url')}`;
}

export async function executeQuery(
  compiled: CompiledPostgresQuery,
  config: PostgresAdapterConfig,
): Promise<AdapterOutcome<AdapterExecutionResult>> {
  const client = await config.queryPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SELECT set_config($1::text, $2::text, true)', [
      'statement_timeout',
      `${config.statementTimeoutMs}ms`,
    ]);
    await client.query('SELECT set_config($1::text, $2::text, true)', [
      'TimeZone',
      'UTC',
    ]);
    await client.query('SELECT set_config($1::text, $2::text, true)', [
      'DateStyle',
      'ISO, YMD',
    ]);
    if (!await verifyReadRole(client, compiled, config)) {
      await rollback(client);
      return refusal(
        'SCOPE_UNENFORCEABLE',
        'The configured PostgreSQL query role is not a verified read-only role.',
        '/scope',
        ['Use a role with SELECT only and no CREATE privilege in the runtime namespace.'],
        'Correct the deployment grants and query-role configuration.',
      );
    }
    for (const [name, value] of compiled.settings) {
      await client.query('SELECT set_config($1::text, $2::text, true)', [name, value]);
    }
    if (compiled.admissionStatement !== undefined && compiled.exactAdmissionLimit !== undefined) {
      const admission = await client.query<[string]>({
        ...compiled.admissionStatement,
        values: [...compiled.admissionStatement.values],
        rowMode: 'array',
      });
      const rawCount = admission.rows[0]?.[0];
      const parsed = SafeIntegerSchema.safeParse(
        typeof rawCount === 'string' ? Number(rawCount) : Number.NaN,
      );
      if (!parsed.success) {
        await rollback(client);
        return backendRefusal();
      }
      if (parsed.data > compiled.exactAdmissionLimit) {
        await rollback(client);
        return refusal(
          'EXACT_SCAN_LIMIT_EXCEEDED',
          'The exact eligible set exceeds the admitted scan limit.',
          '/search/accuracy',
          ['Add a selective where predicate.', 'Request approximate accuracy if policy permits.'],
          {
            action: 'narrowEligibleSetOrRequestApproximate',
            details: {
              limit: compiled.exactAdmissionLimit,
              eligibleCount: parsed.data,
              alternatives: [
                'Add a selective where predicate.',
                'Request approximate accuracy if policy permits.',
              ],
            },
          },
        );
      }
    }
    const snapshotResult = await client.query<[string]>({
      text: 'SELECT pg_current_snapshot()::text',
      rowMode: 'array',
    });
    const snapshot = snapshotResult.rows[0]?.[0];
    if (snapshot === undefined) {
      await rollback(client);
      return backendRefusal();
    }
    const result = await client.query<unknown[]>({
      ...compiled.statement,
      values: [...compiled.statement.values],
      rowMode: 'array',
    });
    const decoded = decodeRows(compiled, result.rows);
    if (decoded === undefined) {
      await rollback(client);
      return backendRefusal();
    }
    if (decoded.kind === 'moneyMixed') {
      await rollback(client);
      return {
        kind: 'refusal',
        refusal: {
          code: 'MONEY_CURRENCY_MIXED',
          message: 'The money aggregate contains more than one currency.',
          path: decoded.path,
          alternatives: ['Group by a catalog field that separates currencies.'],
        },
      };
    }
    await client.query('COMMIT');
    return {
      kind: 'success',
      value: {
        rows: decoded.rows,
        truncated: decoded.truncated,
        snapshot: { kind: 'snapshot', value: snapshotToken(snapshot, config.tokenSecret) },
        ...(decoded.ranks === undefined ? {} : { ranks: decoded.ranks }),
      },
    };
  } catch (error: unknown) {
    await rollback(client);
    return backendRefusal(error);
  } finally {
    client.release();
  }
}
