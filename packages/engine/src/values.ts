import type {
  CatalogPhysicalIdentifier,
  ResolvedFieldBinding,
  ResolvedValueType,
  TypedValue,
} from '@agql/contracts';
import {
  CanonicalDecimalSchema,
  DateValueSchema,
  InstantValueSchema,
  MoneyValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import type { AgqlLiteral, FieldDocument } from '@agql/schemas';

import { fail, semanticError } from './errors.ts';
import type { EngineResult } from './types.ts';

export function resolvedValueType(field: FieldDocument): ResolvedValueType {
  switch (field.kind) {
    case 'money':
      if (field.precision === undefined || field.scale === undefined
        || field.currencies === undefined) {
        return { kind: 'money' };
      }
      return {
        kind: 'money',
        precision: field.precision,
        scale: field.scale,
        currencies: field.currencies,
      };
    case 'decimal':
      if (field.precision === undefined || field.scale === undefined) {
        return { kind: 'decimal' };
      }
      return {
        kind: 'decimal',
        precision: field.precision,
        scale: field.scale,
      };
    case 'text':
      return { kind: 'text', collation: field.collation };
    case 'enum': {
      return { kind: 'enum', codes: field.values.map(({ code }) => code) };
    }
    case 'instant':
      return { kind: 'instant', precision: field.precision };
    default:
      return { kind: field.kind };
  }
}

export function resolveFieldBinding(
  logicalId: string,
  field: FieldDocument,
  physical: CatalogPhysicalIdentifier,
): ResolvedFieldBinding {
  return {
    logicalId,
    physical,
    type: resolvedValueType(field),
    nullable: field.nullable,
  };
}

function invalidLiteral(
  field: Pick<ResolvedFieldBinding, 'type' | 'nullable'>,
  path: string,
): EngineResult<TypedValue> {
  return fail(semanticError(
    `The literal does not match the ${field.type.kind} field type.`,
    path,
    [`Use a canonical ${field.type.kind} value.`],
  ));
}

export function typeLiteral(
  field: Pick<ResolvedFieldBinding, 'type' | 'nullable'>,
  literal: AgqlLiteral,
  path: string,
): EngineResult<TypedValue> {
  if (literal === null) {
    if (!field.nullable && field.type.kind !== 'null') return invalidLiteral(field, path);
    return { ok: true, value: { kind: 'null', value: null } };
  }
  switch (field.type.kind) {
    case 'id':
      return typeof literal === 'string'
        ? { ok: true, value: { kind: 'id', value: literal } }
        : invalidLiteral(field, path);
    case 'boolean':
      return typeof literal === 'boolean'
        ? { ok: true, value: { kind: 'boolean', value: literal } }
        : invalidLiteral(field, path);
    case 'integer': {
      const parsed = SafeIntegerSchema.safeParse(literal);
      return parsed.success
        ? { ok: true, value: { kind: 'integer', value: parsed.data } }
        : invalidLiteral(field, path);
    }
    case 'decimal': {
      const parsed = CanonicalDecimalSchema.safeParse(literal);
      return parsed.success
        ? { ok: true, value: { kind: 'decimal', value: parsed.data } }
        : invalidLiteral(field, path);
    }
    case 'money': {
      const parsed = MoneyValueSchema.safeParse(literal);
      if (!parsed.success || (field.type.currencies !== undefined
        && !field.type.currencies.includes(parsed.data.currency))) {
        return invalidLiteral(field, path);
      }
      return { ok: true, value: { kind: 'money', value: parsed.data } };
    }
    case 'text': {
      const parsed = NormalizedTextSchema.safeParse(literal);
      return parsed.success
        ? { ok: true, value: { kind: 'text', value: parsed.data } }
        : invalidLiteral(field, path);
    }
    case 'enum': {
      if (typeof literal === 'string' && field.type.codes.includes(literal)) {
        return { ok: true, value: { kind: 'enum', value: literal } };
      }
      const alternatives = [...field.type.codes].sort();
      const first = alternatives[0];
      if (first === undefined) throw new TypeError('Enum field lacks declared codes.');
      return fail({
        code: 'ENUM_VALUE_INVALID',
        message: 'The value is not a declared enum code.',
        path,
        alternatives: [first, ...alternatives.slice(1)],
      });
    }
    case 'date': {
      const parsed = DateValueSchema.safeParse(literal);
      return parsed.success
        ? { ok: true, value: { kind: 'date', value: parsed.data } }
        : invalidLiteral(field, path);
    }
    case 'instant': {
      const parsed = InstantValueSchema.safeParse(literal);
      return parsed.success
        ? { ok: true, value: { kind: 'instant', value: parsed.data } }
        : invalidLiteral(field, path);
    }
    case 'null':
      return invalidLiteral(field, path);
  }
}

export function validateOperatorForField(
  field: ResolvedFieldBinding,
  op: string,
  path: string,
): EngineResult<true> {
  if ((op === 'contains' || op === 'startsWith') && field.type.kind !== 'text') {
    return fail(semanticError(
      'Substring predicates require a text field.',
      path,
      ['Use contains or startsWith only with a text field.'],
    ));
  }
  if ((op === 'inLast' || op === 'inCurrent' || op === 'inPrevious')
    && field.type.kind !== 'instant') {
    return fail(semanticError(
      'Relative-time predicates require an instant field.',
      path,
      ['Use a field whose kind is instant.'],
    ));
  }
  if ((op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte')
    && (field.type.kind === 'boolean' || field.type.kind === 'null')) {
    return fail(semanticError(
      'Ordered comparison is not defined for this field type.',
      path,
      ['Use eq, ne, isNull, or isNotNull.'],
    ));
  }
  return { ok: true, value: true };
}
