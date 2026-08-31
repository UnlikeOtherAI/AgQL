import { Buffer } from 'node:buffer';

import {
  CanonicalDecimalSchema,
  DateValueSchema,
  InstantValueSchema,
  MoneyValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
  compareDecimal,
  compareMoney,
} from '@agql/schemas';
import type {
  CalendarPeriod,
  CanonicalDecimal,
  SafeInteger,
} from '@agql/schemas';
import type { ResolvedFieldBinding, TypedValue } from '@agql/contracts';

import type { SqliteParameter } from './types.ts';

export function safeInteger(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

function parsedJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function sqliteInteger(value: unknown, field: ResolvedFieldBinding): SafeInteger {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`SQLite returned a non-safe integer for ${field.logicalId}.`);
  }
  return safeInteger(value);
}

function sqliteText(value: unknown, field: ResolvedFieldBinding): string {
  if (typeof value !== 'string') {
    throw new TypeError(`SQLite returned non-text for ${field.logicalId}.`);
  }
  return value;
}

export function typedValueFromSqlite(value: unknown, field: ResolvedFieldBinding): TypedValue {
  if (value === null) {
    if (!field.nullable) throw new TypeError(`SQLite returned NULL for ${field.logicalId}.`);
    return { kind: 'null', value: null };
  }
  switch (field.type.kind) {
    case 'id':
      return { kind: 'id', value: sqliteText(value, field) };
    case 'boolean': {
      const numeric = sqliteInteger(value, field);
      if (numeric !== 0 && numeric !== 1) {
        throw new TypeError(`SQLite returned a non-boolean integer for ${field.logicalId}.`);
      }
      return { kind: 'boolean', value: numeric === 1 };
    }
    case 'integer':
      return { kind: 'integer', value: sqliteInteger(value, field) };
    case 'decimal':
      return { kind: 'decimal', value: CanonicalDecimalSchema.parse(sqliteText(value, field)) };
    case 'money': {
      const money = MoneyValueSchema.parse(parsedJson(sqliteText(value, field)));
      if (money.currency !== field.type.currency) {
        throw new TypeError(`SQLite returned an unexpected currency for ${field.logicalId}.`);
      }
      return { kind: 'money', value: money };
    }
    case 'text':
      return { kind: 'text', value: NormalizedTextSchema.parse(sqliteText(value, field)) };
    case 'enum': {
      const enumValue = sqliteText(value, field);
      if (!field.type.codes.includes(enumValue)) {
        throw new TypeError(`SQLite returned an undeclared enum code for ${field.logicalId}.`);
      }
      return { kind: 'enum', value: enumValue };
    }
    case 'date':
      return { kind: 'date', value: DateValueSchema.parse(sqliteText(value, field)) };
    case 'instant':
      return { kind: 'instant', value: InstantValueSchema.parse(sqliteText(value, field)) };
    case 'null':
      throw new TypeError(`SQLite returned a value for null-only field ${field.logicalId}.`);
  }
}

export function scalarForWrite(value: TypedValue): SqliteParameter {
  const raw: unknown = Reflect.get(value, 'value');
  switch (value.kind) {
    case 'null':
      if (raw !== null) throw new TypeError('A null TypedValue must carry null.');
      return null;
    case 'boolean':
      if (typeof raw !== 'boolean') {
        throw new TypeError('A boolean TypedValue must carry a boolean.');
      }
      return raw ? 1 : 0;
    case 'integer':
      return SafeIntegerSchema.parse(raw);
    case 'decimal':
      return CanonicalDecimalSchema.parse(raw);
    case 'money':
      return JSON.stringify(MoneyValueSchema.parse(raw));
    case 'text':
      return NormalizedTextSchema.parse(raw);
    case 'date':
      return DateValueSchema.parse(raw);
    case 'instant':
      return InstantValueSchema.parse(raw);
    case 'id':
      if (typeof raw !== 'string' || raw === '') {
        throw new TypeError('An id TypedValue must carry a non-empty string.');
      }
      return raw;
    case 'enum':
      if (typeof raw !== 'string') {
        throw new TypeError('An enum TypedValue must carry a string code.');
      }
      return raw;
  }
}

function orderedString(value: TypedValue): string {
  switch (value.kind) {
    case 'id':
    case 'text':
    case 'enum':
    case 'date':
    case 'instant':
      return value.value;
    default:
      throw new TypeError(`${value.kind} is not a string-ordered value.`);
  }
}

