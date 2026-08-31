import { SafeIntegerSchema } from '@agql/schemas';

import { compileEmbeddingMutation, compileCanonicalIngest } from './ingest-compiler.ts';
import { executeEmbeddingMutation } from './embedding-executor.ts';
import { executeCanonicalIngest } from './ingest-executor.ts';
import { compileQuery } from './query-compiler.ts';
import { executeQuery } from './query-executor.ts';
import { RuntimeRegistry } from './registry.ts';
import type { PostgresAdapter, PostgresAdapterConfig } from './types.ts';
import { POSTGRES_PROFILES } from './types.ts';
import { observeVisibility } from './visibility.ts';

const RESERVED_PHYSICAL = new Set([
  '_agql_idempotency',
  '_agql_ingest_results',
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

function validConfig(config: PostgresAdapterConfig): boolean {
  if (config.queryRole.length === 0 || config.writerRole.length === 0
    || config.queryRole === config.writerRole
    || config.tokenSecret.byteLength < 32
    || !SafeIntegerSchema.safeParse(config.statementTimeoutMs).success
    || config.statementTimeoutMs < 1
    || !SafeIntegerSchema.safeParse(config.exactScanAdmissionLimit).success
    || config.exactScanAdmissionLimit < 1
    || !physicalIdentifierValid(config.namespace)) return false;
  const logicalCollations = [config.codeCollation, ...config.collations]
    .map((collation) => `${collation.id}\u0000${collation.version}`);
  if (new Set(logicalCollations).size !== logicalCollations.length
    || [config.codeCollation, ...config.collations].some((collation) =>
      !physicalIdentifierValid(collation.name)
      || (collation.schema !== undefined && !physicalIdentifierValid(collation.schema)))) {
    return false;
  }
  if (new Set(config.datasets.map((dataset) => dataset.dataset.physical)).size
    !== config.datasets.length) return false;
  if (new Set(config.qualityProfiles.map((quality) => quality.id)).size
    !== config.qualityProfiles.length) return false;
  for (const dataset of config.datasets) {
    const storageNames = [
      ...dataset.fields.map((field) => field.physical),
      ...dataset.embeddings.map((item) => item.embedding.physical),
    ];
    if (dataset.idField.type.kind !== 'id' || dataset.idField.nullable
      || !physicalIdentifierValid(dataset.dataset.physical)
      || RESERVED_PHYSICAL.has(dataset.dataset.physical)
      || !dataset.fields.some((field) => field.physical === dataset.idField.physical)
      || new Set(storageNames).size !== storageNames.length
      || storageNames.some((name) =>
        !physicalIdentifierValid(name) || RESERVED_PHYSICAL.has(name))
      || new Set(dataset.embeddings.map((item) => item.visibilityName)).size
        !== dataset.embeddings.length
      || dataset.embeddings.some((item) =>
        item.visibilityName === 'record' || item.visibilityName === 'lexical'
        || !physicalIdentifierValid(item.annIndex))
      || dataset.fields.some((field) =>
        field.type.kind === 'instant' && field.type.precision === 'nanosecond')) return false;
  }
  for (const quality of config.qualityProfiles) {
    if (quality.id.length === 0 || quality.certificationReference.length === 0
      || !SafeIntegerSchema.safeParse(quality.efSearch).success
      || !SafeIntegerSchema.safeParse(quality.maxScanTuples).success
      || !SafeIntegerSchema.safeParse(quality.maximumBooleanDepth).success
      || quality.efSearch < 1 || quality.maxScanTuples < 1
      || quality.maximumBooleanDepth < 0) return false;
  }
  return true;
}

export function createPostgresAdapter(config: PostgresAdapterConfig): PostgresAdapter {
  if (!validConfig(config)) {
    throw new TypeError('The PostgreSQL adapter deployment configuration is invalid.');
  }
  const registry = new RuntimeRegistry(config);
  return {
    descriptor: {
      id: 'postgres-pgvector',
      version: '0.0.0',
      profiles: POSTGRES_PROFILES,
      consistency: {
        afterWrite: 'certified',
        snapshots: ['transaction'],
        compareAndSwap: true,
      },
    },
    query: {
      compile(plan) {
        return Promise.resolve(compileQuery(plan, registry));
      },
      execute(compiled) {
        return executeQuery(compiled, config);
      },
    },
    canonicalIngest: {
      compile(plan) {
        return Promise.resolve(compileCanonicalIngest(plan, registry));
      },
      execute(compiled) {
        return executeCanonicalIngest(compiled, config);
      },
    },
    visibility: {
      observe(observation) {
        return observeVisibility(observation, registry);
      },
    },
    embeddingWrites: {
      compile(mutation) {
        return Promise.resolve(compileEmbeddingMutation(mutation, registry));
      },
      execute(compiled) {
        return executeEmbeddingMutation(compiled, config);
      },
    },
  };
}
