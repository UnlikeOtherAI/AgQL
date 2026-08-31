import type { Scope } from '@agql/catalog';
import { ScopeSchema } from '@agql/catalog';
import type {
  AdapterDescriptor,
  CatalogPhysicalIdentifier,
  QueryVectorDigest,
} from '@agql/contracts';
import type {
  AccessRule,
  CapabilityProfile,
  FieldPolicy,
} from '@agql/schemas';
import {
  CatalogDocumentSchema,
  InstantValueSchema,
  SafeIntegerSchema,
} from '@agql/schemas';

import type {
  CompileQueryInput,
  DeploymentLimits,
  EngineBinding,
} from './types.ts';

function allow(...requiredCapabilities: readonly string[]): AccessRule {
  return { effect: 'allow', requiredCapabilities: [...requiredCapabilities] };
}

function deny(): AccessRule {
  return { effect: 'deny' };
}

function channels(rule: AccessRule) {
  return { model: rule, principal: rule };
}

function fieldPolicy(rule: AccessRule = allow()): FieldPolicy {
  return {
    select: channels(rule),
    filter: channels(rule),
    group: channels(rule),
    order: channels(rule),
    aggregate: {
      count: channels(rule),
      countDistinct: channels(rule),
      sum: channels(rule),
      avg: channels(rule),
      min: channels(rule),
      max: channels(rule),
    },
    lexicalSearch: channels(rule),
  };
}

const text = {
  kind: 'text',
  nullable: false,
  collation: { id: 'unicode-codepoint', version: '1' },
} as const;

export const catalog = CatalogDocumentSchema.parse({
  schemaVersion: '0',
  catalogVersion: 'catalog-1',
  policyVersion: 'policy-1',
  embeddingSpecs: {
    'body@2': {
      version: '2',
      sourceFields: ['docs.body'],
      inputTransformId: 'plain-text-v1',
      model: {
        id: 'fixture-embedder',
        revision: `sha256:${'a'.repeat(64)}`,
      },
      dimension: 2,
      metric: 'cosine',
      vectorEncoding: 'float32',
      chunking: 'none',
      privacyClass: 'internal',
    },
  },
  datasets: {
    docs: {
      description: 'Scoped documents.',
      idField: 'docs.id',
      fields: {
        'docs.id': { description: 'Stable id.', kind: 'id', nullable: false },
        'docs.tenant': {
          description: 'Tenant.',
          kind: 'enum',
          nullable: false,
          values: [
            { code: 'a', label: 'Tenant A' },
            { code: 'b', label: 'Tenant B' },
          ],
        },
        'docs.title': { description: 'Title.', ...text },
        'docs.body': { description: 'Body.', ...text },
        'docs.secret': { description: 'Secret.', ...text },
        'docs.created': {
          description: 'Created instant.',
          kind: 'instant',
          precision: 'millisecond',
          nullable: false,
        },
        'docs.qty': { description: 'Quantity.', kind: 'integer', nullable: false },
        'docs.amount': {
          description: 'Amount.',
          kind: 'money',
          precision: 38,
          scale: 2,
          currencies: ['USD'],
          nullable: false,
        },
      },
      profiles: [
        'records.v0',
        'aggregate.v0',
        'retrieve.semantic.v0',
        'retrieve.hybrid.v0',
        'ingest.canonical.v0',
      ],
      embeddings: { body: 'body@2' },
      rowScope: { kind: 'partitions', dimensions: ['docs.tenant'] },
      capabilityTags: [],
      defaultFilters: {
        kind: 'predicate',
        field: 'docs.qty',
        op: 'gte',
        value: 0,
      },
      fieldPolicies: {
        'docs.id': fieldPolicy(),
        'docs.tenant': fieldPolicy(),
        'docs.title': fieldPolicy(),
        'docs.body': {
          ...fieldPolicy(),
          lexicalSearch: channels(allow('lexical')),
        },
        'docs.secret': fieldPolicy(deny()),
        'docs.created': fieldPolicy(),
        'docs.qty': fieldPolicy(),
        'docs.amount': fieldPolicy(),
      },
      embeddingPolicies: {
        body: {
          reviewed: true,
          semanticSearch: channels(allow('semantic')),
        },
      },
    },
  },
});

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

