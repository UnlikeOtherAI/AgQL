import assert from 'node:assert/strict';
import test from 'node:test';

import { InstantValueSchema } from '@agql/schemas';

import { calendarPeriod } from './calendar.ts';

test('calendar periods use the supplied timezone across the New York DST spring transition', () => {
  const period = calendarPeriod(
    InstantValueSchema.parse('2024-03-10T07:00:00Z'),
    'America/New_York',
    'day',
  );
  assert.deepEqual(period, {
    start: '2024-03-10',
    endExclusive: '2024-03-11',
    timezone: 'America/New_York',
  });
});

test('calendar weeks are Monday-start periods independent of the process locale', () => {
  const sunday = calendarPeriod(
    InstantValueSchema.parse('2024-01-07T23:59:59Z'),
    'UTC',
    'week',
  );
  const monday = calendarPeriod(
    InstantValueSchema.parse('2024-01-08T00:00:00Z'),
    'UTC',
    'week',
  );
  assert.deepEqual(sunday, { start: '2024-01-01', endExclusive: '2024-01-08', timezone: 'UTC' });
  assert.deepEqual(monday, { start: '2024-01-08', endExclusive: '2024-01-15', timezone: 'UTC' });
});
