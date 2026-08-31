import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type {
  AdapterOutcome,
  AggregateLogicalPlan,
  CatalogPhysicalIdentifier,
  HybridRetrieveLogicalPlan,
  QueryVectorDigest,
  RecordsLogicalPlan,
  ResolvedDatasetBinding,
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
  SemanticRetrieveLogicalPlan,
} from '@agql/contracts';
import {
  effectivePlanHash,
  fingerprintScope,
  NormalizedTextSchema,
  SafeIntegerSchema,
  sourceQueryHash,
} from '@agql/schemas';
import { Pool } from 'pg';

import { createPostgresAdapter } from './adapter.ts';
import { compileCalendarPeriodSql } from './calendar-sql.ts';
import { decodeRows } from './codec.ts';
import { compileQuery } from './query-compiler.ts';
import { RuntimeRegistry } from './registry.ts';
import { ParameterBuilder } from './sql-parameters.ts';
import type {
  CompiledPostgresQuery,
  PostgresAdapterConfig,
  PostgresCollationBinding,
} from './types.ts';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

const safe = (value: number) => SafeIntegerSchema.parse(value);
const pool = new Pool({ connectionString: 'postgres://unused.invalid/agql' });
after(async () => pool.end());

const codeCollation: PostgresCollationBinding = {
  id: 'codepoint',
  version: 'frozen-1',
  databaseVersion: null,
  schema: physical('pg_catalog'),
  name: physical('C'),
};

const textCollation: PostgresCollationBinding = {
  id: 'agql-text',
  version: 'unicode-frozen-1',
  databaseVersion: null,
  schema: physical('pg_catalog'),
  name: physical('C'),
};

const dataset: ResolvedDatasetBinding = {
  logicalId: 'notes',
  physical: physical('data"; DROP TABLE audit; --'),
  bindingVersion: 'binding-1',
};

const idField: ResolvedFieldBinding = {
  logicalId: 'id',
  physical: physical('id"; --'),
  type: { kind: 'id' },
  nullable: false,
};

const tenantField: ResolvedFieldBinding = {
  logicalId: 'tenant',
  physical: physical('tenant_partition'),
  type: { kind: 'text', collation: { id: 'agql-text', version: 'unicode-frozen-1' } },
  nullable: false,
};

const bodyField: ResolvedFieldBinding = {
  logicalId: 'body',
  physical: physical('body_text'),
  type: { kind: 'text', collation: { id: 'agql-text', version: 'unicode-frozen-1' } },
  nullable: true,
};

const amountField: ResolvedFieldBinding = {
  logicalId: 'amount',
  physical: physical('amount_numeric'),
  type: { kind: 'decimal' },
  nullable: true,
};

const instantField: ResolvedFieldBinding = {
  logicalId: 'created',
  physical: physical('created_at'),
  type: { kind: 'instant', precision: 'microsecond' },
  nullable: false,
};

const embedding: ResolvedEmbeddingBinding = {
  name: 'body_embedding',
  specReference: 'body@1',
  specVersion: '1',
  physical: physical('embedding_vector'),
  dimension: safe(3),
  metric: 'cosine',
  vectorEncoding: 'float32',
  model: { id: 'fixture', revision: 'sha256:fixture' },
  inputTransformId: 'nfc-fields-v1',
  privacyClass: 'internal',
};

const config: PostgresAdapterConfig = {
  queryPool: pool,
  writerPool: pool,
  namespace: physical('runtime"; --'),
  queryRole: 'agql_query',
  writerRole: 'agql_writer',
  statementTimeoutMs: safe(2_000),
  exactScanAdmissionLimit: safe(100),
  tokenSecret: new Uint8Array(32),
  vectorByteOrder: 'littleEndian',
  codeCollation,
  collations: [textCollation],
  datasets: [{
    dataset,
    idField,
    fields: [idField, tenantField, bodyField, amountField, instantField],
    lexicalFields: [bodyField.physical],
    embeddings: [{
      embedding,
      visibilityName: 'embedding:body@1',
      annIndex: physical('ann_body_1'),
    }],
  }],
  qualityProfiles: [{
    id: 'balanced',
    certificationReference: 'fixture:balanced-v1',
    efSearch: safe(80),
    maxScanTuples: safe(5_000),
    maximumBooleanDepth: safe(2),
    certifiedPredicates: ['comparison', 'list', 'null', 'substring', 'instantRange'],
  }],
};

