import type {
  AdapterOutcome,
  AggregateLogicalPlan,
  LogicalFilter,
  ResolvedAggregateExpression,
  ResolvedFieldBinding,
  ResolvedOutputPredicate,
} from '@agql/contracts';
import type { SafeInteger } from '@agql/schemas';

import { refusal, unsafePlan } from './refusals.ts';
import { calendarPeriodOutputSql, compileCalendarPeriodSql } from './calendar-sql.ts';
import type { RuntimeRegistry } from './registry.ts';
import { internalColumn, quoteQualified } from './sql-identifiers.ts';
import { encodedOutputSql, validateContiguousSlots } from './sql-output.ts';
import {
  eligibilitySql,
  fieldExpression,
  filterSql,
  SqlCompilationError,
} from './sql-predicates.ts';
import { encodeScalar, ParameterBuilder } from './sql-parameters.ts';
import type { CompiledPostgresQuery, OutputCodec, PostgresDatasetBinding } from './types.ts';

interface AggregateOutput {
  readonly slot: SafeInteger;
  readonly sql: string;
  readonly codec: OutputCodec;
  readonly sourceField?: ResolvedFieldBinding;
}

interface AggregateContext {
  readonly registry: RuntimeRegistry;
  readonly dataset: PostgresDatasetBinding;
  readonly parameters: ParameterBuilder;
}

function aggregateFilter(
  context: AggregateContext,
  aggregate: ResolvedAggregateExpression,
): string {
  if (aggregate.filter === undefined) return '';
  return ` FILTER (WHERE ${filterSql({ ...context, alias: 'd' }, aggregate.filter)})`;
}

function moneyAggregateSql(
  expression: string,
  op: 'sum' | 'avg',
  filter: string,
): string {
  const amount = `(${expression} ->> 'amount')::numeric`;
  const currency = `(${expression} ->> 'currency')`;
  const count = `COUNT(${expression})${filter}`;
  const aggregate = `${op.toUpperCase()}(${amount})${filter}`;
  const currencies = `jsonb_agg(DISTINCT ${currency} ORDER BY ${currency})${filter}`;
  return `CASE WHEN ${count} = 0 THEN NULL ELSE jsonb_build_object(`
    + `'amount', (${aggregate})::text, 'currencies', ${currencies}) END`;
}

function fieldAggregateSql(
  context: AggregateContext,
  aggregate: Exclude<ResolvedAggregateExpression, { readonly op: 'count' }>,
): { readonly sql: string; readonly codec: OutputCodec; readonly field: ResolvedFieldBinding } {
  const field = context.registry.field(context.dataset, aggregate.field);
  if (field === undefined) {
    throw new SqlCompilationError('An aggregate field is not in the dataset binding.', '/metrics');
  }
  const expression = fieldExpression({ ...context, alias: 'd' }, field);
  const filter = aggregateFilter(context, aggregate);
  if (aggregate.op === 'countDistinct') {
    return {
      sql: `COUNT(DISTINCT ${expression})${filter}`,
      codec: { kind: 'aggregateInteger' },
      field,
    };
  }
  if (aggregate.op === 'sum' || aggregate.op === 'avg') {
    if (field.type.kind !== 'integer' && field.type.kind !== 'decimal'
      && field.type.kind !== 'money') {
      throw new SqlCompilationError('sum and avg require integer, decimal, or money.', '/metrics');
    }
    if (field.type.kind === 'money') {
      const scale = field.type.scale === undefined
        ? undefined
        : aggregate.op === 'avg' ? Math.max(field.type.scale, 9) : field.type.scale;
      return {
        sql: moneyAggregateSql(expression, aggregate.op, filter),
        codec: {
          kind: 'aggregateMoney',
          ...(field.type.currencies === undefined ? {} : { currencies: field.type.currencies }),
          ...(scale === undefined ? {} : { scale }),
        },
        field,
      };
    }
    const codec: OutputCodec = aggregate.op === 'sum' && field.type.kind === 'integer'
      ? { kind: 'aggregateInteger' }
      : field.type.kind === 'decimal' && aggregate.op === 'sum'
        ? field.type
        : {
            kind: 'aggregateDecimal',
            ...(field.type.kind === 'decimal' && field.type.scale !== undefined
              ? { scale: Math.max(field.type.scale, 9) }
              : { scale: 9 }),
          };
    return { sql: `${aggregate.op.toUpperCase()}(${expression})${filter}`, codec, field };
  }
  if (field.type.kind === 'null') {
    return { sql: `NULL::text`, codec: field.type, field };
  }
  if (field.type.kind === 'boolean') {
    const functionName = aggregate.op === 'min' ? 'BOOL_AND' : 'BOOL_OR';
    return { sql: `${functionName}(${expression})${filter}`, codec: field.type, field };
  }
  return {
    sql: `${aggregate.op.toUpperCase()}(${expression})${filter}`,
    codec: field.type,
    field,
  };
}

