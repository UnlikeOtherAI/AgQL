import type {
  ExpandedScope,
  LogicalFilter,
  RecordsLogicalPlan,
  ResolvedOrder,
  ResolvedPredicate,
  ResolvedProjection,
  ResultSchemaField,
} from '@agql/contracts';
import type { RecordsQuery, SafeInteger } from '@agql/schemas';

import type { CompileContext } from './compile-context.ts';
import { fail, semanticError } from './errors.ts';
import { authorizedField } from './policy.ts';
import { fieldResultShape } from './result-shape.ts';
import type { EngineResult } from './types.ts';

export interface RecordsPlanOutput {
  readonly plan: RecordsLogicalPlan;
  readonly resultShape: readonly ResultSchemaField[];
}

export function buildRecordsPlan(
  context: CompileContext,
  query: RecordsQuery,
  scope: ExpandedScope,
  filter: LogicalFilter<ResolvedPredicate> | undefined,
): EngineResult<RecordsPlanOutput> {
  const seen = new Set<string>();
  const projection: ResolvedProjection[] = [];
  const resultShape: ResultSchemaField[] = [];
  for (const [index, fieldId] of query.select.entries()) {
    if (seen.has(fieldId)) {
      return fail(semanticError(
        'Every selected output id must be unique.',
        `/select/${index}`,
        ['Select each field at most once.'],
      ));
    }
    seen.add(fieldId);
    const field = authorizedField(context, fieldId, 'select', `/select/${index}`);
    if (!field.ok) return field;
    projection.push({
      output: { logicalId: fieldId, slot: index as SafeInteger },
      field: field.value,
    });
    const document = context.dataset.fields[fieldId];
    if (document === undefined) return fail(semanticError(
      'The selected field is missing from the validated catalog.',
      `/select/${index}`,
      ['Use a field in the effective catalog.'],
    ));
    resultShape.push(fieldResultShape(fieldId, document));
  }
  const firstProjection = projection[0];
  if (firstProjection === undefined) {
    return fail(semanticError(
      'Records projection must contain at least one field.',
      '/select',
      ['Select at least one available field.'],
    ));
  }
  const order: ResolvedOrder[] = [];
  for (const [index, item] of query.order.entries()) {
    const field = authorizedField(context, item.by, 'order', `/order/${index}/by`);
    if (!field.ok) return field;
    order.push({ field: field.value, direction: item.dir, nulls: item.nulls });
  }
  const id = authorizedField(context, context.dataset.idField, 'order', '/from');
  if (!id.ok) return id;
  const final = order.at(-1);
  if (final?.field.logicalId !== context.dataset.idField) {
    order.push({ field: id.value, direction: 'asc', nulls: 'last' });
  }
  const finalOrder = order.at(-1);
  if (finalOrder === undefined) {
    return fail(semanticError(
      'Records ordering must contain at least one field.',
      '/order',
      ['Order by at least one available field.'],
    ));
  }
  const firstOrder = order[0];
  if (firstOrder === undefined) {
    return fail(semanticError(
      'Records ordering must contain at least one field.',
      '/order',
      ['Order by at least one available field.'],
    ));
  }
  return {
    ok: true,
    value: {
      plan: {
        languageVersion: '0',
        mode: 'records',
        profile: 'records.v0',
        sourceQueryHash: context.sourceQueryHash,
        effectivePlanHash: context.effectivePlanHash,
        dataset: {
          logicalId: context.datasetId,
          physical: context.binding.physical,
          bindingVersion: context.input.binding.version,
        },
        scope,
        ...(filter === undefined ? {} : { filter }),
        hardRowLimit: query.take,
        take: query.take,
        projection: [firstProjection, ...projection.slice(1)],
        order: [firstOrder, ...order.slice(1)],
        tieBreak: { kind: 'recordId', order: finalOrder },
      },
      resultShape,
    },
  };
}
