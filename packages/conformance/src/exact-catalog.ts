import { createHash } from 'node:crypto';

import {
  ScopeSchema,
} from '@agql/catalog';
import type { Scope } from '@agql/catalog';
import type {
  CatalogPhysicalIdentifier,
  QueryVectorDigest,
  RuntimeOwnedVector,
} from '@agql/contracts';
import type { EngineBinding, QualityCertification } from '@agql/engine';
import {
  CatalogDocumentSchema,
  CurrencyCodeSchema,
  InstantValueSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import type {
  CatalogDocument,
  DatasetDocument,
  EmbeddingSpecDocument,
  FieldDocument,
  FieldPolicy,
  InstantValue,
  JsonValue,
} from '@agql/schemas';

import type { ExactFixture } from './exact-fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  booleanMember,
  jsonArray,
  jsonObject,
  numberMember,
  objectMember,
  optionalObject,
  optionalString,
  stringMember,
} from './json-shape.ts';

export interface ExactRuntimeInput {
  readonly catalog: CatalogDocument;
  readonly scope: Scope;
  readonly binding: EngineBinding;
  readonly anchor: InstantValue;
  readonly vector?: RuntimeOwnedVector;
  readonly qualityCertifications: readonly QualityCertification[];
}

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function allChannels(effect: 'allow' | 'deny', capability?: string) {
  const access = effect === 'deny'
    ? { effect: 'deny' as const }
    : {
        effect: 'allow' as const,
        requiredCapabilities: capability === undefined ? [] : [capability],
      };
  return { model: access, principal: access };
}

function fieldPolicy(select: boolean): FieldPolicy {
  const allow = allChannels('allow');
  return {
    select: select ? allow : allChannels('deny'),
    filter: allow,
    group: allow,
    order: allow,
    aggregate: {
      count: allow,
      countDistinct: allow,
      sum: allow,
      avg: allow,
      min: allow,
      max: allow,
    },
    lexicalSearch: allow,
  };
}

function fieldIsSelectable(policy: JsonObject | undefined, fieldId: string): boolean {
  const fields = policy === undefined ? undefined : optionalObject(policy, 'fields', '/policy');
  const field = fields?.[fieldId];
  if (field === undefined) return true;
  const object = jsonObject(field, `/policy/fields/${fieldId}`);
  const select = object.select;
  if (select === undefined) return true;
  if (typeof select !== 'boolean') {
    throw new TypeError(`/policy/fields/${fieldId}/select must be a boolean.`);
  }
  return select;
}

function mapField(value: JsonValue, location: string): readonly [string, FieldDocument] {
  const source = jsonObject(value, location);
  const id = stringMember(source, 'id', location);
  const description = stringMember(source, 'description', location);
  const nullable = booleanMember(source, 'nullable', location);
  const kind = stringMember(source, 'kind', location);
  const base = { description, nullable };
  switch (kind) {
    case 'id':
    case 'boolean':
    case 'integer':
    case 'decimal':
    case 'date':
    case 'null':
      return [id, { ...base, kind }];
    case 'money': {
      const currency = optionalString(source, 'currency', location);
      if (currency === undefined) {
        throw new TypeError(`${location} needs a fixed currency in the current catalog contract.`);
      }
      return [id, {
        ...base,
        kind,
        currency: CurrencyCodeSchema.parse(currency),
      }];
    }
    case 'text':
      return [id, {
        ...base,
        kind,
        collation: { id: stringMember(source, 'collation', location), version: '0' },
      }];
    case 'enum':
      return [id, {
        ...base,
        kind,
        values: arrayMember(source, 'values', location).map((item, index) => {
          const enumValue = jsonObject(item, `${location}/values/${index}`);
          return {
            code: stringMember(enumValue, 'code', `${location}/values/${index}`),
            label: stringMember(enumValue, 'label', `${location}/values/${index}`),
          };
        }),
      }];
    case 'instant':
      return [id, {
        ...base,
        kind,
        precision: stringMember(source, 'precision', location) as
          'second' | 'millisecond' | 'microsecond' | 'nanosecond',
      }];
    default:
      throw new TypeError(`${location}/kind ${kind} is not an exact v0 field kind.`);
  }
}

function datasetIsVisible(policy: JsonObject | undefined, datasetId: string): boolean {
  const datasets = policy === undefined ? undefined : optionalObject(policy, 'datasets', '/policy');
  const dataset = datasets?.[datasetId];
  if (dataset === undefined) return true;
  return booleanMember(jsonObject(dataset, `/policy/datasets/${datasetId}`), 'visible',
    `/policy/datasets/${datasetId}`);
}

