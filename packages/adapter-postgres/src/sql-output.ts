import type { ResolvedFieldBinding, ResolvedValueType } from '@agql/contracts';
import type { SafeInteger } from '@agql/schemas';

import type { RuntimeRegistry } from './registry.ts';
import { fieldExpression } from './sql-predicates.ts';
import type { OutputCodec, PostgresDatasetBinding } from './types.ts';

interface OutputContext {
  readonly registry: RuntimeRegistry;
  readonly dataset: PostgresDatasetBinding;
  readonly alias: string;
}

export function selectedFieldSql(context: OutputContext, field: ResolvedFieldBinding): string {
  const expression = fieldExpression(context, field);
  if (field.type.kind === 'integer' || field.type.kind === 'decimal'
    || field.type.kind === 'money' || field.type.kind === 'date') {
    return `${expression}::text`;
  }
  if (field.type.kind === 'instant') {
    return `to_char(${expression} AT TIME ZONE 'UTC', `
      + `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  }
  if (field.type.kind === 'null') return 'NULL::text';
  return expression;
}

export function encodedOutputSql(expression: string, codec: OutputCodec): string {
  if (codec.kind === 'integer' || codec.kind === 'decimal' || codec.kind === 'money'
    || codec.kind === 'date' || codec.kind === 'rank' || codec.kind === 'aggregateInteger'
    || codec.kind === 'aggregateDecimal') {
    return `${expression}::text`;
  }
  if (codec.kind === 'instant') {
    return `to_char(${expression} AT TIME ZONE 'UTC', `
      + `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  }
  return expression;
}

export function outputTypeForField(field: ResolvedFieldBinding): ResolvedValueType {
  return field.type;
}

export function validateContiguousSlots(slots: readonly SafeInteger[]): boolean {
  const sorted = [...slots].sort((left, right) => left - right);
  return sorted.every((slot, index) => slot === index)
    && new Set(sorted).size === sorted.length;
}
