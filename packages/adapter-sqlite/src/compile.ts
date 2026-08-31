import type {
  AdapterOutcome,
  AdapterRefusal,
  AdapterRefusalCode,
  LogicalFilter,
  LogicalPlanForProfile,
  ResolvedAggregateExpression,
  ResolvedFieldBinding,
  ResolvedMetric,
  ResolvedOrder,
  ResolvedPredicate,
  ResolvedProjection,
} from '@agql/contracts';

import { DELETED_COLUMN, decimalOrderSql, quoteIdentifier, quoteRuntimeIdentifier,
  requiresSupportedCollation, scopeAndFilterSql } from './sql.ts';
import type {
  CompiledAggregateQuery,
  CompiledRecordsQuery,
  CompiledSemanticQuery,
  SqliteAdapterOptions,
  SqliteQueryCompiled,
  SqliteParameter,
} from './types.ts';

type QueryPlan = LogicalPlanForProfile<
  'records.v0' | 'aggregate.v0' | 'retrieve.semantic.v0'
>;

function refusal(
  code: Exclude<AdapterRefusalCode, 'AFTER_WRITE_TIMEOUT'>,
  message: string,
  path: string,
  remedy: string,
): AdapterOutcome<never> {
  return {
    kind: 'refusal',
    refusal: { code, message, path, alternatives: [remedy], remedy } as AdapterRefusal,
  };
}

function sortedProjection(
  projection: readonly ResolvedProjection[],
): readonly ResolvedProjection[] {
  const sorted = [...projection].sort((left, right) => left.output.slot - right.output.slot);
  for (const [index, item] of sorted.entries()) {
    if (item.output.slot !== index) {
      throw new TypeError('Resolved projection slots must be contiguous and zero-based.');
    }
  }
  return sorted;
}

function predicateFields(
  predicate: ResolvedPredicate,
  output: ResolvedFieldBinding[],
): void {
  output.push(predicate.field);
}

function filterFields(
  filter: LogicalFilter<ResolvedPredicate> | undefined,
  output: ResolvedFieldBinding[],
): void {
  if (filter === undefined) return;
  if (filter.kind === 'not') {
    filterFields(filter.item, output);
    return;
  }
  if (filter.kind === 'and' || filter.kind === 'or') {
    for (const item of filter.items) filterFields(item, output);
    return;
  }
  predicateFields(filter, output);
}

function scopeFields(plan: QueryPlan): readonly ResolvedFieldBinding[] {
  if (plan.scope.visibility === 'nothing') return [];
  return plan.scope.predicates.map((predicate) => predicate.field);
}

function uniqueFields(fields: readonly ResolvedFieldBinding[]): readonly ResolvedFieldBinding[] {
  const byPhysical = new Map<string, ResolvedFieldBinding>();
  for (const field of fields) byPhysical.set(field.physical, field);
  return [...byPhysical.values()];
}

function orderTerms(order: ResolvedOrder): readonly string[] {
  const column = quoteIdentifier(order.field.physical);
  const nullTerm = `CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END ASC`;
  if (order.field.type.kind === 'decimal') {
    return [nullTerm, decimalOrderSql(column, order.direction)];
  }
  if (order.field.type.kind === 'money') {
    const amount = `json_extract(${column}, '$.amount')`;
    return [nullTerm, decimalOrderSql(amount, order.direction)];
  }
  return [nullTerm, `${column} COLLATE BINARY ${order.direction.toUpperCase()}`];
}

function baseWhere(plan: QueryPlan): {
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
} {
  const pushed = scopeAndFilterSql(plan.scope, plan.filter);
  return {
    sql: `(${pushed.sql}) AND ${quoteRuntimeIdentifier(DELETED_COLUMN)} = 0`,
    parameters: pushed.parameters,
  };
}

