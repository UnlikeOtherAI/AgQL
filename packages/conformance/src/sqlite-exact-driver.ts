import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SQLITE_PROFILES,
  createSqliteAdapter,
} from '@agql/adapter-sqlite';
import type { EngineQueryAdapter, EngineError } from '@agql/engine';
import { executeQuery } from '@agql/engine';
import type { AdapterExecutionResult, AdapterOutcome, TypedValue } from '@agql/contracts';
import {
  QUERY_LIMITS,
  SafeIntegerSchema,
  canonicalizeJcs,
} from '@agql/schemas';
import type { CatalogDocument, DatasetDocument, JsonValue } from '@agql/schemas';

import { mapExactRuntimeInput, mapExactStorageCatalog } from './exact-catalog.ts';
import type {
  ExactAdapterDriver,
  ExactAdapterRun,
  ExactQueryObservation,
  NamedExactQuery,
} from './exact-driver.ts';
import type { ExactFixture } from './exact-fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  jsonArray,
  jsonObject,
  numberMember,
  optionalObject,
} from './json-shape.ts';

type SqliteInput = null | number | bigint | string | Uint8Array;
type SqliteAdapter = ReturnType<typeof createSqliteAdapter>;
type SqliteQueryCompiled = Parameters<SqliteAdapter['query']['execute']>[0];

const ADAPTER_ID = 'sqlite-conformance';
const ADAPTER_VERSION = '0.1';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlType(field: DatasetDocument['fields'][string]): 'INTEGER' | 'TEXT' {
  return field.kind === 'boolean' || field.kind === 'integer' ? 'INTEGER' : 'TEXT';
}

