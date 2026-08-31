import type { AdapterResultValue } from '@agql/contracts';

import { calendarPeriodKey, compareTypedValues } from './scalars.ts';
import type { CompiledAggregateQuery } from './types.ts';

export interface AggregateSortableResult {
  readonly group: { readonly tieBreak: readonly AdapterResultValue[] };
  readonly values: ReadonlyMap<number, AdapterResultValue>;
}

function compareCalendarPeriods(
  left: Extract<AdapterResultValue, { readonly kind: 'calendarPeriod' }>,
  right: Extract<AdapterResultValue, { readonly kind: 'calendarPeriod' }>,
): -1 | 0 | 1 {
  const leftKey = calendarPeriodKey(left.value);
  const rightKey = calendarPeriodKey(right.value);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function compareOutputValue(
  left: AdapterResultValue,
  right: AdapterResultValue,
): -1 | 0 | 1 {
  if (left.kind === 'calendarPeriod' || right.kind === 'calendarPeriod') {
    if (left.kind !== 'calendarPeriod' || right.kind !== 'calendarPeriod') {
      throw new TypeError('Aggregate output kinds must match across groups.');
    }
    return compareCalendarPeriods(left, right);
  }
  return compareTypedValues(left, right);
}

function compareOutput(
  left: ReadonlyMap<number, AdapterResultValue>,
  right: ReadonlyMap<number, AdapterResultValue>,
  compiled: CompiledAggregateQuery,
): number {
  for (const order of compiled.plan.order) {
    const leftValue = left.get(order.output.slot);
    const rightValue = right.get(order.output.slot);
    if (leftValue === undefined || rightValue === undefined) {
      throw new TypeError('Aggregate order slot missing.');
    }
    const leftNull = leftValue.kind === 'null';
    const rightNull = rightValue.kind === 'null';
    if (leftNull !== rightNull) {
      const nullFirst = order.nulls === 'first';
      return leftNull === nullFirst ? -1 : 1;
    }
    if (!leftNull) {
      const comparison = compareOutputValue(leftValue, rightValue);
      if (comparison !== 0) return order.direction === 'asc' ? comparison : -comparison;
    }
  }
  return 0;
}

function compareTieBreak(
  left: AggregateSortableResult['group'],
  right: AggregateSortableResult['group'],
): number {
  for (let index = 0; index < left.tieBreak.length; index += 1) {
    const leftValue = left.tieBreak[index];
    const rightValue = right.tieBreak[index];
    if (leftValue === undefined || rightValue === undefined) {
      throw new TypeError('Aggregate dimension tie-break shape differs between groups.');
    }
    if (leftValue.kind === 'null' || rightValue.kind === 'null') {
      if (leftValue.kind !== rightValue.kind) return leftValue.kind === 'null' ? 1 : -1;
      continue;
    }
    const comparison = compareOutputValue(leftValue, rightValue);
    if (comparison !== 0) return comparison;
  }
  return left.tieBreak.length - right.tieBreak.length;
}

export function sortAggregateResults(
  results: AggregateSortableResult[],
  compiled: CompiledAggregateQuery,
): void {
  results.sort((left, right) => {
    const ordered = compareOutput(left.values, right.values, compiled);
    return ordered === 0 ? compareTieBreak(left.group, right.group) : ordered;
  });
}
