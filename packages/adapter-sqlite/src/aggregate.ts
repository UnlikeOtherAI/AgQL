import { DatabaseSync } from 'node:sqlite';

import {
  CanonicalDecimalSchema,
  SafeIntegerSchema,
  addDecimal,
  addMoney,
} from '@agql/schemas';
import type {
  AdapterExecutionResult,
  AdapterOutcome,
  LogicalFilter,
  ResolvedAggregateExpression,
  ResolvedMetric,
  ResolvedOutputPredicate,
  ResolvedPredicate,
  TypedValue,
} from '@agql/contracts';

import { calendarPeriod } from './calendar.ts';
import {
  compareTypedValues,
  decimalAverage,
  divideDecimalsExactly,
  isNull,
  typedValueFromSqlite,
  typedValueKey,
} from './scalars.ts';
import type { CompiledAggregateQuery, SqliteParameter } from './types.ts';

type SqliteRow = Readonly<Record<string, null | number | bigint | string | Uint8Array>>;
type SourceRow = ReadonlyMap<string, TypedValue>;

class AggregateCapabilityError extends Error {}

interface AggregateGroup {
  readonly key: string;
  readonly dimensions: ReadonlyMap<number, TypedValue>;
  readonly rows: readonly SourceRow[];
}

function values(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SqliteParameter[],
): readonly SqliteRow[] {
  return database.prepare(sql).all(...parameters);
}

function resultValue(
  row: SqliteRow,
  name: string,
): null | number | bigint | string | Uint8Array {
  const value = row[name];
  if (value === undefined) {
    throw new TypeError(`SQLite omitted expected aggregate source column ${name}.`);
  }
  return value;
}

function sourceRows(
  resultRows: readonly SqliteRow[],
  compiled: CompiledAggregateQuery,
): readonly SourceRow[] {
  return resultRows.map((row) => {
    const source = new Map<string, TypedValue>();
    for (const [index, field] of compiled.fields.entries()) {
      source.set(
        field.logicalId,
        typedValueFromSqlite(resultValue(row, `f${index}`), field),
      );
    }
    return source;
  });
}

function sourceValue(row: SourceRow, fieldId: string): TypedValue {
  const value = row.get(fieldId);
  if (value === undefined) throw new TypeError(`Aggregate source did not include ${fieldId}.`);
  return value;
}

function sameValue(left: TypedValue, right: TypedValue): boolean {
  if (left.kind === 'null' || right.kind === 'null') return left.kind === right.kind;
  if (left.kind !== right.kind) return false;
  return typedValueKey(left) === typedValueKey(right);
}

function predicateMatches(
  row: SourceRow,
  predicate: ResolvedPredicate,
): boolean {
  const left = sourceValue(row, predicate.field.logicalId);
  switch (predicate.kind) {
    case 'null':
      return predicate.op === 'isNull' ? isNull(left) : !isNull(left);
    case 'substring':
      if (left.kind !== 'text') return false;
      return predicate.op === 'contains'
        ? left.value.includes(predicate.value)
        : left.value.startsWith(predicate.value);
    case 'instantRange':
      if (left.kind !== 'instant') return false;
      return left.value >= predicate.startInclusive && left.value < predicate.endExclusive;
    case 'list': {
      const included = predicate.values.some((item) => sameValue(left, item));
      return predicate.op === 'in' ? included : !included;
    }
    case 'comparison':
      if (predicate.op === 'eq') return sameValue(left, predicate.value);
      if (predicate.op === 'ne') return !sameValue(left, predicate.value);
      if (isNull(left) || isNull(predicate.value) || left.kind !== predicate.value.kind) {
        return false;
      }
      return comparisonMatches(compareTypedValues(left, predicate.value), predicate.op);
  }
}

function comparisonMatches(
  comparison: -1 | 0 | 1,
  operator: 'lt' | 'lte' | 'gt' | 'gte',
): boolean {
  if (operator === 'lt') return comparison < 0;
  if (operator === 'lte') return comparison <= 0;
  if (operator === 'gt') return comparison > 0;
  return comparison >= 0;
}

function filterMatches(
  row: SourceRow,
  filter: LogicalFilter<ResolvedPredicate> | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.kind === 'not') return !filterMatches(row, filter.item);
  if (filter.kind === 'and') return filter.items.every((item) => filterMatches(row, item));
  if (filter.kind === 'or') return filter.items.some((item) => filterMatches(row, item));
  return predicateMatches(row, filter);
}

