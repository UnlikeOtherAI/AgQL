import type { ExpandedScope, ResolvedPredicate } from '@agql/contracts';

import type { CompileContext } from './compile-context.ts';
import { boundField } from './policy.ts';
import { fail, repairableError } from './errors.ts';
import type { EngineResult } from './types.ts';
import { typeLiteral } from './values.ts';

export function expandScope(context: CompileContext): EngineResult<ExpandedScope> {
  if (context.scope.partitions.kind === 'nothing') {
    return { ok: true, value: { visibility: 'nothing' } };
  }
  if (context.dataset.rowScope.kind === 'none') {
    if (context.scope.partitions.kind !== 'unpartitioned') {
      return fail(repairableError(
        'SCOPE_UNENFORCEABLE',
        'An unpartitioned dataset requires an explicit unpartitioned scope.',
        '/scope/partitions',
        ['Use partitions.kind unpartitioned or nothing.'],
        'Resolve an unpartitioned scope for this dataset.',
      ));
    }
    const id = boundField(context, context.dataset.idField, '/from');
    if (!id.ok) return id;
    if (id.value.nullable) {
      return fail(repairableError(
        'SCOPE_UNENFORCEABLE',
        'The stable id must be non-null to enforce unpartitioned visibility.',
        '/from',
        ['Use a dataset with a non-null stable id.'],
        'Correct the catalog stable-id declaration.',
      ));
    }
    return {
      ok: true,
      value: {
        visibility: 'predicate',
        enforcement: 'mandatoryPushdown',
        predicates: [{ kind: 'null', field: id.value, op: 'isNotNull' }],
      },
    };
  }
  if (context.scope.partitions.kind !== 'values') {
    return fail(repairableError(
      'SCOPE_UNENFORCEABLE',
      'A partitioned dataset requires explicit values for every scope dimension.',
      '/scope/partitions',
      ['Use partitions.kind values or nothing.'],
      'Resolve concrete partition values for this dataset.',
    ));
  }
  const expected = [...context.dataset.rowScope.dimensions].sort();
  const actual = Object.keys(context.scope.partitions.values).sort();
  if (expected.length !== actual.length
    || expected.some((dimension, index) => dimension !== actual[index])) {
    return fail(repairableError(
      'SCOPE_UNENFORCEABLE',
      'Scope partition dimensions do not match the dataset declaration.',
      '/scope/partitions',
      ['Provide every declared partition dimension and no others.'],
      'Resolve the scope against this exact dataset row-scope declaration.',
    ));
  }
  const predicates: ResolvedPredicate[] = [];
  for (const dimension of context.dataset.rowScope.dimensions) {
    const field = boundField(context, dimension, '/scope/partitions');
    if (!field.ok) return field;
    const literals = context.scope.partitions.values[dimension];
    if (literals === undefined || literals.length === 0) {
      return { ok: true, value: { visibility: 'nothing' } };
    }
    const values = [];
    for (const [index, literal] of literals.entries()) {
      const typed = typeLiteral(field.value, literal, `/scope/partitions/${dimension}/${index}`);
      if (!typed.ok) return typed;
      values.push(typed.value);
    }
    predicates.push({ kind: 'list', field: field.value, op: 'in', values });
  }
  const first = predicates[0];
  if (first === undefined) {
    return fail(repairableError(
      'SCOPE_UNENFORCEABLE',
      'A partitioned dataset must declare at least one scope dimension.',
      '/from',
      ['Declare at least one row-scope dimension.'],
      'Correct the catalog row-scope declaration.',
    ));
  }
  return {
    ok: true,
    value: {
      visibility: 'predicate',
      enforcement: 'mandatoryPushdown',
      predicates: [first, ...predicates.slice(1)],
    },
  };
}
