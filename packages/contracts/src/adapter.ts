import type {
  AgqlErrorBase,
  CapabilityProfile,
  InstantValue,
  SafeInteger,
  ScopeFingerprint,
} from '@agql/schemas';

import type {
  CatalogPhysicalIdentifier,
  ExpandedScope,
  LogicalPlanForProfile,
  ResolvedDatasetBinding,
  ResolvedFieldBinding,
  RuntimeOwnedVector,
  TypedValue,
} from './logical-plan.ts';
import type { IngestResult, WriteReceipt } from './receipt.ts';
import type { CalendarPeriodValue } from './result.ts';

/**
 * Values an adapter may return after executing a resolved plan. This deliberately widens
 * query-bound `TypedValue`: calendar periods are result-only values, never predicate or
 * ingest scalars.
 */
export type AdapterResultValue =
  | TypedValue
  | { readonly kind: 'calendarPeriod'; readonly value: CalendarPeriodValue };

export type AdapterRefusalCode =
  | 'UNSUPPORTED_PROFILE'
  | 'SCOPE_UNENFORCEABLE'
  | 'EXACT_SCAN_BUDGET_EXCEEDED'
  | 'EXACT_SCAN_LIMIT_EXCEEDED'
  | 'MONEY_CURRENCY_MIXED'
  | 'FRESHNESS_UNAVAILABLE'
  | 'EMBEDDING_NOT_INDEXED'
  | 'FILTER_SHAPE_UNCERTIFIED'
  | 'COST_GATE_REFUSAL'
  | 'AFTER_WRITE_TIMEOUT';

export interface ExactScanLimitRemedy {
  readonly action: 'narrowEligibleSetOrRequestApproximate';
  readonly details: {
    readonly limit: SafeInteger;
    readonly eligibleCount: SafeInteger;
    readonly alternatives: readonly [string, ...string[]];
  };
}

export type AdapterStandardRemedy = string | ExactScanLimitRemedy;

export type AdapterRefusal =
  | (AgqlErrorBase<Exclude<AdapterRefusalCode, 'AFTER_WRITE_TIMEOUT'>> & {
    readonly remedy?: AdapterStandardRemedy;
  })
  | {
    readonly code: 'AFTER_WRITE_TIMEOUT';
    readonly message: string;
    readonly path: '/afterWrite';
    readonly alternatives: readonly ['Retry with the same receipt and requirements.'];
    readonly remedy: {
      readonly action: 'retryAfterWrite';
      readonly details: {
        readonly receipt: string;
        readonly require: readonly [string, ...string[]];
      };
    };
  };

export type AdapterOutcome<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'refusal'; readonly refusal: AdapterRefusal };

export interface AdapterConsistencyCapabilities {
  readonly afterWrite: 'unsupported' | 'certified';
  readonly snapshots: readonly ('none' | 'request' | 'transaction' | 'historicalPinned')[];
  readonly compareAndSwap: boolean;
}

export interface AdapterDescriptor<P extends readonly CapabilityProfile[]> {
  readonly id: string;
  readonly version: string;
  readonly profiles: P;
  readonly consistency: AdapterConsistencyCapabilities;
}

/** Positional values keyed by resolved output slots; model-authored ids stay engine-side. */
export type AdapterRow = readonly AdapterResultValue[];

export interface AdapterExecutionResult {
  readonly rows: readonly AdapterRow[];
  readonly truncated: boolean;
  readonly snapshot:
    | { readonly kind: 'none' }
    | { readonly kind: 'snapshot'; readonly value: string }
    | { readonly kind: 'watermark'; readonly value: string };
  readonly ranks?: readonly SafeInteger[];
}

/** Adapter-chosen compiled type remains private to that adapter implementation. */
type QueryCapabilityProfile = Extract<
  CapabilityProfile,
  'records.v0' | 'aggregate.v0' | 'retrieve.semantic.v0' | 'retrieve.hybrid.v0'
>;

export interface QueryAdapterOperations<
  Compiled,
  P extends QueryCapabilityProfile = QueryCapabilityProfile,
> {
  compile(plan: LogicalPlanForProfile<P>): Promise<AdapterOutcome<Compiled>>;
  execute(compiled: Compiled): Promise<AdapterOutcome<AdapterExecutionResult>>;
}

export interface CanonicalIngestOperations<CompiledWrite> {
  compile(plan: CanonicalIngestPlan): Promise<AdapterOutcome<CompiledWrite>>;
  execute(compiled: CompiledWrite): Promise<AdapterOutcome<IngestResult>>;
}

export interface ResolvedCanonicalFieldValue {
  readonly field: ResolvedFieldBinding;
  readonly value: TypedValue;
}

