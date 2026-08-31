import { createHash } from 'node:crypto';

import {
  PostgresProvisioner,
  createPostgresAdapter,
} from '@agql/adapter-postgres';
import type {
  PostgresAdapter,
  PostgresAdapterConfig,
  PostgresCollationBinding,
  PostgresDatasetBinding,
  PostgresProvisionerConfig,
} from '@agql/adapter-postgres';
import type { CatalogPhysicalIdentifier } from '@agql/contracts';
import { resolvedValueType } from '@agql/engine';
import type { EngineBinding } from '@agql/engine';
import { SafeIntegerSchema } from '@agql/schemas';
import type { CatalogDocument } from '@agql/schemas';
import { Pool } from 'pg';

const QUERY_ROLE = 'agql_query';
const WRITER_ROLE = 'agql_writer';
const DEFAULT_NAMESPACE = 'agql';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generatedPhysical(kind: string, logical: string): CatalogPhysicalIdentifier {
  return physical(`${kind}_${digest(logical).slice(0, 40)}`);
}

function ensureDistinct(values: readonly CatalogPhysicalIdentifier[]): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError('Generated PostgreSQL physical identifiers collided.');
  }
}

function bindingVersion(catalog: CatalogDocument): string {
  return `server-${digest(`${catalog.catalogVersion}\u0000${catalog.policyVersion}`).slice(0, 32)}`;
}

function textCollations(catalog: CatalogDocument): readonly PostgresCollationBinding[] {
  const found = new Map<string, PostgresCollationBinding>();
  for (const dataset of Object.values(catalog.datasets)) {
    for (const field of Object.values(dataset.fields)) {
      if (field.kind !== 'text') continue;
      const key = `${field.collation.id}\u0000${field.collation.version}`;
      if (!found.has(key)) {
        found.set(key, {
          id: field.collation.id,
          version: field.collation.version,
          databaseVersion: null,
          schema: physical('pg_catalog'),
          name: physical('C'),
        });
      }
    }
  }
  return [...found.values()];
}

function datasetBindings(
  catalog: CatalogDocument,
  version: string,
): readonly PostgresDatasetBinding[] {
  const datasets: PostgresDatasetBinding[] = [];
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    const table = generatedPhysical('d', `${version}\u0000${datasetId}`);
    const fields = Object.entries(dataset.fields).map(([fieldId, field]) => ({
      logicalId: fieldId,
      physical: generatedPhysical('f', `${version}\u0000${datasetId}\u0000${fieldId}`),
      type: resolvedValueType(field),
      nullable: field.nullable,
    }));
    const idField = fields.find((field) => field.logicalId === dataset.idField);
    if (idField === undefined) {
      throw new TypeError(`Catalog dataset ${datasetId} does not resolve its id field.`);
    }
    const embeddings = Object.entries(dataset.embeddings).map(([name, reference]) => {
      const spec = catalog.embeddingSpecs[reference];
      if (spec === undefined) {
        throw new TypeError(`Catalog embedding ${reference} is not declared.`);
      }
      return {
        embedding: {
          name,
          specReference: reference,
          specVersion: spec.version,
          physical: generatedPhysical('e', `${version}\u0000${datasetId}\u0000${name}`),
          dimension: spec.dimension,
          metric: spec.metric,
          vectorEncoding: spec.vectorEncoding,
          model: spec.model,
          inputTransformId: spec.inputTransformId,
          privacyClass: spec.privacyClass,
        },
        visibilityName: `embedding:${reference}`,
        annIndex: generatedPhysical('i', `${version}\u0000${datasetId}\u0000${name}`),
      };
    });
    ensureDistinct([
      ...fields.map((field) => field.physical),
      ...embeddings.map((entry) => entry.embedding.physical),
    ]);
    datasets.push({
      dataset: { logicalId: datasetId, physical: table, bindingVersion: version },
      idField,
      fields,
      lexicalFields: fields
        .filter((field) => field.type.kind === 'text')
        .map((field) => field.physical),
      embeddings,
    });
  }
  ensureDistinct(datasets.map((dataset) => dataset.dataset.physical));
  return datasets;
}