export const binding: EngineBinding = {
  version: 'binding-1',
  datasets: {
    docs: {
      physical: physical('physical_docs'),
      fields: {
        'docs.id': physical('physical_docs_id'),
        'docs.tenant': physical('physical_docs_tenant'),
        'docs.title': physical('physical_docs_title'),
        'docs.body': physical('physical_docs_body'),
        'docs.secret': physical('physical_docs_secret'),
        'docs.created': physical('physical_docs_created'),
        'docs.qty': physical('physical_docs_qty'),
        'docs.amount': physical('physical_docs_amount'),
      },
      embeddings: {
        body: { physical: physical('physical_body_v2'), indexed: true },
      },
    },
  },
};

export const limits: DeploymentLimits = {
  booleanNesting: SafeIntegerSchema.parse(2),
  inList: SafeIntegerSchema.parse(100),
  predicateNodes: SafeIntegerSchema.parse(100),
  select: SafeIntegerSchema.parse(100),
  take: {
    records: SafeIntegerSchema.parse(10_000),
    aggregate: SafeIntegerSchema.parse(1_000),
    retrieve: SafeIntegerSchema.parse(1_000),
  },
};

export const scope: Scope = ScopeSchema.parse({
  principal: 'fixture:reader',
  capabilities: ['semantic', 'lexical', 'ingest.canonical.v0'],
  partitions: { kind: 'values', values: { 'docs.tenant': ['a'] } },
  budgets: {
    maximumQueries: 100,
    maximumExactScanRecords: 1_000,
    maximumCandidateRecords: 1_000,
  },
  expiresAt: '2099-01-01T00:00:00Z',
});

const queryProfiles = [
  'records.v0',
  'aggregate.v0',
  'retrieve.semantic.v0',
  'retrieve.hybrid.v0',
] as const satisfies readonly CapabilityProfile[];

export const adapterDescriptor: AdapterDescriptor<typeof queryProfiles> = {
  id: 'fixture-adapter',
  version: 'adapter-1',
  profiles: queryProfiles,
  consistency: {
    afterWrite: 'certified',
    snapshots: ['none', 'request'],
    compareAndSwap: true,
  },
};

export const vector = {
  bytes: new Uint8Array(8),
  encoding: 'float32',
  dimension: SafeIntegerSchema.parse(2),
  digest: 'query-vector-digest' as QueryVectorDigest,
} as const;

export function compileInput(query: unknown): CompileQueryInput {
  return {
    query,
    catalog,
    scope,
    anchor: InstantValueSchema.parse('2024-03-06T12:34:56Z'),
    channel: 'model',
    limits,
    calendar: {
      timezone: 'UTC',
      timezoneDatabase: 'fixed-offset',
      weekStart: 'monday',
      fiscalDayStart: '00:00:00',
    },
    binding,
    adapter: adapterDescriptor,
    costGate: {
      estimate: {
        estimatedRows: SafeIntegerSchema.parse(10),
        estimatedCandidateRecords: SafeIntegerSchema.parse(10),
        estimatedIntermediateBytes: SafeIntegerSchema.parse(10_000),
        selectiveFilterFields: ['docs.created'],
      },
      maximumEstimatedRows: SafeIntegerSchema.parse(100_000),
      maximumIntermediateBytes: SafeIntegerSchema.parse(1_000_000),
    },
    qualityCertifications: [{
      profile: 'certified-high',
      reference: 'certification-1',
      embeddingSpec: 'body@2',
      adapterId: adapterDescriptor.id,
      adapterVersion: adapterDescriptor.version,
    }],
    vector,
  };
}

export const recordsQuery = {
  version: '0',
  mode: 'records',
  from: 'docs',
  select: ['docs.id', 'docs.title'],
  where: {
    kind: 'predicate',
    field: 'docs.created',
    op: 'inPrevious',
    unit: 'week',
  },
  order: [{ by: 'docs.title', dir: 'asc' }],
  take: 10,
} as const;
