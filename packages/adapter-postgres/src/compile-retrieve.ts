import type {
  AdapterOutcome,
  ResolvedProjection,
  RetrieveLogicalPlan,
  SemanticRetrieveLogicalPlan,
} from '@agql/contracts';
import type { SafeInteger } from '@agql/schemas';

import { refusal, unsafePlan } from './refusals.ts';
import type { RuntimeRegistry } from './registry.ts';
import {
  internalColumn,
  quoteCollation,
  quoteIdentifier,
  quoteQualified,
} from './sql-identifiers.ts';
import { selectedFieldSql, validateContiguousSlots } from './sql-output.ts';
import {
  eligibilitySql,
  fieldExpression,
  filterShapeCertified,
  SqlCompilationError,
} from './sql-predicates.ts';
import { escapeLike, ParameterBuilder } from './sql-parameters.ts';
import type {
  CompiledPostgresQuery,
  PostgresDatasetBinding,
  PostgresEmbeddingBinding,
  PostgresQualityProfile,
  SqlStatement,
} from './types.ts';
import { pgvectorParameter } from './vector.ts';

const RRF_K = 60;

function distanceOperator(metric: PostgresEmbeddingBinding['embedding']['metric']): string {
  if (metric === 'cosine') return '<=>';
  if (metric === 'dot') return '<#>';
  return '<->';
}

function commonValidation(
  plan: RetrieveLogicalPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<{
  readonly dataset: PostgresDatasetBinding;
  readonly embedding: PostgresEmbeddingBinding;
  readonly quality: PostgresQualityProfile;
  readonly vector: string;
}> {
  const dataset = registry.dataset(plan.dataset);
  if (dataset === undefined) {
    return refusal(
      'SCOPE_UNENFORCEABLE',
      'The resolved dataset binding is not installed in this PostgreSQL adapter.',
      '/from',
      ['Use an installed, scope-certified dataset binding.'],
      'Install the resolved dataset binding before executing this plan.',
    );
  }
  const embedding = registry.embedding(dataset, plan.search.embedding);
  if (embedding === undefined || plan.search.embedding.vectorEncoding !== 'float32') {
    return refusal(
      'EMBEDDING_NOT_INDEXED',
      'The resolved EmbeddingSpec is not indexed by this PostgreSQL binding.',
      '/search/using',
      ['Use an indexed float32 EmbeddingSpec.'],
      'Provision and populate the exact resolved EmbeddingSpec before querying it.',
    );
  }
  const quality = registry.quality(plan.search.qualityProfile);
  if (quality === undefined) {
    return refusal(
      'COST_GATE_REFUSAL',
      'The logical retrieval quality profile is not configured for this adapter.',
      '/search/quality',
      ['Use a configured logical quality profile.'],
      'Select a quality profile from the scope-filtered source capabilities.',
    );
  }
  if (!filterShapeCertified(plan.scope, plan.filter, quality)) {
    return refusal(
      'FILTER_SHAPE_UNCERTIFIED',
      'The retrieval quality profile has not certified this effective filter shape.',
      '/filter',
      ['Use predicates certified by the selected logical quality profile.'],
      'Choose a certified filter shape or a quality profile certified for this shape.',
    );
  }
  if (plan.take < 1 || plan.take > plan.hardRowLimit
    || plan.search.hardCandidateLimit <= plan.take) {
    return unsafePlan(
      '/take',
      'Retrieval requires take below both the row and hard candidate limits.',
    );
  }
  if (registry.field(dataset, plan.stableId) === undefined
    || plan.stableId.physical !== dataset.idField.physical) {
    return unsafePlan('/order', 'Retrieval stableId must be the installed dataset id field.');
  }
  const slots = plan.projection.map((projection) => projection.output.slot);
  if (!validateContiguousSlots(slots)) {
    return unsafePlan('/select', 'Resolved output slots must be unique and contiguous from zero.');
  }
  const vector = pgvectorParameter(plan.search.vector, registry.config.vectorByteOrder);
  if (vector === undefined
    || plan.search.vector.dimension !== embedding.embedding.dimension
    || plan.search.vector.encoding !== embedding.embedding.vectorEncoding) {
    return unsafePlan('/search/vector', 'The runtime vector does not match its EmbeddingSpec.');
  }
  return { kind: 'success', value: { dataset, embedding, quality, vector } };
}

function sortedProjection(plan: RetrieveLogicalPlan): readonly ResolvedProjection[] {
  return [...plan.projection].sort((left, right) => left.output.slot - right.output.slot);
}

function projectionSql(
  plan: RetrieveLogicalPlan,
  registry: RuntimeRegistry,
  dataset: PostgresDatasetBinding,
): readonly string[] {
  return sortedProjection(plan).map((projection, index) => {
    if (registry.field(dataset, projection.field) === undefined) {
      throw new SqlCompilationError('A projected field is not in the dataset binding.', '/select');
    }
    return `${selectedFieldSql({ registry, dataset, alias: 'd' }, projection.field)} `
      + `AS ${internalColumn(index)}`;
  });
}

function finalColumns(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `r.${internalColumn(index)}`);
}

