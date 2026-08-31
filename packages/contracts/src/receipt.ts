import type { AgqlError, SafeInteger } from '@agql/schemas';

declare const writeReceiptIdBrand: unique symbol;
declare const visibilityTokenBrand: unique symbol;

export type WriteReceiptId = string & { readonly [writeReceiptIdBrand]: true };

/** Opaque runtime token. Its public type has no backend-native identifier component. */
export type VisibilityToken = string & { readonly [visibilityTokenBrand]: true };

export type VisibilityState =
  | { readonly state: 'accepted' }
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly token: VisibilityToken }
  | {
    readonly state: 'failed';
    readonly code: string;
    readonly message: string;
  }
  | { readonly state: 'superseded' };

export interface RecordWriteReceipt {
  readonly id: string;
  readonly version: SafeInteger;
  readonly visibility: Readonly<Record<string, VisibilityState>>;
}

/**
 * RFC §7 exact batch shape. Visibility keys name `record`, `lexical`, and every derived
 * representation such as `embedding:memory_text@3`. Permitted monotonic transitions are
 * accepted → pending/ready/failed/superseded, pending → ready/failed/superseded, and
 * ready/failed → superseded; no reverse transition exists.
 */
export interface WriteReceipt {
  readonly receipt: WriteReceiptId;
  readonly records: readonly RecordWriteReceipt[];
}

export type VisibilityTransition =
  | {
    readonly from: 'accepted';
    readonly to: 'pending' | 'ready' | 'failed' | 'superseded';
  }
  | { readonly from: 'pending'; readonly to: 'ready' | 'failed' | 'superseded' }
  | { readonly from: 'ready' | 'failed'; readonly to: 'superseded' };

export interface AcceptedIngestRecordOutcome {
  readonly id: string;
  readonly status: 'accepted';
  readonly version: SafeInteger;
  readonly error: null;
}

export interface RefusedIngestRecordOutcome {
  readonly id: string;
  readonly status: 'refused';
  readonly version: null;
  readonly error: AgqlError;
}

/** RFC §7 preserves one ordered outcome per input record alongside one batch receipt. */
export type IngestRecordOutcome = AcceptedIngestRecordOutcome | RefusedIngestRecordOutcome;

export interface IngestResult {
  readonly outcomes: readonly [IngestRecordOutcome, ...IngestRecordOutcome[]];
  readonly writeReceipt: WriteReceipt;
}
