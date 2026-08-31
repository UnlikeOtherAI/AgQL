import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CatalogDocumentSchema,
  InstantValueSchema,
  SafeIntegerSchema,
} from '@agql/schemas';
import type { AccessRule } from '@agql/schemas';

import {
  deriveEmbeddingSearchPolicy,
  deriveModelCatalogDocumentation,
  resolvePartitionValues,
  validateCatalog,
} from './index.ts';
import type { Scope } from './scope.ts';

const allow = (requiredCapabilities: readonly string[] = []) => ({
  effect: 'allow' as const,
  requiredCapabilities: [...requiredCapabilities],
});
const deny = { effect: 'deny' as const };
const channels = (model: AccessRule = allow(), principal: AccessRule = allow()) => ({
  model,
  principal,
});
const fieldPolicy = (model: AccessRule = allow()) => ({
  select: channels(model),
  filter: channels(model),
  group: channels(model),
  order: channels(model),
  aggregate: {
    count: channels(model),
    countDistinct: channels(model),
    sum: channels(model),
    avg: channels(model),
    min: channels(model),
    max: channels(model),
  },
  lexicalSearch: channels(model),
});

function rawCatalog() {
  return {
    schemaVersion: '0',
    catalogVersion: 'catalog-1',
    policyVersion: 'policy-1',
    datasets: {
      notes: {
        description: 'Governed incident notes.',
        idField: 'id',
        fields: {
          id: { kind: 'id', description: 'Stable note id.', nullable: false },
          body: {
            kind: 'text',
            description: 'Incident note body.',
            nullable: false,
            collation: { id: 'unicode-codepoint', version: '15.1' },
          },
          title: {
            kind: 'text',
            description: 'Protected note title.',
            nullable: false,
            collation: { id: 'unicode-codepoint', version: '15.1' },
          },
        },
        profiles: ['records.v0', 'retrieve.semantic.v0'],
        embeddings: { searchable: 'note-search@1' },
        rowScope: { kind: 'none', reason: 'This dataset is explicitly unpartitioned.' },
        capabilityTags: ['canonical'],
        fieldPolicies: {
          id: fieldPolicy(),
          body: fieldPolicy(allow(['notes:read'])),
          title: fieldPolicy(deny),
        },
        embeddingPolicies: {},
      },
    },
    embeddingSpecs: {
      'note-search@1': {
        version: '1',
        sourceFields: ['body', 'title'],
        inputTransformId: 'join-nfc-v1',
        model: {
          id: 'embed-model',
          revision: `sha256:${'0123456789abcdef'.repeat(4)}`,
        },
        dimension: 768,
        metric: 'cosine',
        vectorEncoding: 'float32',
        chunking: 'none',
        privacyClass: 'protected',
      },
    },
  };
}

function scope(partitions: Scope['partitions']): Scope {
  return {
    principal: 'uoa:person:one',
    capabilities: ['notes:read'],
    partitions,
    budgets: {
      maximumQueries: SafeIntegerSchema.parse(10),
      maximumExactScanRecords: SafeIntegerSchema.parse(1_000),
      maximumCandidateRecords: SafeIntegerSchema.parse(100),
    },
    expiresAt: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
  };
}

test('catalog validation accepts a complete described, scoped kernel', () => {
  const result = validateCatalog(rawCatalog());
  assert.equal(result.ok, true);
});

test('undescribed datasets and mutable model aliases are structural refusals', () => {
  const missingDescription = rawCatalog();
  missingDescription.datasets.notes.description = '   ';
  const descriptionResult = validateCatalog(missingDescription);
  assert.equal(descriptionResult.ok, false);
  if (!descriptionResult.ok) {
    assert.equal(descriptionResult.errors[0].code, 'STRUCTURAL_INVALID');
    assert.equal(descriptionResult.errors[0].path, '/datasets/notes/description');
  }
  const missingFieldDescription = rawCatalog();
  missingFieldDescription.datasets.notes.fields.body.description = ' ';
  const fieldDescriptionResult = validateCatalog(missingFieldDescription);
  assert.equal(fieldDescriptionResult.ok, false);
  if (!fieldDescriptionResult.ok) {
    assert.equal(
      fieldDescriptionResult.errors[0].path,
      '/datasets/notes/fields/body/description',
    );
  }

  const mutableRevision = rawCatalog();
  mutableRevision.embeddingSpecs['note-search@1'].model.revision = 'latest';
  const revisionResult = validateCatalog(mutableRevision);
  assert.equal(revisionResult.ok, false);
  if (!revisionResult.ok) {
    assert.equal(revisionResult.errors[0].code, 'STRUCTURAL_INVALID');
    assert.equal(
      revisionResult.errors[0].path,
      '/embeddingSpecs/note-search@1/model/revision',
    );
  }

  const marketingRevision = rawCatalog();
  marketingRevision.embeddingSpecs['note-search@1'].model.revision =
    'text-embedding-marketing-name';
  const marketingResult = validateCatalog(marketingRevision);
  assert.equal(marketingResult.ok, false);
});

