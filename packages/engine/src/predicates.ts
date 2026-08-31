import type {
  LogicalFilter,
  ResolvedPredicate,
} from '@agql/contracts';
import type { WhereExpression } from '@agql/schemas';

import { compileRelativeRange } from './calendar.ts';
import type { CompileContext } from './compile-context.ts';
import { fail, semanticError } from './errors.ts';
import { authorizedField, boundField } from './policy.ts';
import type { EngineResult } from './types.ts';
import { typeLiteral, validateOperatorForField } from './values.ts';

function fieldForPredicate(
  context: CompileContext,
  expression: Extract<WhereExpression, { readonly kind: 'predicate' }>,
  path: string,
  authorize: boolean,
) {
  return authorize
    ? authorizedField(context, expression.field, 'filter', `${path}/field`)
    : boundField(context, expression.field, `${path}/field`);
}

function compileLeaf(
  context: CompileContext,
  expression: Extract<WhereExpression, { readonly kind: 'predicate' }>,
  path: string,
  authorize: boolean,
): EngineResult<ResolvedPredicate> {
  const field = fieldForPredicate(context, expression, path, authorize);
  if (!field.ok) return field;
  const operator = validateOperatorForField(field.value, expression.op, `${path}/op`);
  if (!operator.ok) return operator;
  switch (expression.op) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (expression.value === null) {
        return fail(semanticError(
          'Null comparisons require isNull or isNotNull.',
          `${path}/op`,
          ['isNull', 'isNotNull'],
        ));
      }
      const value = typeLiteral(field.value, expression.value, `${path}/value`);
      if (!value.ok) return value;
      return {
        ok: true,
        value: { kind: 'comparison', field: field.value, op: expression.op, value: value.value },
      };
    }
    case 'in':
    case 'notIn': {
      const values = [];
      for (const [index, literal] of expression.values.entries()) {
        if (literal === null) {
          return fail(semanticError(
            'List predicates cannot contain null.',
            `${path}/values/${index}`,
            ['Remove null and use an explicit null predicate.'],
          ));
        }
        const value = typeLiteral(field.value, literal, `${path}/values/${index}`);
        if (!value.ok) return value;
        values.push(value.value);
      }
      return {
        ok: true,
        value: { kind: 'list', field: field.value, op: expression.op, values },
      };
    }
    case 'isNull':
    case 'isNotNull':
      return {
        ok: true,
        value: { kind: 'null', field: field.value, op: expression.op },
      };
    case 'contains':
    case 'startsWith':
      return {
        ok: true,
        value: {
          kind: 'substring',
          field: field.value,
          op: expression.op,
          value: expression.value,
          semantics: 'escaped-case-sensitive-substring',
        },
      };
    case 'inLast':
      return compileRelativeRange(
        field.value,
        context.input.anchor,
        expression.op,
        expression.unit,
        expression.amount,
        path,
      );
    case 'inCurrent':
    case 'inPrevious':
      return compileRelativeRange(
        field.value,
        context.input.anchor,
        expression.op,
        expression.unit,
        undefined,
        path,
      );
  }
}

export function compileWhere(
  context: CompileContext,
  expression: WhereExpression,
  path: string,
  authorize = true,
): EngineResult<LogicalFilter<ResolvedPredicate>> {
  if (expression.kind === 'predicate') {
    return compileLeaf(context, expression, path, authorize);
  }
  if (expression.kind === 'not') {
    const item = compileWhere(context, expression.item, `${path}/item`, authorize);
    return item.ok ? { ok: true, value: { kind: 'not', item: item.value } } : item;
  }
  const items: LogicalFilter<ResolvedPredicate>[] = [];
  for (const [index, source] of expression.items.entries()) {
    const item = compileWhere(context, source, `${path}/items/${index}`, authorize);
    if (!item.ok) return item;
    items.push(item.value);
  }
  const first = items[0];
  if (first === undefined) {
    return fail(semanticError(
      'Boolean predicates require at least one item.',
      `${path}/items`,
      ['Add a predicate item.'],
    ));
  }
  return {
    ok: true,
    value: {
      kind: expression.kind,
      items: [first, ...items.slice(1)],
    },
  };
}

export function compileEffectiveFilter(
  context: CompileContext,
): EngineResult<LogicalFilter<ResolvedPredicate> | undefined> {
  const defaultFilter = context.dataset.defaultFilters === undefined
    ? undefined
    : compileWhere(context, context.dataset.defaultFilters, '/catalog/defaultFilters', false);
  if (defaultFilter !== undefined && !defaultFilter.ok) return defaultFilter;
  const queryFilter = context.query.where === undefined
    ? undefined
    : compileWhere(context, context.query.where, '/where');
  if (queryFilter !== undefined && !queryFilter.ok) return queryFilter;
  if (defaultFilter?.ok === true && queryFilter?.ok === true) {
    return {
      ok: true,
      value: { kind: 'and', items: [defaultFilter.value, queryFilter.value] },
    };
  }
  if (defaultFilter?.ok === true) return { ok: true, value: defaultFilter.value };
  if (queryFilter?.ok === true) return { ok: true, value: queryFilter.value };
  return { ok: true, value: undefined };
}