function aggregateSql(
  context: AggregateContext,
  aggregate: ResolvedAggregateExpression,
): { readonly sql: string; readonly codec: OutputCodec; readonly field?: ResolvedFieldBinding } {
  if (aggregate.op === 'count') {
    return {
      sql: `COUNT(*)${aggregateFilter(context, aggregate)}`,
      codec: { kind: 'aggregateInteger' },
    };
  }
  return fieldAggregateSql(context, aggregate);
}

function ratioSql(
  context: AggregateContext,
  numerator: ResolvedAggregateExpression,
  denominator: ResolvedAggregateExpression,
): string {
  const left = aggregateSql(context, numerator).sql;
  const right = aggregateSql(context, denominator).sql;
  return `ROUND(((${left})::numeric / NULLIF((${right})::numeric, 0::numeric)), 9)`;
}

function fieldForCodec(
  dataset: PostgresDatasetBinding,
  output: AggregateOutput,
): ResolvedFieldBinding | undefined {
  if (output.sourceField !== undefined) return output.sourceField;
  if (output.codec.kind === 'aggregateInteger') {
    return { ...dataset.idField, type: { kind: 'integer' }, nullable: false };
  }
  if (output.codec.kind === 'aggregateDecimal') {
    return { ...dataset.idField, type: { kind: 'decimal' }, nullable: true };
  }
  return undefined;
}

function havingLeaf(
  predicate: ResolvedOutputPredicate,
  outputs: ReadonlyMap<SafeInteger, AggregateOutput>,
  context: AggregateContext,
): string {
  const output = outputs.get(predicate.output.slot);
  if (output === undefined) {
    throw new SqlCompilationError('A having output slot is not defined.', '/having');
  }
  if (predicate.op === 'isNull') return `(${output.sql}) IS NULL`;
  if (predicate.op === 'isNotNull') return `(${output.sql}) IS NOT NULL`;
  if (predicate.value === undefined) {
    throw new SqlCompilationError('A having comparison requires a typed value.', '/having');
  }
  const field = fieldForCodec(context.dataset, output);
  if (field === undefined) {
    throw new SqlCompilationError('The having value type cannot be represented.', '/having');
  }
  const encoded = encodeScalar(field, predicate.value);
  if (encoded === undefined) {
    throw new SqlCompilationError('A having value does not match its output type.', '/having');
  }
  const parameter = context.parameters.add(encoded.parameter, encoded.cast);
  const operator = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
  return `(${output.sql}) ${operator[predicate.op]} ${parameter}`;
}

function havingSql(
  filter: LogicalFilter<ResolvedOutputPredicate>,
  outputs: ReadonlyMap<SafeInteger, AggregateOutput>,
  context: AggregateContext,
): string {
  if ('kind' in filter) {
    if (filter.kind === 'and' || filter.kind === 'or') {
      const joiner = filter.kind === 'and' ? ' AND ' : ' OR ';
      const clauses = filter.items.map((item) => havingSql(item, outputs, context));
      return `(${clauses.join(joiner)})`;
    }
    return `(NOT ${havingSql(filter.item, outputs, context)})`;
  }
  return havingLeaf(filter, outputs, context);
}

