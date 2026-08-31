import type {
  AdapterContract,
  CanonicalIngestPlan,
  CatalogPhysicalIdentifier,
  ResolvedDatasetBinding,
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
  ResolvedValueType,
  RetrievalIndexMutation,
  RetrievalIndexOperations,
} from '@agql/contracts';
import type { SafeInteger } from '@agql/schemas';
import type { Pool } from 'pg';

export const POSTGRES_PROFILES = [
  'records.v0',
  'aggregate.v0',
  'retrieve.semantic.v0',
  'retrieve.hybrid.v0',
  'ingest.canonical.v0',
] as const;

export type PostgresProfile = (typeof POSTGRES_PROFILES)[number];
export type VectorByteOrder = 'littleEndian' | 'bigEndian';
export type CertifiedPredicateKind =
  | 'comparison'
  | 'list'
  | 'null'
  | 'substring'
  | 'instantRange';

export interface PostgresCollationBinding {
  readonly id: string;
  readonly version: string;
  readonly databaseVersion: string | null;
  readonly schema?: CatalogPhysicalIdentifier;
  readonly name: CatalogPhysicalIdentifier;
}

export interface PostgresEmbeddingBinding {
  readonly embedding: ResolvedEmbeddingBinding;
  readonly visibilityName: string;
  readonly annIndex: CatalogPhysicalIdentifier;
}

export interface PostgresDatasetBinding {
  readonly dataset: ResolvedDatasetBinding;
  readonly idField: ResolvedFieldBinding;
  readonly fields: readonly ResolvedFieldBinding[];
  readonly lexicalFields: readonly CatalogPhysicalIdentifier[];
  readonly embeddings: readonly PostgresEmbeddingBinding[];
}

export interface PostgresQualityProfile {
  readonly id: string;
  readonly certificationReference: string;
  readonly efSearch: SafeInteger;
  readonly maxScanTuples: SafeInteger;
  readonly maximumBooleanDepth: SafeInteger;
  readonly certifiedPredicates: readonly CertifiedPredicateKind[];
}

export interface PostgresAdapterConfig {
  readonly queryPool: Pool;
  readonly writerPool: Pool;
  readonly namespace: CatalogPhysicalIdentifier;
  readonly queryRole: string;
  readonly writerRole: string;
  readonly statementTimeoutMs: SafeInteger;
  readonly exactScanAdmissionLimit: SafeInteger;
  readonly tokenSecret: Uint8Array;
  readonly vectorByteOrder: VectorByteOrder;
  readonly codeCollation: PostgresCollationBinding;
  readonly collations: readonly PostgresCollationBinding[];
  readonly datasets: readonly PostgresDatasetBinding[];
  readonly qualityProfiles: readonly PostgresQualityProfile[];
}

export type PgParameter = string | number | boolean | null;

export interface SqlStatement {
  readonly text: string;
  readonly values: readonly PgParameter[];
}

export type OutputCodec =
  | ResolvedValueType
  | { readonly kind: 'rank' }
  | { readonly kind: 'aggregateInteger' }
  | { readonly kind: 'aggregateDecimal' };

export interface CompiledPostgresQuery {
  readonly operation: 'query';
  readonly dataset: PostgresDatasetBinding;
  readonly statement: SqlStatement;
  readonly admissionStatement?: SqlStatement;
  readonly exactAdmissionLimit?: SafeInteger;
  readonly settings: readonly (readonly [string, string])[];
  readonly outputCodecs: readonly OutputCodec[];
  readonly outputSlots: readonly SafeInteger[];
  readonly rankColumn?: SafeInteger;
  readonly totalColumn: SafeInteger;
  readonly take: SafeInteger;
}

export interface CompiledPostgresIngest {
  readonly operation: 'canonicalIngest';
  readonly plan: CanonicalIngestPlan;
  readonly dataset: PostgresDatasetBinding;
  readonly operationDigest: string;
}

export interface CompiledPostgresEmbeddingMutation {
  readonly operation: 'embeddingMutation';
  readonly dataset: PostgresDatasetBinding;
  readonly embedding: PostgresEmbeddingBinding;
  readonly mutation: RetrievalIndexMutation;
  readonly operationDigest: string;
}

export type PostgresAdapter = AdapterContract<
  typeof POSTGRES_PROFILES,
  CompiledPostgresQuery,
  CompiledPostgresIngest
> & {
  /** Runtime-only embedding worker path; deliberately absent from agent-facing profiles. */
  readonly embeddingWrites: RetrievalIndexOperations<CompiledPostgresEmbeddingMutation>;
};

export interface PostgresDatasetSchema {
  readonly binding: PostgresDatasetBinding;
}

export interface PostgresProvisionerConfig {
  readonly pool: Pool;
  readonly namespace: CatalogPhysicalIdentifier;
  readonly provisionerRole: string;
  readonly queryRole: string;
  readonly writerRole: string;
  readonly codeCollation: PostgresCollationBinding;
  readonly collations: readonly PostgresCollationBinding[];
}

export type ProvisioningOutcome =
  | { readonly kind: 'success' }
  | {
    readonly kind: 'refusal';
    readonly code:
      | 'INVALID_SCHEMA'
      | 'ROLE_SEPARATION_REQUIRED'
      | 'PGVECTOR_UNAVAILABLE'
      | 'PROVISIONING_FAILED';
    readonly message: string;
    readonly remedy: string;
  };
