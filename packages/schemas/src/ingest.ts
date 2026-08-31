import { z } from 'zod';

import {
  NonnegativeSafeIntegerSchema,
  SafeIntegerSchema,
} from './values.ts';
import type { SafeInteger } from './values.ts';

const JsonPrimitiveSchema = z.union([z.string(), z.boolean(), SafeIntegerSchema, z.null()]);

export type RecordValue =
  | string
  | boolean
  | SafeInteger
  | null
  | readonly RecordValue[]
  | { readonly [key: string]: RecordValue };

type RecordValueInput =
  | string
  | boolean
  | number
  | null
  | readonly RecordValueInput[]
  | { readonly [key: string]: RecordValueInput };

export const RecordValueSchema: z.ZodType<
  RecordValue,
  z.ZodTypeDef,
  RecordValueInput
> = z.lazy(() => z.union([
  JsonPrimitiveSchema,
  z.array(RecordValueSchema),
  z.record(RecordValueSchema),
]));

const RecordIdentityShape = {
  id: z.string().min(1),
};

const VersionPreconditionShape = {
  ifVersion: NonnegativeSafeIntegerSchema.optional(),
};

const IngestBaseShape = {
  dataset: z.string().min(1),
  idempotencyKey: z.string().min(1),
  embeddingPolicy: z.literal('catalog'),
};

export const InsertOnlyIngestSchema = z.object({
  ...IngestBaseShape,
  mode: z.literal('insertOnly'),
  records: z.array(z.object({
    ...RecordIdentityShape,
    value: z.record(RecordValueSchema),
  }).strict()).min(1),
}).strict();

export const ReplaceIngestSchema = z.object({
  ...IngestBaseShape,
  mode: z.literal('replace'),
  records: z.array(z.object({
    ...RecordIdentityShape,
    ...VersionPreconditionShape,
    value: z.record(RecordValueSchema),
  }).strict()).min(1),
}).strict();

export const DeleteIngestSchema = z.object({
  ...IngestBaseShape,
  mode: z.literal('delete'),
  records: z.array(z.object({
    ...RecordIdentityShape,
    ...VersionPreconditionShape,
  }).strict()).min(1),
}).strict();

export const IngestDocumentSchema = z.discriminatedUnion('mode', [
  InsertOnlyIngestSchema,
  ReplaceIngestSchema,
  DeleteIngestSchema,
]);

export type IngestDocument = z.infer<typeof IngestDocumentSchema>;
