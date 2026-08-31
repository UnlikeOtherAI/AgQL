import type {
  AdapterRow,
  FreshnessDeclaration,
  ModelPreviewRow,
  ModelReleasedValue,
  ProvenanceEnvelope,
  ResolvedOutputBinding,
  ResultEnvelope,
  ResultSchemaField,
  ResultValue,
  TypedValue,
} from '@agql/contracts';
import { executionFingerprint } from '@agql/schemas';

import { fail, repairableError, semanticError } from './errors.ts';
import { evaluateAfterWrite } from './receipts.ts';
import type {
  EngineResult,
  QueryExecutionOutput,
  ResultAssemblyInput,
} from './types.ts';

function outputBindings(input: ResultAssemblyInput): readonly ResolvedOutputBinding[] {
  const plan = input.compiled.plan;
  if (plan.mode === 'aggregate') {
    return [
      ...plan.dimensions.map(({ output }) => output),
      ...plan.metrics.map(({ output }) => output),
    ];
  }
  return plan.projection.map(({ output }) => output);
}

function resultValue(value: TypedValue): ResultValue {
  return value.value;
}

function releaseValue(value: TypedValue): ModelReleasedValue {
  return resultValue(value) as ModelReleasedValue;
}

function valueMatchesSchema(value: TypedValue, schema: ResultSchemaField): boolean {
  if (value.kind === 'null') return schema.nullable;
  if (schema.kind === 'rank' || schema.kind === 'calendarPeriod') return false;
  if (schema.kind === 'text') return value.kind === 'text';
  if (schema.kind === 'enum') return value.kind === 'enum';
  return schema.kind === value.kind;
}

function releaseRow(
  row: AdapterRow,
  rank: number | undefined,
  bindings: readonly ResolvedOutputBinding[],
  schema: readonly ResultSchemaField[],
  path: string,
): EngineResult<ModelPreviewRow> {
  if (row.length !== bindings.length) {
    return fail(semanticError(
      'The adapter row width does not match the resolved output slots.',
      path,
      ['Return exactly one typed value for every resolved output slot.'],
    ));
  }
  const released: Record<string, ModelReleasedValue> = {};
  for (const binding of bindings) {
    const value = row[binding.slot];
    const field = schema.find(({ id }) => id === binding.logicalId);
    if (value === undefined || field === undefined || !valueMatchesSchema(value, field)) {
      return fail(semanticError(
        'The adapter returned a value that violates the result-shape contract.',
        `${path}/${binding.slot}`,
        ['Return the resolved typed value at its assigned output slot.'],
      ));
    }
    released[binding.logicalId] = releaseValue(value);
  }
  const rankField = schema.find(({ kind }) => kind === 'rank');
  if (rankField !== undefined) {
    if (rank === undefined || !Number.isSafeInteger(rank) || rank <= 0) {
      return fail(semanticError(
        'Retrieval rows require a positive safe-integer rank.',
        `${path}/rank`,
        ['Return one rank per retrieval row.'],
      ));
    }
    released[rankField.id] = rank as ModelReleasedValue;
  }
  return { ok: true, value: released };
}

function encodedRowsBytes(rows: readonly AdapterRow[]): number {
  const encoder = new TextEncoder();
  return rows.reduce((total, row) => total + encoder.encode(JSON.stringify(row)).byteLength, 0);
}

function snapshotDeclaration(input: ResultAssemblyInput): EngineResult<{
  readonly freshness: FreshnessDeclaration['executionSnapshot'];
  readonly fingerprint: ResultAssemblyInput['execution']['snapshot'];
}> {
  const snapshot = input.execution.snapshot;
  if (input.executionSnapshotTier === 'none') {
    if (snapshot.kind !== 'none') {
      return fail(semanticError(
        'Snapshot evidence was returned for a declaration of none.',
        '/execution/snapshot',
        ['Declare the certified snapshot tier used by this execution.'],
      ));
    }
    return { ok: true, value: { freshness: { kind: 'none' }, fingerprint: snapshot } };
  }
  if (snapshot.kind === 'none') {
    return fail(semanticError(
      'A declared snapshot tier requires adapter snapshot evidence.',
      '/execution/snapshot',
      ['Return a snapshot or watermark value.'],
    ));
  }
  return {
    ok: true,
    value: {
      freshness: { kind: input.executionSnapshotTier, snapshot: snapshot.value },
      fingerprint: snapshot,
    },
  };
}

