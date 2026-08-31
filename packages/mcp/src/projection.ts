import type {
  FreshnessDeclaration,
  ModelPreviewRow,
  ModelReleasedValue,
  ProvenanceEnvelope,
  ResultEnvelope,
  ResultSchemaField,
  VisibilityState,
  WriteReceipt,
} from '@agql/contracts';
import type { AgqlError } from '@agql/schemas';

import type {
  AgentRequestContext,
  CatalogPayload,
  ComponentTimings,
  ExplainPayload,
  ExplainQueryValue,
  PutRecordsPayload,
  RejectedPayload,
  RunPayload,
  RunQueryValue,
  RuntimeOutcome,
  RuntimeTimings,
  SaveQueryPayload,
  SavedQueryValue,
} from './types.ts';
import { EMPTY_RUNTIME_TIMINGS } from './types.ts';

function componentTimings(
  context: AgentRequestContext,
  timings: RuntimeTimings,
): ComponentTimings {
  return {
    authMs: context.authMs,
    validationPolicyMs: timings.validationPolicyMs,
    queryEmbeddingMs: timings.queryEmbeddingMs,
    adapterCompileMs: timings.adapterCompileMs,
    backendMs: timings.backendMs,
    fusionReleaseMs: timings.fusionReleaseMs,
  };
}

function copyErrors(
  errors: readonly [AgqlError, ...AgqlError[]],
): readonly [AgqlError, ...AgqlError[]] {
  const copied = errors.map((error): AgqlError => {
    if (error.code === 'REFERENCE_NOT_AVAILABLE') {
      return {
        code: error.code,
        message: error.message,
        path: error.path,
        alternatives: [...error.alternatives],
      };
    }
    const [first, ...rest] = error.alternatives;
    return {
      code: error.code,
      message: error.message,
      path: error.path,
      alternatives: [first, ...rest],
    };
  });
  const first = copied[0];
  if (first === undefined) throw new TypeError('A rejected outcome must contain an error.');
  return [first, ...copied.slice(1)];
}

export function rejectedPayload(
  context: AgentRequestContext,
  errors: readonly [AgqlError, ...AgqlError[]],
  timings: RuntimeTimings = EMPTY_RUNTIME_TIMINGS,
): RejectedPayload {
  return {
    status: 'rejected',
    errors: copyErrors(errors),
    timings: componentTimings(context, timings),
  };
}

function projectSchemaField(field: ResultSchemaField): ResultSchemaField {
  if (field.kind === 'money') return { ...field };
  if (field.kind === 'text') return { ...field, collation: { ...field.collation } };
  if (field.kind === 'enum') {
    return { ...field, values: field.values.map((value) => ({ ...value })) };
  }
  if (field.kind === 'instant' || field.kind === 'calendarPeriod') return { ...field };
  return { ...field };
}

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}

function projectObjectValue(
  field: ResultSchemaField,
  value: object,
): ModelReleasedValue {
  if (!isRecord(value)) throw new TypeError('Model result values cannot be arrays.');
  if (field.kind === 'money'
    && typeof value.amount === 'string'
    && typeof value.currency === 'string') {
    return { amount: value.amount, currency: value.currency } as ModelReleasedValue;
  }
  if (field.kind === 'calendarPeriod'
    && typeof value.start === 'string'
    && typeof value.endExclusive === 'string'
    && typeof value.timezone === 'string'
    && typeof value.grain === 'string'
    && typeof value.label === 'string') {
    return {
      start: value.start,
      endExclusive: value.endExclusive,
      timezone: value.timezone,
      grain: value.grain,
      label: value.label,
    } as ModelReleasedValue;
  }
  throw new TypeError(`The released value does not match schema field ${field.id}.`);
}

function projectValue(
  field: ResultSchemaField,
  value: ModelReleasedValue,
): ModelReleasedValue {
  if (value !== null && typeof value === 'object') return projectObjectValue(field, value);
  return value;
}

function projectRow(
  schema: readonly ResultSchemaField[],
  row: ModelPreviewRow,
): ModelPreviewRow {
  const projected: Record<string, ModelReleasedValue> = {};
  for (const field of schema) {
    const value = row[field.id];
    if (value !== undefined) projected[field.id] = projectValue(field, value);
  }
  return projected;
}

function projectFreshness(freshness: FreshnessDeclaration): FreshnessDeclaration {
  const writeVisibility = freshness.writeVisibility.kind === 'unconstrained'
    ? { kind: 'unconstrained' as const }
    : { kind: 'afterWrite' as const, receipt: freshness.writeVisibility.receipt };
  const snapshot = freshness.executionSnapshot;
  const executionSnapshot = snapshot.kind === 'none'
    ? { kind: 'none' as const }
    : { kind: snapshot.kind, snapshot: snapshot.snapshot };
  return { writeVisibility, executionSnapshot };
}

