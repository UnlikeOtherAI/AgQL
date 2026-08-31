import { createHash } from 'node:crypto';

import type {
  CatalogPhysicalIdentifier,
  ResolvedFieldBinding,
} from '@agql/contracts';
import type { PoolClient } from 'pg';

import { quoteCollation, quoteIdentifier, quoteQualified } from './sql-identifiers.ts';
import type {
  PostgresCollationBinding,
  PostgresDatasetSchema,
  PostgresProvisionerConfig,
  ProvisioningOutcome,
} from './types.ts';

const MINIMUM_PGVECTOR = [0, 8, 0] as const;
const RESERVED_PHYSICAL = new Set([
  '_agql_idempotency',
  '_agql_receipt_records',
  '_agql_scope_fingerprint',
  '_agql_updated_at',
  '_agql_version',
  '_agql_visibility',
]);

function physicalIdentifierValid(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 63
    && !value.includes('\u0000');
}

function operatorIdentifier(value: string): string | undefined {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength < 1 || byteLength > 63 || value.includes('\u0000')) return undefined;
  return `"${value.replace(/"/gu, '""')}"`;
}

function versionAtLeast(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MINIMUM_PGVECTOR.length; index += 1) {
    const component = actual[index] ?? 0;
    const minimum = MINIMUM_PGVECTOR[index] ?? 0;
    if (component > minimum) return true;
    if (component < minimum) return false;
  }
  return true;
}

function collationFor(
  field: ResolvedFieldBinding,
  config: PostgresProvisionerConfig,
): PostgresCollationBinding | undefined {
  if (field.type.kind === 'text') {
    const logicalCollation = field.type.collation;
    return config.collations.find((candidate) =>
      candidate.id === logicalCollation.id
      && candidate.version === logicalCollation.version);
  }
  if (field.type.kind === 'id' || field.type.kind === 'enum') return config.codeCollation;
  return undefined;
}

function fieldTypeSql(
  field: ResolvedFieldBinding,
  config: PostgresProvisionerConfig,
): string | undefined {
  let type: string;
  if (field.type.kind === 'boolean') type = 'boolean';
  else if (field.type.kind === 'integer') type = 'bigint';
  else if (field.type.kind === 'decimal') type = 'numeric';
  else if (field.type.kind === 'money') type = 'jsonb';
  else if (field.type.kind === 'date') type = 'date';
  else if (field.type.kind === 'instant') {
    if (field.type.precision === 'nanosecond') return undefined;
    type = 'timestamptz';
  } else type = 'text';
  const collation = collationFor(field, config);
  if ((field.type.kind === 'text' || field.type.kind === 'id' || field.type.kind === 'enum')
    && collation === undefined) return undefined;
  return type + (collation === undefined ? '' : ` COLLATE ${quoteCollation(collation)}`);
}

function fieldDefinition(
  field: ResolvedFieldBinding,
  config: PostgresProvisionerConfig,
): string | undefined {
  const type = fieldTypeSql(field, config);
  if (type === undefined) return undefined;
  const column = quoteIdentifier(field.physical);
  const nullability = field.nullable ? '' : ' NOT NULL';
  const checks: string[] = [];
  if (field.type.kind === 'text') checks.push(`${column} IS NFC NORMALIZED`);
  if (field.type.kind === 'enum') {
    const codes = field.type.codes.map((code) => `'${code.replace(/'/gu, "''")}'`);
    checks.push(`${column} = ANY (ARRAY[${codes.join(', ')}]::text[])`);
  }
  if (field.type.kind === 'null') checks.push(`${column} IS NULL`);
  const check = checks.length === 0 ? '' : ` CHECK (${checks.join(' AND ')})`;
  return `${column} ${type}${nullability}${check}`;
}

