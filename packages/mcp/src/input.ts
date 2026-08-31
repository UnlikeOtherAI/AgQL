import {
  AfterWriteSchema,
  DeleteIngestSchema,
  IngestDocumentSchema,
  InsertOnlyIngestSchema,
  QueryDocumentSchema,
  ReplaceIngestSchema,
  queryDocumentJsonSchema,
  structuralErrors,
  validateIngestDocument,
  validateQueryDocument,
} from '@agql/schemas';
import type {
  AgqlError,
  QueryDocument,
} from '@agql/schemas';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type {
  PutRecordsOperationInput,
  QueryOperationInput,
  SaveQueryOperationInput,
} from './types.ts';

export const TOOL_NAMES = [
  'search_catalog',
  'describe_catalog',
  'lookup_values',
  'explain_query',
  'run_query',
  'put_records',
  'save_query',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

interface JsonObjectSchema {
  readonly type: 'object';
  readonly [key: string]: unknown;
}

const SourceSchema = z.string().min(1);
const LimitSchema = z.number().int().positive().max(100).default(20);

export const SearchCatalogInputSchema = z.object({
  source: SourceSchema,
  query: z.string(),
  limit: LimitSchema,
}).strict();

export const DescribeCatalogInputSchema = z.object({
  source: SourceSchema,
  refs: z.array(z.string().min(1)).min(1).max(100),
}).strict();

export const LookupValuesInputSchema = z.object({
  source: SourceSchema,
  field: z.string().min(1),
  query: z.string(),
  limit: LimitSchema,
}).strict();

const QueryWrapperSchema = z.object({
  source: SourceSchema,
  query: z.unknown(),
  afterWrite: AfterWriteSchema.optional(),
}).strict();

const SaveQueryWrapperSchema = z.object({
  source: SourceSchema,
  name: z.string().min(1),
  query: z.unknown(),
  executionReceipt: z.string().min(1),
}).strict();

const PutRecordsWrapperSchema = z.object({ source: SourceSchema }).passthrough();

export type SearchCatalogInput = z.infer<typeof SearchCatalogInputSchema>;
export type DescribeCatalogInput = z.infer<typeof DescribeCatalogInputSchema>;
export type LookupValuesInput = z.infer<typeof LookupValuesInputSchema>;

export const PutRecordsToolSchema = z.discriminatedUnion('mode', [
  InsertOnlyIngestSchema.extend({ source: SourceSchema }),
  ReplaceIngestSchema.extend({ source: SourceSchema }),
  DeleteIngestSchema.extend({ source: SourceSchema }),
]);

export type InputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly [AgqlError, ...AgqlError[]] };

function parsed<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
): InputResult<Output> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: structuralErrors(result.error) };
}

function duplicateAfterWrite(): InputResult<never> {
  return {
    ok: false,
    errors: [{
      code: 'SEMANTIC_INVALID',
      message: 'afterWrite must be provided either beside query or inside query, not both.',
      path: '/afterWrite',
      alternatives: ['Remove one of the two afterWrite values.'],
    }],
  };
}

function normalizedQuery(
  value: unknown,
  afterWrite: z.infer<typeof AfterWriteSchema> | undefined,
): InputResult<QueryDocument> {
  const query = validateQueryDocument(value);
  if (!query.ok) return query;
  if (afterWrite === undefined) return query;
  if (query.value.afterWrite !== undefined) return duplicateAfterWrite();
  return validateQueryDocument({ ...query.value, afterWrite });
}

export function parseQueryOperation(value: unknown): InputResult<QueryOperationInput> {
  const wrapper = parsed(QueryWrapperSchema, value);
  if (!wrapper.ok) return wrapper;
  const query = normalizedQuery(wrapper.value.query, wrapper.value.afterWrite);
  if (!query.ok) return query;
  return { ok: true, value: { source: wrapper.value.source, query: query.value } };
}

export function parseSaveQuery(value: unknown): InputResult<SaveQueryOperationInput> {
  const wrapper = parsed(SaveQueryWrapperSchema, value);
  if (!wrapper.ok) return wrapper;
  const query = validateQueryDocument(wrapper.value.query);
  if (!query.ok) return query;
  return {
    ok: true,
    value: {
      source: wrapper.value.source,
      name: wrapper.value.name,
      query: query.value,
      executionReceipt: wrapper.value.executionReceipt,
    },
  };
}

function ingestWithoutSource(value: Readonly<Record<string, unknown>>): unknown {
  const entries = Object.entries(value).filter(([key]) => key !== 'source');
  return Object.fromEntries(entries);
}

export function parsePutRecords(value: unknown): InputResult<PutRecordsOperationInput> {
  const wrapper = parsed(PutRecordsWrapperSchema, value);
  if (!wrapper.ok) return wrapper;
  const document = validateIngestDocument(ingestWithoutSource(wrapper.value));
  if (!document.ok) return document;
  return {
    ok: true,
    value: { source: wrapper.value.source, document: document.value },
  };
}

const afterWriteJsonSchema = zodToJsonSchema(AfterWriteSchema, { target: 'jsonSchema7' });
const putRecordsGeneratedSchema = zodToJsonSchema(PutRecordsToolSchema, {
  target: 'jsonSchema7',
});

const queryInputSchema: JsonObjectSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', minLength: 1 },
    query: queryDocumentJsonSchema,
    afterWrite: afterWriteJsonSchema,
  },
  required: ['source', 'query'],
  additionalProperties: false,
};

const saveQueryInputSchema: JsonObjectSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    query: queryDocumentJsonSchema,
    executionReceipt: { type: 'string', minLength: 1 },
  },
  required: ['source', 'name', 'query', 'executionReceipt'],
  additionalProperties: false,
};

const putRecordsInputSchema: JsonObjectSchema = {
  ...putRecordsGeneratedSchema,
  type: 'object',
};

export const toolInputJsonSchemas = {
  search_catalog: {
    type: 'object',
    properties: {
      source: { type: 'string', minLength: 1 },
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    required: ['source', 'query'],
    additionalProperties: false,
  },
  describe_catalog: {
    type: 'object',
    properties: {
      source: { type: 'string', minLength: 1 },
      refs: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    },
    required: ['source', 'refs'],
    additionalProperties: false,
  },
  lookup_values: {
    type: 'object',
    properties: {
      source: { type: 'string', minLength: 1 },
      field: { type: 'string', minLength: 1 },
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    required: ['source', 'field', 'query'],
    additionalProperties: false,
  },
  explain_query: queryInputSchema,
  run_query: queryInputSchema,
  put_records: putRecordsInputSchema,
  save_query: saveQueryInputSchema,
} as const satisfies Readonly<Record<ToolName, JsonObjectSchema>>;

export const languageSchemas = {
  query: QueryDocumentSchema,
  ingest: IngestDocumentSchema,
};

export function parseSearchCatalog(value: unknown): InputResult<SearchCatalogInput> {
  return parsed(SearchCatalogInputSchema, value);
}

export function parseDescribeCatalog(value: unknown): InputResult<DescribeCatalogInput> {
  return parsed(DescribeCatalogInputSchema, value);
}

export function parseLookupValues(value: unknown): InputResult<LookupValuesInput> {
  return parsed(LookupValuesInputSchema, value);
}