function projectProvenance(provenance: ProvenanceEnvelope): ProvenanceEnvelope {
  const retrieval = provenance.retrieval === undefined ? {} : {
    retrieval: {
      embeddingSpec: provenance.retrieval.embeddingSpec,
      queryVectorDigest: provenance.retrieval.queryVectorDigest,
      accuracy: provenance.retrieval.accuracy,
      ...(provenance.retrieval.fusion === undefined
        ? {}
        : { fusion: provenance.retrieval.fusion }),
      qualityProfile: provenance.retrieval.qualityProfile,
      qualityCertificationReference: provenance.retrieval.qualityCertificationReference,
    },
  };
  return {
    sourceQueryHash: provenance.sourceQueryHash,
    effectivePlanHash: provenance.effectivePlanHash,
    executionFingerprint: provenance.executionFingerprint,
    catalogVersion: provenance.catalogVersion,
    policyVersion: provenance.policyVersion,
    bindingVersion: provenance.bindingVersion,
    engineVersion: provenance.engineVersion,
    adapterVersion: provenance.adapterVersion,
    scopeFingerprint: provenance.scopeFingerprint,
    anchor: provenance.anchor,
    ...retrieval,
    replayTier: provenance.replayTier,
  };
}

/** Copies only contract fields; runtime extras can never cross into a model-channel payload. */
export function projectResultEnvelope(envelope: ResultEnvelope): ResultEnvelope {
  const schema = envelope.schema.map(projectSchemaField);
  const base = {
    schema,
    preview: envelope.preview.map((row) => projectRow(schema, row)),
    truncated: envelope.truncated,
    freshness: projectFreshness(envelope.freshness),
    principalResultAvailable: envelope.principalResultAvailable,
    provenance: projectProvenance(envelope.provenance),
  };
  if ('query' in envelope.determinism) {
    return { ...base, determinism: { query: 'exact' } };
  }
  if (base.provenance.retrieval === undefined) {
    throw new TypeError('Approximate retrieval requires retrieval provenance.');
  }
  return {
    ...base,
    determinism: { retrieval: 'approximate' },
    provenance: { ...base.provenance, retrieval: base.provenance.retrieval },
  };
}

export function projectExplainOutcome(
  context: AgentRequestContext,
  outcome: RuntimeOutcome<ExplainQueryValue>,
): ExplainPayload | RejectedPayload {
  if (!outcome.ok) return rejectedPayload(context, outcome.errors, outcome.timings);
  const value = outcome.value;
  return {
    status: 'accepted',
    sourceQueryHash: value.sourceQueryHash,
    effectivePlanHash: value.effectivePlanHash,
    resultSchema: value.resultSchema.map(projectSchemaField),
    determinism: 'query' in value.determinism
      ? { query: 'exact' }
      : { retrieval: 'approximate' },
    projection: value.projection,
    pushdown: [...value.pushdown],
    compensation: [...value.compensation],
    cost: value.cost.estimatedRows === undefined
      ? { verdict: 'ok' }
      : { verdict: 'ok', estimatedRows: value.cost.estimatedRows },
    notes: [...value.notes],
    timings: componentTimings(context, outcome.timings),
  };
}

export function projectRunOutcome(
  context: AgentRequestContext,
  outcome: RuntimeOutcome<RunQueryValue>,
): RunPayload | RejectedPayload {
  if (!outcome.ok) return rejectedPayload(context, outcome.errors, outcome.timings);
  const envelope = projectResultEnvelope(outcome.value.envelope);
  return {
    status: 'ok',
    ...envelope,
    executionReceipt: outcome.value.executionReceipt,
    timings: componentTimings(context, outcome.timings),
  };
}

function projectVisibility(state: VisibilityState): VisibilityState {
  if (state.state === 'ready') return { state: 'ready', token: state.token };
  if (state.state === 'failed') {
    return { state: 'failed', code: state.code, message: state.message };
  }
  return { state: state.state };
}

function projectWriteReceipt(receipt: WriteReceipt): WriteReceipt {
  return {
    receipt: receipt.receipt,
    records: receipt.records.map((record) => ({
      id: record.id,
      version: record.version,
      visibility: Object.fromEntries(Object.entries(record.visibility).map(([name, state]) => [
        name,
        projectVisibility(state),
      ])),
    })),
  };
}

export function projectPutOutcome(
  context: AgentRequestContext,
  outcome: RuntimeOutcome<WriteReceipt>,
): PutRecordsPayload | RejectedPayload {
  return outcome.ok
    ? {
      status: 'accepted',
      writeReceipt: projectWriteReceipt(outcome.value),
      timings: componentTimings(context, outcome.timings),
    }
    : rejectedPayload(context, outcome.errors, outcome.timings);
}

export function projectSaveOutcome(
  context: AgentRequestContext,
  outcome: RuntimeOutcome<SavedQueryValue>,
): SaveQueryPayload | RejectedPayload {
  if (!outcome.ok) return rejectedPayload(context, outcome.errors, outcome.timings);
  return {
    status: 'accepted',
    savedQuery: {
      source: outcome.value.source,
      name: outcome.value.name,
      sourceQueryHash: outcome.value.sourceQueryHash,
      effectivePlanHash: outcome.value.effectivePlanHash,
    },
    timings: componentTimings(context, outcome.timings),
  };
}

export function catalogPayload<T>(
  context: AgentRequestContext,
  value: T,
): CatalogPayload<T> {
  return {
    status: 'ok',
    value,
    timings: componentTimings(context, EMPTY_RUNTIME_TIMINGS),
  };
}
