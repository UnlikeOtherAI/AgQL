import type { ResolvedDimension } from '@agql/contracts';

import { fieldExpression, SqlCompilationError } from './sql-predicates.ts';
import type { PredicateContext } from './sql-predicates.ts';

export interface CalendarPeriodSql {
  readonly start: string;
  readonly endExclusive: string;
  readonly timezoneParameter: string;
}

const INTERVALS = {
  day: "INTERVAL '1 day'",
  week: "INTERVAL '1 week'",
  month: "INTERVAL '1 month'",
  quarter: "INTERVAL '3 months'",
  year: "INTERVAL '1 year'",
} as const;

/** PostgreSQL weeks are ISO/Monday-start; the timezone is always a native parameter. */
export function compileCalendarPeriodSql(
  dimension: Extract<ResolvedDimension, { readonly kind: 'calendarPeriod' }>,
  context: PredicateContext,
): CalendarPeriodSql {
  const field = context.registry.field(context.dataset, dimension.field);
  if (field === undefined || (field.type.kind !== 'instant' && field.type.kind !== 'date')) {
    throw new SqlCompilationError(
      'Calendar periods require a date or instant field.',
      '/dimensions',
    );
  }
  const timezone = context.parameters.add(dimension.timezone, 'text');
  const source = fieldExpression(context, field);
  const local = field.type.kind === 'instant'
    ? `${source} AT TIME ZONE ${timezone}`
    : `${source}::timestamp`;
  const start = `date_trunc('${dimension.grain}', ${local})`;
  return {
    start,
    endExclusive: `(${start} + ${INTERVALS[dimension.grain]})`,
    timezoneParameter: timezone,
  };
}
