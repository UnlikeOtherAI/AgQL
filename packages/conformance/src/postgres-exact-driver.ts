import { randomBytes } from 'node:crypto';

import {
  POSTGRES_PROFILES,
  PostgresProvisioner,
  createPostgresAdapter,
} from '@agql/adapter-postgres';
import type {
  PostgresAdapterConfig,
  PostgresCollationBinding,
  PostgresDatasetBinding,
  PostgresProvisionerConfig,
} from '@agql/adapter-postgres';
import type {
  EngineQueryAdapter,
  EngineError,
} from '@agql/engine';
import { executeQuery, resolvedValueType } from '@agql/engine';
/* eslint-disable max-len */

import type {
  AdapterExecutionResult,
  AdapterResultValue,
  CatalogPhysicalIdentifier,
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
} from '@agql/contracts';
import {
  QUERY_LIMITS,
  SafeIntegerSchema,
  canonicalizeJcs,
} from '@agql/schemas';
import type { CatalogDocument, DatasetDocument, JsonValue } from '@agql/schemas';
import { Pool } from 'pg';

import { mapExactRuntimeInput, mapExactStorageCatalog } from './exact-catalog.ts';
import type {
  ExactAdapterDriver,
  ExactAdapterRun,
  ExactQueryObservation,
} from './exact-driver.ts';
import type { ExactFixture } from './exact-fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  jsonArray,
  jsonObject,
  optionalObject,
} from './json-shape.ts';

type PostgresAdapter = ReturnType<typeof createPostgresAdapter>;
type PostgresQueryCompiled = Parameters<PostgresAdapter['query']['execute']>[0];
type SeedValue = null | boolean | number | string;

const ADAPTER_ID = 'postgres-pgvector';
const ADAPTER_VERSION = '0.0.0';
const DEPLOYMENT_COMMAND = 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/agql pnpm conformance --suite exact --adapter postgres';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleSql(value: string): string {
  if (!/^[a-z][a-z0-9_]+$/u.test(value)) throw new TypeError('Invalid generated PostgreSQL role.');
  return quoteIdentifier(value);
}

function errorJson(error: EngineError): JsonValue {
  return {
    code: error.code,
    message: error.message,
    path: error.path,
    alternatives: [...error.alternatives],
    remedy: error.remedy ?? null,
  };
}

function typedJson(value: AdapterResultValue): JsonValue {
  if (value.kind === 'money') return { amount: value.value.amount, currency: value.value.currency };
  if (value.kind === 'calendarPeriod') {
    return {
      start: value.value.start,
      endExclusive: value.value.endExclusive,
      timezone: value.value.timezone,
      grain: value.value.grain,
      label: value.value.label,
    };
  }
  return value.value;
}

function requestedPageSize(fixture: ExactFixture): number | undefined {
  const execution = optionalObject(fixture.value, 'execution', fixture.sourcePath);
  if (execution === undefined) return undefined;
  const pageSize = execution.pageSize;
  if (pageSize === undefined) return undefined;
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError('/execution/pageSize must be a positive safe integer.');
  }
  return pageSize;
}

function semanticProjection(
  fixture: ExactFixture,
  execution: AdapterExecutionResult,
  plan: Awaited<ReturnType<typeof executeQuery<PostgresQueryCompiled>>> & { readonly ok: true },
): JsonValue {
  const logicalPlan = plan.value.compiled.plan;
  const bindings = logicalPlan.mode === 'aggregate'
    ? [...logicalPlan.dimensions.map(({ output }) => output), ...logicalPlan.metrics.map(({ output }) => output)]
    : logicalPlan.projection.map(({ output }) => output);
  const rows = execution.rows.map((row, rowIndex) => {
    const released: Record<string, JsonValue> = {};
    for (const binding of bindings) {
      const value = row[binding.slot];
      if (value === undefined) throw new TypeError(`Adapter row ${rowIndex} omitted slot ${binding.slot}.`);
      released[binding.logicalId] = typedJson(value);
    }
    if (logicalPlan.mode === 'retrieve') {
      const rank = execution.ranks?.[rowIndex];
      if (rank === undefined) throw new TypeError(`Retrieval row ${rowIndex} omitted rank.`);
      released.rank = rank;
    }
    return released;
  });
  if (logicalPlan.mode === 'aggregate') return { groups: rows };
  const pageSize = requestedPageSize(fixture);
  if (pageSize === undefined) return { rows };
  const concatenatedRows: JsonValue[] = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    concatenatedRows.push(...rows.slice(offset, offset + pageSize));
  }
  return { concatenatedRows };
}

function exactLimit(fixture: ExactFixture): number {
  const binding = optionalObject(fixture.value, 'binding', fixture.sourcePath);
  const value = binding?.exactEligibleSetMaximum;
  if (value === undefined) return 100_000;
  if (typeof value !== 'number') throw new TypeError('/binding/exactEligibleSetMaximum must be a number.');
  return value;
}

