import type {
  AggregateLogicalPlan,
  CanonicalIngestPlan,
  LogicalPlanForProfile,
  ResolvedFieldBinding,
  ResolvedProjection,
} from '@agql/contracts';
import type { SafeInteger } from '@agql/schemas';

export interface SqliteTextCollation {
  readonly id: string;
  readonly version: string;
}

export interface SqliteAdapterOptions {
  /** Path to a SQLite database. Query executions always reopen this path read-only. */
  readonly databasePath: string;
  /** Exact semantic retrieval is refused when its eligible set exceeds this bound. */
  readonly exactScanAdmissionLimit: SafeInteger;
  /** Every text comparison, grouping, or ordering must use one of these declared collations. */
  readonly supportedTextCollations: readonly SqliteTextCollation[];
  /** Stable public adapter identity included in its capability descriptor. */
  readonly id: string;
  readonly version: string;
}

export interface CompiledRecordsQuery {
  readonly kind: 'records';
  readonly plan: LogicalPlanForProfile<'records.v0'>;
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
  readonly projection: readonly ResolvedProjection[];
}

export interface CompiledAggregateQuery {
  readonly kind: 'aggregate';
  readonly plan: AggregateLogicalPlan;
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
  readonly fields: readonly ResolvedFieldBinding[];
}

export interface CompiledSemanticQuery {
  readonly kind: 'semantic';
  readonly plan: LogicalPlanForProfile<'retrieve.semantic.v0'>;
  readonly countSql: string;
  readonly countParameters: readonly SqliteParameter[];
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
  readonly projection: readonly ResolvedProjection[];
  readonly exactAdmissionLimit: SafeInteger;
}

export interface CompiledCanonicalIngest {
  readonly kind: 'ingest';
  readonly plan: CanonicalIngestPlan;
}

export type SqliteQueryCompiled =
  | CompiledRecordsQuery
  | CompiledAggregateQuery
  | CompiledSemanticQuery;

export type SqliteParameter = string | number | bigint | Uint8Array | null;