function admissionStatement(
  plan: SemanticRetrieveLogicalPlan,
  registry: RuntimeRegistry,
  dataset: PostgresDatasetBinding,
  embedding: PostgresEmbeddingBinding,
  limit: SafeInteger,
): SqlStatement {
  const parameters = new ParameterBuilder();
  const context = { registry, dataset, alias: 'd', parameters };
  const eligibility = eligibilitySql(context, plan.scope, plan.filter);
  const probeLimit = parameters.add(limit + 1, 'bigint');
  const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
  const vectorColumn = `d.${quoteIdentifier(embedding.embedding.physical)}`;
  return {
    text: 'SELECT COUNT(*)::text FROM ('
      + `SELECT 1 FROM ${table} AS d WHERE (${eligibility}) `
      + `AND ${vectorColumn} IS NOT NULL LIMIT ${probeLimit}) AS admitted`,
    values: parameters.values,
  };
}

function compileSemantic(
  plan: SemanticRetrieveLogicalPlan,
  registry: RuntimeRegistry,
  validated: Extract<ReturnType<typeof commonValidation>, { readonly kind: 'success' }>['value'],
): CompiledPostgresQuery {
  const { dataset, embedding, quality, vector } = validated;
  const parameters = new ParameterBuilder();
  const context = { registry, dataset, alias: 'd', parameters };
  const eligibility = eligibilitySql(context, plan.scope, plan.filter);
  const projection = projectionSql(plan, registry, dataset);
  const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
  const vectorColumn = `d.${quoteIdentifier(embedding.embedding.physical)}`;
  const queryVector = parameters.add(vector, 'vector');
  const distance = `${vectorColumn} ${distanceOperator(embedding.embedding.metric)} ${queryVector}`;
  const stableId = fieldExpression({ registry, dataset, alias: 'd' }, plan.stableId);
  const candidateLimit = parameters.add(plan.search.hardCandidateLimit, 'bigint');
  const outputCount = projection.length;
  const candidate = `SELECT ${projection.join(', ')}, ${stableId} AS "_agql_id", `
    + `${distance} AS "_agql_distance" FROM ${table} AS d `
    + `WHERE (${eligibility}) AND ${vectorColumn} IS NOT NULL `
    + `ORDER BY ${distance} ASC, ${stableId} ASC LIMIT ${candidateLimit}`;
  const rankColumn = outputCount as SafeInteger;
  const totalColumn = (outputCount + 1) as SafeInteger;
  const ranked = `SELECT c.*, ROW_NUMBER() OVER (`
    + `ORDER BY c."_agql_distance" ASC, c."_agql_id" COLLATE `
    + `${quoteCollation(registry.config.codeCollation)} ASC)::text AS `
    + `${internalColumn(rankColumn)}, `
    + `COUNT(*) OVER()::text AS ${internalColumn(totalColumn)} FROM candidates AS c`;
  const limit = parameters.add(plan.take, 'bigint');
  const exact = plan.search.accuracy === 'exact';
  const exactLimit = Math.min(
    registry.config.exactScanAdmissionLimit,
    plan.search.hardCandidateLimit - 1,
  ) as SafeInteger;
  return {
    operation: 'query',
    dataset,
    statement: {
      text: `WITH candidates AS MATERIALIZED (${candidate}), ranked AS (${ranked}) `
        + `SELECT ${[
          ...finalColumns(outputCount),
          `r.${internalColumn(rankColumn)}`,
          `r.${internalColumn(totalColumn)}`,
        ].join(', ')} `
        + `FROM ranked AS r ORDER BY r.${internalColumn(rankColumn)}::bigint LIMIT ${limit}`,
      values: parameters.values,
    },
    ...(exact ? {
      admissionStatement: admissionStatement(plan, registry, dataset, embedding, exactLimit),
      exactAdmissionLimit: exactLimit,
    } : {}),
    settings: exact
      ? [['enable_indexscan', 'off'], ['enable_bitmapscan', 'off']]
      : [
        ['hnsw.ef_search', String(quality.efSearch)],
        ['hnsw.iterative_scan', 'strict_order'],
        ['hnsw.max_scan_tuples', String(quality.maxScanTuples)],
      ],
    outputCodecs: sortedProjection(plan).map((item) => item.field.type),
    outputSlots: sortedProjection(plan).map((item) => item.output.slot),
    rankColumn,
    totalColumn,
    take: plan.take,
  };
}