function mapDataset(
  value: JsonValue,
  policy: JsonObject | undefined,
  location: string,
): readonly [string, DatasetDocument] | undefined {
  const source = jsonObject(value, location);
  const id = stringMember(source, 'id', location);
  if (!datasetIsVisible(policy, id)) return undefined;
  const fields = Object.fromEntries(arrayMember(source, 'fields', location).map((item, index) =>
    mapField(item, `${location}/fields/${index}`)));
  const rowScope = objectMember(source, 'rowScope', location);
  const rowScopeKind = stringMember(rowScope, 'kind', `${location}/rowScope`);
  const embeddingsSource = optionalObject(source, 'embeddings', location) ?? {};
  const embeddings = Object.fromEntries(
    Object.entries(embeddingsSource).map(([name, reference]) => {
      if (typeof reference !== 'string') {
        throw new TypeError(`${location}/embeddings/${name} must be a string.`);
      }
      return [name, reference];
    }),
  );
  return [id, {
    description: stringMember(source, 'description', location),
    idField: stringMember(source, 'idField', location),
    fields,
    profiles: arrayMember(source, 'profiles', location).map((profile, index) => {
      if (typeof profile !== 'string') {
        throw new TypeError(`${location}/profiles/${index} must be a string.`);
      }
      return profile as DatasetDocument['profiles'][number];
    }),
    embeddings,
    rowScope: rowScopeKind === 'none'
      ? { kind: 'none', reason: stringMember(rowScope, 'reason', `${location}/rowScope`) }
      : {
          kind: 'partitions',
          dimensions: arrayMember(rowScope, 'dimensions', `${location}/rowScope`).map(
            (dimension, index) => {
              if (typeof dimension !== 'string') {
                throw new TypeError(`${location}/rowScope/dimensions/${index} must be a string.`);
              }
              return dimension;
            },
          ),
        },
    capabilityTags: [],
    fieldPolicies: Object.fromEntries(Object.keys(fields).map((fieldId) => [
      fieldId,
      fieldPolicy(fieldIsSelectable(policy, fieldId)),
    ])),
    embeddingPolicies: Object.fromEntries(Object.entries(embeddings).map(([name, reference]) => [
      name,
      {
        reviewed: true as const,
        semanticSearch: allChannels('allow', `semanticSearch:${reference}`),
      },
    ])),
  }];
}

function immutableRevision(revision: string): string {
  if (/^sha256:[a-f0-9]{64}$/u.test(revision)) return revision;
  return `sha256:${createHash('sha256').update(revision, 'utf8').digest('hex')}`;
}

function mapEmbeddingSpec(
  value: JsonValue,
  location: string,
): readonly [string, EmbeddingSpecDocument] {
  const source = jsonObject(value, location);
  const id = stringMember(source, 'id', location);
  const model = objectMember(source, 'model', location);
  const suffix = id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : id;
  return [id, {
    version: suffix,
    sourceFields: arrayMember(source, 'sourceFields', location).map((field, index) => {
      if (typeof field !== 'string') {
        throw new TypeError(`${location}/sourceFields/${index} must be a string.`);
      }
      return field;
    }),
    inputTransformId: stringMember(source, 'inputTransform', location),
    model: {
      id: stringMember(model, 'id', `${location}/model`),
      revision: immutableRevision(stringMember(model, 'revision', `${location}/model`)),
    },
    dimension: SafeIntegerSchema.parse(numberMember(source, 'dimension', location)),
    metric: stringMember(source, 'metric', location) as EmbeddingSpecDocument['metric'],
    vectorEncoding: stringMember(source, 'vectorEncoding', location) as
      EmbeddingSpecDocument['vectorEncoding'],
    chunking: 'none',
    privacyClass: stringMember(source, 'privacyClass', location),
  }];
}

function fixtureCatalog(fixture: ExactFixture): CatalogDocument {
  const source = objectMember(fixture.value, 'catalog', fixture.sourcePath);
  const policy = optionalObject(fixture.value, 'policy', fixture.sourcePath);
  const datasets = Object.fromEntries(arrayMember(source, 'datasets', '/catalog')
    .map((item, index) => mapDataset(item, policy, `/catalog/datasets/${index}`))
    .filter((item): item is readonly [string, DatasetDocument] => item !== undefined));
  const specs = source.embeddingSpecs === undefined
    ? []
    : jsonArray(source.embeddingSpecs, '/catalog/embeddingSpecs');
  const policyVersion = policy === undefined
    ? `${stringMember(source, 'version', '/catalog')}:policy`
    : stringMember(policy, 'version', '/policy');
  return CatalogDocumentSchema.parse({
    schemaVersion: '0',
    catalogVersion: stringMember(source, 'version', '/catalog'),
    policyVersion,
    datasets,
    embeddingSpecs: Object.fromEntries(specs.map((item, index) =>
      mapEmbeddingSpec(item, `/catalog/embeddingSpecs/${index}`))),
  });
}

