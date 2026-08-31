import type { PolicyChannel, Scope } from '@agql/catalog';
import type {
  AdapterDescriptor,
  AdapterExecutionResult,
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  LogicalPlan,
  ResultEnvelope,
  FreshnessDeclaration,
  ResultSchemaField,
  RuntimeOwnedVector,
  VisibilityObservation,
  WriteReceipt,
} from '@agql/contracts';
import type {
  AgqlError,
  CatalogDocument,
  CapabilityProfile,
  InstantValue,
  SafeInteger,
  ScopeFingerprint,
} from '@agql/schemas';

export type EngineError = AgqlError & {
  readonly remedy?: string | {
    readonly action: 'retryAfterWrite';
    readonly details: {
      readonly receipt: string;
      readonly require: readonly [string, ...string[]];
    };
  } | {
    readonly action: 'narrowEligibleSetOrRequestApproximate';
    readonly details: {
      readonly limit: SafeInteger;
      readonly eligibleCount: SafeInteger;
      readonly alternatives: readonly [string, ...string[]];
    };
  };
};

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly [EngineError, ...EngineError[]] };

export interface DeploymentLimits {
  readonly booleanNesting: SafeInteger;
  readonly inList: SafeInteger;
  readonly predicateNodes: SafeInteger;
  readonly select: SafeInteger;
  readonly take: {
    readonly aggregate: SafeInteger;
    readonly records: SafeInteger;
    readonly retrieve: SafeInteger;
  };
}

export interface EngineEmbeddingBinding {
  readonly physical: CatalogPhysicalIdentifier;
  readonly indexed: boolean;
}

export interface EngineDatasetBinding {
  readonly physical: CatalogPhysicalIdentifier;
  readonly fields: Readonly<Record<string, CatalogPhysicalIdentifier>>;
  readonly embeddings: Readonly<Record<string, EngineEmbeddingBinding>>;
}

/** Trusted deployment bindings are the sole source of physical identifiers. */
export interface EngineBinding {
  readonly version: string;
  readonly datasets: Readonly<Record<string, EngineDatasetBinding>>;
}

export interface QueryCostEstimate {
  readonly estimatedRows: SafeInteger;
  readonly estimatedCandidateRecords: SafeInteger;
  readonly estimatedIntermediateBytes: SafeInteger;
  readonly selectiveFilterFields: readonly string[];
}

export interface QueryCostGate {
  readonly estimate: QueryCostEstimate;
  readonly maximumEstimatedRows: SafeInteger;
  readonly maximumIntermediateBytes: SafeInteger;
}

export interface QualityCertification {
  readonly profile: string;
  readonly reference: string;
  readonly embeddingSpec: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
}

export interface CalendarPolicy {
  readonly timezone: string;
  readonly timezoneDatabase: '2024a' | 'fixed-offset';
  readonly weekStart: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday'
    | 'saturday' | 'sunday';
  readonly fiscalDayStart: string;
}

export interface CompileQueryInput {
  readonly query: unknown;
  readonly catalog: CatalogDocument;
  readonly scope: Scope;
  readonly anchor: InstantValue;
  readonly channel: PolicyChannel;
  readonly limits: DeploymentLimits;
  readonly calendar: CalendarPolicy;
  readonly binding: EngineBinding;
  readonly adapter: AdapterDescriptor<readonly CapabilityProfile[]>;
  readonly costGate: QueryCostGate;
  readonly qualityCertifications: readonly QualityCertification[];
  readonly vector?: RuntimeOwnedVector;
}

export interface CompileIngestInput {
  readonly document: unknown;
  readonly catalog: CatalogDocument;
  readonly scope: Scope;
  readonly anchor: InstantValue;
  readonly binding: EngineBinding;
  readonly adapter: AdapterDescriptor<readonly CapabilityProfile[]>;
}

export interface CompileIngestOutput {
  readonly plan: CanonicalIngestPlan;
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly bindingVersion: string;
}

export type CompensationOperation =
  | 'finalProjectionAndRedaction'
  | 'canonicalScalarConversion'
  | 'stableTieOrdering'
  | 'rrf-v0'
  | 'exactDistanceNormalization';

export interface QueryExplain {
  readonly profile: CapabilityProfile;
  readonly cost: QueryCostEstimate & {
    readonly verdict: 'admitted';
    readonly maximumEstimatedRows: SafeInteger;
    readonly maximumIntermediateBytes: SafeInteger;
  };
  readonly resultShape: readonly ResultSchemaField[];
  readonly pushdown: readonly (
    'scope' | 'filter' | 'order' | 'limit' | 'aggregate' | 'retrieval'
  )[];
  readonly compensation: readonly CompensationOperation[];
  readonly determinism:
    | { readonly query: 'exact' }
    | { readonly retrieval: 'approximate' };
}

export interface CompileOutput {
  readonly plan: LogicalPlan;
  readonly explain: QueryExplain;
  readonly sourceCanonical: string;
  readonly scopeFingerprint: ScopeFingerprint;
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly bindingVersion: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly anchor: InstantValue;
  readonly channel: PolicyChannel;
  readonly afterWrite?: VisibilityObservation;
  readonly qualityCertification?: QualityCertification;
}

/** Release controls are inference dampeners, not privacy theorems. */
export interface MinimumCohortReleasePolicy {
  readonly kind: 'minimumCohort';
  readonly channel: PolicyChannel;
  readonly minimum: SafeInteger;
}

export interface ReleasePolicyInput {
  readonly policies: readonly MinimumCohortReleasePolicy[];
  readonly previewRowLimit: SafeInteger;
  readonly channelPolicyFingerprint: string;
}

export interface ComponentTimings {
  readonly authMs: SafeInteger;
  readonly validationPolicyMs: SafeInteger;
  readonly queryEmbeddingMs: SafeInteger;
  readonly adapterCompileMs: SafeInteger;
  readonly backendMs: SafeInteger;
  readonly fusionReleaseMs: SafeInteger;
}

export interface ResultAssemblyInput {
  readonly compiled: CompileOutput;
  readonly execution: AdapterExecutionResult;
  readonly engineVersion: string;
  readonly adapterVersion: string;
  readonly release: ReleasePolicyInput;
  readonly replayTier: 'auditable' | 'reevaluable' | 'exactReplay';
  readonly principalResultAvailable: boolean;
  readonly timings: ComponentTimings;
  readonly executionSnapshotTier: FreshnessDeclaration['executionSnapshot']['kind'];
  readonly observedReceipt?: WriteReceipt;
  readonly cohortCounts?: readonly SafeInteger[];
}

export interface QueryExecutionOutput {
  readonly result: ResultEnvelope;
  readonly timings: ComponentTimings;
}
