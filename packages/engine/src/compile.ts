import { ScopeSchema, validateCatalog } from '@agql/catalog';
import type {
  CapabilityProfile,
  QueryDocument,
} from '@agql/schemas';
import {
  effectivePlanHash,
  fingerprintScope,
  InstantValueSchema,
  validateAndCanonicalizeQuery,
} from '@agql/schemas';

import type { CompileContext } from './compile-context.ts';
import { applyCostGate } from './cost.ts';
import {
  fail,
  repairableError,
  semanticError,
  unavailableReference,
} from './errors.ts';
import { validateDeploymentLimits } from './limits.ts';
import { buildAggregatePlan } from './plan-aggregate.ts';
import { buildRecordsPlan } from './plan-records.ts';
import { buildRetrievePlan } from './plan-retrieve.ts';
import { compileEffectiveFilter } from './predicates.ts';
import { expandScope } from './scope.ts';
import type {
  CompileOutput,
  CompileQueryInput,
  CompensationOperation,
  EngineResult,
  QualityCertification,
  QueryExplain,
} from './types.ts';

function requiredProfile(query: QueryDocument): CapabilityProfile {
  if (query.mode === 'records') return 'records.v0';
  if (query.mode === 'aggregate') return 'aggregate.v0';
  return query.search.kind === 'semantic'
    ? 'retrieve.semantic.v0'
    : 'retrieve.hybrid.v0';
}

function profileAvailable(context: CompileContext, profile: CapabilityProfile): EngineResult<true> {
  if (context.dataset.profiles.includes(profile)
    && context.input.adapter.profiles.includes(profile)) {
    return { ok: true, value: true };
  }
  return fail(repairableError(
    'UNSUPPORTED_PROFILE',
    'The dataset and adapter do not both advertise the required capability profile.',
    '/mode',
    ['Choose a source advertising the required profile.'],
    `Route the query to a source advertising ${profile}.`,
  ));
}

function validateAfterWrite(
  context: CompileContext,
): EngineResult<CompileOutput['afterWrite']> {
  const requirement = context.query.afterWrite;
  if (requirement === undefined) return { ok: true, value: undefined };
  if (context.input.adapter.consistency.afterWrite !== 'certified') {
    return fail(repairableError(
      'FRESHNESS_UNAVAILABLE',
      'This adapter deployment cannot certify afterWrite visibility.',
      '/afterWrite',
      ['Remove afterWrite explicitly.', 'Choose a certified binding.'],
      'Choose a binding certified for afterWrite or remove the requirement explicitly.',
    ));
  }
  if (context.query.mode === 'retrieve') {
    const using = context.query.search.kind === 'semantic'
      ? context.query.search.using
      : context.query.search.semantic.using;
    const embeddingRequirements = requirement.require.filter((name) =>
      name.startsWith('embedding:'));
    if (embeddingRequirements.length > 0
      && !embeddingRequirements.includes(`embedding:${using}`)) {
      return fail(repairableError(
        'FRESHNESS_UNAVAILABLE',
        'afterWrite names a different EmbeddingSpec version than this retrieval.',
        '/afterWrite/require',
        [`embedding:${using}`],
        'Require visibility of the exact EmbeddingSpec version used by the query.',
      ));
    }
  }
  const first = requirement.require[0];
  if (first === undefined) {
    return fail(semanticError(
      'afterWrite requires at least one named visibility state.',
      '/afterWrite/require',
      ['Name at least one required state.'],
    ));
  }
  return {
    ok: true,
    value: {
      receipt: requirement.receipt,
      require: [first, ...requirement.require.slice(1)],
      timeoutMs: requirement.timeoutMs,
      anchor: context.input.anchor,
    },
  };
}

function compensationFor(): readonly CompensationOperation[] {
  const common: CompensationOperation[] = [
    'finalProjectionAndRedaction',
    'canonicalScalarConversion',
  ];
  return common;
}

function explain(
  context: CompileContext,
  profile: CapabilityProfile,
  resultShape: QueryExplain['resultShape'],
): QueryExplain {
  const approximate = context.query.mode === 'retrieve'
    && (context.query.search.kind === 'hybrid'
      || context.query.search.accuracy === 'approximate');
  return {
    profile,
    cost: {
      ...context.input.costGate.estimate,
      verdict: 'admitted',
      maximumEstimatedRows: context.input.costGate.maximumEstimatedRows,
      maximumIntermediateBytes: context.input.costGate.maximumIntermediateBytes,
    },
    resultShape,
    pushdown: context.query.mode === 'aggregate'
      ? ['scope', 'filter', 'aggregate', 'order', 'limit']
      : context.query.mode === 'retrieve'
        ? ['scope', 'filter', 'retrieval', 'limit']
        : ['scope', 'filter', 'order', 'limit'],
    compensation: compensationFor(),
    determinism: approximate
      ? { retrieval: 'approximate' }
      : { query: 'exact' },
  };
}

