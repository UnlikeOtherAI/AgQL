import type {
  CanonicalDecimal,
  CurrencyCode,
  DateValue,
  EffectivePlanHash,
  ExecutionFingerprint,
  InstantValue,
  ScopeFingerprint,
  SafeInteger,
  SourceQueryHash,
} from '@agql/schemas';

import type { QueryVectorDigest } from './logical-plan.ts';
import type { WriteReceiptId } from './receipt.ts';

declare const modelReleasedValueBrand: unique symbol;

export type CalendarGrain = 'day' | 'fiscalDay' | 'week' | 'month';

/** RFC §4.1 result-only half-open civil-time bucket. */
export interface CalendarPeriodValue {
  readonly start: InstantValue;
  readonly endExclusive: InstantValue;
  readonly timezone: string;
  readonly grain: CalendarGrain;
  readonly label: string;
}

export type ResultValue =
  | null
  | boolean
  | SafeInteger
  | string
  | CanonicalDecimal
  | { readonly amount: CanonicalDecimal; readonly currency: CurrencyCode }
  | DateValue
  | InstantValue
  | CalendarPeriodValue;

/**
 * Only the release-policy stage may construct a non-null model-channel value. Null carries
 * no principal data, so it remains the one directly inhabitable released value.
 */
export type ModelReleasedValue = null | (Exclude<ResultValue, null> & {
  readonly [modelReleasedValueBrand]: true;
});

export type ModelPreviewRow = Readonly<Record<string, ModelReleasedValue>>;

interface ResultSchemaFieldBase {
  readonly id: string;
  readonly nullable: boolean;
}

export type ResultSchemaField =
  | (ResultSchemaFieldBase & {
    readonly kind: 'id' | 'boolean' | 'integer' | 'decimal' | 'date' | 'null' | 'rank';
  })
  | (ResultSchemaFieldBase & { readonly kind: 'money'; readonly currency: CurrencyCode })
  | (ResultSchemaFieldBase & {
    readonly kind: 'text';
    readonly collation: { readonly id: string; readonly version: string };
  })
  | (ResultSchemaFieldBase & {
    readonly kind: 'enum';
    readonly values: readonly { readonly code: string; readonly label: string }[];
  })
  | (ResultSchemaFieldBase & {
    readonly kind: 'instant';
    readonly precision: 'second' | 'millisecond' | 'microsecond' | 'nanosecond';
  })
  | (ResultSchemaFieldBase & {
    readonly kind: 'calendarPeriod';
    readonly grain: CalendarGrain;
    readonly timezone: string;
  });

export type DeterminismDeclaration =
  | { readonly query: 'exact' }
  | { readonly retrieval: 'approximate' };

export interface FreshnessDeclaration {
  readonly writeVisibility:
    | { readonly kind: 'unconstrained' }
    | { readonly kind: 'afterWrite'; readonly receipt: WriteReceiptId };
  readonly executionSnapshot:
    | { readonly kind: 'none' }
    | { readonly kind: 'request'; readonly snapshot: string }
    | { readonly kind: 'transaction'; readonly snapshot: string }
    | { readonly kind: 'historicalPinned'; readonly snapshot: string };
}

export interface RetrievalProvenance {
  readonly embeddingSpec: string;
  readonly queryVectorDigest: QueryVectorDigest;
  readonly accuracy: 'exact' | 'approximate';
  readonly fusion?: 'rrf-v0';
  readonly qualityProfile: string;
  readonly qualityCertificationReference: string;
}

export interface ProvenanceEnvelope {
  readonly sourceQueryHash: SourceQueryHash;
  readonly effectivePlanHash: EffectivePlanHash;
  readonly executionFingerprint: ExecutionFingerprint;
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly bindingVersion: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
  readonly scopeFingerprint: ScopeFingerprint;
  readonly anchor: InstantValue;
  readonly retrieval?: RetrievalProvenance;
  readonly replayTier: 'auditable' | 'reevaluable' | 'exactReplay';
}

/**
 * RFC §8 model channel only. Principal rows have no property or generic slot in this type;
 * only a non-authoritative availability boolean may cross the model-channel boundary.
 */
interface ResultEnvelopeBase {
  readonly schema: readonly ResultSchemaField[];
  readonly preview: readonly ModelPreviewRow[];
  readonly truncated: boolean;
  readonly freshness: FreshnessDeclaration;
  readonly principalResultAvailable: boolean;
}

export type ResultEnvelope =
  | (ResultEnvelopeBase & {
    readonly determinism: { readonly query: 'exact' };
    readonly provenance: ProvenanceEnvelope;
  })
  | (ResultEnvelopeBase & {
    readonly determinism: { readonly retrieval: 'approximate' };
    readonly provenance: ProvenanceEnvelope & { readonly retrieval: RetrievalProvenance };
  });