function engineBinding(
  catalog: CatalogDocument,
  version: string,
  datasets: readonly PostgresDatasetBinding[],
): EngineBinding {
  const entries = datasets.map((dataset) => {
    const logical = catalog.datasets[dataset.dataset.logicalId];
    if (logical === undefined) {
      throw new TypeError(`A generated binding has no catalog dataset.`);
    }
    return [dataset.dataset.logicalId, {
      physical: dataset.dataset.physical,
      fields: Object.fromEntries(dataset.fields.map((field) => [field.logicalId, field.physical])),
      embeddings: Object.fromEntries(dataset.embeddings.map((entry) => [entry.embedding.name, {
        physical: entry.embedding.physical,
        indexed: true,
      }])),
    }] as const;
  });
  return { version, datasets: Object.fromEntries(entries) };
}

function provisionerRole(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  const username = decodeURIComponent(parsed.username);
  if (username.length === 0) {
    throw new TypeError('DATABASE_URL must explicitly name the PostgreSQL provisioner role.');
  }
  return username;
}

export interface PostgresDeploymentOptions {
  readonly databaseUrl: string;
  readonly tokenSecret: Uint8Array;
  readonly namespace?: CatalogPhysicalIdentifier;
  readonly queryRole?: string;
  readonly writerRole?: string;
  readonly provisionerRole?: string;
}

export interface PostgresDeployment {
  readonly adapter: PostgresAdapter;
  readonly binding: EngineBinding;
  readonly datasets: readonly PostgresDatasetBinding[];
  provision(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Generates only deployment-owned bindings from catalog identifiers. Query-authored names
 * never reach PostgreSQL: the adapter receives the resolved bindings below.
 */
export function createPostgresDeployment(
  catalog: CatalogDocument,
  options: PostgresDeploymentOptions,
): PostgresDeployment {
  const version = bindingVersion(catalog);
  const datasets = datasetBindings(catalog, version);
  const namespace = options.namespace ?? physical(DEFAULT_NAMESPACE);
  const queryRole = options.queryRole ?? QUERY_ROLE;
  const writerRole = options.writerRole ?? WRITER_ROLE;
  const provisioner = options.provisionerRole ?? provisionerRole(options.databaseUrl);
  const codeCollation: PostgresCollationBinding = {
    id: 'agql-codepoint',
    version: 'pg-c-v1',
    databaseVersion: null,
    schema: physical('pg_catalog'),
    name: physical('C'),
  };
  const collations = textCollations(catalog);
  const provisionerPool = new Pool({ connectionString: options.databaseUrl });
  const queryPool = new Pool({
    connectionString: options.databaseUrl,
    options: `-c role=${queryRole}`,
  });
  const writerPool = new Pool({
    connectionString: options.databaseUrl,
    options: `-c role=${writerRole}`,
  });
  const adapterConfig: PostgresAdapterConfig = {
    queryPool,
    writerPool,
    namespace,
    queryRole,
    writerRole,
    statementTimeoutMs: SafeIntegerSchema.parse(5_000),
    exactScanAdmissionLimit: SafeIntegerSchema.parse(10_000),
    tokenSecret: options.tokenSecret.slice(),
    vectorByteOrder: 'littleEndian',
    codeCollation,
    collations,
    datasets,
    qualityProfiles: [],
  };
  const provisionerConfig: PostgresProvisionerConfig = {
    pool: provisionerPool,
    namespace,
    provisionerRole: provisioner,
    queryRole,
    writerRole,
    codeCollation,
    collations,
  };
  return {
    adapter: createPostgresAdapter(adapterConfig),
    binding: engineBinding(catalog, version, datasets),
    datasets,
    async provision(): Promise<void> {
      for (const binding of datasets) {
        const outcome = await new PostgresProvisioner(provisionerConfig).provision({ binding });
        if (outcome.kind === 'refusal') {
          throw new TypeError(`${outcome.code}: ${outcome.message} ${outcome.remedy}`);
        }
      }
    },
    async close(): Promise<void> {
      await Promise.all([provisionerPool.end(), queryPool.end(), writerPool.end()]);
    },
  };
}