function compileOutputs(
  plan: AggregateLogicalPlan,
  context: AggregateContext,
): { readonly outputs: readonly AggregateOutput[]; readonly groups: readonly string[] } {
  const outputs: AggregateOutput[] = [];
  const groups: string[] = [];
  for (const dimension of plan.dimensions) {
    if (dimension.kind === 'calendarPeriod') {
      const period = compileCalendarPeriodSql(dimension, { ...context, alias: 'd' });
      const sql = calendarPeriodOutputSql(period);
      outputs.push({
        slot: dimension.output.slot,
        sql,
        codec: {
          kind: 'calendarPeriod',
          timezone: dimension.timezone,
          grain: dimension.grain,
        },
      });
      groups.push(sql);
      continue;
    }
    const field = context.registry.field(context.dataset, dimension.field);
    if (field === undefined) {
      throw new SqlCompilationError(
        'A dimension field is not in the dataset binding.',
        '/dimensions',
      );
    }
    const sql = fieldExpression({ ...context, alias: 'd' }, field);
    outputs.push({ slot: dimension.output.slot, sql, codec: field.type, sourceField: field });
    groups.push(sql);
  }
  for (const [index, metric] of plan.metrics.entries()) {
    if (metric.kind === 'aggregate') {
      const compiled = aggregateSql(context, metric.aggregate);
      const codec = compiled.codec.kind === 'aggregateMoney'
        ? { ...compiled.codec, metricPath: `/metrics/${index}` }
        : compiled.codec;
      outputs.push({
        slot: metric.output.slot,
        sql: compiled.sql,
        codec,
        ...(compiled.field === undefined ? {} : { sourceField: compiled.field }),
      });
    } else {
      outputs.push({
        slot: metric.output.slot,
        sql: ratioSql(context, metric.numerator, metric.denominator),
        codec: { kind: 'aggregateDecimal', scale: 9 },
      });
    }
  }
  return { outputs: outputs.sort((left, right) => left.slot - right.slot), groups };
}

export function compileAggregate(
  plan: AggregateLogicalPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresQuery> {
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
  if (plan.take > plan.hardRowLimit || plan.take < 1) {
    return unsafePlan('/take', 'The requested row count exceeds the plan hard row limit.');
  }
  const slots = [
    ...plan.dimensions.map((dimension) => dimension.output.slot),
    ...plan.metrics.map((metric) => metric.output.slot),
  ];
  if (!validateContiguousSlots(slots)) {
    return unsafePlan('/metrics', 'Resolved output slots must be unique and contiguous from zero.');
  }
  try {
    const parameters = new ParameterBuilder();
    const context = { registry, dataset, parameters };
    const { outputs, groups } = compileOutputs(plan, context);
    const outputMap = new Map(outputs.map((output) => [output.slot, output]));
    const eligibility = eligibilitySql({ ...context, alias: 'd' }, plan.scope, plan.filter);
    const select = outputs.map((output) => `${output.sql} AS ${internalColumn(output.slot)}`);
    const having = plan.having === undefined
      ? ''
      : ` HAVING ${havingSql(plan.having, outputMap, context)}`;
    const groupBy = groups.length === 0 ? '' : ` GROUP BY ${groups.join(', ')}`;
    const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
    const inner = `SELECT ${select.join(', ')} FROM ${table} AS d WHERE ${eligibility}`
      + groupBy + having;
    const outerSelect = outputs.map((output) =>
      `${encodedOutputSql(`g.${internalColumn(output.slot)}`, output.codec)} `
      + `AS ${internalColumn(output.slot)}`);
    const totalColumn = outputs.length;
    outerSelect.push(`COUNT(*) OVER()::text AS ${internalColumn(totalColumn)}`);
    const order = plan.order.map((item) => {
      if (!outputMap.has(item.output.slot)) {
        throw new SqlCompilationError('An ordered output slot is not defined.', '/order');
      }
      return `g.${internalColumn(item.output.slot)} ${item.direction.toUpperCase()} `
        + 'NULLS LAST';
    });
    if (plan.tieBreak.kind === 'dimensionTuple') {
      for (const field of plan.tieBreak.fields) {
        const dimension = plan.dimensions.find(
          (item) => item.field.physical === field.physical,
        );
        if (dimension === undefined) {
          throw new SqlCompilationError('A tie-break field is not a dimension.', '/order');
        }
        order.push(`g.${internalColumn(dimension.output.slot)} ASC NULLS LAST`);
      }
    }
    const limit = parameters.add(plan.take, 'bigint');
    return {
      kind: 'success',
      value: {
        operation: 'query',
        dataset,
        statement: {
          text: `SELECT ${outerSelect.join(', ')} FROM (${inner}) AS g `
            + `ORDER BY ${order.join(', ')} LIMIT ${limit}`,
          values: parameters.values,
        },
        settings: [],
        outputCodecs: outputs.map((output) => output.codec),
        outputSlots: outputs.map((output) => output.slot),
        totalColumn: totalColumn as SafeInteger,
        take: plan.take,
      },
    };
  } catch (error: unknown) {
    if (error instanceof SqlCompilationError) return unsafePlan(error.path, error.message);
    throw error;
  }
}
