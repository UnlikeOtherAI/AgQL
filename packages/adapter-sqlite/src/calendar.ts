import type { CalendarGrain, CalendarPeriodValue } from '@agql/contracts';
import { InstantValueSchema } from '@agql/schemas';
import type { InstantValue } from '@agql/schemas';

type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday'
  | 'saturday' | 'sunday';

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface CivilDateTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const WEEKDAYS: readonly Weekday[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const match = parts.find((item) => item.type === type);
  if (match === undefined) throw new TypeError(`Intl did not produce a ${type} part.`);
  return Number(match.value);
}

function fixedOffsetSeconds(timezone: string): number | undefined {
  if (timezone === 'UTC') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(timezone);
  if (match === null) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) throw new TypeError('A fixed timezone offset is invalid.');
  const seconds = hours * 3_600 + minutes * 60;
  return match[1] === '-' ? -seconds : seconds;
}

function utcCivil(milliseconds: number): CivilDateTime {
  const date = new Date(milliseconds);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function localCivil(milliseconds: number, timezone: string): CivilDateTime {
  const offset = fixedOffsetSeconds(timezone);
  if (offset !== undefined) return utcCivil(milliseconds + offset * 1_000);
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  });
  const parts = formatter.formatToParts(new Date(milliseconds));
  return {
    year: part(parts, 'year'),
    month: part(parts, 'month'),
    day: part(parts, 'day'),
    hour: part(parts, 'hour'),
    minute: part(parts, 'minute'),
    second: part(parts, 'second'),
  };
}

function civilMilliseconds(value: CivilDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
}

function sameCivil(left: CivilDateTime, right: CivilDateTime): boolean {
  return civilMilliseconds(left) === civilMilliseconds(right);
}

function instantForCivil(value: CivilDateTime, timezone: string): InstantValue {
  const fixed = fixedOffsetSeconds(timezone);
  const naive = civilMilliseconds(value);
  if (fixed !== undefined) {
    return InstantValueSchema.parse(new Date(naive - fixed * 1_000).toISOString()
      .replace('.000Z', 'Z'));
  }
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = naive + hours * 3_600_000;
    offsets.add(civilMilliseconds(localCivil(sample, timezone)) - sample);
  }
  const candidates = [...offsets].map((offset) => naive - offset);
  const exact = candidates
    .filter((candidate) => sameCivil(localCivil(candidate, timezone), value))
    .sort((left, right) => left - right)[0];
  if (exact !== undefined) {
    return InstantValueSchema.parse(new Date(exact).toISOString().replace('.000Z', 'Z'));
  }
  const afterGap = candidates.map((candidate) => ({
    candidate,
    localDelta: civilMilliseconds(localCivil(candidate, timezone)) - naive,
  })).filter(({ localDelta }) => localDelta > 0)
    .sort((left, right) =>
      left.localDelta - right.localDelta || left.candidate - right.candidate)[0];
  if (afterGap === undefined) throw new TypeError('The civil-time boundary cannot be resolved.');
  return InstantValueSchema.parse(new Date(afterGap.candidate).toISOString().replace('.000Z', 'Z'));
}

function dateFromMilliseconds(milliseconds: number): CivilDate {
  const value = new Date(milliseconds);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function dateMilliseconds(value: CivilDate): number {
  return Date.UTC(value.year, value.month - 1, value.day);
}

function addDays(value: CivilDate, days: number): CivilDate {
  return dateFromMilliseconds(dateMilliseconds(value) + days * 86_400_000);
}

function addMonth(value: CivilDate): CivilDate {
  return value.month === 12
    ? { year: value.year + 1, month: 1, day: 1 }
    : { year: value.year, month: value.month + 1, day: 1 };
}

function weekdayIndex(value: CivilDate): number {
  const sundayZero = new Date(dateMilliseconds(value)).getUTCDay();
  return sundayZero === 0 ? 6 : sundayZero - 1;
}

function startOfWeek(value: CivilDate, weekStart: Weekday): CivilDate {
  const startIndex = WEEKDAYS.indexOf(weekStart);
  return addDays(value, -((weekdayIndex(value) - startIndex + 7) % 7));
}

function fiscalSeconds(value: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) throw new TypeError('fiscalDayStart must use HH:mm:ss.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TypeError('fiscalDayStart must be a valid civil time.');
  }
  return hour * 3_600 + minute * 60 + second;
}

function timeParts(seconds: number): Pick<CivilDateTime, 'hour' | 'minute' | 'second'> {
  return {
    hour: Math.floor(seconds / 3_600),
    minute: Math.floor((seconds % 3_600) / 60),
    second: seconds % 60,
  };
}

function formatDate(value: CivilDate): string {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}`
    + `-${String(value.day).padStart(2, '0')}`;
}

function weekLabel(start: CivilDate, weekStart: Weekday): string {
  const weekOne = (year: number): CivilDate => startOfWeek({ year, month: 1, day: 4 }, weekStart);
  let weekYear = start.year;
  if (dateMilliseconds(start) < dateMilliseconds(weekOne(weekYear))) weekYear -= 1;
  else if (dateMilliseconds(start) >= dateMilliseconds(weekOne(weekYear + 1))) weekYear += 1;
  const week = Math.floor(
    (dateMilliseconds(start) - dateMilliseconds(weekOne(weekYear))) / (7 * 86_400_000),
  ) + 1;
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function periodDates(
  local: CivilDateTime,
  grain: CalendarGrain,
  weekStart: Weekday,
  fiscalStartSeconds: number,
): { readonly start: CivilDate; readonly end: CivilDate; readonly boundarySeconds: number } {
  if (grain === 'day') {
    const start = { year: local.year, month: local.month, day: local.day };
    return { start, end: addDays(start, 1), boundarySeconds: 0 };
  }
  const localSeconds = local.hour * 3_600 + local.minute * 60 + local.second;
  const localDate = { year: local.year, month: local.month, day: local.day };
  const effectiveDate = localSeconds < fiscalStartSeconds ? addDays(localDate, -1) : localDate;
  if (grain === 'fiscalDay') {
    return {
      start: effectiveDate,
      end: addDays(effectiveDate, 1),
      boundarySeconds: fiscalStartSeconds,
    };
  }
  if (grain === 'week') {
    const start = startOfWeek(effectiveDate, weekStart);
    return { start, end: addDays(start, 7), boundarySeconds: fiscalStartSeconds };
  }
  const start = { year: effectiveDate.year, month: effectiveDate.month, day: 1 };
  return { start, end: addMonth(start), boundarySeconds: fiscalStartSeconds };
}

export function calendarPeriod(
  instant: InstantValue,
  timezone: string,
  grain: CalendarGrain,
  weekStart: Weekday,
  fiscalDayStart: string,
): CalendarPeriodValue {
  const local = localCivil(new Date(instant).valueOf(), timezone);
  const dates = periodDates(local, grain, weekStart, fiscalSeconds(fiscalDayStart));
  const boundary = timeParts(dates.boundarySeconds);
  const start = instantForCivil({ ...dates.start, ...boundary }, timezone);
  const endExclusive = instantForCivil({ ...dates.end, ...boundary }, timezone);
  const label = grain === 'week'
    ? weekLabel(dates.start, weekStart)
    : grain === 'month'
      ? formatDate(dates.start).slice(0, 7)
      : formatDate(dates.start);
  return { start, endExclusive, timezone, grain, label };
}