function generatedIndexName(
  prefix: string,
  table: CatalogPhysicalIdentifier,
  field: CatalogPhysicalIdentifier,
): CatalogPhysicalIdentifier {
  const digest = createHash('sha256')
    .update(`${table}\u0000${field}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `_agql_${prefix}_${digest}` as CatalogPhysicalIdentifier;
}

function pgvectorOpclass(metric: 'cosine' | 'dot' | 'euclidean'): string {
  if (metric === 'cosine') return 'vector_cosine_ops';
  if (metric === 'dot') return 'vector_ip_ops';
  return 'vector_l2_ops';
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the provisioning result that triggered rollback.
  }
}

async function validateCollation(
  client: PoolClient,
  binding: PostgresCollationBinding,
): Promise<boolean> {
  const physical = binding.schema === undefined
    ? quoteIdentifier(binding.name)
    : quoteQualified(binding.schema, binding.name);
  const result = await client.query<[string | null]>({
    text: 'SELECT pg_collation_actual_version($1::regcollation)',
    values: [physical],
    rowMode: 'array',
  });
  return result.rows[0]?.[0] === binding.databaseVersion;
}

async function createControlTables(
  client: PoolClient,
  config: PostgresProvisionerConfig,
): Promise<void> {
  const namespace = quoteIdentifier(config.namespace);
  await client.query(`CREATE TABLE IF NOT EXISTS ${namespace}."_agql_idempotency" (`
    + 'scope_key text NOT NULL, idempotency_key text NOT NULL, operation_digest text NOT NULL, '
    + 'receipt_id text NOT NULL, PRIMARY KEY (scope_key, idempotency_key))');
  await client.query(`CREATE TABLE IF NOT EXISTS ${namespace}."_agql_receipt_records" (`
    + 'record_ordinal bigint GENERATED ALWAYS AS IDENTITY, receipt_id text NOT NULL, '
    + 'dataset_physical text NOT NULL, record_id text NOT NULL, version bigint NOT NULL, '
    + 'action text NOT NULL CHECK (action IN (\'upsert\', \'delete\', \'embedding\')), '
    + 'PRIMARY KEY (receipt_id, dataset_physical, record_id))');
  await client.query(`CREATE TABLE IF NOT EXISTS ${namespace}."_agql_ingest_results" (`
    + 'receipt_id text PRIMARY KEY, payload jsonb NOT NULL)');
  await client.query(`CREATE TABLE IF NOT EXISTS ${namespace}."_agql_visibility" (`
    + 'dataset_physical text NOT NULL, record_id text NOT NULL, version bigint NOT NULL, '
    + 'state_name text NOT NULL, state text NOT NULL '
    + 'CHECK (state IN (\'accepted\', \'pending\', \'ready\', \'failed\', \'superseded\')), '
    + 'token text, code text, message text, '
    + 'PRIMARY KEY (dataset_physical, record_id, version, state_name))');
}

async function grantControlTables(
  client: PoolClient,
  config: PostgresProvisionerConfig,
  queryRole: string,
  writerRole: string,
): Promise<void> {
  const namespace = quoteIdentifier(config.namespace);
  const tables = [
    '_agql_idempotency',
    '_agql_receipt_records',
    '_agql_ingest_results',
    '_agql_visibility',
  ]
    .map((name) => `${namespace}."${name}"`).join(', ');
  await client.query(`REVOKE ALL ON ${tables} FROM PUBLIC`);
  await client.query(`GRANT SELECT ON ${tables} TO ${queryRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO ${writerRole}`);
  await client.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${namespace} TO ${writerRole}`,
  );
}

async function createDataset(
  client: PoolClient,
  config: PostgresProvisionerConfig,
  schema: PostgresDatasetSchema,
  queryRole: string,
  writerRole: string,
): Promise<boolean> {
  const dataset = schema.binding;
  const storageNames = [
    ...dataset.fields.map((field) => field.physical),
    ...dataset.embeddings.map((item) => item.embedding.physical),
  ];
  if (dataset.fields.length === 0 || dataset.idField.nullable
    || !physicalIdentifierValid(dataset.dataset.physical)
    || RESERVED_PHYSICAL.has(dataset.dataset.physical)
    || !dataset.fields.some((field) => field.physical === dataset.idField.physical)
    || new Set(storageNames).size !== storageNames.length
    || storageNames.some((name) =>
      !physicalIdentifierValid(name) || RESERVED_PHYSICAL.has(name))
    || dataset.embeddings.some((item) =>
      item.embedding.vectorEncoding !== 'float32'
      || !physicalIdentifierValid(item.annIndex))) {
    return false;
  }
  const fields: string[] = [];
  for (const field of dataset.fields) {
    const definition = fieldDefinition(field, config);
    if (definition === undefined) return false;
    fields.push(definition);
  }
  for (const embedding of dataset.embeddings) {
    fields.push(`${quoteIdentifier(embedding.embedding.physical)} `
      + `vector(${embedding.embedding.dimension})`);
  }
  fields.push(
    '"_agql_version" bigint NOT NULL CHECK ("_agql_version" > 0)',
    '"_agql_scope_fingerprint" text NOT NULL',
    '"_agql_updated_at" timestamptz NOT NULL',
    `PRIMARY KEY (${quoteIdentifier(dataset.idField.physical)})`,
  );
  const table = quoteQualified(config.namespace, dataset.dataset.physical);
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (${fields.join(', ')})`);
  for (const physical of dataset.lexicalFields) {
    const field = dataset.fields.find((candidate) => candidate.physical === physical);
    if (field?.type.kind !== 'text') return false;
    const index = quoteIdentifier(
      generatedIndexName('fts', dataset.dataset.physical, physical),
    );
    await client.query(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} USING gin (`
      + `to_tsvector('simple'::regconfig, ${quoteIdentifier(physical)}))`);
  }
  for (const embedding of dataset.embeddings) {
    const index = quoteIdentifier(embedding.annIndex);
    await client.query(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} USING hnsw (`
      + `${quoteIdentifier(embedding.embedding.physical)} `
      + `${pgvectorOpclass(embedding.embedding.metric)})`);
  }
  await client.query(`REVOKE ALL ON ${table} FROM PUBLIC`);
  await client.query(`GRANT SELECT ON ${table} TO ${queryRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${writerRole}`);
  return true;
}

export class PostgresProvisioner {
  readonly #config: PostgresProvisionerConfig;

  public constructor(config: PostgresProvisionerConfig) {
    this.#config = config;
  }

  public async provision(schema: PostgresDatasetSchema): Promise<ProvisioningOutcome> {
    const provisionerRole = operatorIdentifier(this.#config.provisionerRole);
    const queryRole = operatorIdentifier(this.#config.queryRole);
    const writerRole = operatorIdentifier(this.#config.writerRole);
    if (provisionerRole === undefined || queryRole === undefined || writerRole === undefined
      || new Set([provisionerRole, queryRole, writerRole]).size !== 3) {
      return {
        kind: 'refusal',
        code: 'ROLE_SEPARATION_REQUIRED',
        message: 'Provisioner, query, and writer roles must be distinct PostgreSQL roles.',
        remedy: 'Configure three distinct operator-owned role names.',
      };
    }
    if (!physicalIdentifierValid(this.#config.namespace)) {
      return {
        kind: 'refusal',
        code: 'INVALID_SCHEMA',
        message: 'The runtime namespace is not a PostgreSQL physical identifier.',
        remedy: 'Mint a nonempty runtime identifier of at most 63 UTF-8 bytes.',
      };
    }
    const client = await this.#config.pool.connect();
    try {
      const role = await client.query<[string]>({
        text: 'SELECT current_user::text',
        rowMode: 'array',
      });
      if (role.rows[0]?.[0] !== this.#config.provisionerRole) {
        return {
          kind: 'refusal',
          code: 'ROLE_SEPARATION_REQUIRED',
          message: 'Provisioning is not running as the configured third PostgreSQL role.',
          remedy: 'Connect the provisioner pool as the configured provisioner role.',
        };
      }
      const available = await client.query<[string | null]>({
        text: 'SELECT default_version FROM pg_available_extensions WHERE name = $1::text',
        values: ['vector'],
        rowMode: 'array',
      });
      const availableVersion = available.rows[0]?.[0];
      if (availableVersion === null || availableVersion === undefined
        || !versionAtLeast(availableVersion)) {
        return {
          kind: 'refusal',
          code: 'PGVECTOR_UNAVAILABLE',
          message: 'pgvector 0.8.0 or newer is not available to the provisioner.',
          remedy: 'Install pgvector 0.8.0 or newer before provisioning this adapter.',
        };
      }
      await client.query('BEGIN');
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const installed = await client.query<[string]>({
        text: 'SELECT extversion FROM pg_extension WHERE extname = $1::text',
        values: ['vector'],
        rowMode: 'array',
      });
      const installedVersion = installed.rows[0]?.[0];
      if (installedVersion === undefined || !versionAtLeast(installedVersion)) {
        await rollback(client);
        return {
          kind: 'refusal',
          code: 'PGVECTOR_UNAVAILABLE',
          message: 'The installed pgvector extension is older than 0.8.0.',
          remedy: 'Upgrade pgvector before provisioning this adapter.',
        };
      }
      for (const collation of [this.#config.codeCollation, ...this.#config.collations]) {
        if (!await validateCollation(client, collation)) {
          await rollback(client);
          return {
            kind: 'refusal',
            code: 'INVALID_SCHEMA',
            message: 'A physical collation does not match its pinned database version.',
            remedy: 'Bind the logical collation to an installed collation at the declared version.',
          };
        }
      }
      const namespace = quoteIdentifier(this.#config.namespace);
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${namespace} AUTHORIZATION ${provisionerRole}`,
      );
      await client.query(`REVOKE ALL ON SCHEMA ${namespace} FROM PUBLIC`);
      await client.query(`REVOKE CREATE ON SCHEMA ${namespace} FROM ${queryRole}, ${writerRole}`);
      await client.query(`GRANT USAGE ON SCHEMA ${namespace} TO ${queryRole}, ${writerRole}`);
      await createControlTables(client, this.#config);
      await grantControlTables(client, this.#config, queryRole, writerRole);
      if (!await createDataset(client, this.#config, schema, queryRole, writerRole)) {
        await rollback(client);
        return {
          kind: 'refusal',
          code: 'INVALID_SCHEMA',
          message: 'The validated logical schema cannot be represented exactly by this adapter.',
          remedy: 'Use unique fields, float32 embeddings, and at most microsecond instants.',
        };
      }
      await client.query('COMMIT');
      return { kind: 'success' };
    } catch {
      await rollback(client);
      return {
        kind: 'refusal',
        code: 'PROVISIONING_FAILED',
        message: 'PostgreSQL did not complete the isolated provisioning transaction.',
        remedy: 'Inspect private operator diagnostics and retry with a new physical binding.',
      };
    } finally {
      client.release();
    }
  }
}
