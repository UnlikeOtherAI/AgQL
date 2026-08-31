import type { AdapterOutcome, RecordsLogicalPlan, ResolvedOrder } from '@agql/contracts';

import { refusal, unsafePlan } from './refusals.ts';
import type { RuntimeRegistry } from './registry.ts';
import { internalColumn, quoteQualified } from './sql-identifiers.ts';
import { validateContiguousSlots, selectedFieldSql } from './sql-output.ts';
import {
  eligibilitySql,
  fieldExpression,
  SqlCompilationError,
} from './sql-predicates.ts';
import { ParameterBuilder } from './sql-parameters.ts';
import type { CompiledPostgresQuery } from './types.ts';

function orderExpression(
  registry: RuntimeRegistry,
  dataset: CompiledPostgresQuery['dataset'],
  order: ResolvedOrder,
): string {
  if (registry.field(dataset, order.field) === undefined) {
    throw new SqlCompilationError('An order field is not part of the dataset binding.', '/order');
  }
  const expression = fieldExpression({ registry, dataset, alias: 'd' }, order.field);
  return `${expression} ${order.direction.toUpperCase()} NULLS LAST`;
}

export function compileRecords(
  plan: RecordsLogicalPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresQuery> {
  const dataset = registry.dataset(plan.dataset);
  if (dataset === undefined) {
    return refusal(
      'SCOPE_UNENFORCEABLE',
      'The resolved dataset binding is not installed in this PostgreSQL adapter.',
      '/from',
      ['Use an installed, scope-certified dataset binding.'],
      'Install the resolved dataset binding before executing this plan.',
    );
  }
  if (plan.take > plan.hardRowLimit || plan.take < 1) {
    return unsafePlan('/take', 'The requested row count exceeds the plan hard row limit.');
  }
  const slots = plan.projection.map((projection) => projection.output.slot);
  if (!validateContiguousSlots(slots)) {
    return unsafePlan('/select', 'Resolved output slots must be unique and contiguous from zero.');
  }
  try {
    const parameters = new ParameterBuilder();
    const context = { registry, dataset, alias: 'd', parameters };
    const sortedProjection = [...plan.projection].sort(
      (left, right) => left.output.slot - right.output.slot,
    );
    for (const projection of sortedProjection) {
      if (registry.field(dataset, projection.field) === undefined) {
        throw new SqlCompilationError(
          'A projected field is not part of the dataset binding.',
          '/select',
        );
      }
    }
    const selections = sortedProjection.map((projection, index) =>
      `${selectedFieldSql(context, projection.field)} AS ${internalColumn(index)}`);
    const totalColumn = sortedProjection.length;
    selections.push(`COUNT(*) OVER()::text AS ${internalColumn(totalColumn)}`);
    const eligibility = eligibilitySql(context, plan.scope, plan.filter);
    const order = [...plan.order, plan.tieBreak.order]
      .map((item) => orderExpression(registry, dataset, item));
    const limit = parameters.add(plan.take, 'bigint');
    const table = quoteQualified(registry.config.namespace, dataset.dataset.physical);
    return {
      kind: 'success',
      value: {
        operation: 'query',
        dataset,
        statement: {
          text: `SELECT ${selections.join(', ')} FROM ${table} AS d `
            + `WHERE ${eligibility} ORDER BY ${order.join(', ')} LIMIT ${limit}`,
          values: parameters.values,
        },
        settings: [],
        outputCodecs: sortedProjection.map((projection) => projection.field.type),
        outputSlots: sortedProjection.map((projection) => projection.output.slot),
        totalColumn: totalColumn as typeof plan.take,
        take: plan.take,
      },
    };
  } catch (error: unknown) {
    if (error instanceof SqlCompilationError) return unsafePlan(error.path, error.message);
    throw error;
  }
}
