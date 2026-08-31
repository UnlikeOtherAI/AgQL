import { QUERY_LIMITS } from '@agql/schemas';
import type { QueryDocument, SafeInteger, WhereExpression } from '@agql/schemas';

import { structuralError } from './errors.ts';
import type { DeploymentLimits, EngineError, EngineResult } from './types.ts';

interface WhereInspection {
  readonly nodes: number;
  readonly maxDepth: number;
  readonly largestList: number;
}

function inspectWhere(expression: WhereExpression, depth = 0): WhereInspection {
  if (expression.kind === 'predicate') {
    return {
      nodes: 1,
      maxDepth: depth,
      largestList: expression.op === 'in' || expression.op === 'notIn'
        ? expression.values.length
        : 0,
    };
  }
  if (expression.kind === 'not') {
    const nested = inspectWhere(expression.item, depth + 1);
    return { ...nested, nodes: nested.nodes + 1 };
  }
  const nested = expression.items.map((item) => inspectWhere(item, depth + 1));
  return {
    nodes: 1 + nested.reduce((sum, item) => sum + item.nodes, 0),
    maxDepth: Math.max(depth, ...nested.map((item) => item.maxDepth)),
    largestList: Math.max(0, ...nested.map((item) => item.largestList)),
  };
}

function queryWhereExpressions(query: QueryDocument): readonly WhereExpression[] {
  const expressions: WhereExpression[] = [];
  if (query.where !== undefined) expressions.push(query.where);
  if (query.mode !== 'aggregate') return expressions;
  if (query.having !== undefined) expressions.push(query.having);
  for (const metric of query.metrics) {
    if (metric.kind === 'aggregate') {
      if (metric.filter !== undefined) expressions.push(metric.filter);
    } else {
      if (metric.numerator.filter !== undefined) expressions.push(metric.numerator.filter);
      if (metric.denominator.filter !== undefined) expressions.push(metric.denominator.filter);
    }
  }
  return expressions;
}

function loweredLimitErrors(
  query: QueryDocument,
  limits: DeploymentLimits,
): readonly EngineError[] {
  const errors: EngineError[] = [];
  const inspections = queryWhereExpressions(query).map((expression) => inspectWhere(expression));
  const nodes = inspections.reduce((sum, item) => sum + item.nodes, 0);
  const depth = Math.max(0, ...inspections.map((item) => item.maxDepth));
  const list = Math.max(0, ...inspections.map((item) => item.largestList));
  const outputCount = query.mode === 'aggregate'
    ? query.dimensions.length + query.metrics.length
    : query.select.length;
  if (nodes > limits.predicateNodes) {
    errors.push(structuralError(
      `Predicate nodes exceed the deployment limit of ${limits.predicateNodes}.`,
      '/where',
      [`Use at most ${limits.predicateNodes} predicate nodes.`],
    ));
  }
  if (depth > limits.booleanNesting) {
    errors.push(structuralError(
      `Boolean nesting exceeds the deployment limit of ${limits.booleanNesting}.`,
      '/where',
      [`Use at most ${limits.booleanNesting} boolean levels.`],
    ));
  }
  if (list > limits.inList) {
    errors.push(structuralError(
      `An in-list exceeds the deployment limit of ${limits.inList}.`,
      '/where',
      [`Use at most ${limits.inList} values in one list.`],
    ));
  }
  if (outputCount > limits.select) {
    errors.push(structuralError(
      `Output selection exceeds the deployment limit of ${limits.select}.`,
      query.mode === 'aggregate' ? '/dimensions' : '/select',
      [`Request at most ${limits.select} outputs.`],
    ));
  }
  const takeLimit = limits.take[query.mode];
  if (query.take > takeLimit) {
    errors.push(structuralError(
      `take exceeds the deployment limit of ${takeLimit}.`,
      '/take',
      [`Use take no greater than ${takeLimit}.`],
    ));
  }
  return errors;
}

function isValidLimit(value: SafeInteger, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function invalidConfiguration(limits: DeploymentLimits): EngineError | undefined {
  const checks: readonly [SafeInteger, number, string][] = [
    [limits.booleanNesting, QUERY_LIMITS.booleanNesting, '/limits/booleanNesting'],
    [limits.inList, QUERY_LIMITS.inList, '/limits/inList'],
    [limits.predicateNodes, QUERY_LIMITS.predicateNodes, '/limits/predicateNodes'],
    [limits.select, QUERY_LIMITS.select, '/limits/select'],
    [limits.take.records, QUERY_LIMITS.take.records, '/limits/take/records'],
    [limits.take.aggregate, QUERY_LIMITS.take.aggregate, '/limits/take/aggregate'],
    [limits.take.retrieve, QUERY_LIMITS.take.retrieve, '/limits/take/retrieve'],
  ];
  for (const [value, maximum, path] of checks) {
    if (!isValidLimit(value, maximum)) {
      return structuralError(
        'A deployment limit must be nonnegative and must not raise its v0 maximum.',
        path,
        [`Use a value from 0 through ${maximum}.`],
      );
    }
  }
  return undefined;
}

export function validateDeploymentLimits(
  query: QueryDocument,
  limits: DeploymentLimits,
): EngineResult<true> {
  const configurationError = invalidConfiguration(limits);
  if (configurationError !== undefined) return { ok: false, errors: [configurationError] };
  const errors = loweredLimitErrors(query, limits);
  const first = errors[0];
  return first === undefined
    ? { ok: true, value: true }
    : { ok: false, errors: [first, ...errors.slice(1)] };
}