function dimensionGroup(
  source: SourceRow,
  compiled: CompiledAggregateQuery,
): { readonly key: string; readonly values: ReadonlyMap<number, TypedValue> } {
  const dimensions = new Map<number, TypedValue>();
  const keyParts: string[] = [];
  for (const dimension of compiled.plan.dimensions) {
    const sourceValueForDimension = sourceValue(source, dimension.field.logicalId);
    if (dimension.kind === 'calendarPeriod') {
      if (sourceValueForDimension.kind !== 'instant') {
        throw new TypeError('Calendar dimension field must have instant values.');
      }
      // AdapterRow cannot carry CalendarPeriod: contracts currently omit it from TypedValue.
      calendarPeriod(sourceValueForDimension.value, dimension.timezone, dimension.grain);
      throw new AggregateCapabilityError(
        'Calendar period output is not representable by AdapterExecutionResult.AdapterRow.',
      );
    }
    dimensions.set(dimension.output.slot, sourceValueForDimension);
    keyParts.push(typedValueKey(sourceValueForDimension));
  }
  return { key: keyParts.join('\u001f'), values: dimensions };
}

function filteredRows(
  rows: readonly SourceRow[],
  expression: ResolvedAggregateExpression,
): readonly SourceRow[] {
  return rows.filter((row) => filterMatches(row, expression.filter));
}

function numericFieldValues(
  rows: readonly SourceRow[],
  expression: Exclude<ResolvedAggregateExpression, { readonly op: 'count' }>,
): readonly TypedValue[] {
  return rows
    .map((row) => sourceValue(row, expression.field.logicalId))
    .filter((value) => !isNull(value));
}

function sumValues(valuesToSum: readonly TypedValue[]): TypedValue {
  const first = valuesToSum[0];
  if (first === undefined) return { kind: 'null', value: null };
  if (first.kind === 'integer') {
    let sum = 0;
    for (const item of valuesToSum) {
      if (item.kind !== 'integer') throw new TypeError('Aggregate field kinds must match.');
      sum += item.value;
      if (!Number.isSafeInteger(sum)) {
        throw new AggregateCapabilityError('Integer sum exceeds safe range.');
      }
    }
    return { kind: 'integer', value: SafeIntegerSchema.parse(sum) };
  }
  if (first.kind === 'decimal') {
    let sum = CanonicalDecimalSchema.parse('0');
    for (const item of valuesToSum) {
      if (item.kind !== 'decimal') throw new TypeError('Aggregate field kinds must match.');
      sum = addDecimal(sum, item.value);
    }
    return { kind: 'decimal', value: sum };
  }
  if (first.kind === 'money') {
    let sum = first.value;
    for (const item of valuesToSum.slice(1)) {
      if (item.kind !== 'money') throw new TypeError('Aggregate field kinds must match.');
      const added = addMoney(sum, item.value);
      if (!added.ok) throw new AggregateCapabilityError('Money sum spans more than one currency.');
      sum = added.value;
    }
    return { kind: 'money', value: sum };
  }
  throw new AggregateCapabilityError(
    'sum is available only for integer, decimal, and money fields.',
  );
}

function averageValues(valuesToAverage: readonly TypedValue[]): TypedValue {
  const sum = sumValues(valuesToAverage);
  if (sum.kind === 'null') return sum;
  const count = SafeIntegerSchema.parse(valuesToAverage.length);
  if (sum.kind === 'integer') {
    const average = decimalAverage(
      CanonicalDecimalSchema.parse(String(sum.value)),
      count,
    );
    if (average === undefined) {
      throw new AggregateCapabilityError('Average has no terminating decimal form.');
    }
    return { kind: 'decimal', value: average };
  }
  if (sum.kind === 'decimal') {
    const average = decimalAverage(sum.value, count);
    if (average === undefined) {
      throw new AggregateCapabilityError('Average has no terminating decimal form.');
    }
    return { kind: 'decimal', value: average };
  }
  if (sum.kind === 'money') {
    const average = decimalAverage(sum.value.amount, count);
    if (average === undefined) {
      throw new AggregateCapabilityError('Average has no terminating decimal form.');
    }
    return { kind: 'money', value: { amount: average, currency: sum.value.currency } };
  }
  throw new AggregateCapabilityError(
    'avg is available only for integer, decimal, and money fields.',
  );
}

