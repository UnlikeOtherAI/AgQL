import type { ResolvedDimension } from '@agql/contracts';

import { fieldExpression, SqlCompilationError } from './sql-predicates.ts';
import type { PredicateContext } from './sql-predicates.ts';

type CalendarDimension = Extract<ResolvedDimension, { readonly kind: 'calendarPeriod' }>;

export interface CalendarPeriodSql {
  readonly start: string;
  readonly endExclusive: string;
  readonly localStart: string;
  readonly timezoneParameter: string;
  readonly grain: CalendarDimension['grain'];
  readonly weekStart: CalendarDimension['weekStart'];
}

const WEEKDAY_INDEX = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
} as const;

const NEXT_INTERVAL = {
  day: "INTERVAL '1 day'",
  fiscalDay: "INTERVAL '1 day'",
  week: "INTERVAL '1 week'",
  month: "INTERVAL '1 month'",
} as const;

function fiscalInterval(value: string): string {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) {
    throw new SqlCompilationError('fiscalDayStart must use HH:mm:ss.', '/dimensions');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new SqlCompilationError('fiscalDayStart is not a valid civil time.', '/dimensions');
  }
  return `make_interval(secs => ${hour * 3_600 + minute * 60 + second})`;
}

function localBoundary(local: string, dimension: CalendarDimension): string {
  if (dimension.grain === 'day') return `date_trunc('day', ${local})`;
  const fiscal = fiscalInterval(dimension.fiscalDayStart);
  const shifted = `((${local}) - ${fiscal})`;
  if (dimension.grain === 'fiscalDay') {
    return `(date_trunc('day', ${shifted}) + ${fiscal})`;
  }
  if (dimension.grain === 'month') {
    return `(date_trunc('month', ${shifted}) + ${fiscal})`;
  }
  const weekday = WEEKDAY_INDEX[dimension.weekStart];
  return `(date_trunc('day', ${shifted}) - (((extract(isodow FROM ${shifted}))::int `
    + `- ${weekday} + 7) % 7) * INTERVAL '1 day' + ${fiscal})`;
}

export function compileCalendarPeriodSql(
  dimension: CalendarDimension,
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
    ? `(${source} AT TIME ZONE ${timezone})`
    : `${source}::timestamp`;
  const start = localBoundary(local, dimension);
  const end = `((${start}) + ${NEXT_INTERVAL[dimension.grain]})`;
  return {
    start: `((${start}) AT TIME ZONE ${timezone})`,
    endExclusive: `((${end}) AT TIME ZONE ${timezone})`,
    localStart: start,
    timezoneParameter: timezone,
    grain: dimension.grain,
    weekStart: dimension.weekStart,
  };
}

function weekOne(year: string, weekday: number): string {
  const januaryFourth = `make_date((${year})::int, 1, 4)`;
  return `((${januaryFourth}) - (((extract(isodow FROM ${januaryFourth}))::int `
    + `- ${weekday} + 7) % 7))`;
}

function weekLabel(localStart: string, weekStart: CalendarDimension['weekStart']): string {
  const startDate = `((${localStart})::date)`;
  const calendarYear = `(extract(year FROM ${startDate}))::int`;
  const currentWeekOne = weekOne(calendarYear, WEEKDAY_INDEX[weekStart]);
  const nextYear = `((${calendarYear}) + 1)`;
  const nextWeekOne = weekOne(nextYear, WEEKDAY_INDEX[weekStart]);
  const previousYear = `((${calendarYear}) - 1)`;
  const weekYear = `(CASE WHEN ${startDate} < ${currentWeekOne} THEN ${previousYear} `
    + `WHEN ${startDate} >= ${nextWeekOne} THEN ${nextYear} ELSE ${calendarYear} END)`;
  const first = weekOne(weekYear, WEEKDAY_INDEX[weekStart]);
  const weekNumber = `((${startDate} - ${first}) / 7 + 1)`;
  return `((${weekYear})::text || '-W' || lpad((${weekNumber})::text, 2, '0'))`;
}

export function calendarPeriodOutputSql(period: CalendarPeriodSql): string {
  const instant = (value: string): string => `to_char((${value}) AT TIME ZONE 'UTC', `
    + `'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  const label = period.grain === 'week'
    ? weekLabel(period.localStart, period.weekStart)
    : period.grain === 'month'
      ? `to_char(${period.localStart}, 'YYYY-MM')`
      : `to_char(${period.localStart}, 'YYYY-MM-DD')`;
  return `CASE WHEN (${period.start}) IS NULL THEN NULL::text ELSE `
    + `json_build_object('start', ${instant(period.start)}, `
    + `'endExclusive', ${instant(period.endExclusive)}, `
    + `'timezone', ${period.timezoneParameter}, 'grain', '${period.grain}', `
    + `'label', ${label})::text END`;
}