const registry = new RuntimeRegistry(config);
const sourceHash = sourceQueryHash({ test: 'postgres-adapter' });
const scopeHash = fingerprintScope({ partitions: ['tenant-a'] });
const planHash = effectivePlanHash({
  sourceQueryHash: sourceHash,
  languageVersion: '0',
  catalogVersion: 'catalog-1',
  policyVersion: 'policy-1',
  scopeFingerprint: scopeHash,
});

function vector(): SemanticRetrieveLogicalPlan['search']['vector'] {
  const values = new Float32Array([1, 0, 0]);
  return {
    bytes: new Uint8Array(values.buffer),
    encoding: 'float32',
    dimension: safe(3),
    digest: 'digest-1' as QueryVectorDigest,
  };
}

function success<T>(outcome: AdapterOutcome<T>): T {
  if (outcome.kind === 'refusal') {
    assert.fail(`${outcome.refusal.code}: ${outcome.refusal.message}`);
  }
  return outcome.value;
}

function common() {
  return {
    languageVersion: '0' as const,
    sourceQueryHash: sourceHash,
    effectivePlanHash: planHash,
    dataset,
    scope: {
      visibility: 'predicate' as const,
      enforcement: 'mandatoryPushdown' as const,
      predicates: [{
        kind: 'comparison' as const,
        field: tenantField,
        op: 'eq' as const,
        value: {
          kind: 'text' as const,
          value: NormalizedTextSchema.parse("tenant'; DROP TABLE secret; --"),
        },
      }] as const,
    },
    hardRowLimit: safe(20),
    take: safe(5),
  };
}

test('descriptor advertises only implemented profiles and transaction snapshots', () => {
  const adapter = createPostgresAdapter(config);
  assert.deepEqual(adapter.descriptor.profiles, [
    'records.v0',
    'aggregate.v0',
    'retrieve.semantic.v0',
    'retrieve.hybrid.v0',
    'ingest.canonical.v0',
  ]);
  assert.deepEqual(adapter.descriptor.consistency, {
    afterWrite: 'certified',
    snapshots: ['transaction'],
    compareAndSwap: true,
  });
  assert.equal('retrievalIndex' in adapter, false);
});

