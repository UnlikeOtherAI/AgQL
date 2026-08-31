import { createHash } from 'node:crypto';

import type {
  AdapterOutcome,
  CanonicalIngestPlan,
  ResolvedCanonicalFieldValue,
  RetrievalIndexMutation,
  TypedValue,
} from '@agql/contracts';
import { canonicalizeJcs, SafeIntegerSchema } from '@agql/schemas';

import { refusal, unsafePlan } from './refusals.ts';
import type { RuntimeRegistry } from './registry.ts';
import { eligibilitySql, SqlCompilationError } from './sql-predicates.ts';
import { ParameterBuilder } from './sql-parameters.ts';
import { encodeScalar } from './sql-parameters.ts';
import type {
  CompiledPostgresEmbeddingMutation,
  CompiledPostgresIngest,
  PostgresDatasetBinding,
} from './types.ts';
import { pgvectorParameter } from './vector.ts';

function valueJson(value: TypedValue): unknown {
  if (value.kind === 'money') {
    return {
      kind: value.kind,
      value: { amount: value.value.amount, currency: value.value.currency },
    };
  }
  return { kind: value.kind, value: value.value };
}

function fieldValueJson(value: ResolvedCanonicalFieldValue): unknown {
  return { field: value.field.physical, value: valueJson(value.value) };
}

function ingestDigest(plan: CanonicalIngestPlan): string {
  const records = plan.records.map((record) => ({
    id: record.id,
    ...('ifVersion' in record
      ? { ifVersion: record.ifVersion }
      : {}),
    ...('values' in record ? { values: record.values.map(fieldValueJson) } : {}),
  }));
  return createHash('sha256').update(canonicalizeJcs({
    mode: plan.mode,
    dataset: plan.dataset.physical,
    scopeFingerprint: plan.scopeFingerprint,
    idempotencyKey: plan.idempotencyKey,
    embeddingPolicy: plan.embeddingPolicy,
    records,
  }), 'utf8').digest('hex');
}

function validateValues(
  dataset: PostgresDatasetBinding,
  recordId: string,
  values: readonly ResolvedCanonicalFieldValue[],
  registry: RuntimeRegistry,
): boolean {
  const seen = new Set<string>();
  for (const item of values) {
    const field = registry.field(dataset, item.field);
    if (field === undefined || seen.has(field.physical)) return false;
    seen.add(field.physical);
    if (field.physical === dataset.idField.physical) {
      if (item.value.kind !== 'id' || item.value.value !== recordId) return false;
    } else if (encodeScalar(field, item.value) === undefined) {
      return false;
    }
  }
  return dataset.fields.every((field) => field.physical === dataset.idField.physical
    || seen.has(field.physical));
}

export function compileCanonicalIngest(
  plan: CanonicalIngestPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresIngest> {
  const dataset = registry.dataset(plan.dataset);
  if (dataset === undefined || registry.field(dataset, plan.idField) === undefined
    || plan.idField.physical !== dataset.idField.physical) {
    return refusal(
      'SCOPE_UNENFORCEABLE',
      'The canonical ingest binding is not installed in this PostgreSQL adapter.',
      '/dataset',
      ['Use an installed canonical dataset binding.'],
      'Install the resolved canonical binding before ingest.',
    );
  }
  if (plan.scope.visibility === 'predicate' && plan.scope.predicates.length === 0) {
    return refusal(
      'SCOPE_UNENFORCEABLE',
      'Canonical ingestion requires a non-empty mandatory-pushdown scope predicate.',
      '/scope',
      ['Compile ingestion from a resolved scope with visible partitions.'],
      'Resolve and preserve the expanded scope predicate before adapter compilation.',
    );
  }
  try {
    const parameters = new ParameterBuilder();
    eligibilitySql({ registry, dataset, alias: 'd', parameters }, plan.scope);
  } catch (error: unknown) {
    if (error instanceof SqlCompilationError) {
      return refusal(
        'SCOPE_UNENFORCEABLE',
        'Canonical ingestion scope fields are not enforceable by this PostgreSQL binding.',
        '/scope',
        ['Use a binding that contains every resolved scope field.'],
        'Choose a binding that enforces the expanded scope before every mutation.',
      );
    }
    throw error;
  }
  if (plan.idempotencyKey.length === 0 || plan.records.length === 0
    || new Set(plan.records.map((record) => record.id)).size !== plan.records.length
    || plan.records.some((record) => record.id.length === 0)) {
    return unsafePlan(
      '/records',
      'Canonical ingest ids and idempotency keys must be nonempty and unique.',
    );
  }
  for (const record of plan.records) {
    if ('ifVersion' in record && !SafeIntegerSchema.safeParse(record.ifVersion).success) {
      return unsafePlan('/records/ifVersion', 'ifVersion must be a safe integer.');
    }
    if ('values' in record && !validateValues(dataset, record.id, record.values, registry)) {
      return unsafePlan(
        '/records/value',
        'Whole-record ingest values must exactly cover the installed canonical fields.',
      );
    }
  }
  return {
    kind: 'success',
    value: {
      operation: 'canonicalIngest',
      plan,
      dataset,
      registry,
      operationDigest: ingestDigest(plan),
    },
  };
}

function mutationDigest(mutation: RetrievalIndexMutation): string {
  return createHash('sha256').update(canonicalizeJcs({
    kind: mutation.kind,
    recordId: mutation.recordId,
    representation: mutation.representation,
    sourceVersion: mutation.sourceVersion,
    idempotencyKey: mutation.idempotencyKey,
    ...(mutation.kind === 'put' ? {
      vector: Buffer.from(
        mutation.vector.bytes.buffer,
        mutation.vector.bytes.byteOffset,
        mutation.vector.bytes.byteLength,
      ).toString('base64'),
      encoding: mutation.vector.encoding,
      dimension: mutation.vector.dimension,
      digest: mutation.vector.digest,
    } : {}),
  }), 'utf8').digest('hex');
}

export function compileEmbeddingMutation(
  mutation: RetrievalIndexMutation,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresEmbeddingMutation> {
  const resolved = registry.embeddingByPhysical(mutation.representation);
  if (resolved === undefined) {
    return refusal(
      'EMBEDDING_NOT_INDEXED',
      'The resolved embedding representation is not installed.',
      '/representation',
      ['Use an installed embedding representation.'],
      'Provision the exact embedding representation before indexing it.',
    );
  }
  if (mutation.recordId.length === 0 || mutation.idempotencyKey.length === 0
    || !SafeIntegerSchema.safeParse(mutation.sourceVersion).success) {
    return unsafePlan('', 'The embedding mutation boundary values are invalid.');
  }
  if (mutation.kind === 'put') {
    const vector = pgvectorParameter(mutation.vector, registry.config.vectorByteOrder);
    if (vector === undefined
      || mutation.vector.dimension !== resolved.binding.embedding.dimension
      || mutation.vector.encoding !== resolved.binding.embedding.vectorEncoding) {
      return unsafePlan(
        '/vector',
        'The runtime vector does not match the installed EmbeddingSpec.',
      );
    }
  }
  return {
    kind: 'success',
    value: {
      operation: 'embeddingMutation',
      dataset: resolved.dataset,
      embedding: resolved.binding,
      mutation,
      operationDigest: mutationDigest(mutation),
    },
  };
}
