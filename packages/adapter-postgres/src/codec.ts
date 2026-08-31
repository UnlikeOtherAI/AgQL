import type { AdapterResultValue, AdapterRow, TypedValue } from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  DateValueSchema,
  InstantValueSchema,
  MoneyValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';

import type { CompiledPostgresQuery, OutputCodec } from './types.ts';

function canonicalNumeric(raw: string): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(raw);
  if (match === null) return undefined;
  const sign = match[1] ?? '';
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/u, '');
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  const unsigned = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return /^0(?:\.0*)?$/u.test(unsigned) ? '0' : `${sign}${unsigned}`;
}

function stringValue(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function decodeInteger(raw: unknown): TypedValue | undefined {
  const parsed = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^-?\d+$/u.test(raw) ? Number(raw)
      : Number.NaN;
  const result = SafeIntegerSchema.safeParse(parsed);
  return result.success ? { kind: 'integer', value: result.data } : undefined;
}

function decodeDecimal(raw: unknown, scale?: number): TypedValue | undefined {
  const value = stringValue(raw);
  if (value === undefined) return undefined;
  const canonical = canonicalNumeric(value);
  if (canonical === undefined) return undefined;
  const result = CanonicalDecimalSchema.safeParse(canonical);
  if (!result.success) return undefined;
  if (scale === undefined) return { kind: 'decimal', value: result.data };
  const [integer, fraction = ''] = result.data.split('.');
  const suffix = scale === 0 ? '' : `.${fraction.padEnd(scale, '0')}`;
  return { kind: 'decimal', value: `${integer ?? '0'}${suffix}` as typeof result.data };
}

function decimalAtScale(value: string, scale: number | undefined): string | undefined {
  const canonical = canonicalNumeric(value);
  if (canonical === undefined || scale === undefined) return canonical;
  const [integer, fraction = ''] = canonical.split('.');
  return `${integer ?? '0'}${scale === 0 ? '' : `.${fraction.padEnd(scale, '0')}`}`;
}

type AggregateMoneyDecode =
  | { readonly kind: 'value'; readonly value: AdapterResultValue }
  | { readonly kind: 'mixed' }
  | { readonly kind: 'invalid' };

function decodeAggregateMoney(
  raw: unknown,
  codec: Extract<OutputCodec, { readonly kind: 'aggregateMoney' }>,
): AggregateMoneyDecode {
  const value = stringValue(raw);
  if (value === undefined) return { kind: 'invalid' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(decoded) || !isUnknownArray(decoded.currencies)) return { kind: 'invalid' };
  const currencies = decoded.currencies;
  if (currencies.length !== 1) return { kind: 'mixed' };
  const currency = currencies[0];
  if (typeof decoded.amount !== 'string' || typeof currency !== 'string') {
    return { kind: 'invalid' };
  }
  const amount = decimalAtScale(decoded.amount, codec.scale);
  if (amount === undefined) return { kind: 'invalid' };
  const money = MoneyValueSchema.safeParse({ amount, currency });
  if (!money.success || (codec.currencies !== undefined
    && !codec.currencies.includes(money.data.currency))) return { kind: 'invalid' };
  return { kind: 'value', value: { kind: 'money', value: money.data } };
}

function instantAtPrecision(
  value: string,
  codec: Extract<OutputCodec, { kind: 'instant' }>,
): string {
  if (codec.precision === 'second') return value.replace(/\.\d+Z$/u, 'Z');
  const digits = codec.precision === 'millisecond'
    ? 3
    : codec.precision === 'microsecond' ? 6 : 9;
  const match = /^(.*\.)(\d+)Z$/u.exec(value);
  if (match === null) return value;
  return `${match[1] ?? ''}${(match[2] ?? '').padEnd(digits, '0').slice(0, digits)}Z`;
}

export function decodeOutput(codec: OutputCodec, raw: unknown): AdapterResultValue | undefined {
  if (raw === null) return { kind: 'null', value: null };
  if (codec.kind === 'rank' || codec.kind === 'aggregateInteger'
    || codec.kind === 'integer') return decodeInteger(raw);
  if (codec.kind === 'aggregateDecimal') return decodeDecimal(raw, codec.scale);
  if (codec.kind === 'decimal') return decodeDecimal(raw, codec.scale);
  if (codec.kind === 'money') {
    const value = stringValue(raw);
    if (value === undefined) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
    const money = MoneyValueSchema.safeParse(decoded);
    if (!money.success || (codec.currencies !== undefined
      && !codec.currencies.includes(money.data.currency))) return undefined;
    return { kind: 'money', value: money.data };
  }
  if (codec.kind === 'boolean') {
    return typeof raw === 'boolean' ? { kind: 'boolean', value: raw } : undefined;
  }
  const value = stringValue(raw);
  if (value === undefined) return undefined;
  if (codec.kind === 'id') return value.length > 0 ? { kind: 'id', value } : undefined;
  if (codec.kind === 'text') {
    const parsed = NormalizedTextSchema.safeParse(value);
    return parsed.success ? { kind: 'text', value: parsed.data } : undefined;
  }
  if (codec.kind === 'enum') {
    return codec.codes.includes(value) ? { kind: 'enum', value } : undefined;
  }
  if (codec.kind === 'date') {
    const parsed = DateValueSchema.safeParse(value);
    return parsed.success ? { kind: 'date', value: parsed.data } : undefined;
  }
  if (codec.kind === 'instant') {
    const parsed = InstantValueSchema.safeParse(instantAtPrecision(value, codec));
    return parsed.success ? { kind: 'instant', value: parsed.data } : undefined;
  }
  if (codec.kind === 'calendarPeriod') {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(decoded)) return undefined;
    const start = InstantValueSchema.safeParse(decoded.start);
    const endExclusive = InstantValueSchema.safeParse(decoded.endExclusive);
    const { timezone, grain, label } = decoded;
    if (!start.success || !endExclusive.success || timezone !== codec.timezone
      || grain !== codec.grain || typeof label !== 'string' || label.length === 0) return undefined;
    return {
      kind: 'calendarPeriod',
      value: {
        start: start.data,
        endExclusive: endExclusive.data,
        timezone,
        grain: codec.grain,
        label,
      },
    };
  }
  return undefined;
}