function fieldType(field: DatasetDocument['fields'][string]): ResolvedFieldBinding['type'] {
  return resolvedValueType(field);
}

function datasetBindings(catalog: CatalogDocument): readonly PostgresDatasetBinding[] {
  return Object.entries(catalog.datasets).map(([datasetId, dataset]) => {
    const fields: ResolvedFieldBinding[] = Object.entries(dataset.fields).map(([logicalId, field]) => ({
      logicalId,
      physical: physical(logicalId),
      type: fieldType(field),
      nullable: field.nullable,
    }));
    const idField = fields.find((field) => field.logicalId === dataset.idField);
    if (idField === undefined) throw new TypeError(`Dataset ${datasetId} id field is absent.`);
    const embeddings = Object.entries(dataset.embeddings).map(([name, specReference]) => {
      const spec = catalog.embeddingSpecs[specReference];
      if (spec === undefined) throw new TypeError(`EmbeddingSpec ${specReference} is absent.`);
      const embedding: ResolvedEmbeddingBinding = {
        name,
        specReference,
        specVersion: spec.version,
        physical: physical(`__embedding_${name}`),
        dimension: spec.dimension,
        metric: spec.metric,
        vectorEncoding: spec.vectorEncoding,
        model: spec.model,
        inputTransformId: spec.inputTransformId,
        privacyClass: spec.privacyClass,
      };
      return {
        embedding,
        visibilityName: `embedding:${specReference}`,
        annIndex: physical(`ann_${datasetId}_${name}`),
      };
    });
    return {
      dataset: { logicalId: datasetId, physical: physical(datasetId), bindingVersion: `binding:${catalog.catalogVersion}` },
      idField,
      fields,
      lexicalFields: fields.filter(({ type }) => type.kind === 'text').map(({ physical: name }) => name),
      embeddings,
    };
  });
}

function seedRecord(value: JsonValue): { readonly datasetId?: string; readonly record: JsonObject; readonly derived?: JsonObject } {
  const object = jsonObject(value, '/seed/*');
  const nested = optionalObject(object, 'record', '/seed/*');
  if (nested === undefined) return { record: object };
  const dataset = object.dataset;
  if (dataset !== undefined && typeof dataset !== 'string') throw new TypeError('/seed/*/dataset must be a string.');
  return {
    ...(dataset === undefined ? {} : { datasetId: dataset }),
    record: nested,
    ...(object.derived === undefined ? {} : { derived: jsonObject(object.derived, '/seed/*/derived') }),
  };
}

function scalar(value: JsonValue, field: DatasetDocument['fields'][string]): SeedValue {
  if (value === null) return null;
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError('Boolean seed value has wrong type.');
    return value;
  }
  if (field.kind === 'integer') {
    if (typeof value !== 'number') throw new TypeError('Integer seed value has wrong type.');
    return value;
  }
  if (field.kind === 'money') {
    return canonicalizeJcs(jsonObject(value, '/seed/*/money'));
  }
  if (field.kind === 'null') throw new TypeError('A null-typed field cannot contain a non-null seed value.');
  if (typeof value !== 'string') throw new TypeError(`${field.kind} seed value has wrong type.`);
  return field.kind === 'text' ? value.normalize('NFC') : value;
}

function vector(value: JsonValue): string {
  const values = jsonArray(value, '/seed/*/derived');
  return `[${values.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new TypeError(`Vector ${index} is invalid.`);
    return String(item);
  }).join(',')}]`;
}