function recordsCompilation(
  plan: LogicalPlanForProfile<'records.v0'>,
  options: SqliteAdapterOptions,
): AdapterOutcome<CompiledRecordsQuery> {
  if (plan.take > plan.hardRowLimit) {
    return refusal(
      'COST_GATE_REFUSAL',
      'Records execution needs one bounded row beyond take to report truncation honestly.',
      '/take',
      'Set the hard row limit above take.',
    );
  }
  const collationFields: ResolvedFieldBinding[] = plan.order.map((item) => item.field);
  filterFields(plan.filter, collationFields);
  collationFields.push(...scopeFields(plan));
  if (!requiresSupportedCollation(collationFields, options.supportedTextCollations)) {
    return refusal(
      'UNSUPPORTED_PROFILE',
      'This adapter has not declared the catalog text collation required by the plan.',
      '/order',
      'Use a source that declares the catalog collation.',
    );
  }
  const projection = sortedProjection(plan.projection);
  const selected = projection.map((item, index) =>
    `${quoteIdentifier(item.field.physical)} AS ${quoteRuntimeIdentifier(`c${index}`)}`);
  const where = baseWhere(plan);
  const order = [...plan.order, plan.tieBreak.order].flatMap(orderTerms).join(', ');
  const sql = `SELECT ${selected.join(', ')} FROM ${quoteIdentifier(plan.dataset.physical)}`
    + ` WHERE ${where.sql} ORDER BY ${order} LIMIT ?`;
  return {
    kind: 'success',
    value: {
      kind: 'records',
      plan,
      sql,
      parameters: [...where.parameters, plan.take + 1],
      projection,
    },
  };
}

function aggregateFields(
  plan: LogicalPlanForProfile<'aggregate.v0'>,
): readonly ResolvedFieldBinding[] {
  const fields: ResolvedFieldBinding[] = [];
  for (const dimension of plan.dimensions) fields.push(dimension.field);
  for (const metric of plan.metrics) metricFields(metric, fields);
  return uniqueFields(fields);
}

function expressionFields(
  expression: ResolvedAggregateExpression,
  fields: ResolvedFieldBinding[],
): void {
  if (expression.op !== 'count') fields.push(expression.field);
  filterFields(expression.filter, fields);
}

function metricFields(metric: ResolvedMetric, fields: ResolvedFieldBinding[]): void {
  if (metric.kind === 'aggregate') {
    expressionFields(metric.aggregate, fields);
    return;
  }
  expressionFields(metric.numerator, fields);
  expressionFields(metric.denominator, fields);
}

function aggregateCompilation(
  plan: LogicalPlanForProfile<'aggregate.v0'>,
  options: SqliteAdapterOptions,
): AdapterOutcome<CompiledAggregateQuery> {
  const fields = aggregateFields(plan);
  const collationFields: ResolvedFieldBinding[] = [...fields];
  filterFields(plan.filter, collationFields);
  collationFields.push(...scopeFields(plan));
  if (!requiresSupportedCollation(collationFields, options.supportedTextCollations)) {
    return refusal(
      'UNSUPPORTED_PROFILE',
      'This adapter has not declared the catalog text collation required by the aggregate.',
      '/dimensions',
      'Use a source that declares the catalog collation.',
    );
  }
  const selected = fields.map((field, index) =>
    `${quoteIdentifier(field.physical)} AS ${quoteRuntimeIdentifier(`f${index}`)}`);
  if (selected.length === 0) selected.push(`1 AS ${quoteRuntimeIdentifier('bounded_row')}`);
  const where = baseWhere(plan);
  const sql = `SELECT ${selected.join(', ')} FROM ${quoteIdentifier(plan.dataset.physical)}`
    + ` WHERE ${where.sql} LIMIT ?`;
  return {
    kind: 'success',
    value: {
      kind: 'aggregate',
      plan,
      sql,
      parameters: [...where.parameters, plan.hardRowLimit],
      fields,
    },
  };
}

