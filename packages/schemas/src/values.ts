import { Decimal } from 'decimal.js';
import { z } from 'zod';

import type { AgqlError, ValidationResult } from './errors.ts';

declare const canonicalDecimalBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;
declare const normalizedTextBrand: unique symbol;
declare const dateBrand: unique symbol;
declare const instantBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

/** RFC §2 canonical, non-exponential decimal wire value. */
export type CanonicalDecimal = string & { readonly [canonicalDecimalBrand]: true };

/** RFC §2 ISO-4217 alphabetic currency code. */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };

/** RFC §2 text known to be in Unicode NFC. */
export type NormalizedText = string & { readonly [normalizedTextBrand]: true };

export type DateValue = string & { readonly [dateBrand]: true };
export type InstantValue = string & { readonly [instantBrand]: true };
export type SafeInteger = number & { readonly [safeIntegerBrand]: true };

export interface MoneyValue<C extends CurrencyCode = CurrencyCode> {
  readonly amount: CanonicalDecimal;
  readonly currency: C;
}

const CANONICAL_DECIMAL = /^(?!-0$)-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

export const ISO_4217_CODES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD',
  'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP',
  'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU',
  'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL',
  'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES',
  'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
  'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR',
  'MWK', 'MXN', 'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN',
  'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV',
  'WST', 'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR',
  'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX', 'YER', 'ZAR', 'ZMW', 'ZWG',
] as const;

const CURRENCY_CODES: ReadonlySet<string> = new Set(ISO_4217_CODES);

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDateParts(year: string, month: string, day: string): boolean {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  return numericMonth >= 1 && numericMonth <= 12
    && numericDay >= 1 && numericDay <= daysInMonth(numericYear, numericMonth);
}

export const CanonicalDecimalSchema = z.string().regex(CANONICAL_DECIMAL).transform(
  (value): CanonicalDecimal => value as CanonicalDecimal,
);

export const CurrencyCodeSchema = z.enum(ISO_4217_CODES).refine(
  (value) => CURRENCY_CODES.has(value),
  'Currency must be an assigned ISO-4217 alphabetic code.',
).transform((value): CurrencyCode => value as CurrencyCode);

export const NormalizedTextSchema = z.string().refine(
  (value) => value === value.normalize('NFC'),
  'Text must use Unicode NFC normalization.',
).transform((value): NormalizedText => value as NormalizedText);

export const DateValueSchema = z.string().refine((value) => {
  const match = DATE.exec(value);
  return match !== null && validDateParts(match[1] ?? '', match[2] ?? '', match[3] ?? '');
}, 'Date must be a real calendar date in YYYY-MM-DD form.').transform(
  (value): DateValue => value as DateValue,
);

export const InstantValueSchema = z.string().refine((value) => {
  const match = INSTANT.exec(value);
  if (match === null) return false;
  const dateValid = validDateParts(match[1] ?? '', match[2] ?? '', match[3] ?? '');
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return dateValid && hour <= 23 && minute <= 59 && second <= 59;
}, 'Instant must be a real RFC 3339 UTC instant with at most nanosecond precision.').transform(
  (value): InstantValue => value as InstantValue,
);

export const SafeIntegerSchema = z.number().int().safe().transform(
  (value): SafeInteger => value as SafeInteger,
);

export const PositiveSafeIntegerSchema = z.number().int().safe().positive().transform(
  (value): SafeInteger => value as SafeInteger,
);

export const NonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative().transform(
  (value): SafeInteger => value as SafeInteger,
);

export const MoneyValueSchema = z.object({
  amount: CanonicalDecimalSchema,
  currency: CurrencyCodeSchema,
}).strict();

export const CalendarPeriodSchema = z.object({
  start: DateValueSchema,
  endExclusive: DateValueSchema,
  timezone: z.string().min(1),
}).strict();

export type CalendarPeriod = z.infer<typeof CalendarPeriodSchema>;

export const AgqlLiteralSchema = z.union([
  z.string(),
  z.boolean(),
  SafeIntegerSchema,
  MoneyValueSchema,
  z.null(),
]);

export type AgqlLiteral = z.infer<typeof AgqlLiteralSchema>;

function operationPrecision(values: readonly CanonicalDecimal[], multiplication = false): number {
  const digits = values.map((value) => value.replace(/[-.]/gu, '').length);
  if (multiplication) return digits.reduce((total, value) => total + value, 0) + 2;
  return Math.max(...digits) + 2;
}

function decimalContext(
  values: readonly CanonicalDecimal[],
  multiplication = false,
): typeof Decimal {
  return Decimal.clone({
    precision: operationPrecision(values, multiplication),
    rounding: Decimal.ROUND_HALF_EVEN,
    toExpNeg: -1_000_000_000,
    toExpPos: 1_000_000_000,
  });
}

