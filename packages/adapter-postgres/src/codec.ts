import type { AdapterRow, TypedValue } from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  DateValueSchema,
  InstantValueSchema,
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

function decodeInteger(raw: unknown): TypedValue | undefined {
  const parsed = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^-?\d+$/u.test(raw) ? Number(raw)
      : Number.NaN;
  const result = SafeIntegerSchema.safeParse(parsed);
  return result.success ? { kind: 'integer', value: result.data } : undefined;
}

function decodeDecimal(raw: unknown): TypedValue | undefined {
  const value = stringValue(raw);
  if (value === undefined) return undefined;
  const canonical = canonicalNumeric(value);
  if (canonical === undefined) return undefined;
  const result = CanonicalDecimalSchema.safeParse(canonical);
  return result.success ? { kind: 'decimal', value: result.data } : undefined;
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

export function decodeOutput(codec: OutputCodec, raw: unknown): TypedValue | undefined {
  if (raw === null) return { kind: 'null', value: null };
  if (codec.kind === 'rank' || codec.kind === 'aggregateInteger'
    || codec.kind === 'integer') return decodeInteger(raw);
  if (codec.kind === 'aggregateDecimal' || codec.kind === 'decimal') return decodeDecimal(raw);
  if (codec.kind === 'money') {
    const decoded = decodeDecimal(raw);
    return decoded?.kind === 'decimal'
      ? { kind: 'money', value: { amount: decoded.value, currency: codec.currency } }
      : undefined;
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
  return undefined;
}

export interface DecodedRows {
  readonly rows: readonly AdapterRow[];
  readonly ranks?: readonly ReturnType<typeof SafeIntegerSchema.parse>[];
  readonly truncated: boolean;
}

export function decodeRows(
  compiled: CompiledPostgresQuery,
  databaseRows: readonly (readonly unknown[])[],
): DecodedRows | undefined {
  const rows: AdapterRow[] = [];
  const ranks: ReturnType<typeof SafeIntegerSchema.parse>[] = [];
  let total = 0;
  for (const databaseRow of databaseRows) {
    const decoded: TypedValue[] = [];
    for (let index = 0; index < compiled.outputCodecs.length; index += 1) {
      const codec = compiled.outputCodecs[index] ?? { kind: 'null' };
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
    rows,
    ...(compiled.rankColumn === undefined ? {} : { ranks }),
    truncated: total > rows.length,
  };
}