export function compareTypedValues(left: TypedValue, right: TypedValue): -1 | 0 | 1 {
  if (left.kind === 'null' && right.kind === 'null') return 0;
  if (left.kind === 'null') return -1;
  if (right.kind === 'null') return 1;
  if (left.kind === 'decimal' && right.kind === 'decimal') {
    return compareDecimal(left.value, right.value);
  }
  if (left.kind === 'money' && right.kind === 'money') {
    const comparison = compareMoney(left.value, right.value);
    if (!comparison.ok) throw new TypeError('Cannot compare money values in different currencies.');
    return comparison.value;
  }
  if (left.kind === 'integer' && right.kind === 'integer') {
    if (left.value < right.value) return -1;
    if (left.value > right.value) return 1;
    return 0;
  }
  if (left.kind === 'boolean' && right.kind === 'boolean') {
    if (left.value === right.value) return 0;
    return left.value ? 1 : -1;
  }
  if (left.kind !== right.kind) {
    throw new TypeError(`Cannot compare ${left.kind} and ${right.kind}.`);
  }
  const comparison = Buffer.compare(
    Buffer.from(orderedString(left), 'utf8'),
    Buffer.from(orderedString(right), 'utf8'),
  );
  if (comparison < 0) return -1;
  if (comparison > 0) return 1;
  return 0;
}

export function typedValueKey(value: TypedValue): string {
  if (value.kind === 'money') return `money:${value.value.currency}:${value.value.amount}`;
  if (value.kind === 'null') return 'null';
  return `${value.kind}:${String(value.value)}`;
}

export function isNull(value: TypedValue): boolean {
  return value.kind === 'null';
}

export function decimalAverage(
  sum: CanonicalDecimal,
  count: SafeInteger,
): CanonicalDecimal | undefined {
  if (count <= 0) return undefined;
  return divideDecimalsExactly(sum, CanonicalDecimalSchema.parse(String(count)));
}

export function divideDecimalsExactly(
  numeratorValue: CanonicalDecimal,
  denominatorValue: CanonicalDecimal,
): CanonicalDecimal | undefined {
  const numerator = decimalFraction(numeratorValue);
  const denominator = decimalFraction(denominatorValue);
  if (denominator.numerator === 0n) return undefined;
  const fractionNumerator = numerator.numerator * denominator.denominator;
  const fractionDenominator = numerator.denominator * denominator.numerator;
  const negative = fractionNumerator < 0n !== fractionDenominator < 0n;
  const unsignedNumerator = fractionNumerator < 0n ? -fractionNumerator : fractionNumerator;
  const unsignedDenominator = fractionDenominator < 0n ? -fractionDenominator : fractionDenominator;
  const divisor = greatestCommonDivisor(unsignedNumerator, unsignedDenominator);
  let reducedDenominator = unsignedDenominator / divisor;
  let twos = 0;
  let fives = 0;
  while (reducedDenominator % 2n === 0n) {
    reducedDenominator /= 2n;
    twos += 1;
  }
  while (reducedDenominator % 5n === 0n) {
    reducedDenominator /= 5n;
    fives += 1;
  }
  if (reducedDenominator !== 1n) return undefined;
  const scale = Math.max(twos, fives);
  const adjusted = unsignedNumerator / divisor
    * (BigInt(2) ** BigInt(scale - twos))
    * (BigInt(5) ** BigInt(scale - fives));
  const sign = negative && adjusted !== 0n ? '-' : '';
  const absolute = adjusted.toString();
  if (scale === 0) return CanonicalDecimalSchema.parse(`${sign}${absolute}`);
  const padded = absolute.padStart(scale + 1, '0');
  return CanonicalDecimalSchema.parse(
    `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/\.0+$/u, ''),
  );
}

function decimalFraction(value: CanonicalDecimal): {
  readonly numerator: bigint;
  readonly denominator: bigint;
} {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const point = unsigned.indexOf('.');
  const fraction = point < 0 ? '' : unsigned.slice(point + 1);
  const digits = (point < 0 ? unsigned : unsigned.slice(0, point)) + fraction;
  return {
    numerator: BigInt(`${negative ? '-' : ''}${digits}`),
    denominator: BigInt(10) ** BigInt(fraction.length),
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let first = left;
  let second = right;
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

export function calendarPeriodKey(period: CalendarPeriod): string {
  return `${period.start}:${period.endExclusive}:${period.timezone}`;
}
