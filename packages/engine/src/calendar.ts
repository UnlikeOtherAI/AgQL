import type { ResolvedFieldBinding, ResolvedPredicate } from '@agql/contracts';
import { InstantValueSchema } from '@agql/schemas';
import type { InstantValue, SafeInteger } from '@agql/schemas';

import { fail, semanticError } from './errors.ts';
import type { EngineResult } from './types.ts';

export type CalendarUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

function dateFromAnchor(anchor: InstantValue): Date {
  return new Date(anchor);
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, month, day);
  result.setUTCHours(hour, minute, second, millisecond);
  return result;
}

function daysInUtcMonth(year: number, month: number): number {
  return utcDate(year, month + 1, 0).getUTCDate();
}

function shiftMonths(source: Date, months: number): Date {
  const targetMonth = source.getUTCMonth() + months;
  const year = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(source.getUTCDate(), daysInUtcMonth(year, month));
  return utcDate(
    year,
    month,
    day,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}

function shift(source: Date, amount: number, unit: CalendarUnit): Date {
  if (unit === 'month') return shiftMonths(source, amount);
  if (unit === 'quarter') return shiftMonths(source, amount * 3);
  if (unit === 'year') return shiftMonths(source, amount * 12);
  const result = new Date(source.getTime());
  result.setUTCDate(result.getUTCDate() + amount * (unit === 'week' ? 7 : 1));
  return result;
}

function periodStart(anchor: Date, unit: CalendarUnit): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  if (unit === 'year') return utcDate(year, 0, 1);
  if (unit === 'quarter') return utcDate(year, Math.floor(month / 3) * 3, 1);
  if (unit === 'month') return utcDate(year, month, 1);
  const day = utcDate(year, month, anchor.getUTCDate());
  if (unit === 'day') return day;
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

function zonedParts(
  value: Date,
  timezone: string,
): readonly [number, number, number, number, number, number] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = new Map<string, string>(
    formatter.formatToParts(value).map(({ type, value: part }) => [type, part]),
  );
  const numeric = (name: string): number => Number(parts.get(name));
  return [
    numeric('year'), numeric('month'), numeric('day'), numeric('hour'), numeric('minute'),
    numeric('second'),
  ];
}

function localWallTimeToUtc(value: Date, timezone: string): Date {
  const [year, month, day, hour, minute, second] = [
    value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
    value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(),
  ];
  const candidate = Date.UTC(
    year, month - 1, day, hour, minute, second, value.getUTCMilliseconds(),
  );
  const observed = zonedParts(new Date(candidate), timezone);
  const observedAsUtc = Date.UTC(
    observed[0], observed[1] - 1, observed[2], observed[3], observed[4], observed[5],
  );
  return new Date(candidate - (observedAsUtc - candidate));
}

function instant(date: Date, path: string): EngineResult<InstantValue> {
  if (!Number.isFinite(date.getTime())) {
    return fail(semanticError(
      'Relative-time arithmetic exceeds the supported instant range.',
      path,
      ['Use a smaller relative-time amount.'],
    ));
  }
  const parsed = InstantValueSchema.safeParse(date.toISOString());
  if (!parsed.success) {
    return fail(semanticError(
      'Relative-time arithmetic did not produce a canonical instant.',
      path,
      ['Use an anchor within the interoperable UTC instant range.'],
    ));
  }
  return { ok: true, value: parsed.data };
}

export function compileRelativeRange(
  field: ResolvedFieldBinding,
  anchor: InstantValue,
  op: 'inLast' | 'inCurrent' | 'inPrevious',
  unit: CalendarUnit,
  amount: SafeInteger | undefined,
  path: string,
  timezone = 'UTC',
): EngineResult<ResolvedPredicate> {
  const anchorDate = dateFromAnchor(anchor);
  let startDate: Date;
  let end: EngineResult<InstantValue>;
  if (op === 'inLast') {
    if (amount === undefined) {
      return fail(semanticError(
        'inLast requires an explicit positive amount.',
        path,
        ['Provide amount as a positive safe integer.'],
      ));
    }
    const numericAmount: number = amount;
    startDate = shift(anchorDate, -numericAmount, unit);
    end = instant(new Date(anchorDate.getTime() + 1), path);
  } else {
    const parts = zonedParts(anchorDate, timezone);
    const wallAnchor = utcDate(
      parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5],
    );
    const currentStart = periodStart(wallAnchor, unit);
    startDate = op === 'inPrevious' ? shift(currentStart, -1, unit) : currentStart;
    end = instant(localWallTimeToUtc(
      op === 'inPrevious' ? currentStart : shift(currentStart, 1, unit), timezone,
    ), path);
  }
  const startDateUtc = op === 'inLast' ? startDate : localWallTimeToUtc(startDate, timezone);
  const start = instant(startDateUtc, path);
  if (!start.ok) return start;
  if (!end.ok) return end;
  return {
    ok: true,
    value: {
      kind: 'instantRange',
      field,
      startInclusive: start.value,
      endExclusive: end.value,
      anchor,
    },
  };
}