function semanticCompilation(
  plan: LogicalPlanForProfile<'retrieve.semantic.v0'>,
  options: SqliteAdapterOptions,
): AdapterOutcome<CompiledSemanticQuery> {
  if (plan.search.accuracy !== 'exact') {
    return refusal(
      'UNSUPPORTED_PROFILE',
      'The SQLite reference adapter implements exact semantic retrieval only.',
      '/search/accuracy',
      'Request exact accuracy or use an approximate retrieval adapter.',
    );
  }
  const bytesPerValue = plan.search.vector.encoding === 'float64'
    ? 8
    : plan.search.vector.encoding === 'float32' ? 4 : 1;
  const expectedBytes = plan.search.vector.encoding === 'binary'
    ? Math.ceil(plan.search.vector.dimension / 8)
    : plan.search.vector.dimension * bytesPerValue;
  if (plan.search.vector.dimension !== plan.search.embedding.dimension
    || plan.search.vector.encoding !== plan.search.embedding.vectorEncoding
    || plan.search.vector.bytes.byteLength !== expectedBytes) {
    return refusal(
      'EMBEDDING_NOT_INDEXED',
      'The runtime-owned query vector does not match the resolved indexed EmbeddingSpec.',
      '/search/vector',
      'Regenerate the query vector for the resolved EmbeddingSpec.',
    );
  }
  if (plan.take > plan.search.hardCandidateLimit) {
    return refusal(
      'EXACT_SCAN_BUDGET_EXCEEDED',
      'Exact semantic retrieval cannot return more rows than its bounded eligible scan.',
      '/take',
      'Lower take or raise the engine-approved candidate limit.',
    );
  }
  const collationFields: ResolvedFieldBinding[] = [];
  filterFields(plan.filter, collationFields);
  collationFields.push(...scopeFields(plan));
  if (!requiresSupportedCollation(collationFields, options.supportedTextCollations)) {
    return refusal(
      'UNSUPPORTED_PROFILE',
      'This adapter has not declared the catalog text collation required by the retrieval filter.',
      '/where',
      'Use a source that declares the catalog collation.',
    );
  }
  const projection = sortedProjection(plan.projection);
  const selected = projection.map((item, index) =>
    `${quoteIdentifier(item.field.physical)} AS ${quoteRuntimeIdentifier(`c${index}`)}`);
  selected.push(
    `${quoteIdentifier(plan.stableId.physical)} AS ${quoteRuntimeIdentifier('stable_id')}`,
  );
  selected.push(
    `${quoteIdentifier(plan.search.embedding.physical)} AS ${quoteRuntimeIdentifier('vector')}`,
  );
  const where = baseWhere(plan);
  const vectorColumn = quoteIdentifier(plan.search.embedding.physical);
  const eligibility = `(${where.sql}) AND ${vectorColumn} IS NOT NULL`;
  const table = quoteIdentifier(plan.dataset.physical);
  return {
    kind: 'success',
    value: {
      kind: 'semantic',
      plan,
      countSql: `SELECT COUNT(*) AS ${quoteRuntimeIdentifier('eligible_count')} FROM (`
        + `SELECT 1 FROM ${table} WHERE ${eligibility} LIMIT ?`
        + `) AS ${quoteRuntimeIdentifier('bounded_eligible')}`,
      countParameters: [
        ...where.parameters,
        BigInt(Math.min(plan.search.hardCandidateLimit, options.exactScanAdmissionLimit)) + 1n,
      ],
      sql: `SELECT ${selected.join(', ')} FROM ${table} WHERE ${eligibility}`
        + ` ORDER BY ${quoteIdentifier(plan.stableId.physical)} COLLATE BINARY ASC LIMIT ?`,
      parameters: [...where.parameters, plan.search.hardCandidateLimit],
      projection,
      exactAdmissionLimit: options.exactScanAdmissionLimit,
    },
  };
}

export function compileSqlitePlan(
  plan: QueryPlan,
  options: SqliteAdapterOptions,
): AdapterOutcome<SqliteQueryCompiled> {
  const enforcement: unknown = plan.scope.visibility === 'predicate'
    ? Reflect.get(plan.scope, 'enforcement')
    : undefined;
  if (plan.scope.visibility === 'predicate'
    && (enforcement !== 'mandatoryPushdown' || plan.scope.predicates.length === 0)) {
    return refusal(
      'SCOPE_UNENFORCEABLE',
      'The resolved scope is not a non-empty mandatory-pushdown predicate.',
      '/scope',
      'Recompile the query with an expanded mandatory-pushdown scope.',
    );
  }
  switch (plan.profile) {
    case 'records.v0':
      return recordsCompilation(plan, options);
    case 'aggregate.v0':
      return aggregateCompilation(plan, options);
    case 'retrieve.semantic.v0':
      return semanticCompilation(plan, options);
  }
  return compileIneligibleProfile();
}

export function compileIneligibleProfile(): AdapterOutcome<never> {
  return refusal(
    'UNSUPPORTED_PROFILE',
    'The SQLite reference adapter does not advertise this query profile.',
    '/profile',
    'Use records, aggregate, or exact semantic retrieval.',
  );
}