test('records SQL contains only quoted physical identifiers and bound model scalars', () => {
  const needle = "%_'quoted'; --";
  const plan: RecordsLogicalPlan = {
    ...common(),
    mode: 'records',
    profile: 'records.v0',
    filter: {
      kind: 'substring',
      field: bodyField,
      op: 'contains',
      value: NormalizedTextSchema.parse(needle),
      semantics: 'escaped-case-sensitive-substring',
    },
    projection: [{
      output: { logicalId: '__proto__; DROP TABLE x', slot: safe(0) },
      field: bodyField,
    }],
    order: [{ field: bodyField, direction: 'asc' }],
    tieBreak: {
      kind: 'recordId',
      order: { field: idField, direction: 'asc' },
    },
  };
  const compiled = success(compileQuery(plan, registry));
  assert.doesNotMatch(compiled.statement.text, /__proto__|tenant';|%_'quoted'/u);
  assert.match(compiled.statement.text, /"data""; DROP TABLE audit; --"/u);
  assert.match(compiled.statement.text, /LIKE \$\d+::text ESCAPE '\\'/u);
  assert.match(compiled.statement.text, /COLLATE "pg_catalog"\."C"/u);
  assert.match(compiled.statement.text, /ASC NULLS LAST/u);
  assert.ok(compiled.statement.values.includes("tenant'; DROP TABLE secret; --"));
  assert.ok(compiled.statement.values.includes("%\\%\\_'quoted'; --%"));
});

test('aggregate SQL repeats group expressions and keeps numerics out of float8', () => {
  const plan: AggregateLogicalPlan = {
    ...common(),
    mode: 'aggregate',
    profile: 'aggregate.v0',
    dimensions: [{
      kind: 'field',
      output: { logicalId: '__proto__', slot: safe(0) },
      field: tenantField,
    }],
    metrics: [{
      kind: 'aggregate',
      output: { logicalId: 'sum_amount', slot: safe(1) },
      aggregate: { op: 'sum', field: amountField },
    }],
    order: [{
      output: { logicalId: 'sum_amount', slot: safe(1) },
      direction: 'desc',
    }],
    tieBreak: { kind: 'dimensionTuple', fields: [tenantField] },
  };
  const compiled = success(compileQuery(plan, registry));
  assert.match(compiled.statement.text, /GROUP BY d\."tenant_partition" COLLATE/u);
  assert.doesNotMatch(compiled.statement.text, /GROUP BY 1|float8|__proto__/u);
  assert.match(compiled.statement.text, /SUM\(d\."amount_numeric"\)/u);
  assert.match(compiled.statement.text, /NULLS LAST/u);
});

test('calendar SQL binds timezone, uses explicit grain, and documents Monday weeks', () => {
  const parameters = new ParameterBuilder();
  const compiled = compileCalendarPeriodSql({
    kind: 'calendarPeriod',
    output: { logicalId: 'week', slot: safe(0) },
    field: instantField,
    grain: 'week',
    timezone: 'Europe/London',
    weekStart: 'monday',
    fiscalDayStart: '00:00:00',
    resultKind: 'calendarPeriod',
  }, { registry, dataset: config.datasets[0] ?? assert.fail(), alias: 'd', parameters });
  assert.match(compiled.localStart, /extract\(isodow/u);
  assert.match(compiled.endExclusive, /INTERVAL '1 week'.*AT TIME ZONE \$1::text/u);
  assert.deepEqual(parameters.values, ['Europe/London']);
});

test('calendar-period aggregates compile and decode result-only CalendarPeriod rows', () => {
  const plan: AggregateLogicalPlan = {
    ...common(),
    mode: 'aggregate',
    profile: 'aggregate.v0',
    dimensions: [{
      kind: 'calendarPeriod',
      output: { logicalId: 'week', slot: safe(0) },
      field: instantField,
      grain: 'week',
      timezone: 'UTC',
      weekStart: 'monday',
      fiscalDayStart: '00:00:00',
      resultKind: 'calendarPeriod',
    }],
    metrics: [{
      kind: 'aggregate',
      output: { logicalId: 'count', slot: safe(1) },
      aggregate: { op: 'count' },
    }],
    order: [{ output: { logicalId: 'week', slot: safe(0) }, direction: 'asc' }],
    tieBreak: { kind: 'dimensionTuple', fields: [instantField] },
  };
  const compiled = success(compileQuery(plan, registry));
  assert.match(compiled.statement.text, /json_build_object\('start'/u);
  assert.match(compiled.statement.text, /GROUP BY .*json_build_object/su);
  assert.deepEqual(compiled.outputCodecs[0], {
    kind: 'calendarPeriod', timezone: 'UTC', grain: 'week',
  });
  const decoded = decodeRows(compiled, [[
    '{"start":"2024-01-01T00:00:00Z","endExclusive":"2024-01-08T00:00:00Z",'
      + '"timezone":"UTC","grain":"week","label":"2024-W01"}',
    '2',
    '1',
  ]]);
  if (decoded?.kind !== 'success') {
    assert.fail('Expected calendar aggregation decoding to succeed.');
  }
  assert.deepEqual(decoded.rows, [[
    {
      kind: 'calendarPeriod',
      value: {
        start: '2024-01-01T00:00:00Z', endExclusive: '2024-01-08T00:00:00Z',
        timezone: 'UTC', grain: 'week', label: '2024-W01',
      },
    },
    { kind: 'integer', value: 2 },
  ]]);
});

test('semantic exact adds an eligible-set admission probe and disables ANN indexes', () => {
  const plan: SemanticRetrieveLogicalPlan = {
    ...common(),
    mode: 'retrieve',
    profile: 'retrieve.semantic.v0',
    projection: [{ output: { logicalId: 'body', slot: safe(0) }, field: bodyField }],
    stableId: idField,
    search: {
      kind: 'semantic',
      embedding,
      vector: vector(),
      accuracy: 'exact',
      qualityProfile: 'balanced',
      hardCandidateLimit: safe(10),
    },
  };
  const compiled = success(compileQuery(plan, registry));
  assert.ok(compiled.admissionStatement !== undefined);
  assert.match(compiled.admissionStatement.text, /WHERE .*tenant_partition.*LIMIT/su);
  assert.deepEqual(compiled.settings, [
    ['enable_indexscan', 'off'],
    ['enable_bitmapscan', 'off'],
  ]);
  assert.doesNotMatch(compiled.statement.text, /digest-1|balanced/u);
});

test('hybrid repeats scope in both channels and the payload join ON clause', () => {
  const lexicalText = NormalizedTextSchema.parse("memory_%'; --");
  const plan: HybridRetrieveLogicalPlan = {
    ...common(),
    mode: 'retrieve',
    profile: 'retrieve.hybrid.v0',
    projection: [{ output: { logicalId: '__proto__', slot: safe(0) }, field: bodyField }],
    stableId: idField,
    search: {
      kind: 'hybrid',
      embedding,
      vector: vector(),
      accuracy: 'approximate',
      lexical: {
        field: bodyField,
        text: lexicalText,
        semantics: 'escaped-case-sensitive-substring',
      },
      fusion: 'rrf-v0',
      qualityProfile: 'balanced',
      hardCandidateLimit: safe(10),
    },
  };
  const compiled: CompiledPostgresQuery = success(compileQuery(plan, registry));
  assert.doesNotMatch(compiled.statement.text, /memory_|__proto__|balanced/u);
  assert.equal(compiled.statement.text.match(/tenant_partition/gu)?.length, 3);
  assert.match(compiled.statement.text, /FULL OUTER JOIN lexical_ranked/u);
  assert.match(compiled.statement.text, /JOIN .* AS d ON .* AND \(/u);
  assert.match(compiled.statement.text, /60::numeric/u);
  assert.ok(compiled.statement.values.includes(lexicalText));
  assert.ok(compiled.statement.values.includes("%memory\\_\\%'; --%"));
});

test('uncertified approximate filters refuse before SQL compilation', () => {
  const restricted = new RuntimeRegistry({
    ...config,
    qualityProfiles: [{
      ...config.qualityProfiles[0] ?? assert.fail(),
      certifiedPredicates: ['comparison'],
    }],
  });
  const plan: SemanticRetrieveLogicalPlan = {
    ...common(),
    mode: 'retrieve',
    profile: 'retrieve.semantic.v0',
    filter: { kind: 'null', field: bodyField, op: 'isNotNull' },
    projection: [{ output: { logicalId: 'body', slot: safe(0) }, field: bodyField }],
    stableId: idField,
    search: {
      kind: 'semantic',
      embedding,
      vector: vector(),
      accuracy: 'approximate',
      qualityProfile: 'balanced',
      hardCandidateLimit: safe(10),
    },
  };
  const outcome = compileQuery(plan, restricted);
  assert.equal(outcome.kind, 'refusal');
  if (outcome.kind === 'refusal') {
    assert.equal(outcome.refusal.code, 'FILTER_SHAPE_UNCERTIFIED');
  }
});
