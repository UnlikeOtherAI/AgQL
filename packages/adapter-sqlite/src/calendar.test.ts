import assert from 'node:assert/strict';
import test from 'node:test';

import { InstantValueSchema } from '@agql/schemas';

import { calendarPeriod } from './calendar.ts';

test('calendar periods use the supplied timezone across the New York DST spring transition', () => {
  const period = calendarPeriod(
    InstantValueSchema.parse('2024-03-10T07:00:00Z'),
    'America/New_York',
    'day',
    'monday',
    '00:00:00',
  );
  assert.deepEqual(period, {
    start: '2024-03-10T05:00:00Z',
    endExclusive: '2024-03-11T04:00:00Z',
    timezone: 'America/New_York',
    grain: 'day',
    label: '2024-03-10',
  });
});

test('calendar weeks are Monday-start periods independent of the process locale', () => {
  const sunday = calendarPeriod(
    InstantValueSchema.parse('2024-01-07T23:59:59Z'),
    'UTC',
    'week',
    'monday',
    '00:00:00',
  );
  const monday = calendarPeriod(
    InstantValueSchema.parse('2024-01-08T00:00:00Z'),
    'UTC',
    'week',
    'monday',
    '00:00:00',
  );
  assert.deepEqual(sunday, {
    start: '2024-01-01T00:00:00Z', endExclusive: '2024-01-08T00:00:00Z',
    timezone: 'UTC', grain: 'week', label: '2024-W01',
  });
  assert.deepEqual(monday, {
    start: '2024-01-08T00:00:00Z', endExclusive: '2024-01-15T00:00:00Z',
    timezone: 'UTC', grain: 'week', label: '2024-W02',
  });
});

test('fiscal days use civil boundaries across the New York fall transition', () => {
  const period = calendarPeriod(
    InstantValueSchema.parse('2024-11-03T08:30:00Z'),
    'America/New_York',
    'fiscalDay',
    'monday',
    '04:00:00',
  );
  assert.deepEqual(period, {
    start: '2024-11-02T08:00:00Z',
    endExclusive: '2024-11-03T09:00:00Z',
    timezone: 'America/New_York',
    grain: 'fiscalDay',
    label: '2024-11-02',
  });
});
