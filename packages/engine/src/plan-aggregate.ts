import type {
  AggregateLogicalPlan,
  ExpandedScope,
  LogicalFilter,
  ResolvedAggregateExpression,
  ResolvedDimension,
  ResolvedMetric,
  ResolvedOutputBinding,
  ResolvedOutputPredicate,
  ResolvedPredicate,
  ResolvedValueType,
  ResultSchemaField,
} from '@agql/contracts';
import type {
  AggregateQuery,
  SafeInteger,
  WhereExpression,
} from '@agql/schemas';

import type { CompileContext } from './compile-context.ts';
import { fail, semanticError } from './errors.ts';
import { authorizedField } from './policy.ts';
import { compileWhere } from './predicates.ts';
import { fieldResultShape, resolvedResultShape } from './result-shape.ts';
import type { EngineResult } from './types.ts';
import { typeLiteral } from './values.ts';

type AggregateMetric = AggregateQuery['metrics'][number];
type AggregateExpression = Exclude<AggregateMetric, { readonly op: 'ratio' }>;

interface ExpressionOutput {
  readonly expression: ResolvedAggregateExpression;
  readonly type: ResolvedValueType;
  readonly nullable: boolean;
  readonly orderFields: readonly string[];
  readonly shape: ResultSchemaField;
}

interface OutputMeta {
  readonly output: ResolvedOutputBinding;
  readonly type: ResolvedValueType;
  readonly nullable: boolean;
  readonly orderFields: readonly string[];
  readonly shape: ResultSchemaField;
  readonly metric: boolean;
  readonly expression?: ResolvedAggregateExpression;
}

function aggregateTypeAllowed(op: AggregateExpression['op'], type: ResolvedValueType): boolean {
  if (op === 'count') return true;
  if (op === 'countDistinct') return type.kind !== 'null';
  if (op === 'sum' || op === 'avg') {
    return type.kind === 'integer' || type.kind === 'decimal' || type.kind === 'money';
  }
  return type.kind !== 'null' && type.kind !== 'boolean';
}

function averageType(type: ResolvedValueType): ResolvedValueType {
  return type.kind === 'integer' ? { kind: 'decimal' } : type;
}

function compileAggregateExpression(
  context: CompileContext,
  expression: AggregateExpression,
  path: string,
  outputId: string,
): EngineResult<ExpressionOutput> {
  const filter = expression.filter === undefined
    ? undefined
    : compileWhere(context, expression.filter, `${path}/filter`);
  if (filter !== undefined && !filter.ok) return filter;
  if (expression.op === 'count') {
    const id = authorizedField(
      context,
      context.dataset.idField,
      { aggregate: 'count' },
      path,
    );
    if (!id.ok) return id;
    const type: ResolvedValueType = { kind: 'integer' };
    return {
      ok: true,
      value: {
        expression: {
          op: 'count',
          ...(filter?.ok === true ? { filter: filter.value } : {}),
        },
        type,
        nullable: false,
        orderFields: [context.dataset.idField],
        shape: resolvedResultShape(outputId, type, false),
      },
    };
  }
  const field = authorizedField(
    context,
    expression.field,
    { aggregate: expression.op },
    `${path}/field`,
  );
  if (!field.ok) return field;
  if (!aggregateTypeAllowed(expression.op, field.value.type)) {
    return fail(semanticError(
      `The ${expression.op} aggregate is not defined for ${field.value.type.kind}.`,
      `${path}/op`,
      ['Use an aggregate compatible with the field kind.'],
    ));
  }
  const type = expression.op === 'avg' ? averageType(field.value.type) : field.value.type;
  const document = context.dataset.fields[expression.field];
  if (document === undefined) {
    return fail(semanticError(
      'The aggregate field is missing from the validated catalog.',
      `${path}/field`,
      ['Use a field in the effective catalog.'],
    ));
  }
  const shape = expression.op === 'min' || expression.op === 'max'
    ? { ...fieldResultShape(outputId, document), nullable: true }
    : resolvedResultShape(outputId, type, true);
  return {
    ok: true,
    value: {
      expression: {
        op: expression.op,
        field: field.value,
        ...(filter?.ok === true ? { filter: filter.value } : {}),
      },
      type,
      nullable: true,
      orderFields: [expression.field],
      shape,
    },
  };
}

function compileHavingLeaf(
  expression: Extract<WhereExpression, { readonly kind: 'predicate' }>,
  outputs: ReadonlyMap<string, OutputMeta>,
  path: string,
): EngineResult<ResolvedOutputPredicate> {
  const meta = outputs.get(expression.field);
  if (!meta?.metric) {
    return fail(semanticError(
      'having may reference only a declared metric id.',
      `${path}/field`,
      ['Use a metric id from this aggregate query.'],
    ));
  }
  switch (expression.op) {
    case 'isNull':
    case 'isNotNull':
      return { ok: true, value: { output: meta.output, op: expression.op } };
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (expression.value === null) {
        return fail(semanticError(
          'Null comparisons in having require isNull or isNotNull.',
          `${path}/op`,
          ['isNull', 'isNotNull'],
        ));
      }
      const value = typeLiteral(meta, expression.value, `${path}/value`);
      if (!value.ok) return value;
      return { ok: true, value: { output: meta.output, op: expression.op, value: value.value } };
    }
    default:
      return fail(semanticError(
        'This predicate operator is not supported in having.',
        `${path}/op`,
        ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'isNull', 'isNotNull'],
      ));
  }
}