function aggregateValue(
  expression: ResolvedAggregateExpression,
  rowsToAggregate: readonly SourceRow[],
): TypedValue {
  const filtered = filteredRows(rowsToAggregate, expression);
  if (expression.op === 'count') {
    return { kind: 'integer', value: SafeIntegerSchema.parse(filtered.length) };
  }
  const fieldValues = numericFieldValues(filtered, expression);
  if (expression.op === 'countDistinct') {
    const distinct = new Set(fieldValues.map(typedValueKey));
    return { kind: 'integer', value: SafeIntegerSchema.parse(distinct.size) };
  }
  if (expression.op === 'sum') return sumValues(fieldValues);
  if (expression.op === 'avg') return averageValues(fieldValues);
  const first = fieldValues[0];
  if (first === undefined) return { kind: 'null', value: null };
  return fieldValues.slice(1).reduce((best, item) => {
    const comparison = compareTypedValues(item, best);
    const takeItem = expression.op === 'min' ? comparison < 0 : comparison > 0;
    return takeItem ? item : best;
  }, first);
}

function metricValue(
  metric: ResolvedMetric,
  rowsToAggregate: readonly SourceRow[],
): TypedValue {
  if (metric.kind === 'aggregate') return aggregateValue(metric.aggregate, rowsToAggregate);
  const numerator = aggregateValue(metric.numerator, rowsToAggregate);
  const denominator = aggregateValue(metric.denominator, rowsToAggregate);
  if (isNull(numerator) || isNull(denominator)) return { kind: 'null', value: null };
  const numeratorDecimal = numerator.kind === 'integer'
    ? CanonicalDecimalSchema.parse(String(numerator.value))
    : numerator.kind === 'decimal' ? numerator.value : undefined;
  const denominatorDecimal = denominator.kind === 'integer'
    ? CanonicalDecimalSchema.parse(String(denominator.value))
    : denominator.kind === 'decimal' ? denominator.value : undefined;
  if (numeratorDecimal === undefined || denominatorDecimal === undefined) {
    throw new AggregateCapabilityError('ratio requires integer or decimal aggregate operands.');
  }
  const ratio = divideDecimalsExactly(numeratorDecimal, denominatorDecimal);
  if (ratio === undefined) return { kind: 'null', value: null };
  return { kind: 'decimal', value: ratio };
}

function outputMatches(
  value: TypedValue,
  predicate: ResolvedOutputPredicate,
): boolean {
  if (predicate.op === 'isNull') return isNull(value);
  if (predicate.op === 'isNotNull') return !isNull(value);
  if (predicate.value === undefined) {
    throw new TypeError('Comparison output predicate requires a value.');
  }
  if (predicate.op === 'eq') return sameValue(value, predicate.value);
  if (predicate.op === 'ne') return !sameValue(value, predicate.value);
  if (isNull(value) || isNull(predicate.value) || value.kind !== predicate.value.kind) {
    return false;
  }
  const comparison = compareTypedValues(value, predicate.value);
  return predicate.op === 'lt'
    ? comparison < 0
    : predicate.op === 'lte'
      ? comparison <= 0
      : predicate.op === 'gt'
        ? comparison > 0
        : comparison >= 0;
}

function havingMatches(
  valuesBySlot: ReadonlyMap<number, TypedValue>,
  having: LogicalFilter<ResolvedOutputPredicate> | undefined,
): boolean {
  if (having === undefined) return true;
  if ('kind' in having) {
    if (having.kind === 'not') return !havingMatches(valuesBySlot, having.item);
    if (having.kind === 'and') {
      return having.items.every((item) => havingMatches(valuesBySlot, item));
    }
    return having.items.some((item) => havingMatches(valuesBySlot, item));
  }
  const value = valuesBySlot.get(having.output.slot);
  if (value === undefined) {
    throw new TypeError('Having predicate references an absent output slot.');
  }
  return outputMatches(value, having);
}

