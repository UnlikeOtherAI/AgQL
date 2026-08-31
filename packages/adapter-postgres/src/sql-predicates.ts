import type {
  ExpandedScope,
  LogicalFilter,
  ResolvedFieldBinding,
  ResolvedPredicate,
} from '@agql/contracts';

import type { RuntimeRegistry } from './registry.ts';
import { quoteCollation, quoteIdentifier } from './sql-identifiers.ts';
import type { ParameterBuilder } from './sql-parameters.ts';
import { encodeScalar, escapeLike } from './sql-parameters.ts';
import type { PostgresDatasetBinding, PostgresQualityProfile } from './types.ts';

export class SqlCompilationError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(message);
    this.name = 'SqlCompilationError';
    this.path = path;
  }
}

export interface PredicateContext {
  readonly registry: RuntimeRegistry;
  readonly dataset: PostgresDatasetBinding;
  readonly alias: string;
  readonly parameters: ParameterBuilder;
}

function registeredField(
  context: PredicateContext,
  field: ResolvedFieldBinding,
): ResolvedFieldBinding {
  const registered = context.registry.field(context.dataset, field);
  if (registered === undefined) {
    throw new SqlCompilationError(
      'A predicate field is not part of the resolved dataset binding.',
      '/filter',
    );
  }
  return registered;
}

export function fieldExpression(
  context: Omit<PredicateContext, 'parameters'>,
  field: ResolvedFieldBinding,
): string {
  const registered = context.registry.field(context.dataset, field);
  if (registered === undefined) {
    throw new SqlCompilationError('A field is not in the dataset binding.', '/');
  }
  const base = `${context.alias}.${quoteIdentifier(registered.physical)}`;
  if (registered.type.kind === 'text') {
    const collation = context.registry.collation(
      registered.type.collation.id,
      registered.type.collation.version,
    );
    if (collation === undefined) {
      throw new SqlCompilationError(
        'The declared text collation is not installed in this adapter binding.',
        '/filter',
      );
    }
    return `${base} COLLATE ${quoteCollation(collation)}`;
  }
  if (registered.type.kind === 'id' || registered.type.kind === 'enum') {
    return `${base} COLLATE ${quoteCollation(context.registry.config.codeCollation)}`;
  }
  return base;
}

function comparisonSql(context: PredicateContext, predicate: ResolvedPredicate): string {
  if (predicate.kind !== 'comparison') {
    throw new SqlCompilationError('Expected a comparison predicate.', '/filter');
  }
  const field = registeredField(context, predicate.field);
  const left = fieldExpression(context, field);
  if (predicate.value.kind === 'null') {
    if (predicate.op === 'eq') return `${left} IS NULL`;
    if (predicate.op === 'ne') return `${left} IS NOT NULL`;
    return 'FALSE';
  }
  const encoded = encodeScalar(field, predicate.value);
  if (encoded === undefined) {
    throw new SqlCompilationError('A predicate value does not match its field type.', '/filter');
  }
  const right = context.parameters.add(encoded.parameter, encoded.cast);
  const operators = {
    eq: '=',
    ne: '<>',
    lt: '<',
    lte: '<=',
    gt: '>',
    gte: '>=',
  } as const;
  return `${left} ${operators[predicate.op]} ${right}`;
}

function listSql(context: PredicateContext, predicate: ResolvedPredicate): string {
  if (predicate.kind !== 'list') {
    throw new SqlCompilationError('Expected a list predicate.', '/filter');
  }
  const field = registeredField(context, predicate.field);
  const left = fieldExpression(context, field);
  if (predicate.values.length === 0) return predicate.op === 'in' ? 'FALSE' : 'TRUE';
  const comparisons = predicate.values.map((value) => {
    if (value.kind === 'null') return `${left} IS NULL`;
    const encoded = encodeScalar(field, value);
    if (encoded === undefined) {
      throw new SqlCompilationError('A list value does not match its field type.', '/filter');
    }
    return `${left} = ${context.parameters.add(encoded.parameter, encoded.cast)}`;
  });
  const membership = `(${comparisons.join(' OR ')})`;
  return predicate.op === 'in' ? membership : `NOT ${membership}`;
}