interface CanonicalIngestPlanBase {
  readonly dataset: ResolvedDatasetBinding;
  readonly idField: ResolvedFieldBinding;
  readonly scopeFingerprint: ScopeFingerprint;
  readonly scope: ExpandedScope;
  readonly idempotencyKey: string;
  readonly embeddingPolicy: 'catalog';
}

export type CanonicalIngestPlan =
  | (CanonicalIngestPlanBase & {
    readonly mode: 'insertOnly';
    readonly records: readonly [{
      readonly id: string;
      readonly values: readonly [ResolvedCanonicalFieldValue, ...ResolvedCanonicalFieldValue[]];
    }, ...{
      readonly id: string;
      readonly values: readonly [ResolvedCanonicalFieldValue, ...ResolvedCanonicalFieldValue[]];
    }[]];
  })
  | (CanonicalIngestPlanBase & {
    readonly mode: 'replace';
    readonly records: readonly [{
      readonly id: string;
      readonly ifVersion?: SafeInteger;
      readonly values: readonly [ResolvedCanonicalFieldValue, ...ResolvedCanonicalFieldValue[]];
    }, ...{
      readonly id: string;
      readonly ifVersion?: SafeInteger;
      readonly values: readonly [ResolvedCanonicalFieldValue, ...ResolvedCanonicalFieldValue[]];
    }[]];
  })
  | (CanonicalIngestPlanBase & {
    readonly mode: 'delete';
    readonly records: readonly [{
      readonly id: string;
      readonly ifVersion?: SafeInteger;
    }, ...{
      readonly id: string;
      readonly ifVersion?: SafeInteger;
    }[]];
  });

export type RetrievalIndexMutation =
  | {
    readonly kind: 'put';
    readonly recordId: string;
    readonly representation: CatalogPhysicalIdentifier;
    readonly vector: RuntimeOwnedVector;
    readonly sourceVersion: SafeInteger;
    readonly idempotencyKey: string;
  }
  | {
    readonly kind: 'delete';
    readonly recordId: string;
    readonly representation: CatalogPhysicalIdentifier;
    readonly sourceVersion: SafeInteger;
    readonly idempotencyKey: string;
  };

export interface RetrievalIndexOperations<CompiledIndexMutation> {
  compile(
    mutation: RetrievalIndexMutation,
  ): Promise<AdapterOutcome<CompiledIndexMutation>>;
  execute(compiled: CompiledIndexMutation): Promise<AdapterOutcome<WriteReceipt>>;
}

export interface VisibilityObservation {
  readonly receipt: string;
  readonly require: readonly [string, ...string[]];
  readonly timeoutMs: SafeInteger;
  readonly anchor: InstantValue;
  readonly scopeFingerprint: ScopeFingerprint;
  readonly scope: ExpandedScope;
  readonly dataset: ResolvedDatasetBinding;
  readonly idField: ResolvedFieldBinding;
}

export interface VisibilityOperations {
  observe(requirement: VisibilityObservation): Promise<AdapterOutcome<WriteReceipt>>;
}

/**
 * RFC §9 capability-honest adapter contract. Every operation family is optional, so a pure
 * retrieval index can advertise only retrieval profiles and omit records/canonical ingest.
 * The separated write interfaces keep mutation unreachable from the Query Core contract.
 */
type QueryFacet<P extends readonly CapabilityProfile[], Compiled> =
  Extract<P[number], QueryCapabilityProfile> extends never
    ? { readonly query?: never }
    : {
      readonly query: QueryAdapterOperations<
        Compiled,
        Extract<P[number], QueryCapabilityProfile>
      >;
    };

type IngestFacet<P extends readonly CapabilityProfile[], Compiled> =
  'ingest.canonical.v0' extends P[number]
    ? { readonly canonicalIngest: CanonicalIngestOperations<Compiled> }
    : { readonly canonicalIngest?: never };

type RetrievalIndexFacet<P extends readonly CapabilityProfile[], Compiled> =
  'retrieval-index.v0' extends P[number]
    ? { readonly retrievalIndex: RetrievalIndexOperations<Compiled> }
    : { readonly retrievalIndex?: never };

export type AdapterContract<
  P extends readonly CapabilityProfile[],
  QueryCompiled = never,
  IngestCompiled = never,
  IndexCompiled = never,
> = {
  readonly descriptor: AdapterDescriptor<P>;
  readonly visibility?: VisibilityOperations;
} & QueryFacet<P, QueryCompiled>
  & IngestFacet<P, IngestCompiled>
  & RetrievalIndexFacet<P, IndexCompiled>;
