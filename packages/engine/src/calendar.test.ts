import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogPhysicalIdentifier } from '@agql/contracts';
import { InstantValueSchema, SafeIntegerSchema } from '@agql/schemas';

import { compileRelativeRange } from './calendar.ts';
import type { EngineResult } from './types.ts';

const field = {
  logicalId: 'events.at',
  physical: 'physical_events_at' as CatalogPhysicalIdentifier,
  type: { kind: 'instant', precision: 'millisecond' },
  nullable: false,
} as const;

function success<T>(result: EngineResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

test('inLast is a half-open calendar subtraction capped at the explicit anchor', () => {
  const anchor = InstantValueSchema.parse('2024-03-31T12:00:00Z');
  const range = success(compileRelativeRange(
    field,
    anchor,
    'inLast',
    'month',
    SafeIntegerSchema.parse(1),
    '/where',
  ));
  if (range.kind !== 'instantRange') assert.fail('Expected instant range.');
  assert.equal(range.startInclusive, '2024-02-29T12:00:00.000Z');
  assert.equal(range.endExclusive, '2024-03-31T12:00:00.001Z');
  assert.equal(range.anchor, anchor);
});

test('inLast subtracts civil units on the catalog wall clock, not elapsed time', () => {
  // 2024-03-11T05:30:00Z is 01:30 local on the day after New York springs
  // forward. One civil day earlier is 01:30 local on the 10th, which is still
  // UTC-05:00 and therefore 06:30Z — 23 elapsed hours, not 24.
  const anchor = InstantValueSchema.parse('2024-03-11T05:30:00Z');
  const range = success(compileRelativeRange(
    field,
    anchor,
    'inLast',
    'day',
    SafeIntegerSchema.parse(1),
    '/where',
    'America/New_York',
  ));
  if (range.kind !== 'instantRange') assert.fail('Expected instant range.');
  assert.equal(range.startInclusive, '2024-03-10T06:30:00.000Z');
  assert.equal(range.endExclusive, '2024-03-11T05:30:00.001Z');
});

test('a sub-second anchor keeps its remainder through the wall-clock round trip', () => {
  const anchor = InstantValueSchema.parse('2024-03-11T05:30:00.250Z');
  const range = success(compileRelativeRange(
    field,
    anchor,
    'inLast',
    'day',
    SafeIntegerSchema.parse(1),
    '/where',
    'America/New_York',
  ));
  if (range.kind !== 'instantRange') assert.fail('Expected instant range.');
  assert.equal(range.startInclusive, '2024-03-10T06:30:00.250Z');
});

test('inCurrent uses the containing UTC calendar period', () => {
  const anchor = InstantValueSchema.parse('2024-05-17T12:34:56Z');
  const range = success(compileRelativeRange(
    field,
    anchor,
    'inCurrent',
    'quarter',
    undefined,
    '/where',
  ));
  if (range.kind !== 'instantRange') assert.fail('Expected instant range.');
  assert.equal(range.startInclusive, '2024-04-01T00:00:00.000Z');
  assert.equal(range.endExclusive, '2024-07-01T00:00:00.000Z');
});

test('inPrevious uses Monday-start weeks and never reads a clock', () => {
  const anchor = InstantValueSchema.parse('2024-03-06T12:34:56Z');
  const first = success(compileRelativeRange(
    field,
    anchor,
    'inPrevious',
    'week',
    undefined,
    '/where',
  ));
  const second = success(compileRelativeRange(
    field,
    anchor,
    'inPrevious',
    'week',
    undefined,
    '/where',
  ));
  assert.deepEqual(first, second);
  if (first.kind !== 'instantRange') assert.fail('Expected instant range.');
  assert.equal(first.startInclusive, '2024-02-26T00:00:00.000Z');
  assert.equal(first.endExclusive, '2024-03-04T00:00:00.000Z');
});
