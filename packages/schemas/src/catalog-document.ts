import { z } from 'zod';

import { WhereExpressionSchema } from './query.ts';
import { CurrencyCodeSchema, PositiveSafeIntegerSchema } from './values.ts';

export const CapabilityProfileSchema = z.enum([
  'records.v0',
  'aggregate.v0',
  'retrieve.semantic.v0',
  'retrieve.hybrid.v0',
  'ingest.canonical.v0',
  'retrieval-index.v0',
]);

export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

const DescriptionSchema = z.string().trim().min(1);
const IdentifierSchema = z.string().min(1);
const BaseFieldShape = {
  description: DescriptionSchema,
  nullable: z.boolean(),
};

export const FieldDocumentSchema = z.discriminatedUnion('kind', [
  z.object({ ...BaseFieldShape, kind: z.literal('id') }).strict(),
  z.object({ ...BaseFieldShape, kind: z.literal('boolean') }).strict(),
  z.object({ ...BaseFieldShape, kind: z.literal('integer') }).strict(),
  z.object({ ...BaseFieldShape, kind: z.literal('decimal') }).strict(),
  z.object({
    ...BaseFieldShape,
    kind: z.literal('money'),
    currency: CurrencyCodeSchema,
  }).strict(),
  z.object({
    ...BaseFieldShape,
    kind: z.literal('text'),
    collation: z.object({
      id: IdentifierSchema,
      version: IdentifierSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...BaseFieldShape,
    kind: z.literal('enum'),
    values: z.array(z.object({
      code: IdentifierSchema,
      label: z.string().min(1),
    }).strict()).min(1),
  }).strict(),
  z.object({ ...BaseFieldShape, kind: z.literal('date') }).strict(),
  z.object({
    ...BaseFieldShape,
    kind: z.literal('instant'),
    precision: z.enum(['second', 'millisecond', 'microsecond', 'nanosecond']),
  }).strict(),
  z.object({ ...BaseFieldShape, kind: z.literal('null') }).strict(),
]);

export type FieldDocument = z.infer<typeof FieldDocumentSchema>;

const AccessRuleSchema = z.discriminatedUnion('effect', [
  z.object({
    effect: z.literal('allow'),
    requiredCapabilities: z.array(IdentifierSchema),
  }).strict(),
  z.object({ effect: z.literal('deny') }).strict(),
]);

const ChannelAccessSchema = z.object({
  model: AccessRuleSchema,
  principal: AccessRuleSchema,
}).strict();

export const FieldPolicySchema = z.object({
  select: ChannelAccessSchema,
  filter: ChannelAccessSchema,
  group: ChannelAccessSchema,
  order: ChannelAccessSchema,
  aggregate: z.object({
    count: ChannelAccessSchema,
    countDistinct: ChannelAccessSchema,
    sum: ChannelAccessSchema,
    avg: ChannelAccessSchema,
    min: ChannelAccessSchema,
    max: ChannelAccessSchema,
  }).strict(),
  lexicalSearch: ChannelAccessSchema,
}).strict();

export const EmbeddingPolicySchema = z.object({
  reviewed: z.literal(true),
  semanticSearch: ChannelAccessSchema,
}).strict();

export const RowScopeDeclarationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('partitions'),
    dimensions: z.array(IdentifierSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal('none'),
    reason: DescriptionSchema,
  }).strict(),
]);

const IMMUTABLE_REVISION = /^(?:sha256:[a-f0-9]{64}|git:[a-f0-9]{40,64}|provider:[\w./-]{8,})$/u;
const MUTABLE_REVISION = /(?:^|[./:-])(?:latest|stable|current|default|production|prod|v\d+)$/iu;

export const EmbeddingSpecDocumentSchema = z.object({
  version: IdentifierSchema,
  sourceFields: z.array(IdentifierSchema).min(1),
  inputTransformId: IdentifierSchema,
  model: z.object({
    id: IdentifierSchema,
    revision: z.string().regex(
      IMMUTABLE_REVISION,
      'Model revision must use a digest, commit, or provider immutable-id form.',
    ).refine(
      (value) => !MUTABLE_REVISION.test(value),
      'Model revision must be an immutable provider revision, not a marketing alias.',
    ),
  }).strict().refine(
    (model) => model.id !== model.revision,
    'Model revision must identify an immutable revision independently of the model id.',
  ),
  dimension: PositiveSafeIntegerSchema,
  metric: z.enum(['cosine', 'dot', 'euclidean']),
  vectorEncoding: z.enum(['float32', 'float64', 'int8', 'binary']),
  chunking: z.literal('none'),
  privacyClass: IdentifierSchema,
}).strict();

export type EmbeddingSpecDocument = z.infer<typeof EmbeddingSpecDocumentSchema>;
export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type ChannelAccess = z.infer<typeof ChannelAccessSchema>;
export type FieldPolicy = z.infer<typeof FieldPolicySchema>;
export type EmbeddingPolicy = z.infer<typeof EmbeddingPolicySchema>;

export const DatasetDocumentSchema = z.object({
  description: DescriptionSchema,
  idField: IdentifierSchema,
  fields: z.record(IdentifierSchema, FieldDocumentSchema),
  profiles: z.array(CapabilityProfileSchema),
  embeddings: z.record(IdentifierSchema, IdentifierSchema),
  defaultFilters: WhereExpressionSchema.optional(),
  rowScope: RowScopeDeclarationSchema,
  capabilityTags: z.array(IdentifierSchema),
  fieldPolicies: z.record(IdentifierSchema, FieldPolicySchema),
  embeddingPolicies: z.record(IdentifierSchema, EmbeddingPolicySchema),
}).strict();

export type DatasetDocument = z.infer<typeof DatasetDocumentSchema>;

export const CatalogDocumentSchema = z.object({
  schemaVersion: z.literal('0'),
  catalogVersion: IdentifierSchema,
  policyVersion: IdentifierSchema,
  datasets: z.record(IdentifierSchema, DatasetDocumentSchema),
  embeddingSpecs: z.record(IdentifierSchema, EmbeddingSpecDocumentSchema),
}).strict();

export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;