function releasedIndexes(input: ResultAssemblyInput): EngineResult<ReadonlySet<number>> {
  const policies = input.release.policies.filter(({ channel }) => channel === 'model');
  if (policies.length === 0) {
    return { ok: true, value: new Set(input.execution.rows.map((_, index) => index)) };
  }
  const counts = input.cohortCounts;
  if (counts?.length !== input.execution.rows.length) {
    return fail(semanticError(
      'minimumCohort release requires one trusted cohort count per result row.',
      '/cohortCounts',
      ['Provide bounded cohort counts from the authorized aggregate execution.'],
    ));
  }
  const minimum = Math.max(...policies.map(({ minimum: value }) => value));
  return {
    ok: true,
    value: new Set(counts.flatMap((count, index) => count >= minimum ? [index] : [])),
  };
}

function validateAssemblyInput(input: ResultAssemblyInput): EngineResult<true> {
  const numericInputs = [
    input.release.previewRowLimit,
    input.compiled.explain.cost.maximumIntermediateBytes,
    input.timings.authMs,
    input.timings.validationPolicyMs,
    input.timings.queryEmbeddingMs,
    input.timings.adapterCompileMs,
    input.timings.backendMs,
    input.timings.fusionReleaseMs,
  ];
  if (numericInputs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return fail(semanticError(
      'Release limits and component timings must be nonnegative safe integers.',
      '/release',
      ['Provide validated nonnegative safe-integer measurements and limits.'],
    ));
  }
  if (input.release.policies.some(({ minimum }) =>
    !Number.isSafeInteger(minimum) || minimum <= 0)) {
    return fail(semanticError(
      'minimumCohort must be a positive safe integer.',
      '/release/policies',
      ['Use a positive cohort threshold.'],
    ));
  }
  const retrieval = input.compiled.plan.mode === 'retrieve';
  if (retrieval && input.execution.ranks?.length !== input.execution.rows.length) {
    return fail(semanticError(
      'Retrieval execution requires exactly one rank per row.',
      '/execution/ranks',
      ['Return a complete bounded rank list.'],
    ));
  }
  if (!retrieval && input.execution.ranks !== undefined) {
    return fail(semanticError(
      'Ranks are permitted only for retrieval results.',
      '/execution/ranks',
      ['Remove ranks from records or aggregate execution.'],
    ));
  }
  if (input.cohortCounts?.some((count) =>
    !Number.isSafeInteger(count) || count < 0) === true) {
    return fail(semanticError(
      'Cohort counts must be nonnegative safe integers.',
      '/cohortCounts',
      ['Provide validated cohort counts.'],
    ));
  }
  return { ok: true, value: true };
}

function provenance(
  input: ResultAssemblyInput,
  snapshot: ResultAssemblyInput['execution']['snapshot'],
): EngineResult<ProvenanceEnvelope> {
  const plan = input.compiled.plan;
  const certification = input.compiled.qualityCertification;
  if (plan.mode === 'retrieve' && certification === undefined) {
    return fail(semanticError(
      'Retrieval provenance requires the compile-time quality certification.',
      '/provenance/retrieval',
      ['Compile with a matching quality certification.'],
    ));
  }
  const embeddingSpec = plan.mode === 'retrieve'
    ? {
      reference: plan.search.embedding.specReference,
      specVersion: plan.search.embedding.specVersion,
      model: plan.search.embedding.model,
      inputTransformId: plan.search.embedding.inputTransformId,
    }
    : undefined;
  const qualityProfile = plan.mode === 'retrieve' ? plan.search.qualityProfile : undefined;
  const fingerprint = executionFingerprint({
    effectivePlanHash: plan.effectivePlanHash,
    bindingVersion: input.compiled.bindingVersion,
    engineVersion: input.engineVersion,
    adapterVersion: input.adapterVersion,
    anchor: input.compiled.anchor,
    snapshot,
    ...(embeddingSpec === undefined ? {} : { embeddingSpec }),
    ...(qualityProfile === undefined ? {} : { qualityProfile }),
    channelPolicyFingerprint: input.release.channelPolicyFingerprint,
  });
  let retrieval: ProvenanceEnvelope['retrieval'];
  if (plan.mode === 'retrieve' && certification !== undefined) {
    retrieval = {
      embeddingSpec: plan.search.embedding.specReference,
      queryVectorDigest: plan.search.vector.digest,
      accuracy: plan.search.accuracy,
      ...(plan.search.kind === 'hybrid' ? { fusion: 'rrf-v0' as const } : {}),
      qualityProfile: plan.search.qualityProfile,
      qualityCertificationReference: certification.reference,
    };
  }
  return {
    ok: true,
    value: {
      sourceQueryHash: plan.sourceQueryHash,
      effectivePlanHash: plan.effectivePlanHash,
      executionFingerprint: fingerprint,
      catalogVersion: input.compiled.catalogVersion,
      policyVersion: input.compiled.policyVersion,
      bindingVersion: input.compiled.bindingVersion,
      engineVersion: input.engineVersion,
      adapterVersion: input.adapterVersion,
      scopeFingerprint: input.compiled.scopeFingerprint,
      anchor: input.compiled.anchor,
      ...(retrieval === undefined ? {} : { retrieval }),
      replayTier: input.replayTier,
    },
  };
}

