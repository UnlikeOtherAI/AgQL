import type {
  CanonicalDecimal,
  CapabilityProfile,
  CurrencyCode,
  DateValue,
  EffectivePlanHash,
  InstantValue,
  MoneyValue,
  NormalizedText,
  SafeInteger,
  SourceQueryHash,
} from '@agql/schemas';

import type { CalendarGrain } from './result.ts';

declare const physicalIdentifierBrand: unique symbol;
declare const queryVectorDigestBrand: unique symbol;

/** Catalog-origin physical name. No model-produced string is assignable to this type. */
export type CatalogPhysicalIdentifier = string & {
  readonly [physicalIdentifierBrand]: true;
};

export type QueryVectorDigest = string & { readonly [queryVectorDigestBrand]: true };

/** RFC §2 scalar after catalog-directed type resolution. */
export type TypedValue =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'integer'; readonly value: SafeInteger }
  | { readonly kind: 'decimal'; readonly value: CanonicalDecimal }
  | { readonly kind: 'money'; readonly value: MoneyValue }
  | { readonly kind: 'text'; readonly value: NormalizedText }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'date'; readonly value: DateValue }
  | { readonly kind: 'instant'; readonly value: InstantValue }
  | { readonly kind: 'null'; readonly value: null };

export interface ResolvedDatasetBinding {
  readonly logicalId: string;
  readonly physical: CatalogPhysicalIdentifier;
  readonly bindingVersion: string;
}

export interface ResolvedFieldBinding {
  readonly logicalId: string;
  readonly physical: CatalogPhysicalIdentifier;
  readonly type: ResolvedValueType;
  readonly nullable: boolean;
}

export type ResolvedValueType =
  | { readonly kind: 'id' | 'boolean' | 'integer' | 'decimal' | 'date' | 'null' }
  | { readonly kind: 'money'; readonly currency: CurrencyCode }
  | {
    readonly kind: 'text';
    readonly collation: { readonly id: string; readonly version: string };
  }
  | { readonly kind: 'enum'; readonly codes: readonly string[] }
  | {
    readonly kind: 'instant';
    readonly precision: 'second' | 'millisecond' | 'microsecond' | 'nanosecond';
  };

/** Model-authored output ids resolve to positional slots and are never native identifiers. */
export interface ResolvedOutputBinding {
  readonly logicalId: string;
  readonly slot: SafeInteger;
}

export interface ResolvedProjection {
  readonly output: ResolvedOutputBinding;
  readonly field: ResolvedFieldBinding;
}

export type ComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

export type ResolvedPredicate =
  | {
    readonly kind: 'comparison';
    readonly field: ResolvedFieldBinding;
    readonly op: ComparisonOperator;
    readonly value: TypedValue;
  }
  | {
    readonly kind: 'list';
    readonly field: ResolvedFieldBinding;
    readonly op: 'in' | 'notIn';
    readonly values: readonly TypedValue[];
  }
  | {
    readonly kind: 'null';
    readonly field: ResolvedFieldBinding;
    readonly op: 'isNull' | 'isNotNull';
  }
  | {
    readonly kind: 'substring';
    readonly field: ResolvedFieldBinding;
    readonly op: 'contains' | 'startsWith';
    readonly value: NormalizedText;
    readonly semantics: 'escaped-case-sensitive-substring';
  }
  | {
    readonly kind: 'instantRange';
    readonly field: ResolvedFieldBinding;
    readonly startInclusive: InstantValue;
    readonly endExclusive: InstantValue;
    readonly anchor: InstantValue;
  };

export type LogicalFilter<P> =
  | P
  | { readonly kind: 'and'; readonly items: readonly [LogicalFilter<P>, ...LogicalFilter<P>[]] }
  | { readonly kind: 'or'; readonly items: readonly [LogicalFilter<P>, ...LogicalFilter<P>[]] }
  | { readonly kind: 'not'; readonly item: LogicalFilter<P> };

export type ExpandedScope =
  | { readonly visibility: 'nothing' }
  | {
    readonly visibility: 'predicate';
    readonly enforcement: 'mandatoryPushdown';
    readonly predicates: readonly [ResolvedPredicate, ...ResolvedPredicate[]];
  };

export interface ResolvedOrder {
  readonly field: ResolvedFieldBinding;
  readonly direction: 'asc' | 'desc';
}

export type StableTieBreak =
  | { readonly kind: 'recordId'; readonly order: ResolvedOrder }
  | {
    readonly kind: 'dimensionTuple';
    readonly fields: readonly [ResolvedFieldBinding, ...ResolvedFieldBinding[]];
  }
  | { readonly kind: 'singleAggregateRow' };

interface LogicalPlanBase {
  readonly languageVersion: '0';
  readonly sourceQueryHash: SourceQueryHash;
  readonly effectivePlanHash: EffectivePlanHash;
  readonly dataset: ResolvedDatasetBinding;
  readonly scope: ExpandedScope;
  readonly filter?: LogicalFilter<ResolvedPredicate>;
  readonly hardRowLimit: SafeInteger;
  readonly take: SafeInteger;
}

export interface RecordsLogicalPlan extends LogicalPlanBase {
  readonly mode: 'records';
  readonly profile: Extract<CapabilityProfile, 'records.v0'>;
  readonly projection: readonly [ResolvedProjection, ...ResolvedProjection[]];
  readonly order: readonly [ResolvedOrder, ...ResolvedOrder[]];
  readonly tieBreak: Extract<StableTieBreak, { readonly kind: 'recordId' }>;
}

