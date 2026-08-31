import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogDocumentJsonSchema,
  ingestDocumentJsonSchema,
  queryDocumentJsonSchema,
} from './json-schema.ts';

test('emitted JSON Schemas preserve closed objects and non-float query numbers', () => {
  const query = JSON.stringify(queryDocumentJsonSchema);
  const ingest = JSON.stringify(ingestDocumentJsonSchema);
  assert.match(query, /"const":"0"/u);
  assert.match(query, /"additionalProperties":false/u);
  assert.doesNotMatch(query, /"type":"number"/u);
  assert.match(ingest, /"const":"insertOnly"/u);
  assert.match(ingest, /"const":"replace"/u);
  assert.match(ingest, /"const":"delete"/u);
});

test('emitted catalog schema carries currency vocabulary and revision syntax', () => {
  const catalog = JSON.stringify(catalogDocumentJsonSchema);
  assert.match(catalog, /"GBP"/u);
  assert.match(catalog, /sha256/u);
  assert.match(catalog, /"const":"none"/u);
});