function vectorBytes(values: readonly JsonValue[], encoding: string): Uint8Array {
  if (encoding !== 'float32') {
    throw new TypeError(`The checked-in exact retrieval corpus requires float32, not ${encoding}.`);
  }
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Derived vector member ${index} must be a finite number.`);
    }
    view.setFloat32(index * 4, value, true);
  }
  return bytes;
}

function scalarForStorage(
  value: JsonValue,
  field: DatasetDocument['fields'][string],
): SqliteInput {
  if (value === null) return null;
  switch (field.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError('Boolean seed value has wrong type.');
      return value ? 1 : 0;
    case 'integer':
      if (typeof value !== 'number') throw new TypeError('Integer seed value has wrong type.');
      return value;
    case 'money':
      return canonicalizeJcs(value);
    case 'id':
    case 'decimal':
    case 'text':
    case 'enum':
    case 'date':
    case 'instant':
      if (typeof value !== 'string') {
        throw new TypeError(`${field.kind} seed value has wrong type.`);
      }
      return value;
    case 'null':
      throw new TypeError('A null-typed field cannot contain a non-null seed value.');
  }
}

function seedRecord(item: JsonValue): {
  readonly datasetId?: string;
  readonly record: JsonObject;
  readonly derived?: JsonObject;
} {
  const object = jsonObject(item, '/seed/*');
  const nested = optionalObject(object, 'record', '/seed/*');
  if (nested !== undefined) {
    const dataset = object.dataset;
    if (dataset !== undefined && typeof dataset !== 'string') {
      throw new TypeError('/seed/*/dataset must be a string.');
    }
    return {
      ...(dataset === undefined ? {} : { datasetId: dataset }),
      record: nested,
      ...(object.derived === undefined
        ? {}
        : { derived: jsonObject(object.derived, '/seed/*/derived') }),
    };
  }
  return { record: object };
}

function datasetForRecord(
  catalog: CatalogDocument,
  explicit: string | undefined,
): readonly [string, DatasetDocument] {
  if (explicit !== undefined) {
    const dataset = catalog.datasets[explicit];
    if (dataset === undefined) throw new TypeError(`Seed names unavailable dataset ${explicit}.`);
    return [explicit, dataset];
  }
  const datasets = Object.entries(catalog.datasets);
  const only = datasets[0];
  if (only === undefined || datasets.length !== 1) {
    throw new TypeError('A multi-dataset fixture seed must name its dataset.');
  }
  return only;
}

function localFieldName(datasetId: string, fieldId: string): string {
  const prefix = `${datasetId}.`;
  if (!fieldId.startsWith(prefix)) {
    throw new TypeError(`Field ${fieldId} is not namespaced by dataset ${datasetId}.`);
  }
  return fieldId.slice(prefix.length);
}

function createSchema(database: DatabaseSync, catalog: CatalogDocument): void {
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    const fields = Object.entries(dataset.fields).map(([fieldId, field]) =>
      `${quoteIdentifier(fieldId)} ${sqlType(field)}${field.nullable ? '' : ' NOT NULL'}`);
    const embeddings = Object.keys(dataset.embeddings).map((name) =>
      `${quoteIdentifier(`__embedding_${name}`)} BLOB`);
    database.exec(`CREATE TABLE ${quoteIdentifier(datasetId)} (`
      + [...fields, ...embeddings, '__agql_version INTEGER NOT NULL',
        '__agql_deleted INTEGER NOT NULL'].join(', ')
      + ') STRICT');
  }
}

function insertSeed(
  database: DatabaseSync,
  catalog: CatalogDocument,
  seed: readonly JsonValue[],
): void {
  for (const item of seed) {
    const parsed = seedRecord(item);
    const [datasetId, dataset] = datasetForRecord(catalog, parsed.datasetId);
    const fieldEntries = Object.entries(dataset.fields);
    const embeddingEntries = Object.entries(dataset.embeddings);
    const columns = [
      ...fieldEntries.map(([fieldId]) => fieldId),
      ...embeddingEntries.map(([name]) => `__embedding_${name}`),
      '__agql_version',
      '__agql_deleted',
    ];
    const parameters: SqliteInput[] = [];
    for (const [fieldId, field] of fieldEntries) {
      const localName = localFieldName(datasetId, fieldId);
      const value = parsed.record[localName];
      if (value === undefined) {
        if (!field.nullable) throw new TypeError(`Seed record omits ${fieldId}.`);
        parameters.push(null);
      } else {
        parameters.push(scalarForStorage(value, field));
      }
    }
    for (const [, specReference] of embeddingEntries) {
      const derived = parsed.derived?.[`embedding:${specReference}`];
      if (derived === undefined) {
        parameters.push(null);
      } else {
        const spec = catalog.embeddingSpecs[specReference];
        if (spec === undefined) throw new TypeError(`Missing EmbeddingSpec ${specReference}.`);
        parameters.push(vectorBytes(
          jsonArray(derived, `/seed/*/derived/embedding:${specReference}`),
          spec.vectorEncoding,
        ));
      }
    }
    parameters.push(1, 0);
    const placeholders = columns.map(() => '?').join(', ');
    database.prepare(`INSERT INTO ${quoteIdentifier(datasetId)} (`
      + `${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`).run(...parameters);
  }
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

function typedJson(value: TypedValue): JsonValue {
  if (value.kind === 'money') {
    return { amount: value.value.amount, currency: value.value.currency };
  }
  return value.value;
}

function semanticProjection(
  execution: AdapterExecutionResult,
  plan: Awaited<ReturnType<typeof executeQuery<SqliteQueryCompiled>>> & { readonly ok: true },
): JsonValue {
  const logicalPlan = plan.value.compiled.plan;
  const bindings = logicalPlan.mode === 'aggregate'
    ? [...logicalPlan.dimensions.map(({ output }) => output),
        ...logicalPlan.metrics.map(({ output }) => output)]
    : logicalPlan.projection.map(({ output }) => output);
  const rows = execution.rows.map((row, rowIndex) => {
    const released: Record<string, JsonValue> = {};
    for (const binding of bindings) {
      const value = row[binding.slot];
      if (value === undefined) {
        throw new TypeError(`Adapter row ${rowIndex} omitted slot ${binding.slot}.`);
      }
      released[binding.logicalId] = typedJson(value);
    }
    if (logicalPlan.mode === 'retrieve') {
      const rank = execution.ranks?.[rowIndex];
      if (rank === undefined) throw new TypeError(`Retrieval row ${rowIndex} omitted rank.`);
      released.rank = rank;
    }
    return released;
  });
  return logicalPlan.mode === 'aggregate' ? { groups: rows } : { rows };
}

function exactLimit(fixture: ExactFixture): number {
  const binding = optionalObject(fixture.value, 'binding', fixture.sourcePath);
  if (binding?.exactEligibleSetMaximum === undefined) return 100_000;
  return numberMember(binding, 'exactEligibleSetMaximum', '/binding');
}

async function executeOnce(
  fixture: ExactFixture,
  query: JsonValue,
  databasePath: string,
): Promise<ExactQueryObservation> {
  const adapter = createSqliteAdapter({
    databasePath,
    exactScanAdmissionLimit: SafeIntegerSchema.parse(exactLimit(fixture)),
    supportedTextCollations: [{ id: 'unicode-codepoint-v0', version: '0' }],
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
  });
  const runtime = mapExactRuntimeInput(fixture, ADAPTER_ID, ADAPTER_VERSION);
  let backendCalls = 0;
  const visibility = adapter.visibility;
  const counted: EngineQueryAdapter<SqliteQueryCompiled> = {
    descriptor: {
      ...adapter.descriptor,
      profiles: ['records.v0', 'aggregate.v0', 'retrieve.semantic.v0'],
    },
    query: {
      compile(plan) {
        backendCalls += 1;
        if (plan.profile === 'retrieve.hybrid.v0') {
          const refused: AdapterOutcome<SqliteQueryCompiled> = {
            kind: 'refusal',
            refusal: {
              code: 'UNSUPPORTED_PROFILE',
              message: 'SQLite exact conformance does not implement hybrid retrieval.',
              path: '/mode',
              alternatives: ['Use an adapter advertising retrieve.hybrid.v0.'],
              remedy: 'Select another conformance adapter.',
            },
          };
          return Promise.resolve(refused);
        }
        return adapter.query.compile(plan);
      },
      execute(compiled) {
        backendCalls += 1;
        return adapter.query.execute(compiled);
      },
    },
    ...(visibility === undefined ? {} : { visibility }),
  };
  try {
    const result = await executeQuery({
      query,
      catalog: runtime.catalog,
      scope: runtime.scope,
      anchor: runtime.anchor,
      channel: 'principal',
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
      calendar: { timezone: 'UTC', weekStartsOn: 'monday' },
      binding: runtime.binding,
      adapter: counted.descriptor,
      costGate: {
        estimate: {
          estimatedRows: runtime.scope.budgets.maximumExactScanRecords,
          estimatedCandidateRecords: runtime.scope.budgets.maximumCandidateRecords,
          estimatedIntermediateBytes: SafeIntegerSchema.parse(1_000_000),
          selectiveFilterFields: [],
        },
        maximumEstimatedRows: SafeIntegerSchema.parse(1_000_000),
        maximumIntermediateBytes: SafeIntegerSchema.parse(10_000_000),
      },
      qualityCertifications: runtime.qualityCertifications,
      ...(runtime.vector === undefined ? {} : { vector: runtime.vector }),
    }, counted);
    if (!result.ok) {
      return { kind: 'refusal', errors: result.errors.map(errorJson), backendCalls };
    }
    const semantic = semanticProjection(result.value.execution, result);
    return {
      kind: 'success',
      semantic,
      sourceQueryHash: result.value.compiled.plan.sourceQueryHash,
      determinism: 'retrieval' in result.value.compiled.explain.determinism
        ? 'approximate'
        : 'exact',
      repeatedSemanticEqual: true,
      backendCalls,
    };
  } catch (error) {
    return {
      kind: 'exception',
      message: error instanceof Error ? error.message : String(error),
      backendCalls,
    };
  }
}

function observationBytes(observation: ExactQueryObservation): string | undefined {
  return observation.kind === 'success' ? canonicalizeJcs(observation.semantic) : undefined;
}

async function executeRepeated(
  fixture: ExactFixture,
  query: JsonValue,
  databasePath: string,
): Promise<ExactQueryObservation> {
  const first = await executeOnce(fixture, query, databasePath);
  if (first.kind !== 'success') return first;
  const second = await executeOnce(fixture, query, databasePath);
  if (second.kind !== 'success') {
    return {
      kind: 'exception',
      message: `repeat changed outcome from success to ${second.kind}`,
      backendCalls: first.backendCalls + second.backendCalls,
    };
  }
  return {
    ...first,
    repeatedSemanticEqual: observationBytes(first) === observationBytes(second),
    backendCalls: first.backendCalls + second.backendCalls,
  };
}

export function createSqliteExactDriver(): ExactAdapterDriver {
  return {
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    profiles: SQLITE_PROFILES,
    async run(
      fixture: ExactFixture,
      queries: readonly NamedExactQuery[],
    ): Promise<ExactAdapterRun> {
      const profileAdvertised = SQLITE_PROFILES.some((profile) =>
        profile === fixture.requiresProfile);
      if (!profileAdvertised) {
        return {
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          profileAdvertised,
          observations: Object.fromEntries(queries.map(({ name }) => [name, {
            kind: 'declined' as const,
            reason: `adapter does not advertise ${fixture.requiresProfile}`,
            backendCalls: 0 as const,
          }])),
        };
      }
      const directory = await mkdtemp(path.join(tmpdir(), 'agql-exact-'));
      const databasePath = path.join(directory, 'fixture.sqlite');
      try {
        const storageCatalog = mapExactStorageCatalog(fixture);
        const database = new DatabaseSync(databasePath);
        try {
          createSchema(database, storageCatalog);
          insertSeed(database, storageCatalog,
            arrayMember(fixture.value, 'seed', fixture.sourcePath));
        } finally {
          database.close();
        }
        const observations: Record<string, ExactQueryObservation> = {};
        for (const query of queries) {
          observations[query.name] = await executeRepeated(fixture, query.query, databasePath);
        }
        return {
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          profileAdvertised,
          observations,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          profileAdvertised,
          observations: Object.fromEntries(queries.map(({ name }) => [name, {
            kind: 'exception' as const,
            message,
            backendCalls: 0,
          }])),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