function substringSql(context: PredicateContext, predicate: ResolvedPredicate): string {
  if (predicate.kind !== 'substring') {
    throw new SqlCompilationError('Expected a substring predicate.', '/filter');
  }
  const field = registeredField(context, predicate.field);
  if (field.type.kind !== 'text') {
    throw new SqlCompilationError('Substring predicates require a text field.', '/filter');
  }
  const escaped = escapeLike(predicate.value);
  const pattern = predicate.op === 'contains' ? `%${escaped}%` : `${escaped}%`;
  const parameter = context.parameters.add(pattern, 'text');
  return `${fieldExpression(context, field)} LIKE ${parameter} ESCAPE '\\'`;
}

function predicateSql(context: PredicateContext, predicate: ResolvedPredicate): string {
  if (predicate.kind === 'comparison') return comparisonSql(context, predicate);
  if (predicate.kind === 'list') return listSql(context, predicate);
  if (predicate.kind === 'null') {
    const field = registeredField(context, predicate.field);
    const operator = predicate.op === 'isNull' ? 'IS NULL' : 'IS NOT NULL';
    return `${fieldExpression(context, field)} ${operator}`;
  }
  if (predicate.kind === 'substring') return substringSql(context, predicate);
  const field = registeredField(context, predicate.field);
  if (field.type.kind !== 'instant') {
    throw new SqlCompilationError('Instant ranges require an instant field.', '/filter');
  }
  const start = context.parameters.add(predicate.startInclusive, 'timestamptz');
  const end = context.parameters.add(predicate.endExclusive, 'timestamptz');
  const expression = fieldExpression(context, field);
  return `(${expression} >= ${start} AND ${expression} < ${end})`;
}

export function filterSql(
  context: PredicateContext,
  filter: LogicalFilter<ResolvedPredicate>,
): string {
  if (filter.kind === 'and') {
    return `(${filter.items.map((item) => filterSql(context, item)).join(' AND ')})`;
  }
  if (filter.kind === 'or') {
    return `(${filter.items.map((item) => filterSql(context, item)).join(' OR ')})`;
  }
  if (filter.kind === 'not') return `(NOT ${filterSql(context, filter.item)})`;
  return predicateSql(context, filter);
}

export function eligibilitySql(
  context: PredicateContext,
  scope: ExpandedScope,
  filter?: LogicalFilter<ResolvedPredicate>,
): string {
  if (scope.visibility === 'nothing') return 'FALSE';
  const clauses = scope.predicates.map((predicate) => predicateSql(context, predicate));
  if (filter !== undefined) clauses.push(filterSql(context, filter));
  return clauses.length === 0 ? 'TRUE' : clauses.map((clause) => `(${clause})`).join(' AND ');
}

function inspectFilter(
  filter: LogicalFilter<ResolvedPredicate>,
  depth: number,
  profile: PostgresQualityProfile,
): boolean {
  if (depth > profile.maximumBooleanDepth) return false;
  if (filter.kind === 'and' || filter.kind === 'or') {
    return filter.items.every((item) => inspectFilter(item, depth + 1, profile));
  }
  if (filter.kind === 'not') return inspectFilter(filter.item, depth + 1, profile);
  return profile.certifiedPredicates.includes(filter.kind);
}

export function filterShapeCertified(
  scope: ExpandedScope,
  filter: LogicalFilter<ResolvedPredicate> | undefined,
  profile: PostgresQualityProfile,
): boolean {
  if (scope.visibility === 'predicate'
    && !scope.predicates.every(
      (predicate) => profile.certifiedPredicates.includes(predicate.kind),
    )) {
    return false;
  }
  return filter === undefined || inspectFilter(filter, 0, profile);
}
