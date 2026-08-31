import type { ModelDatasetDocumentation, Scope } from '@agql/catalog';
import type {
  DeterminismDeclaration,
  ResultEnvelope,
  ResultSchemaField,
  WriteReceipt,
} from '@agql/contracts';
import type {
  AgqlError,
  EffectivePlanHash,
  IngestDocument,
  InstantValue,
  QueryDocument,
  SourceQueryHash,
} from '@agql/schemas';

export interface AgentRequestContext {
  readonly credentialKind: 'agent';
  readonly scope: Scope;
  readonly requestAnchor: InstantValue;
  readonly authMs: number;
}

export interface RuntimeTimings {
  readonly validationPolicyMs: number;
  readonly queryEmbeddingMs: number;
  readonly adapterCompileMs: number;
  readonly backendMs: number;
  readonly fusionReleaseMs: number;
}

export interface ComponentTimings extends RuntimeTimings {
  readonly authMs: number;
}

export type RuntimeOutcome<T> =
  | {
    readonly ok: true;
    readonly value: T;
    readonly timings: RuntimeTimings;
  }
  | {
    readonly ok: false;
    readonly errors: readonly [AgqlError, ...AgqlError[]];
    readonly timings: RuntimeTimings;
  };

export interface QueryOperationInput {
  readonly source: string;
  readonly query: QueryDocument;
}

export interface PutRecordsOperationInput {
  readonly source: string;
  readonly document: IngestDocument;
}

export interface ExplainQueryValue {
  readonly sourceQueryHash: SourceQueryHash;
  readonly effectivePlanHash: EffectivePlanHash;
  readonly resultSchema: readonly ResultSchemaField[];
  readonly determinism: DeterminismDeclaration;
  readonly projection: string;
  readonly pushdown: readonly string[];
  readonly compensation: readonly string[];
  readonly cost: {
    readonly verdict: 'ok';
    readonly estimatedRows?: number;
  };
  readonly notes: readonly string[];
}

export interface RunQueryValue {
  readonly envelope: ResultEnvelope;
  readonly executionReceipt: string;
}

export interface SavedQueryValue {
  readonly source: string;
  readonly name: string;
  readonly sourceQueryHash: SourceQueryHash;
  readonly effectivePlanHash: EffectivePlanHash;
}

export interface SaveQueryOperationInput extends QueryOperationInput {
  readonly name: string;
  readonly executionReceipt: string;
}

/** Engine-facing entry points. A deployment binds these to the pure engine and adapters. */
export interface QueryRuntime {
  explainQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<ExplainQueryValue>>;
  runQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<RunQueryValue>>;
  putRecords(
    context: AgentRequestContext,
    input: PutRecordsOperationInput,
  ): Promise<RuntimeOutcome<WriteReceipt>>;
}

export interface SavedQueryPort {
  saveQuery(
    context: AgentRequestContext,
    input: SaveQueryOperationInput,
  ): Promise<RuntimeOutcome<SavedQueryValue>>;
}

export interface CatalogSearchItem {
  readonly kind: 'dataset' | 'field' | 'embedding';
  readonly ref: string;
  readonly description: string;
  readonly operations: readonly string[];
}

export interface CatalogSearchValue {
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly matches: readonly CatalogSearchItem[];
}

export interface CatalogDescriptionValue {
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly datasets: readonly ModelDatasetDocumentation[];
}

export interface LookupValuesValue {
  readonly field: string;
  readonly values: readonly { readonly code: string; readonly label: string }[];
}

export interface RejectedPayload {
  readonly status: 'rejected';
  readonly errors: readonly [AgqlError, ...AgqlError[]];
  readonly timings: ComponentTimings;
}

export interface CatalogPayload<T> {
  readonly status: 'ok';
  readonly value: T;
  readonly timings: ComponentTimings;
}

export interface ExplainPayload extends ExplainQueryValue {
  readonly status: 'accepted';
  readonly timings: ComponentTimings;
}

export type RunPayload = ResultEnvelope & {
  readonly status: 'ok';
  readonly executionReceipt: string;
  readonly timings: ComponentTimings;
};

export interface PutRecordsPayload {
  readonly status: 'accepted';
  readonly writeReceipt: WriteReceipt;
  readonly timings: ComponentTimings;
}

export interface SaveQueryPayload {
  readonly status: 'accepted';
  readonly savedQuery: SavedQueryValue;
  readonly timings: ComponentTimings;
}

export type ToolPayload =
  | CatalogPayload<CatalogSearchValue | CatalogDescriptionValue | LookupValuesValue>
  | ExplainPayload
  | RunPayload
  | PutRecordsPayload
  | SaveQueryPayload
  | RejectedPayload;

export const EMPTY_RUNTIME_TIMINGS: RuntimeTimings = {
  validationPolicyMs: 0,
  queryEmbeddingMs: 0,
  adapterCompileMs: 0,
  backendMs: 0,
  fusionReleaseMs: 0,
};
