import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AggregateQuerySchema,
  IngestDocumentSchema,
  QueryDocumentSchema,
  RecordsQuerySchema,
  RetrieveQuerySchema,
} from './index.ts';

const order = [{ by: 'orders.id', dir: 'asc' }] as const;

test('the three closed query modes accept their RFC v0 shapes', () => {
  assert.equal(RecordsQuerySchema.safeParse({
    version: '0',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order,
    take: 10,
  }).success, true);
  assert.equal(AggregateQuerySchema.safeParse({
    version: '0',
    mode: 'aggregate',
    from: 'orders',
    dimensions: [{ kind: 'field', field: 'orders.channel', id: 'channel' }],
    metrics: [{ op: 'count', id: 'orders' }],
    order: [{ by: 'channel', dir: 'asc' }],
    take: 10,
  }).success, true);
  assert.equal(RetrieveQuerySchema.safeParse({
    version: '0',
    mode: 'retrieve',
    from: 'notes',
    search: {
      kind: 'hybrid',
      semantic: { using: 'body', text: 'cold room', accuracy: 'approximate' },
      lexical: { field: 'notes.body', text: 'cold room' },
      fusion: 'rrf-v0',
      quality: 'certified-high',
    },
    select: ['notes.id'],
    take: 5,
  }).success, true);
});

test('query schema rejects floats, passthroughs, omitted bounds, and wrong version', () => {
  const invalid = QueryDocumentSchema.safeParse({
    version: '1',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order,
    where: { kind: 'predicate', field: 'orders.total', op: 'eq', value: 1.5 },
    rawSql: 'delete from orders',
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.ok(invalid.error.issues.length >= 3);
  }
});

test('boolean nesting beyond the v0 limit is structural rejection', () => {
  const leaf = { kind: 'predicate', field: 'orders.id', op: 'eq', value: 'one' };
  const invalid = RecordsQuerySchema.safeParse({
    version: '0',
    mode: 'records',
    from: 'orders',
    select: ['orders.id'],
    order,
    where: {
      kind: 'not',
      item: { kind: 'not', item: { kind: 'not', item: leaf } },
    },
    take: 10,
  });
  assert.equal(invalid.success, false);
});

test('ingest is a separate closed contract with whole records only', () => {
  assert.equal(IngestDocumentSchema.safeParse({
    dataset: 'memories',
    mode: 'replace',
    records: [{ id: 'one', value: { confidence: '0.8' }, ifVersion: 7 }],
    embeddingPolicy: 'catalog',
    idempotencyKey: 'task:one',
  }).success, true);
  assert.equal(IngestDocumentSchema.safeParse({
    dataset: 'memories',
    mode: 'delete',
    records: [{ id: 'one', update: { $set: { private: true } } }],
    embeddingPolicy: 'catalog',
    idempotencyKey: 'task:two',
  }).success, false);
});
