import type {
  ExpandedScope,
  LogicalFilter,
  ResolvedPredicate,
  ResolvedProjection,
  ResolvedFieldBinding,
  RetrieveLogicalPlan,
  ResultSchemaField,
} from '@agql/contracts';
import type { NormalizedText, RetrieveQuery, SafeInteger } from '@agql/schemas';
import { NormalizedTextSchema } from '@agql/schemas';

import type { CompileContext } from './compile-context.ts';
import { fail, repairableError, semanticError } from './errors.ts';
import { authorizedEmbedding, authorizedField } from './policy.ts';
import { fieldResultShape } from './result-shape.ts';
import type {
  EngineResult,
  QualityCertification,
} from './types.ts';

export interface RetrievePlanOutput {
  readonly plan: RetrieveLogicalPlan;
  readonly resultShape: readonly ResultSchemaField[];
  readonly qualityCertification: QualityCertification;
}

interface LexicalSearchInput {
  readonly field: ResolvedFieldBinding;
  readonly text: NormalizedText;
}

function compileLexicalSearch(
  context: CompileContext,
  query: Extract<RetrieveQuery['search'], { readonly kind: 'hybrid' }>,
): EngineResult<LexicalSearchInput> {
  const lexical = authorizedField(
    context,
    query.lexical.field,
    'lexicalSearch',
    '/search/lexical/field',
  );
  if (!lexical.ok) return lexical;
  if (lexical.value.type.kind !== 'text') {
    return fail(semanticError(
      'Hybrid lexical search requires a text field.',
      '/search/lexical/field',
      ['Use an available text field.'],
    ));
  }
  const text = NormalizedTextSchema.safeParse(query.lexical.text);
  if (!text.success) {
    return fail(semanticError(
      'Hybrid lexical text must use Unicode NFC normalization.',
      '/search/lexical/text',
      ['Provide NFC-normalized text.'],
    ));
  }
  return { ok: true, value: { field: lexical.value, text: text.data } };
}

