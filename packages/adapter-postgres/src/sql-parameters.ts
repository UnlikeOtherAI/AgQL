import type { ResolvedFieldBinding, TypedValue } from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  DateValueSchema,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';

import type { PgParameter } from './types.ts';

type SqlCast =
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'numeric'
  | 'text'
  | 'timestamptz'
  | 'vector';

export class ParameterBuilder {
  readonly #values: PgParameter[] = [];

  public add(value: PgParameter, cast: SqlCast): string {
    this.#values.push(value);
    return `$${this.#values.length}::${cast}`;
  }

  public get values(): readonly PgParameter[] {
    return this.#values;
  }
}

export interface EncodedScalar {
  readonly parameter: PgParameter;
  readonly cast: Exclude<SqlCast, 'vector'>;
}

function castForField(field: ResolvedFieldBinding): EncodedScalar['cast'] {
  if (field.type.kind === 'boolean') return 'boolean';
  if (field.type.kind === 'integer') return 'bigint';
  if (field.type.kind === 'decimal' || field.type.kind === 'money') return 'numeric';
  if (field.type.kind === 'date') return 'date';
  if (field.type.kind === 'instant') return 'timestamptz';
  return 'text';
}

function encodeNonNull(field: ResolvedFieldBinding, value: TypedValue): EncodedScalar | undefined {
  if (field.type.kind === 'id' && value.kind === 'id' && value.value.length > 0) {
    return { parameter: value.value, cast: 'text' };
  }
  if (field.type.kind === 'boolean' && value.kind === 'boolean') {
    return { parameter: value.value, cast: 'boolean' };
  }
  if (field.type.kind === 'integer' && value.kind === 'integer'
    && SafeIntegerSchema.safeParse(value.value).success) {
    return { parameter: value.value, cast: 'bigint' };
  }
  if (field.type.kind === 'decimal' && value.kind === 'decimal'
    && CanonicalDecimalSchema.safeParse(value.value).success) {
    return { parameter: value.value, cast: 'numeric' };
  }
  if (field.type.kind === 'money' && value.kind === 'money'
    && value.value.currency === field.type.currency
    && CanonicalDecimalSchema.safeParse(value.value.amount).success) {
    return { parameter: value.value.amount, cast: 'numeric' };
  }
  if (field.type.kind === 'text' && value.kind === 'text'
    && NormalizedTextSchema.safeParse(value.value).success) {
    return { parameter: value.value, cast: 'text' };
  }
  if (field.type.kind === 'enum' && value.kind === 'enum'
    && field.type.codes.includes(value.value)) {
    return { parameter: value.value, cast: 'text' };
  }
  if (field.type.kind === 'date' && value.kind === 'date'
    && DateValueSchema.safeParse(value.value).success) {
    return { parameter: value.value, cast: 'date' };
  }
  if (field.type.kind === 'instant' && value.kind === 'instant'
    && InstantValueSchema.safeParse(value.value).success
    && instantFitsPrecision(value.value, field.type.precision)) {
    return { parameter: value.value, cast: 'timestamptz' };
  }
  return undefined;
}

function instantFitsPrecision(
  value: string,
  precision: Extract<ResolvedFieldBinding['type'], { kind: 'instant' }>['precision'],
): boolean {
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1];
  if (precision === 'second') return fraction === undefined;
  const maximumDigits = precision === 'millisecond'
    ? 3
    : precision === 'microsecond' ? 6 : 9;
  return fraction === undefined || fraction.length <= maximumDigits;
}

export function encodeScalar(
  field: ResolvedFieldBinding,
  value: TypedValue,
): EncodedScalar | undefined {
  if (value.kind === 'null') {
    if (!field.nullable && field.type.kind !== 'null') return undefined;
    return { parameter: null, cast: castForField(field) };
  }
  if (field.type.kind === 'null') return undefined;
  return encodeNonNull(field, value);
}

export function escapeLike(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');
}