async function seed(
  pool: Pool,
  namespace: CatalogPhysicalIdentifier,
  catalog: CatalogDocument,
  bindings: readonly PostgresDatasetBinding[],
  source: readonly JsonValue[],
): Promise<void> {
  for (const item of source) {
    const parsed = seedRecord(item);
    const available = parsed.datasetId === undefined
      ? Object.entries(catalog.datasets)
      : [[parsed.datasetId, catalog.datasets[parsed.datasetId]] as const];
    const entry = available.length === 1 ? available[0] : undefined;
    if (entry?.[1] === undefined) throw new TypeError('Seed must identify exactly one dataset.');
    const [datasetId, dataset] = entry;
    const binding = bindings.find(({ dataset: candidate }) => candidate.logicalId === datasetId);
    if (binding === undefined) throw new TypeError(`Dataset binding ${datasetId} is absent.`);
    const columns = [...Object.keys(dataset.fields), ...binding.embeddings.map(({ embedding }) => embedding.physical), '_agql_version', '_agql_scope_fingerprint', '_agql_updated_at'];
    const values: SeedValue[] = [];
    for (const [fieldId, field] of Object.entries(dataset.fields)) {
      const local = fieldId.startsWith(`${datasetId}.`) ? fieldId.slice(datasetId.length + 1) : fieldId;
      const raw = parsed.record[local];
      if (raw === undefined) {
        if (!field.nullable) throw new TypeError(`Seed record omits ${fieldId}.`);
        values.push(null);
      } else values.push(scalar(raw, field));
    }
    for (const { embedding } of binding.embeddings) {
      const raw = parsed.derived?.[`embedding:${embedding.specReference}`];
      values.push(raw === undefined ? null : vector(raw));
    }
    values.push(1, 'conformance-seed', new Date(0).toISOString());
    const vectorStart = Object.keys(dataset.fields).length;
    const placeholders = columns.map((_column, index) => index >= vectorStart && index < vectorStart + binding.embeddings.length
      ? `$${index + 1}::vector` : `$${index + 1}`);
    await pool.query({
      text: `INSERT INTO ${quoteIdentifier(namespace)}.${quoteIdentifier(binding.dataset.physical)} `
        + `(${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
      values,
    });
  }
}

async function executeOnce(fixture: ExactFixture, query: JsonValue, adapter: PostgresAdapter): Promise<ExactQueryObservation> {
  const runtime = mapExactRuntimeInput(fixture, ADAPTER_ID, ADAPTER_VERSION);
  let backendCalls = 0;
  const counted: EngineQueryAdapter<PostgresQueryCompiled> = {
    descriptor: {
      ...adapter.descriptor,
      profiles: ['records.v0', 'aggregate.v0', 'retrieve.semantic.v0', 'retrieve.hybrid.v0'],
    },
    query: {
      compile(plan) { backendCalls += 1; return adapter.query.compile(plan); },
      execute(compiled) { backendCalls += 1; return adapter.query.execute(compiled); },
    },
    ...(adapter.visibility === undefined ? {} : { visibility: adapter.visibility }),
  };
  try {
    const result = await executeQuery({
      query, catalog: runtime.catalog, scope: runtime.scope, anchor: runtime.anchor, channel: 'principal',
      limits: {
        booleanNesting: SafeIntegerSchema.parse(QUERY_LIMITS.booleanNesting),
        inList: SafeIntegerSchema.parse(QUERY_LIMITS.inList),
        predicateNodes: SafeIntegerSchema.parse(QUERY_LIMITS.predicateNodes),
        select: SafeIntegerSchema.parse(QUERY_LIMITS.select),
        take: {
          aggregate: SafeIntegerSchema.parse(QUERY_LIMITS.take.aggregate),
          records: SafeIntegerSchema.parse(QUERY_LIMITS.take.records),
          retrieve: SafeIntegerSchema.parse(QUERY_LIMITS.take.retrieve),
        },
      },
      calendar: runtime.calendar,
      binding: runtime.binding, adapter: counted.descriptor,
      costGate: { estimate: { estimatedRows: runtime.scope.budgets.maximumExactScanRecords, estimatedCandidateRecords: runtime.scope.budgets.maximumCandidateRecords, estimatedIntermediateBytes: SafeIntegerSchema.parse(1_000_000), selectiveFilterFields: [] }, maximumEstimatedRows: SafeIntegerSchema.parse(1_000_000), maximumIntermediateBytes: SafeIntegerSchema.parse(10_000_000) },
      qualityCertifications: runtime.qualityCertifications,
      ...(runtime.vector === undefined ? {} : { vector: runtime.vector }),
    }, counted);
    if (!result.ok) return { kind: 'refusal', errors: result.errors.map(errorJson), backendCalls };
    return { kind: 'success', semantic: semanticProjection(fixture, result.value.execution, result), sourceQueryHash: result.value.compiled.plan.sourceQueryHash, determinism: 'retrieval' in result.value.compiled.explain.determinism ? 'approximate' : 'exact', repeatedSemanticEqual: true, backendCalls };
  } catch (error) {
    return { kind: 'exception', message: error instanceof Error ? error.message : String(error), backendCalls };
  }
}

async function repeated(fixture: ExactFixture, query: JsonValue, adapter: PostgresAdapter): Promise<ExactQueryObservation> {
  const first = await executeOnce(fixture, query, adapter);
  if (first.kind !== 'success') return first;
  const second = await executeOnce(fixture, query, adapter);
  if (second.kind !== 'success') return { kind: 'exception', message: `repeat changed outcome from success to ${second.kind}`, backendCalls: first.backendCalls + second.backendCalls };
  return { ...first, repeatedSemanticEqual: canonicalizeJcs(first.semantic) === canonicalizeJcs(second.semantic), backendCalls: first.backendCalls + second.backendCalls };
}

async function provisionFixture(fixture: ExactFixture, databaseUrl: string): Promise<{ readonly adapter: PostgresAdapter; readonly cleanup: () => Promise<void> }> {
  const suffix = randomBytes(6).toString('hex');
  const queryRole = `agql_q_${suffix}`;
  const writerRole = `agql_w_${suffix}`;
  const namespace = physical(`agql_exact_${suffix}`);
  const admin = new Pool({ connectionString: databaseUrl });
  const current = await admin.query<{ readonly name: string }>('SELECT current_user::text AS name');
  const provisionerRole = current.rows[0]?.name;
  if (provisionerRole === undefined) throw new TypeError('PostgreSQL did not identify the provisioner role.');
  await admin.query(`CREATE ROLE ${roleSql(queryRole)} NOLOGIN`);
  await admin.query(`CREATE ROLE ${roleSql(writerRole)} NOLOGIN`);
  const queryPool = new Pool({ connectionString: databaseUrl, options: `-c role=${queryRole}` });
  const writerPool = new Pool({ connectionString: databaseUrl, options: `-c role=${writerRole}` });
  const cleanup = async (): Promise<void> => {
    await queryPool.end(); await writerPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${roleSql(queryRole)}`);
    await admin.query(`DROP ROLE IF EXISTS ${roleSql(writerRole)}`);
    await admin.end();
  };
  try {
    const version = await admin.query<{ readonly version: string | null }>({ text: 'SELECT pg_collation_actual_version($1::regcollation) AS version', values: ['pg_catalog."C"'] });
    const codeCollation: PostgresCollationBinding = { id: 'codepoint', version: '0', databaseVersion: version.rows[0]?.version ?? null, schema: physical('pg_catalog'), name: physical('C') };
    const textCollation: PostgresCollationBinding = { ...codeCollation, id: 'unicode-codepoint-v0' };
    const catalog = mapExactStorageCatalog(fixture);
    const bindings = datasetBindings(catalog);
    for (const binding of bindings) {
      const provisionerConfig: PostgresProvisionerConfig = {
        pool: admin,
        namespace,
        provisionerRole,
        queryRole,
        writerRole,
        codeCollation,
        collations: [textCollation],
      };
      const outcome = await new PostgresProvisioner(provisionerConfig).provision({ binding });
      if (outcome.kind === 'refusal') throw new TypeError(`${outcome.code}: ${outcome.message}`);
    }
    await seed(writerPool, namespace, catalog, bindings,
      arrayMember(fixture.value, 'seed', fixture.sourcePath));
    const adapterConfig: PostgresAdapterConfig = {
      queryPool,
      writerPool,
      namespace,
      queryRole,
      writerRole,
      statementTimeoutMs: SafeIntegerSchema.parse(5_000),
      exactScanAdmissionLimit: SafeIntegerSchema.parse(exactLimit(fixture)),
      tokenSecret: randomBytes(32),
      vectorByteOrder: 'littleEndian',
      codeCollation,
      collations: [textCollation],
      datasets: bindings,
      qualityProfiles: ['baseline-unset-v0', 'exact-oracle-v0'].map((id) => ({
        id,
        certificationReference: `conformance:${id}`,
        efSearch: SafeIntegerSchema.parse(80),
        maxScanTuples: SafeIntegerSchema.parse(5_000),
        maximumBooleanDepth: SafeIntegerSchema.parse(8),
        certifiedPredicates: ['comparison', 'list', 'null', 'substring', 'instantRange'] as const,
      })),
    };
    const adapter = createPostgresAdapter(adapterConfig);
    return { adapter, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function createPostgresExactDriver(databaseUrl = process.env.DATABASE_URL): ExactAdapterDriver {
  return {
    id: ADAPTER_ID, version: ADAPTER_VERSION, profiles: POSTGRES_PROFILES,
    async run(fixture, queries): Promise<ExactAdapterRun> {
      if (databaseUrl === undefined || databaseUrl.length === 0) {
        const reason = `PostgreSQL + pgvector is unavailable. Run: ${DEPLOYMENT_COMMAND}`;
        return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, profileAdvertised: false, observations: Object.fromEntries(queries.map(({ name }) => [name, { kind: 'declined' as const, reason, backendCalls: 0 as const }])) };
      }
      try {
        const runtime = await provisionFixture(fixture, databaseUrl);
        try {
          const observations: Record<string, ExactQueryObservation> = {};
          for (const query of queries) observations[query.name] = await repeated(fixture, query.query, runtime.adapter);
          return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, profileAdvertised: true, observations };
        } finally { await runtime.cleanup(); }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const reason = `PostgreSQL + pgvector deployment cannot run (${detail}). Run: ${DEPLOYMENT_COMMAND}`;
        return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, profileAdvertised: false, observations: Object.fromEntries(queries.map(({ name }) => [name, { kind: 'declined' as const, reason, backendCalls: 0 as const }])) };
      }
    },
  };
}