export function buildRetrievePlan(
  context: CompileContext,
  query: RetrieveQuery,
  scope: ExpandedScope,
  filter: LogicalFilter<ResolvedPredicate> | undefined,
): EngineResult<RetrievePlanOutput> {
  const seen = new Set<string>();
  const projection: ResolvedProjection[] = [];
  const resultShape: ResultSchemaField[] = [];
  for (const [index, fieldId] of query.select.entries()) {
    if (seen.has(fieldId)) {
      return fail(semanticError(
        'Every selected output id must be unique.',
        `/select/${index}`,
        ['Select each field at most once.'],
      ));
    }
    seen.add(fieldId);
    const field = authorizedField(context, fieldId, 'select', `/select/${index}`);
    if (!field.ok) return field;
    projection.push({
      output: { logicalId: fieldId, slot: index as SafeInteger },
      field: field.value,
    });
    const document = context.dataset.fields[fieldId];
    if (document === undefined) {
      return fail(semanticError(
        'The selected field is missing from the validated catalog.',
        `/select/${index}`,
        ['Use a field in the effective catalog.'],
      ));
    }
    resultShape.push(fieldResultShape(fieldId, document));
  }
  const firstProjection = projection[0];
  if (firstProjection === undefined) {
    return fail(semanticError(
      'Retrieval projection must contain at least one field.',
      '/select',
      ['Select at least one available field.'],
    ));
  }
  const stableId = authorizedField(context, context.dataset.idField, 'order', '/from');
  if (!stableId.ok) return stableId;
  const using = query.search.kind === 'semantic'
    ? query.search.using
    : query.search.semantic.using;
  const embedding = authorizedEmbedding(context, using, '/search/using');
  if (!embedding.ok) return embedding;
  const lexical = query.search.kind === 'hybrid'
    ? compileLexicalSearch(context, query.search)
    : undefined;
  if (lexical !== undefined && !lexical.ok) return lexical;
  const vector = context.input.vector;
  if (vector === undefined) {
    return fail(semanticError(
      'A policy-authorized runtime-owned query vector is required.',
      '/search/text',
      ['Generate the vector with the runtime embedder for this EmbeddingSpec.'],
    ));
  }
  if (vector.dimension !== embedding.value.binding.dimension
    || vector.encoding !== embedding.value.binding.vectorEncoding) {
    return fail(semanticError(
      'The runtime-owned vector does not match the resolved EmbeddingSpec.',
      '/search/text',
      ['Generate the vector with the embedder bound to this exact EmbeddingSpec.'],
    ));
  }
  const bytesPerDimension = vector.encoding === 'float64'
    ? 8
    : vector.encoding === 'float32'
      ? 4
      : vector.encoding === 'int8'
        ? 1
        : undefined;
  const expectedBytes = bytesPerDimension === undefined
    ? Math.ceil(vector.dimension / 8)
    : vector.dimension * bytesPerDimension;
  if (vector.bytes.byteLength !== expectedBytes || vector.digest.length === 0) {
    return fail(semanticError(
      'The runtime-owned vector byte length or digest violates its encoding contract.',
      '/search/text',
      ['Regenerate the query vector with the exact runtime-owned embedder.'],
    ));
  }
  const certification = context.input.qualityCertifications.find((candidate) =>
    candidate.profile === query.search.quality
    && candidate.embeddingSpec === embedding.value.binding.specReference
    && candidate.adapterId === context.input.adapter.id
    && candidate.adapterVersion === context.input.adapter.version);
  if (certification === undefined) {
    return fail(repairableError(
      'FILTER_SHAPE_UNCERTIFIED',
      'No current quality certification covers this retrieval profile and binding.',
      '/search/quality',
      ['Choose a certified quality profile.'],
      'Certify this adapter, EmbeddingSpec, and quality profile together.',
    ));
  }
  if (certification.reference.length === 0) {
    return fail(semanticError(
      'A quality certification reference must be nonempty.',
      '/qualityCertifications',
      ['Provide a durable certification reference.'],
    ));
  }
  const hardCandidateLimit = context.scope.budgets.maximumCandidateRecords;
  if (hardCandidateLimit < query.take || hardCandidateLimit === 0) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The candidate budget cannot satisfy the requested take.',
      '/take',
      ['Lower take or use a scope with a larger candidate budget.'],
      'Lower take to fit the authorized candidate budget.',
    ));
  }
  const base = {
    languageVersion: '0' as const,
    mode: 'retrieve' as const,
    sourceQueryHash: context.sourceQueryHash,
    effectivePlanHash: context.effectivePlanHash,
    dataset: {
      logicalId: context.datasetId,
      physical: context.binding.physical,
      bindingVersion: context.input.binding.version,
    },
    scope,
    ...(filter === undefined ? {} : { filter }),
    hardRowLimit: query.take,
    take: query.take,
    projection: [firstProjection, ...projection.slice(1)] as const,
    stableId: stableId.value,
  };
  let plan: RetrieveLogicalPlan;
  if (query.search.kind === 'semantic') {
    plan = {
      ...base,
      profile: 'retrieve.semantic.v0',
      search: {
        kind: 'semantic',
        embedding: embedding.value.binding,
        vector,
        accuracy: query.search.accuracy,
        qualityProfile: query.search.quality,
        hardCandidateLimit,
      },
    };
  } else {
    if (lexical?.ok !== true) {
      return fail(semanticError(
        'Hybrid lexical search was not resolved.',
        '/search/lexical',
        ['Use a policy-authorized text field.'],
      ));
    }
    plan = {
      ...base,
      profile: 'retrieve.hybrid.v0',
      search: {
        kind: 'hybrid',
        embedding: embedding.value.binding,
        vector,
        accuracy: 'approximate',
        lexical: {
          field: lexical.value.field,
          text: lexical.value.text,
          semantics: 'escaped-case-sensitive-substring',
        },
        fusion: 'rrf-v0',
        qualityProfile: query.search.quality,
        hardCandidateLimit,
      },
    };
  }
  return {
    ok: true,
    value: {
      plan,
      resultShape: [
        ...resultShape,
        { id: 'rank', kind: 'rank', nullable: false },
      ],
      qualityCertification: certification,
    },
  };
}