function fixtureScope(fixture: ExactFixture, catalog: CatalogDocument): Scope {
  const source = objectMember(fixture.value, 'scope', fixture.sourcePath);
  const partitions = objectMember(source, 'partitions', '/scope');
  const partitioned = Object.values(catalog.datasets)
    .some((dataset) => dataset.rowScope.kind === 'partitions');
  const partitionValues = Object.fromEntries(Object.entries(partitions).map(([name, values]) => [
    name,
    jsonArray(values, `/scope/partitions/${name}`),
  ]));
  const emptyPartition = Object.keys(partitionValues).length === 0
    || Object.values(partitionValues).some((values) => values.length === 0);
  const parsedPartitions = partitioned
    ? emptyPartition
      ? { kind: 'nothing' as const }
      : { kind: 'values' as const, values: partitionValues }
    : { kind: 'unpartitioned' as const };
  const budgets = objectMember(source, 'budgets', '/scope');
  const rows = SafeIntegerSchema.parse(numberMember(budgets, 'rows', '/scope/budgets'));
  return ScopeSchema.parse({
    principal: stringMember(source, 'principal', '/scope'),
    capabilities: arrayMember(source, 'capabilities', '/scope').map((value, index) => {
      if (typeof value !== 'string') {
        throw new TypeError(`/scope/capabilities/${index} must be a string.`);
      }
      return value;
    }),
    partitions: parsedPartitions,
    budgets: {
      maximumQueries: SafeIntegerSchema.parse(1_000),
      maximumExactScanRecords: rows,
      maximumCandidateRecords: rows,
    },
    expiresAt: stringMember(source, 'expiresAt', '/scope'),
  });
}

function fixtureBinding(catalog: CatalogDocument): EngineBinding {
  return {
    version: `binding:${catalog.catalogVersion}`,
    datasets: Object.fromEntries(Object.entries(catalog.datasets).map(([datasetId, dataset]) => [
      datasetId,
      {
        physical: physical(datasetId),
        fields: Object.fromEntries(Object.keys(dataset.fields).map((fieldId) => [
          fieldId,
          physical(fieldId),
        ])),
        embeddings: Object.fromEntries(Object.keys(dataset.embeddings).map((name) => [
          name,
          { physical: physical(`__embedding_${name}`), indexed: true },
        ])),
      },
    ])),
  };
}

function queryVector(fixture: ExactFixture): RuntimeOwnedVector | undefined {
  const execution = optionalObject(fixture.value, 'execution', fixture.sourcePath);
  const runtime = execution === undefined
    ? undefined
    : optionalObject(execution, 'runtimeEmbedder', '/execution');
  if (runtime === undefined) return undefined;
  const values = arrayMember(runtime, 'queryVector', '/execution/runtimeEmbedder').map(
    (value, index) => {
      if (typeof value !== 'number') {
        throw new TypeError(`/execution/runtimeEmbedder/queryVector/${index} must be a number.`);
      }
      return value;
    },
  );
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true);
  return {
    bytes,
    encoding: 'float32',
    dimension: SafeIntegerSchema.parse(values.length),
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as QueryVectorDigest,
  };
}

function fixtureAnchor(fixture: ExactFixture): InstantValue {
  const execution = optionalObject(fixture.value, 'execution', fixture.sourcePath);
  const value = execution === undefined
    ? undefined
    : optionalString(execution, 'anchor', '/execution');
  return InstantValueSchema.parse(value ?? '2000-01-01T00:00:00Z');
}

function qualityCertifications(
  fixture: ExactFixture,
  catalog: CatalogDocument,
  adapterId: string,
  adapterVersion: string,
): readonly QualityCertification[] {
  const query = optionalObject(fixture.value, 'query', fixture.sourcePath);
  const search = query === undefined ? undefined : optionalObject(query, 'search', '/query');
  if (search === undefined) return [];
  const quality = optionalString(search, 'quality', '/query/search');
  const using = optionalString(search, 'using', '/query/search');
  if (quality === undefined || using === undefined || catalog.embeddingSpecs[using] === undefined) {
    return [];
  }
  return [{
    profile: quality,
    reference: `fixture-certification:${fixture.id}`,
    embeddingSpec: using,
    adapterId,
    adapterVersion,
  }];
}

export function mapExactRuntimeInput(
  fixture: ExactFixture,
  adapterId: string,
  adapterVersion: string,
): ExactRuntimeInput {
  const catalog = fixtureCatalog(fixture);
  const vector = queryVector(fixture);
  return {
    catalog,
    scope: fixtureScope(fixture, catalog),
    binding: fixtureBinding(catalog),
    anchor: fixtureAnchor(fixture),
    ...(vector === undefined ? {} : { vector }),
    qualityCertifications: qualityCertifications(
      fixture,
      catalog,
      adapterId,
      adapterVersion,
    ),
  };
}
