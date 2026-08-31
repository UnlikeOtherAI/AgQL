import { zodToJsonSchema } from 'zod-to-json-schema';

import { CatalogDocumentSchema } from './catalog-document.ts';
import { IngestDocumentSchema } from './ingest.ts';
import { QueryDocumentSchema } from './query.ts';

/** JSON Schema emitted from the language-authoritative Zod schemas. */
export const queryDocumentJsonSchema = zodToJsonSchema(QueryDocumentSchema, {
  name: 'AgqlQueryDocumentV0',
  target: 'jsonSchema7',
});

export const ingestDocumentJsonSchema = zodToJsonSchema(IngestDocumentSchema, {
  name: 'AgqlIngestDocumentV0',
  target: 'jsonSchema7',
});

export const catalogDocumentJsonSchema = zodToJsonSchema(CatalogDocumentSchema, {
  name: 'AgqlCatalogDocumentV0',
  target: 'jsonSchema7',
});

