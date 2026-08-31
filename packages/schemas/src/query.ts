import { z } from 'zod';

import {
  AgqlLiteralSchema,
  NonnegativeSafeIntegerSchema,
  NormalizedTextSchema,
  PositiveSafeIntegerSchema,
  SafeIntegerSchema,
} from './values.ts';

export const QUERY_LIMITS = {
  booleanNesting: 2,
  inList: 100,
  predicateNodes: 100,
  select: 100,
  take: {
    aggregate: 1_000,
    records: 10_000,
    retrieve: 1_000,
  },
} as const;

const ReferenceSchema = z.string().min(1);
const OutputIdSchema = z.string().min(1);
const CalendarUnitSchema = z.enum(['day', 'week', 'month', 'quarter', 'year']);

const ValuePredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
  value: AgqlLiteralSchema,
}).strict();

const ListPredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.enum(['in', 'notIn']),
  values: z.array(AgqlLiteralSchema).min(1).max(QUERY_LIMITS.inList),
}).strict();

const NullPredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.enum(['isNull', 'isNotNull']),
}).strict();

const TextPredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.enum(['contains', 'startsWith']),
  value: NormalizedTextSchema,
}).strict();

const InLastPredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.literal('inLast'),
  amount: PositiveSafeIntegerSchema,
  unit: CalendarUnitSchema,
}).strict();

const RelativePeriodPredicateSchema = z.object({
  kind: z.literal('predicate'),
  field: ReferenceSchema,
  op: z.enum(['inCurrent', 'inPrevious']),
  unit: CalendarUnitSchema,
}).strict();

export const PredicateLeafSchema = z.discriminatedUnion('op', [
  ValuePredicateSchema,
  ListPredicateSchema,
  NullPredicateSchema,
  TextPredicateSchema,
  InLastPredicateSchema,
  RelativePeriodPredicateSchema,
]);

export type PredicateLeaf = z.infer<typeof PredicateLeafSchema>;

export type WhereExpression =
  | PredicateLeaf
  | { readonly kind: 'and'; readonly items: readonly WhereExpression[] }
  | { readonly kind: 'or'; readonly items: readonly WhereExpression[] }
  | { readonly kind: 'not'; readonly item: WhereExpression };

type PredicateLeafInput = z.input<typeof PredicateLeafSchema>;
type WhereExpressionInput =
  | PredicateLeafInput
  | { readonly kind: 'and'; readonly items: readonly WhereExpressionInput[] }
  | { readonly kind: 'or'; readonly items: readonly WhereExpressionInput[] }
  | { readonly kind: 'not'; readonly item: WhereExpressionInput };

function inspectWhere(
  expression: WhereExpression,
  booleanDepth: number,
): { readonly maxDepth: number; readonly nodes: number } {
  if (expression.kind === 'predicate') return { maxDepth: booleanDepth, nodes: 1 };
  if (expression.kind === 'not') {
    const nested = inspectWhere(expression.item, booleanDepth + 1);
    return { maxDepth: nested.maxDepth, nodes: nested.nodes + 1 };
  }
  const nested = expression.items.map((item) => inspectWhere(item, booleanDepth + 1));
  return {
    maxDepth: Math.max(booleanDepth, ...nested.map((item) => item.maxDepth)),
    nodes: 1 + nested.reduce((total, item) => total + item.nodes, 0),
  };
}

export const WhereExpressionSchema: z.ZodType<
  WhereExpression,
  z.ZodTypeDef,
  WhereExpressionInput
> = z.lazy(() =>
  z.union([
    PredicateLeafSchema,
    z.object({
      kind: z.literal('and'),
      items: z.array(WhereExpressionSchema).min(1),
    }).strict(),
    z.object({
      kind: z.literal('or'),
      items: z.array(WhereExpressionSchema).min(1),
    }).strict(),
    z.object({
      kind: z.literal('not'),
      item: WhereExpressionSchema,
    }).strict(),
  ]),
).superRefine((expression, context) => {
  const inspection = inspectWhere(expression, 0);
  if (inspection.maxDepth > QUERY_LIMITS.booleanNesting) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Boolean nesting exceeds the v0 limit of ${QUERY_LIMITS.booleanNesting}.`,
    });
  }
  if (inspection.nodes > QUERY_LIMITS.predicateNodes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Predicate nodes exceed the v0 limit of ${QUERY_LIMITS.predicateNodes}.`,
    });
  }
});

export const AfterWriteSchema = z.object({
  receipt: z.string().min(1),
  require: z.array(z.string().min(1)).min(1),
  timeoutMs: NonnegativeSafeIntegerSchema,
}).strict();