function canonicalResult(value: Decimal): CanonicalDecimal {
  const fixed = value.toFixed();
  if (value.isZero()) return '0' as CanonicalDecimal;
  const withoutTrailing = fixed.includes('.')
    ? fixed.replace(/0+$/u, '').replace(/\.$/u, '')
    : fixed;
  return withoutTrailing as CanonicalDecimal;
}

export function addDecimal(
  left: CanonicalDecimal,
  right: CanonicalDecimal,
): CanonicalDecimal {
  const ExactDecimal = decimalContext([left, right]);
  return canonicalResult(new ExactDecimal(left).plus(new ExactDecimal(right)));
}

export function subtractDecimal(
  left: CanonicalDecimal,
  right: CanonicalDecimal,
): CanonicalDecimal {
  const ExactDecimal = decimalContext([left, right]);
  return canonicalResult(new ExactDecimal(left).minus(new ExactDecimal(right)));
}

export function multiplyDecimal(
  left: CanonicalDecimal,
  right: CanonicalDecimal,
): CanonicalDecimal {
  const ExactDecimal = decimalContext([left, right], true);
  return canonicalResult(new ExactDecimal(left).times(new ExactDecimal(right)));
}

export type DecimalRounding = 'down' | 'up' | 'halfEven';

export interface DecimalDivisionContext {
  readonly decimalPlaces: number;
  readonly rounding: DecimalRounding;
}

const ROUNDING = {
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
  halfEven: Decimal.ROUND_HALF_EVEN,
} as const;

export function divideDecimal(
  dividend: CanonicalDecimal,
  divisor: CanonicalDecimal,
  context: DecimalDivisionContext,
): ValidationResult<CanonicalDecimal> {
  if (compareDecimal(divisor, '0' as CanonicalDecimal) === 0) {
    return {
      ok: false,
      errors: [{
        code: 'SEMANTIC_INVALID',
        message: 'Decimal division requires a nonzero divisor.',
        path: '',
        alternatives: ['Use a nonzero divisor.'],
      }],
    };
  }
  if (!Number.isSafeInteger(context.decimalPlaces) || context.decimalPlaces < 0) {
    return {
      ok: false,
      errors: [{
        code: 'SEMANTIC_INVALID',
        message: 'Decimal division requires a nonnegative safe-integer decimal-place count.',
        path: '/decimalPlaces',
        alternatives: ['Use a nonnegative safe integer.'],
      }],
    };
  }
  const ExactDecimal = Decimal.clone({
    precision: operationPrecision([dividend, divisor]) + context.decimalPlaces + 4,
    rounding: ROUNDING[context.rounding],
    toExpNeg: -1_000_000_000,
    toExpPos: 1_000_000_000,
  });
  const quotient = new ExactDecimal(dividend)
    .dividedBy(new ExactDecimal(divisor))
    .toDecimalPlaces(context.decimalPlaces, ROUNDING[context.rounding]);
  return { ok: true, value: canonicalResult(quotient) };
}

export function compareDecimal(
  left: CanonicalDecimal,
  right: CanonicalDecimal,
): -1 | 0 | 1 {
  const ExactDecimal = decimalContext([left, right]);
  const comparison = new ExactDecimal(left).comparedTo(new ExactDecimal(right));
  if (comparison < 0) return -1;
  if (comparison > 0) return 1;
  return 0;
}

export function addMoney<C extends CurrencyCode>(
  left: MoneyValue<C>,
  right: MoneyValue<C>,
): MoneyOperationResult<C> {
  if (left.currency !== right.currency) {
    return {
      ok: false,
      error: {
        code: 'CROSS_CURRENCY_AGGREGATION',
        message: 'Money arithmetic requires one currency or an explicit conversion definition.',
        path: '',
        alternatives: ['Use values with the same currency.', 'Provide a reviewed conversion.'],
      },
    };
  }
  return {
    ok: true,
    value: { amount: addDecimal(left.amount, right.amount), currency: left.currency },
  };
}

export function compareMoney<C extends CurrencyCode>(
  left: MoneyValue<C>,
  right: MoneyValue<C>,
): MoneyComparisonResult {
  if (left.currency !== right.currency) {
    return {
      ok: false,
      error: {
        code: 'CROSS_CURRENCY_AGGREGATION',
        message: 'Money comparison requires one currency or an explicit conversion definition.',
        path: '',
        alternatives: ['Use values with the same currency.', 'Provide a reviewed conversion.'],
      },
    };
  }
  return { ok: true, value: compareDecimal(left.amount, right.amount) };
}

export type MoneyOperationResult<C extends CurrencyCode> =
  | { readonly ok: true; readonly value: MoneyValue<C> }
  | { readonly ok: false; readonly error: AgqlError };

export type MoneyComparisonResult =
  | { readonly ok: true; readonly value: -1 | 0 | 1 }
  | { readonly ok: false; readonly error: AgqlError };