function compileHybrid(
  plan: Extract<RetrieveLogicalPlan, { readonly profile: 'retrieve.hybrid.v0' }>,
  registry: RuntimeRegistry,
  validated: Extract<ReturnType<typeof commonValidation>, { readonly kind: 'success' }>['value'],
): CompiledPostgresQuery {
  const { dataset, embedding, quality, vector } = validated;
  const lexical = registry.field(dataset, plan.search.lexical.field);
  if (lexical?.type.kind !== 'text'
    || !dataset.lexicalFields.includes(lexical.physical)) {
    throw new SqlCompilationError(
      'The lexical field is not indexed for hybrid retrieval.',
      '/search/lexical',
    );
  }
  const parameters = new ParameterBuilder();
  const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
  const vectorColumn = `d.${quoteIdentifier(embedding.embedding.physical)}`;
  const stableId = fieldExpression({ registry, dataset, alias: 'd' }, plan.stableId);
  const semanticEligibility = eligibilitySql(
    { registry, dataset, alias: 'd', parameters },
    plan.scope,
    plan.filter,
  );
  const queryVector = parameters.add(vector, 'vector');
  const distance = `${vectorColumn} ${distanceOperator(embedding.embedding.metric)} ${queryVector}`;
  const semanticLimit = parameters.add(plan.search.hardCandidateLimit, 'bigint');
  const semantic = `SELECT ${stableId} AS "_agql_id", ${distance} AS "_agql_score" `
    + `FROM ${table} AS d WHERE (${semanticEligibility}) AND ${vectorColumn} IS NOT NULL `
    + `ORDER BY ${distance} ASC, ${stableId} ASC LIMIT ${semanticLimit}`;
  const lexicalEligibility = eligibilitySql(
    { registry, dataset, alias: 'd', parameters },
    plan.scope,
    plan.filter,
  );
  const lexicalField = fieldExpression({ registry, dataset, alias: 'd' }, lexical);
  const lexicalText = parameters.add(plan.search.lexical.text, 'text');
  const lexicalPattern = parameters.add(`%${escapeLike(plan.search.lexical.text)}%`, 'text');
  const query = `plainto_tsquery('simple'::regconfig, ${lexicalText})`;
  const lexicalScore = `ts_rank_cd(to_tsvector('simple'::regconfig, ${lexicalField}), ${query})`;
  const lexicalLimit = parameters.add(plan.search.hardCandidateLimit, 'bigint');
  const lexicalCandidates = `SELECT ${stableId} AS "_agql_id", ${lexicalScore} AS "_agql_score" `
    + `FROM ${table} AS d WHERE (${lexicalEligibility}) `
    + `AND ${lexicalField} LIKE ${lexicalPattern} ESCAPE '\\' `
    + `ORDER BY ${lexicalScore} DESC, ${stableId} ASC LIMIT ${lexicalLimit}`;
  const codeCollation = quoteCollation(registry.config.codeCollation);
  const semanticRanked = 'SELECT s."_agql_id", ROW_NUMBER() OVER ('
    + `ORDER BY s."_agql_score" ASC, s."_agql_id" COLLATE ${codeCollation} ASC) AS rank `
    + 'FROM semantic_candidates AS s';
  const lexicalRanked = 'SELECT l."_agql_id", ROW_NUMBER() OVER ('
    + `ORDER BY l."_agql_score" DESC, l."_agql_id" COLLATE ${codeCollation} ASC) AS rank `
    + 'FROM lexical_candidates AS l';
  const fusedScore = 'SELECT COALESCE(s."_agql_id", l."_agql_id") AS "_agql_id", '
    + `(COALESCE(1::numeric / (${RRF_K}::numeric + s.rank::numeric), 0::numeric) + `
    + `COALESCE(1::numeric / (${RRF_K}::numeric + l.rank::numeric), 0::numeric)) `
    + 'AS "_agql_fusion" FROM semantic_ranked AS s FULL OUTER JOIN lexical_ranked AS l '
    + 'ON s."_agql_id" = l."_agql_id"';
  const fusedLimit = parameters.add(plan.search.hardCandidateLimit, 'bigint');
  const fused = 'SELECT f.* FROM fused_scores AS f ORDER BY f."_agql_fusion" DESC, '
    + `f."_agql_id" COLLATE ${codeCollation} ASC LIMIT ${fusedLimit}`;
  const finalEligibility = eligibilitySql(
    { registry, dataset, alias: 'd', parameters },
    plan.scope,
    plan.filter,
  );
  const projection = projectionSql(plan, registry, dataset);
  const joined = `SELECT ${projection.join(', ')}, f."_agql_id", f."_agql_fusion" `
    + `FROM fused AS f JOIN ${table} AS d ON d.${quoteIdentifier(dataset.idField.physical)} = `
    + `f."_agql_id" AND (${finalEligibility})`;
  const outputCount = projection.length;
  const rankColumn = outputCount as SafeInteger;
  const totalColumn = (outputCount + 1) as SafeInteger;
  const ranked = `SELECT j.*, ROW_NUMBER() OVER (ORDER BY j."_agql_fusion" DESC, `
    + `j."_agql_id" COLLATE ${codeCollation} ASC)::text AS ${internalColumn(rankColumn)}, `
    + `COUNT(*) OVER()::text AS ${internalColumn(totalColumn)} FROM joined AS j`;
  const take = parameters.add(plan.take, 'bigint');
  return {
    operation: 'query',
    dataset,
    statement: {
      text: `WITH semantic_candidates AS MATERIALIZED (${semantic}), `
        + `lexical_candidates AS MATERIALIZED (${lexicalCandidates}), `
        + `semantic_ranked AS (${semanticRanked}), lexical_ranked AS (${lexicalRanked}), `
        + `fused_scores AS (${fusedScore}), fused AS MATERIALIZED (${fused}), `
        + `joined AS (${joined}), ranked AS (${ranked}) `
        + `SELECT ${[
          ...finalColumns(outputCount),
          `r.${internalColumn(rankColumn)}`,
          `r.${internalColumn(totalColumn)}`,
        ].join(', ')} `
        + `FROM ranked AS r ORDER BY r.${internalColumn(rankColumn)}::bigint LIMIT ${take}`,
      values: parameters.values,
    },
    settings: [
      ['hnsw.ef_search', String(quality.efSearch)],
      ['hnsw.iterative_scan', 'strict_order'],
      ['hnsw.max_scan_tuples', String(quality.maxScanTuples)],
    ],
    outputCodecs: sortedProjection(plan).map((item) => item.field.type),
    outputSlots: sortedProjection(plan).map((item) => item.output.slot),
    rankColumn,
    totalColumn,
    take: plan.take,
  };
}

export function compileRetrieve(
  plan: RetrieveLogicalPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresQuery> {
  const validated = commonValidation(plan, registry);
  if (validated.kind === 'refusal') return validated;
  try {
    return {
      kind: 'success',
      value: plan.profile === 'retrieve.semantic.v0'
        ? compileSemantic(plan, registry, validated.value)
        : compileHybrid(plan, registry, validated.value),
    };
  } catch (error: unknown) {
    if (error instanceof SqlCompilationError) return unsafePlan(error.path, error.message);
    throw error;
  }
}