test('semantic validation stops after the first document-order error', () => {
  const invalid = rawCatalog();
  invalid.datasets.notes.idField = 'missing';
  invalid.datasets.notes.profiles.push('records.v0');
  const result = validateCatalog(invalid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'SEMANTIC_INVALID');
    assert.equal(result.errors[0].path, '/datasets/notes/idField');
    assert.deepEqual(result.errors[0].alternatives, ['id', 'body', 'title']);
  }
});

test('catalog semantic error paths escape JSON Pointer tokens', () => {
  const raw = rawCatalog();
  const dataset = raw.datasets.notes;
  const result = validateCatalog({
    ...raw,
    datasets: { 'notes/a~b': { ...dataset, idField: 'missing' } },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0].path, '/datasets/notes~1a~0b/idField');
  }
});

test('embedding permission inherits the most restrictive source search rule', () => {
  const catalog = CatalogDocumentSchema.parse(rawCatalog());
  const dataset = catalog.datasets.notes;
  const spec = catalog.embeddingSpecs['note-search@1'];
  assert.notEqual(dataset, undefined);
  assert.notEqual(spec, undefined);
  if (dataset === undefined || spec === undefined) return;
  const inherited = deriveEmbeddingSearchPolicy(dataset, 'searchable', spec);
  assert.equal(inherited.ok, true);
  if (inherited.ok) assert.deepEqual(inherited.value.model, deny);

  const conjunctiveRaw = rawCatalog();
  conjunctiveRaw.datasets.notes.fieldPolicies.title = fieldPolicy(allow(['titles:search']));
  const conjunctiveCatalog = CatalogDocumentSchema.parse(conjunctiveRaw);
  const conjunctiveDataset = conjunctiveCatalog.datasets.notes;
  const conjunctiveSpec = conjunctiveCatalog.embeddingSpecs['note-search@1'];
  if (conjunctiveDataset === undefined || conjunctiveSpec === undefined) return;
  const conjunctive = deriveEmbeddingSearchPolicy(
    conjunctiveDataset,
    'searchable',
    conjunctiveSpec,
  );
  assert.equal(conjunctive.ok, true);
  if (conjunctive.ok) {
    assert.deepEqual(
      conjunctive.value.model,
      allow(['notes:read', 'titles:search']),
    );
  }

  const reviewedRaw = rawCatalog();
  reviewedRaw.datasets.notes.embeddingPolicies = {
    searchable: { reviewed: true, semanticSearch: channels(allow(['semantic:search'])) },
  };
  const reviewedCatalog = CatalogDocumentSchema.parse(reviewedRaw);
  const reviewedDataset = reviewedCatalog.datasets.notes;
  const reviewedSpec = reviewedCatalog.embeddingSpecs['note-search@1'];
  if (reviewedDataset === undefined || reviewedSpec === undefined) return;
  const reviewed = deriveEmbeddingSearchPolicy(reviewedDataset, 'searchable', reviewedSpec);
  assert.equal(reviewed.ok, true);
  if (reviewed.ok) {
    assert.deepEqual(reviewed.value.model, allow(['semantic:search']));
  }
});

test('scope-derived documentation uses exactly the queryable model vocabulary', () => {
  const catalog = CatalogDocumentSchema.parse(rawCatalog());
  assert.deepEqual(resolvePartitionValues({}), { kind: 'nothing' });
  assert.equal(resolvePartitionValues({ region: [] }).kind, 'nothing');
  assert.deepEqual(
    deriveModelCatalogDocumentation(catalog, scope({ kind: 'nothing' })).datasets,
    [],
  );
  const documentation = deriveModelCatalogDocumentation(
    catalog,
    scope({ kind: 'unpartitioned' }),
  );
  assert.equal(documentation.datasets.length, 1);
  assert.deepEqual(
    documentation.datasets[0]?.fields.map((field) => field.id),
    ['id', 'body'],
  );
  assert.deepEqual(documentation.datasets[0]?.profiles, ['records.v0']);
  assert.deepEqual(documentation.datasets[0]?.embeddings, []);
  assert.deepEqual(documentation.datasets[0]?.fields[1]?.definition, {
    kind: 'text',
    description: 'Incident note body.',
    nullable: false,
    collation: { id: 'unicode-codepoint', version: '15.1' },
  });
});