export interface DecodedRows {
  readonly kind: 'success';
  readonly rows: readonly AdapterRow[];
  readonly ranks?: readonly ReturnType<typeof SafeIntegerSchema.parse>[];
  readonly truncated: boolean;
}

export interface DecodedMoneyMixed {
  readonly kind: 'moneyMixed';
  readonly path: string;
}

export function decodeRows(
  compiled: CompiledPostgresQuery,
  databaseRows: readonly (readonly unknown[])[],
): DecodedRows | DecodedMoneyMixed | undefined {
  const rows: AdapterRow[] = [];
  const ranks: ReturnType<typeof SafeIntegerSchema.parse>[] = [];
  let total = 0;
  for (const databaseRow of databaseRows) {
    const decoded: AdapterResultValue[] = [];
    for (let index = 0; index < compiled.outputCodecs.length; index += 1) {
      const codec = compiled.outputCodecs[index] ?? { kind: 'null' };
      if (codec.kind === 'aggregateMoney') {
        const money = decodeAggregateMoney(databaseRow[index], codec);
        if (money.kind === 'mixed') {
          if (codec.metricPath === undefined) return undefined;
          return { kind: 'moneyMixed', path: codec.metricPath };
        }
        if (money.kind === 'invalid') return undefined;
        decoded.push(money.value);
        continue;
      }
      const value = decodeOutput(codec, databaseRow[index]);
      if (value === undefined) return undefined;
      decoded.push(value);
    }
    const totalValue = decodeInteger(databaseRow[compiled.totalColumn]);
    if (totalValue?.kind !== 'integer') return undefined;
    total = totalValue.value;
    if (compiled.rankColumn !== undefined) {
      const rank = decodeInteger(databaseRow[compiled.rankColumn]);
      if (rank?.kind !== 'integer') return undefined;
      ranks.push(rank.value);
    }
    rows.push(decoded);
  }
  return {
    kind: 'success',
    rows,
    ...(compiled.rankColumn === undefined ? {} : { ranks }),
    truncated: total > rows.length,
  };
}