const OrderSchema = z.object({
  by: ReferenceSchema,
  dir: z.enum(['asc', 'desc']),
}).strict();

const QueryBaseShape = {
  version: z.literal('0'),
  from: ReferenceSchema,
  where: WhereExpressionSchema.optional(),
  afterWrite: AfterWriteSchema.optional(),
};

export const RecordsQuerySchema = z.object({
  ...QueryBaseShape,
  mode: z.literal('records'),
  select: z.array(ReferenceSchema).min(1).max(QUERY_LIMITS.select),
  order: z.array(OrderSchema).min(1),
  take: z.number().int().safe().positive().max(QUERY_LIMITS.take.records).transform(
    (value) => SafeIntegerSchema.parse(value),
  ),
}).strict();

const FieldDimensionSchema = z.object({
  kind: z.literal('field'),
  field: ReferenceSchema,
  id: OutputIdSchema,
}).strict();

const TimeDimensionSchema = z.object({
  kind: z.literal('timeBucket'),
  field: ReferenceSchema,
  grain: CalendarUnitSchema,
  timezone: z.string().min(1),
  id: OutputIdSchema,
}).strict();

const AggregateFilterShape = {
  filter: WhereExpressionSchema.optional(),
};

const CountAggregateSchema = z.object({
  op: z.literal('count'),
  ...AggregateFilterShape,
}).strict();

const FieldAggregateSchema = z.object({
  op: z.enum(['countDistinct', 'sum', 'avg', 'min', 'max']),
  field: ReferenceSchema,
  ...AggregateFilterShape,
}).strict();

const NamedAggregateMetricSchema = z.union([
  CountAggregateSchema.extend({ id: OutputIdSchema }),
  FieldAggregateSchema.extend({ id: OutputIdSchema }),
]);

const RatioMetricSchema = z.object({
  op: z.literal('ratio'),
  numerator: ReferenceSchema,
  denominator: ReferenceSchema,
  id: OutputIdSchema,
}).strict();

export const AggregateQuerySchema = z.object({
  ...QueryBaseShape,
  mode: z.literal('aggregate'),
  dimensions: z.array(z.discriminatedUnion('kind', [
    FieldDimensionSchema,
    TimeDimensionSchema,
  ])),
  metrics: z.array(z.union([NamedAggregateMetricSchema, RatioMetricSchema])).min(1),
  having: z.preprocess((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    if (typeof source.metric !== 'string' || source.field !== undefined) return value;
    const { metric, ...remaining } = source;
    return { ...remaining, field: metric };
  }, WhereExpressionSchema).optional(),
  order: z.array(OrderSchema).min(1),
  take: z.number().int().safe().positive().max(QUERY_LIMITS.take.aggregate).transform(
    (value) => SafeIntegerSchema.parse(value),
  ),
}).strict();

const SemanticSearchCoreShape = {
  using: ReferenceSchema,
  text: NormalizedTextSchema.pipe(z.string().min(1)),
  accuracy: z.enum(['exact', 'approximate']),
};

const SemanticSearchSchema = z.object({
  kind: z.literal('semantic'),
  ...SemanticSearchCoreShape,
  quality: ReferenceSchema,
}).strict();

const HybridSearchSchema = z.object({
  kind: z.literal('hybrid'),
  semantic: z.object({
    using: ReferenceSchema,
    text: NormalizedTextSchema.pipe(z.string().min(1)),
    accuracy: z.literal('approximate'),
  }).strict(),
  lexical: z.object({
    field: ReferenceSchema,
    text: NormalizedTextSchema.pipe(z.string().min(1)),
  }).strict(),
  fusion: z.literal('rrf-v0'),
  quality: ReferenceSchema,
}).strict();

export const RetrieveQuerySchema = z.object({
  ...QueryBaseShape,
  mode: z.literal('retrieve'),
  search: z.discriminatedUnion('kind', [SemanticSearchSchema, HybridSearchSchema]),
  select: z.array(ReferenceSchema).min(1).max(QUERY_LIMITS.select),
  take: z.number().int().safe().positive().max(QUERY_LIMITS.take.retrieve).transform(
    (value) => SafeIntegerSchema.parse(value),
  ),
}).strict();

export const QueryDocumentSchema = z.discriminatedUnion('mode', [
  RecordsQuerySchema,
  AggregateQuerySchema,
  RetrieveQuerySchema,
]);

export type QueryDocument = z.infer<typeof QueryDocumentSchema>;
export type RecordsQuery = z.infer<typeof RecordsQuerySchema>;
export type AggregateQuery = z.infer<typeof AggregateQuerySchema>;
export type RetrieveQuery = z.infer<typeof RetrieveQuerySchema>;