function retrievalAccuracy(query: QueryDocument): 'exact' | 'approximate' | undefined {
  if (query.mode !== 'retrieve') return undefined;
  return query.search.kind === 'hybrid' ? 'approximate' : query.search.accuracy;
}

export function compileQuery(input: CompileQueryInput): EngineResult<CompileOutput> {
  const validated = validateAndCanonicalizeQuery(input.query);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const limits = validateDeploymentLimits(validated.value.document, input.limits);
  if (!limits.ok) return limits;
  const catalog = validateCatalog(input.catalog);
  if (!catalog.ok) return { ok: false, errors: catalog.errors };
  const scope = ScopeSchema.safeParse(input.scope);
  if (!scope.success) {
    return fail(semanticError(
      'The server-resolved scope is invalid.',
      '/scope',
      ['Resolve a scope accepted by the catalog scope schema.'],
    ));
  }
  const anchor = InstantValueSchema.safeParse(input.anchor);
  if (!anchor.success) {
    return fail(semanticError(
      'Compilation requires an explicit canonical anchor.',
      '/anchor',
      ['Provide an RFC 3339 UTC instant.'],
    ));
  }
  if (new Date(anchor.data).getTime() >= new Date(scope.data.expiresAt).getTime()) {
    return fail(semanticError(
      'The scope is expired at the explicit execution anchor.',
      '/scope/expiresAt',
      ['Use a scope valid at the execution anchor.'],
    ));
  }
  const dataset = catalog.value.datasets[validated.value.document.from];
  const binding = input.binding.datasets[validated.value.document.from];
  if (dataset === undefined || binding === undefined) {
    return fail(unavailableReference('/from'));
  }
  const scopeFingerprint = fingerprintScope(scope.data);
  const planHash = effectivePlanHash({
    sourceQueryHash: validated.value.sourceQueryHash,
    languageVersion: '0',
    catalogVersion: catalog.value.catalogVersion,
    policyVersion: catalog.value.policyVersion,
    scopeFingerprint,
  });
  const context: CompileContext = {
    input: {
      ...input,
      catalog: catalog.value,
      scope: scope.data,
      anchor: anchor.data,
    },
    query: validated.value.document,
    datasetId: validated.value.document.from,
    dataset,
    binding,
    scope: scope.data,
    scopeFingerprint,
    sourceQueryHash: validated.value.sourceQueryHash,
    effectivePlanHash: planHash,
  };
  const profile = requiredProfile(context.query);
  const available = profileAvailable(context, profile);
  if (!available.ok) return available;
  const afterWrite = validateAfterWrite(context);
  if (!afterWrite.ok) return afterWrite;
  const expandedScope = expandScope(context);
  if (!expandedScope.ok) return expandedScope;
  const filter = compileEffectiveFilter(context);
  if (!filter.ok) return filter;
  let planOutput: {
    readonly plan: CompileOutput['plan'];
    readonly resultShape: QueryExplain['resultShape'];
    readonly qualityCertification?: QualityCertification;
  };
  if (context.query.mode === 'records') {
    const built = buildRecordsPlan(context, context.query, expandedScope.value, filter.value);
    if (!built.ok) return built;
    planOutput = built.value;
  } else if (context.query.mode === 'aggregate') {
    const built = buildAggregatePlan(context, context.query, expandedScope.value, filter.value);
    if (!built.ok) return built;
    planOutput = built.value;
  } else {
    const built = buildRetrievePlan(context, context.query, expandedScope.value, filter.value);
    if (!built.ok) return built;
    planOutput = built.value;
  }
  const cost = applyCostGate(
    input,
    context.query.mode,
    retrievalAccuracy(context.query),
    expandedScope.value,
  );
  if (!cost.ok) return cost;
  return {
    ok: true,
    value: {
      plan: planOutput.plan,
      explain: explain(context, profile, planOutput.resultShape),
      sourceCanonical: validated.value.canonical,
      scopeFingerprint,
      catalogVersion: catalog.value.catalogVersion,
      policyVersion: catalog.value.policyVersion,
      bindingVersion: input.binding.version,
      adapterId: input.adapter.id,
      adapterVersion: input.adapter.version,
      anchor: input.anchor,
      channel: input.channel,
      ...(afterWrite.value === undefined ? {} : { afterWrite: afterWrite.value }),
      ...(planOutput.qualityCertification === undefined
        ? {}
        : { qualityCertification: planOutput.qualityCertification }),
    },
  };
}