function compileHaving(
  expression: WhereExpression,
  outputs: ReadonlyMap<string, OutputMeta>,
  path: string,
): EngineResult<LogicalFilter<ResolvedOutputPredicate>> {
  if (expression.kind === 'predicate') return compileHavingLeaf(expression, outputs, path);
  if (expression.kind === 'not') {
    const item = compileHaving(expression.item, outputs, `${path}/item`);
    return item.ok ? { ok: true, value: { kind: 'not', item: item.value } } : item;
  }
  const items: LogicalFilter<ResolvedOutputPredicate>[] = [];
  for (const [index, expressionItem] of expression.items.entries()) {
    const item = compileHaving(expressionItem, outputs, `${path}/items/${index}`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  const first = items[0];
  if (first === undefined) {
    return fail(semanticError('having requires an item.', path, ['Add a metric predicate.']));
  }
  return { ok: true, value: { kind: expression.kind, items: [first, ...items.slice(1)] } };
}

export interface AggregatePlanOutput {
  readonly plan: AggregateLogicalPlan;
  readonly resultShape: readonly ResultSchemaField[];
}

export function buildAggregatePlan(
  context: CompileContext,
  query: AggregateQuery,
  scope: ExpandedScope,
  filter: LogicalFilter<ResolvedPredicate> | undefined,
): EngineResult<AggregatePlanOutput> {
  const outputs = new Map<string, OutputMeta>();
  const dimensions: ResolvedDimension[] = [];
  const resultShape: ResultSchemaField[] = [];
  for (const [index, dimension] of query.dimensions.entries()) {
    const reserved = ['__proto__', 'prototype', 'constructor'].includes(dimension.id);
    if (reserved) {
      return fail({
        code: 'OUTPUT_ID_INVALID',
        message: 'The output id does not use the AgQL v0 safe identifier grammar.',
        path: `/dimensions/${index}/id`,
        alternatives: ['Choose an id matching [A-Za-z][A-Za-z0-9_]{0,63} and not reserved by v0.'],
      });
    }
    if (outputs.has(dimension.id)) {
      return fail({
        code: 'OUTPUT_ID_COLLISION',
        message: 'The output id is already used by another dimension or metric.',
        path: `/dimensions/${index}/id`,
        alternatives: ['Choose a unique output id matching [A-Za-z][A-Za-z0-9_]{0,63}.'],
      });
    }
    const field = authorizedField(context, dimension.field, 'group', `/dimensions/${index}/field`);
    if (!field.ok) return field;
    const output = { logicalId: dimension.id, slot: index as SafeInteger };
    const document = context.dataset.fields[dimension.field];
    if (document === undefined) return fail(semanticError(
      'The dimension field is missing from the validated catalog.',
      `/dimensions/${index}/field`,
      ['Use a field in the effective catalog.'],
    ));
    let shape: ResultSchemaField;
    if (dimension.kind === 'timeBucket') {
      if (dimension.grain === 'quarter' || dimension.grain === 'year') {
        return fail(semanticError(
          'The calendar grain is not part of the v0 vocabulary.',
          `/dimensions/${index}/grain`,
          ['day', 'fiscalDay', 'week', 'month'],
        ));
      }
      shape = {
        id: dimension.id,
        kind: 'calendarPeriod',
        grain: dimension.grain,
        timezone: dimension.timezone,
        nullable: true,
      };
      if (field.value.type.kind !== 'instant' && field.value.type.kind !== 'date') {
        return fail(semanticError(
          'A time bucket requires a date or instant field.',
          `/dimensions/${index}/field`,
          ['Use a date or instant field.'],
        ));
      }
      if (dimension.timezone !== context.input.calendar.timezone) {
        return fail(semanticError(
          'The time-bucket timezone is not available in this calendar policy.',
          `/dimensions/${index}/timezone`,
          [context.input.calendar.timezone],
        ));
      }
      dimensions.push({
        kind: 'calendarPeriod',
        output,
        field: field.value,
        grain: dimension.grain,
        timezone: dimension.timezone,
        weekStart: context.input.calendar.weekStart,
        fiscalDayStart: context.input.calendar.fiscalDayStart,
        resultKind: 'calendarPeriod',
      });
    } else {
      shape = fieldResultShape(dimension.id, document);
      dimensions.push({ kind: 'field', output, field: field.value });
    }
    outputs.set(dimension.id, {
      output,
      type: field.value.type,
      nullable: shape.nullable,
      orderFields: [dimension.field],
      shape,
      metric: false,
    });
    resultShape.push(shape);
  }
  const metrics: ResolvedMetric[] = [];
  for (const [index, metric] of query.metrics.entries()) {
    const slot = (query.dimensions.length + index) as SafeInteger;
    if (['__proto__', 'prototype', 'constructor'].includes(metric.id)) {
      return fail({
        code: 'OUTPUT_ID_INVALID',
        message: 'The output id does not use the AgQL v0 safe identifier grammar.',
        path: `/metrics/${index}/id`,
        alternatives: ['Choose an id matching [A-Za-z][A-Za-z0-9_]{0,63} and not reserved by v0.'],
      });
    }
    if (outputs.has(metric.id)) {
      return fail({
        code: 'OUTPUT_ID_COLLISION',
        message: 'The output id is already used by another dimension or metric.',
        path: `/metrics/${index}/id`,
        alternatives: ['Choose a unique output id matching [A-Za-z][A-Za-z0-9_]{0,63}.'],
      });
    }
    const output = { logicalId: metric.id, slot };
    if (metric.op !== 'ratio') {
      const compiled = compileAggregateExpression(context, metric, `/metrics/${index}`, metric.id);
      if (!compiled.ok) return compiled;
      metrics.push({ kind: 'aggregate', output, aggregate: compiled.value.expression });
      outputs.set(metric.id, {
        output, ...compiled.value, metric: true, expression: compiled.value.expression,
      });
      resultShape.push(compiled.value.shape);
    } else {
      const numerator = outputs.get(metric.numerator);
      if (numerator?.metric !== true || numerator.expression === undefined) {
        return fail(semanticError(
          'ratio numerator must reference an earlier aggregate metric.',
          `/metrics/${index}/numerator`,
          ['Reference an earlier count, countDistinct, sum, avg, min, or max metric.'],
        ));
      }
      const denominator = outputs.get(metric.denominator);
      if (denominator?.metric !== true || denominator.expression === undefined) {
        return fail(semanticError(
          'ratio denominator must reference an earlier aggregate metric.',
          `/metrics/${index}/denominator`,
          ['Reference an earlier count, countDistinct, sum, avg, min, or max metric.'],
        ));
      }
      const numericKinds = new Set(['integer', 'decimal', 'money']);
      if (!numericKinds.has(numerator.type.kind)
        || !numericKinds.has(denominator.type.kind)
        || (numerator.type.kind === 'money'
          && denominator.type.kind === 'money'
          && numerator.type.currency !== denominator.type.currency)
        || ((numerator.type.kind === 'money') !== (denominator.type.kind === 'money'))) {
        return fail(semanticError(
          'ratio requires compatible numeric aggregate operands.',
          `/metrics/${index}`,
          ['Use numeric operands, with matching currencies for money.'],
        ));
      }
      metrics.push({
        kind: 'ratio',
        output,
        numerator: numerator.expression,
        denominator: denominator.expression,
        divideByZero: 'null',
      });
      const type: ResolvedValueType = { kind: 'decimal' };
      const shape = resolvedResultShape(metric.id, type, true);
      outputs.set(metric.id, {
        output,
        type,
        nullable: true,
        orderFields: [...numerator.orderFields, ...denominator.orderFields],
        shape,
        metric: true,
      });
      resultShape.push(shape);
    }
  }
  const firstMetric = metrics[0];
  if (firstMetric === undefined) {
    return fail(semanticError(
      'Aggregate queries require a metric.',
      '/metrics',
      ['Add a metric.'],
    ));
  }
  const having = query.having === undefined
    ? undefined
    : compileHaving(query.having, outputs, '/having');
  if (having !== undefined && !having.ok) return having;
  const order = [];
  for (const [index, item] of query.order.entries()) {
    const meta = outputs.get(item.by);
    if (meta === undefined) {
      return fail(semanticError(
        'Aggregate ordering must reference an output id.',
        `/order/${index}/by`,
        ['Use a declared dimension or metric id.'],
      ));
    }
    for (const fieldId of meta.orderFields) {
      const allowed = authorizedField(
        context,
        fieldId,
        'order',
        `/order/${index}/by`,
      );
      if (!allowed.ok) return allowed;
    }
    order.push({ output: meta.output, direction: item.dir });
  }
  const firstOrder = order[0];
  if (firstOrder === undefined) {
    return fail(semanticError(
      'Aggregate ordering is required.',
      '/order',
      ['Add an output order.'],
    ));
  }
  let tieBreak: AggregateLogicalPlan['tieBreak'];
  const firstDimension = dimensions[0];
  if (firstDimension === undefined) {
    tieBreak = { kind: 'singleAggregateRow' };
  } else {
    tieBreak = {
      kind: 'dimensionTuple',
      fields: [firstDimension.field, ...dimensions.slice(1).map(({ field }) => field)],
    };
  }
  return {
    ok: true,
    value: {
      plan: {
        languageVersion: '0',
        mode: 'aggregate',
        profile: 'aggregate.v0',
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
        dimensions,
        metrics: [firstMetric, ...metrics.slice(1)],
        ...(having?.ok === true ? { having: having.value } : {}),
        order: [firstOrder, ...order.slice(1)],
        tieBreak,
      },
      resultShape,
    },
  };
}