function outputRow(
  valuesBySlot: ReadonlyMap<number, TypedValue>,
): readonly TypedValue[] {
  const slots = [...valuesBySlot.keys()].sort((left, right) => left - right);
  return slots.map((slot, index) => {
    if (slot !== index) {
      throw new TypeError('Aggregate output slots must be contiguous and zero-based.');
    }
    const value = valuesBySlot.get(slot);
    if (value === undefined) throw new TypeError('Aggregate output slot is missing.');
    return value;
  });
}

function compareOutput(
  left: ReadonlyMap<number, TypedValue>,
  right: ReadonlyMap<number, TypedValue>,
  compiled: CompiledAggregateQuery,
): number {
  for (const order of compiled.plan.order) {
    const leftValue = left.get(order.output.slot);
    const rightValue = right.get(order.output.slot);
    if (leftValue === undefined || rightValue === undefined) {
      throw new TypeError('Aggregate order slot missing.');
    }
    const leftNull = isNull(leftValue);
    const rightNull = isNull(rightValue);
    if (leftNull !== rightNull) {
      const nullFirst = order.nulls === 'first';
      return leftNull === nullFirst ? -1 : 1;
    }
    if (!leftNull) {
      const comparison = compareTypedValues(leftValue, rightValue);
      if (comparison !== 0) {
        return order.direction === 'asc' ? comparison : -comparison;
      }
    }
  }
  return 0;
}

export function executeAggregate(
  databasePath: string,
  compiled: CompiledAggregateQuery,
): AdapterOutcome<AdapterExecutionResult> {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    readOnly: true,
    defensive: true,
  });
  try {
    const raw = values(database, compiled.sql, compiled.parameters);
    if (raw.length >= compiled.plan.hardRowLimit) {
      return {
        kind: 'refusal',
        refusal: {
          code: 'COST_GATE_REFUSAL',
          message: 'Aggregate source rows reached the engine-approved hard row limit.',
          path: '/take',
          alternatives: ['Add a selective predicate.', 'Raise the engine-approved hard row limit.'],
          remedy: 'Reduce the aggregate source rows before execution.',
        },
      };
    }
    const groups = new Map<string, {
      dimensions: ReadonlyMap<number, TypedValue>;
      rows: SourceRow[];
    }>();
    for (const source of sourceRows(raw, compiled)) {
      const grouping = dimensionGroup(source, compiled);
      const existing = groups.get(grouping.key);
      if (existing === undefined) {
        groups.set(grouping.key, { dimensions: grouping.values, rows: [source] });
      } else {
        existing.rows.push(source);
      }
    }
    if (compiled.plan.dimensions.length === 0 && groups.size === 0) {
      groups.set('', { dimensions: new Map(), rows: [] });
    }
    const results: {
      readonly group: AggregateGroup;
      readonly values: ReadonlyMap<number, TypedValue>;
    }[] = [];
    for (const [key, group] of groups) {
      const valuesBySlot = new Map<number, TypedValue>(group.dimensions);
      for (const metric of compiled.plan.metrics) {
        valuesBySlot.set(metric.output.slot, metricValue(metric, group.rows));
      }
      if (havingMatches(valuesBySlot, compiled.plan.having)) {
        results.push({
          group: { key, dimensions: group.dimensions, rows: group.rows },
          values: valuesBySlot,
        });
      }
    }
    results.sort((left, right) => {
      const ordered = compareOutput(left.values, right.values, compiled);
      if (ordered !== 0) return ordered;
      if (left.group.key < right.group.key) return -1;
      if (left.group.key > right.group.key) return 1;
      return 0;
    });
    const truncated = results.length > compiled.plan.take;
    const selected = truncated ? results.slice(0, compiled.plan.take) : results;
    return {
      kind: 'success',
      value: {
        rows: selected.map((result) => outputRow(result.values)),
        truncated,
        snapshot: { kind: 'none' },
      },
    };
  } catch (caught: unknown) {
    if (caught instanceof AggregateCapabilityError) {
      return {
        kind: 'refusal',
        refusal: {
          code: 'UNSUPPORTED_PROFILE',
          message: caught.message,
          path: '/dimensions',
          alternatives: ['Use an output type representable by the current AdapterContract.'],
          remedy: 'Use field dimensions until AdapterRow adds calendar-period values.',
        },
      };
    }
    throw caught;
  } finally {
    database.close();
  }
}