export function assembleResult(
  input: ResultAssemblyInput,
): EngineResult<QueryExecutionOutput> {
  const boundary = validateAssemblyInput(input);
  if (!boundary.ok) return boundary;
  if (input.compiled.channel !== 'model') {
    return fail(semanticError(
      'A principal-channel compilation cannot be assembled into a model envelope.',
      '/channel',
      ['Compile separately for the model channel.'],
    ));
  }
  if (input.adapterVersion !== input.compiled.adapterVersion) {
    return fail(semanticError(
      'The execution adapter version differs from the compiled version.',
      '/adapterVersion',
      ['Execute with the exact compiled adapter version.'],
    ));
  }
  if (input.execution.rows.length > input.compiled.plan.hardRowLimit
    || encodedRowsBytes(input.execution.rows)
      > input.compiled.explain.cost.maximumIntermediateBytes) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The adapter exceeded a mandatory bounded-result backstop.',
      '/execution/rows',
      ['Return no more than the compiled row and byte limits.'],
      'Enforce the hard backend limit before rows cross the adapter boundary.',
    ));
  }
  if (input.compiled.afterWrite !== undefined) {
    if (input.observedReceipt === undefined) {
      return fail(repairableError(
        'AFTER_WRITE_TIMEOUT',
        'No certified receipt observation accompanies this afterWrite result.',
        '/afterWrite',
        ['Observe every required state before result assembly.'],
        'Wait for certified visibility and provide the observed receipt.',
      ));
    }
    const visible = evaluateAfterWrite(input.compiled.afterWrite, input.observedReceipt);
    if (!visible.ok) return visible;
  }
  const snapshot = snapshotDeclaration(input);
  if (!snapshot.ok) return snapshot;
  const released = releasedIndexes(input);
  if (!released.ok) return released;
  const bindings = outputBindings(input);
  const previewRows: ModelPreviewRow[] = [];
  for (const [index, row] of input.execution.rows.entries()) {
    if (!released.value.has(index)) continue;
    const rank = input.execution.ranks?.[index];
    const preview = releaseRow(
      row,
      rank,
      bindings,
      input.compiled.explain.resultShape,
      `/execution/rows/${index}`,
    );
    if (!preview.ok) return preview;
    previewRows.push(preview.value);
  }
  const preview = previewRows.slice(0, input.release.previewRowLimit);
  let writeVisibility: FreshnessDeclaration['writeVisibility'];
  if (input.compiled.afterWrite === undefined) {
    writeVisibility = { kind: 'unconstrained' };
  } else {
    const receipt = input.observedReceipt;
    if (receipt === undefined) {
      return fail(repairableError(
        'AFTER_WRITE_TIMEOUT',
        'The certified observed receipt is absent at result assembly.',
        '/afterWrite',
        ['Provide the receipt returned by certified visibility observation.'],
        'Observe every required state before result assembly.',
      ));
    }
    writeVisibility = { kind: 'afterWrite', receipt: receipt.receipt };
  }
  const provenanceResult = provenance(input, snapshot.value.fingerprint);
  if (!provenanceResult.ok) return provenanceResult;
  const provenanceValue = provenanceResult.value;
  const base = {
    schema: input.compiled.explain.resultShape,
    preview,
    truncated: input.execution.truncated || previewRows.length > preview.length,
    freshness: {
      writeVisibility,
      executionSnapshot: snapshot.value.freshness,
    },
    principalResultAvailable: input.principalResultAvailable,
  };
  let result: ResultEnvelope;
  if ('retrieval' in input.compiled.explain.determinism) {
    const retrieval = provenanceValue.retrieval;
    if (retrieval === undefined || retrieval.qualityCertificationReference.length === 0) {
      return fail(semanticError(
        'Approximate retrieval requires complete certified provenance.',
        '/provenance/retrieval',
        ['Provide the matching quality certification reference.'],
      ));
    }
    result = {
      ...base,
      determinism: { retrieval: 'approximate' },
      provenance: { ...provenanceValue, retrieval },
    };
  } else {
    result = { ...base, determinism: { query: 'exact' }, provenance: provenanceValue };
  }
  return { ok: true, value: { result, timings: input.timings } };
}
