import assert from 'node:assert/strict';
import test from 'node:test';

import { createSqliteAdapter, SQLITE_PROFILES } from './index.ts';
import type {
  CatalogPhysicalIdentifier,
  LogicalPlanForProfile,
  QueryVectorDigest,
  ResolvedFieldBinding,
} from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';
import type { EffectivePlanHash, SafeInteger, SourceQueryHash } from '@agql/schemas';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

const idField: ResolvedFieldBinding = {
  logicalId: 'documents.id',
  physical: physical('document_id'),
  type: { kind: 'id' },
  nullable: false,
};

const approximate: LogicalPlanForProfile<'retrieve.semantic.v0'> = {
  languageVersion: '0',
  sourceQueryHash: 'source' as SourceQueryHash,
  effectivePlanHash: 'plan' as EffectivePlanHash,
  dataset: { logicalId: 'documents', physical: physical('documents'), bindingVersion: 'b1' },
  scope: { visibility: 'nothing' },
  hardRowLimit: safe(10),
  take: safe(1),
  mode: 'retrieve',
  profile: 'retrieve.semantic.v0',
  projection: [{ output: { logicalId: 'id', slot: safe(0) }, field: idField }],
  stableId: idField,
  search: {
    kind: 'semantic',
    embedding: {
      name: 'body',
      specReference: 'body@1',
      specVersion: '1',
      physical: physical('embedding'),
      dimension: safe(2),
      metric: 'dot',
      vectorEncoding: 'float32',
      model: { id: 'fixture', revision: 'sha256:fixture' },
      inputTransformId: 'fixture-v1',
      privacyClass: 'internal',
    },
    vector: {
      bytes: new Uint8Array(8),
      encoding: 'float32',
      dimension: safe(2),
      digest: 'vector' as QueryVectorDigest,
    },
    accuracy: 'approximate',
    qualityProfile: 'ann-profile',
    hardCandidateLimit: safe(10),
  },
};

test('the descriptor omits hybrid and refuses approximate semantic plans', async () => {
  assert.equal(new Set<string>(SQLITE_PROFILES).has('retrieve.hybrid.v0'), false);
  const sqlite = createSqliteAdapter({
    databasePath: '/path/that-is-never-opened-for-compile.sqlite',
    exactScanAdmissionLimit: safe(10),
    supportedTextCollations: [],
    id: 'sqlite-reference',
    version: 'test-v1',
  });
  const result = await sqlite.query.compile(approximate);
  assert.equal(result.kind, 'refusal');
  if (result.kind === 'refusal') assert.equal(result.refusal.code, 'UNSUPPORTED_PROFILE');
});

test('semantic compilation refuses a runtime vector that does not match its EmbeddingSpec',
  async () => {
  const sqlite = createSqliteAdapter({
    databasePath: '/path/that-is-never-opened-for-compile.sqlite',
    exactScanAdmissionLimit: safe(10),
    supportedTextCollations: [],
    id: 'sqlite-reference',
    version: 'test-v1',
  });
  const result = await sqlite.query.compile({
    ...approximate,
    search: {
      ...approximate.search,
      accuracy: 'exact',
      vector: { ...approximate.search.vector, bytes: new Uint8Array(4), dimension: safe(1) },
    },
  });
  assert.equal(result.kind, 'refusal');
  if (result.kind === 'refusal') assert.equal(result.refusal.code, 'EMBEDDING_NOT_INDEXED');
});