export type ResolvedDimension =
  | {
    readonly kind: 'field';
    readonly output: ResolvedOutputBinding;
    readonly field: ResolvedFieldBinding;
  }
  | {
    readonly kind: 'calendarPeriod';
    readonly output: ResolvedOutputBinding;
    readonly field: ResolvedFieldBinding;
    readonly grain: CalendarGrain;
    readonly timezone: string;
    readonly weekStart: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday'
      | 'saturday' | 'sunday';
    readonly fiscalDayStart: string;
    readonly resultKind: 'calendarPeriod';
  };

export type ResolvedAggregateExpression =
  | {
    readonly op: 'count';
    readonly filter?: LogicalFilter<ResolvedPredicate>;
  }
  | {
    readonly op: 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
    readonly field: ResolvedFieldBinding;
    readonly filter?: LogicalFilter<ResolvedPredicate>;
  };

export type ResolvedMetric =
  | {
    readonly kind: 'aggregate';
    readonly output: ResolvedOutputBinding;
    readonly aggregate: ResolvedAggregateExpression;
  }
  | {
    readonly kind: 'ratio';
    readonly output: ResolvedOutputBinding;
    readonly numerator: ResolvedAggregateExpression;
    readonly denominator: ResolvedAggregateExpression;
    readonly divideByZero: 'null';
  };

export interface ResolvedOutputPredicate {
  readonly output: ResolvedOutputBinding;
  readonly op: ComparisonOperator | 'isNull' | 'isNotNull';
  readonly value?: TypedValue;
}

export interface ResolvedOutputOrder {
  readonly output: ResolvedOutputBinding;
  readonly direction: 'asc' | 'desc';
}

export interface AggregateLogicalPlan extends LogicalPlanBase {
  readonly mode: 'aggregate';
  readonly profile: Extract<CapabilityProfile, 'aggregate.v0'>;
  readonly dimensions: readonly ResolvedDimension[];
  readonly metrics: readonly [ResolvedMetric, ...ResolvedMetric[]];
  readonly having?: LogicalFilter<ResolvedOutputPredicate>;
  readonly order: readonly [ResolvedOutputOrder, ...ResolvedOutputOrder[]];
  readonly tieBreak: Extract<
    StableTieBreak,
    { readonly kind: 'dimensionTuple' | 'singleAggregateRow' }
  >;
}

export interface ResolvedEmbeddingBinding {
  readonly name: string;
  readonly specReference: string;
  readonly specVersion: string;
  readonly physical: CatalogPhysicalIdentifier;
  readonly dimension: SafeInteger;
  readonly metric: 'cosine' | 'dot' | 'euclidean';
  readonly vectorEncoding: 'float32' | 'float64' | 'int8' | 'binary';
  readonly model: { readonly id: string; readonly revision: string };
  readonly inputTransformId: string;
  readonly privacyClass: string;
}

/** Runtime-produced bytes; adapters index/search this vector and never generate it. */
export interface RuntimeOwnedVector {
  readonly bytes: Uint8Array;
  readonly encoding: ResolvedEmbeddingBinding['vectorEncoding'];
  readonly dimension: SafeInteger;
  readonly digest: QueryVectorDigest;
}

export type ResolvedRetrievalSearch =
  | {
    readonly kind: 'semantic';
    readonly embedding: ResolvedEmbeddingBinding;
    readonly vector: RuntimeOwnedVector;
    readonly accuracy: 'exact' | 'approximate';
    readonly qualityProfile: string;
    readonly hardCandidateLimit: SafeInteger;
  }
  | {
    readonly kind: 'hybrid';
    readonly embedding: ResolvedEmbeddingBinding;
    readonly vector: RuntimeOwnedVector;
    readonly accuracy: 'approximate';
    readonly lexical: {
      readonly field: ResolvedFieldBinding;
      readonly text: NormalizedText;
      readonly semantics: 'escaped-case-sensitive-substring';
    };
    readonly fusion: 'rrf-v0';
    readonly qualityProfile: string;
    readonly hardCandidateLimit: SafeInteger;
  };

interface RetrieveLogicalPlanBase extends LogicalPlanBase {
  readonly mode: 'retrieve';
  readonly projection: readonly [ResolvedProjection, ...ResolvedProjection[]];
  readonly stableId: ResolvedFieldBinding;
}

export interface SemanticRetrieveLogicalPlan extends RetrieveLogicalPlanBase {
  readonly profile: Extract<CapabilityProfile, 'retrieve.semantic.v0'>;
  readonly search: Extract<ResolvedRetrievalSearch, { readonly kind: 'semantic' }>;
}

export interface HybridRetrieveLogicalPlan extends RetrieveLogicalPlanBase {
  readonly profile: Extract<CapabilityProfile, 'retrieve.hybrid.v0'>;
  readonly search: Extract<ResolvedRetrievalSearch, { readonly kind: 'hybrid' }>;
}

export type RetrieveLogicalPlan =
  | SemanticRetrieveLogicalPlan
  | HybridRetrieveLogicalPlan;

/**
 * RFC §9 engine/adapter boundary. It is resolved, typed and scope-expanded: no model AST,
 * unresolved name, relative time, default, policy decision or model-authored physical name
 * can cross this boundary. Adapters MUST push down `scope` before content leaves trust.
 */
export type LogicalPlan =
  | RecordsLogicalPlan
  | AggregateLogicalPlan
  | SemanticRetrieveLogicalPlan
  | HybridRetrieveLogicalPlan;

export type LogicalPlanForProfile<P extends CapabilityProfile> = LogicalPlan extends infer Plan
  ? Plan extends { readonly profile: P }
    ? Plan
    : never
  : never;
