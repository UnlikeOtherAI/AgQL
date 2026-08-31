import { DateValueSchema } from '@agql/schemas';
import type { CalendarPeriod, InstantValue } from '@agql/schemas';

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const match = parts.find((item) => item.type === type);
  if (match === undefined) throw new TypeError(`Intl did not produce a ${type} part.`);
  return Number(match.value);
}

function localDate(instant: InstantValue, timezone: string): LocalDate {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  });
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new TypeError('An instant must be parseable by Date.');
  const parts = formatter.formatToParts(date);
  return { year: part(parts, 'year'), month: part(parts, 'month'), day: part(parts, 'day') };
}

function fromUtcDate(date: Date): LocalDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return fromUtcDate(result);
}

function weekdayMondayZero(date: LocalDate): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return weekday === 0 ? 6 : weekday - 1;
}

function startOfMonth(date: LocalDate): LocalDate {
  return { year: date.year, month: date.month, day: 1 };
}

function startOfQuarter(date: LocalDate): LocalDate {
  return { year: date.year, month: Math.floor((date.month - 1) / 3) * 3 + 1, day: 1 };
}

function startOfYear(date: LocalDate): LocalDate {
  return { year: date.year, month: 1, day: 1 };
}

function formatDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}`
    + `-${String(date.day).padStart(2, '0')}`;
}

function periodBounds(date: LocalDate, grain: 'day' | 'week' | 'month' | 'quarter' | 'year'):
  readonly [LocalDate, LocalDate] {
  switch (grain) {
    case 'day':
      return [date, addDays(date, 1)];
    case 'week': {
      const start = addDays(date, -weekdayMondayZero(date));
      return [start, addDays(start, 7)];
    }
    case 'month': {
      const start = startOfMonth(date);
      return [start, { year: start.month === 12 ? start.year + 1 : start.year,
        month: start.month === 12 ? 1 : start.month + 1, day: 1 }];
    }
    case 'quarter': {
      const start = startOfQuarter(date);
      return [start, addMonths(start, 3)];
    }
    case 'year': {
      const start = startOfYear(date);
      return [start, { year: start.year + 1, month: 1, day: 1 }];
    }
  }
}

function addMonths(date: LocalDate, months: number): LocalDate {
  const offset = date.month - 1 + months;
  return { year: date.year + Math.floor(offset / 12), month: (offset % 12) + 1, day: date.day };
}

/**
 * Grouping uses an explicit IANA timezone and proleptic Gregorian civil dates. It does not
 * use SQLite's UTC-only date functions, so DST changes affect membership but never create
 * duration-shaped buckets. Monday is the fixed v0 adapter week start pending a catalog rule.
 */
export function calendarPeriod(
  instant: InstantValue,
  timezone: string,
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year',
): CalendarPeriod {
  const [start, endExclusive] = periodBounds(localDate(instant, timezone), grain);
  return {
    start: DateValueSchema.parse(formatDate(start)),
    endExclusive: DateValueSchema.parse(formatDate(endExclusive)),
    timezone,
  };
}
