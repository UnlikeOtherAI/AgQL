import { createHash } from 'node:crypto';

import { canonicalizeJcs } from './jcs.ts';
import type { InstantValue } from './values.ts';

declare const sourceQueryHashBrand: unique symbol;
declare const effectivePlanHashBrand: unique symbol;
declare const executionFingerprintBrand: unique symbol;
declare const scopeFingerprintBrand: unique symbol;

export type SourceQueryHash = string & { readonly [sourceQueryHashBrand]: true };
export type EffectivePlanHash = string & { readonly [effectivePlanHashBrand]: true };
export type ExecutionFingerprint = string & { readonly [executionFingerprintBrand]: true };
export type ScopeFingerprint = string & { readonly [scopeFingerprintBrand]: true };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * RFC §3 source identity over a validated, default-materialized query.
 * Equal hashes are treated as identical canonical queries. This is deliberately one-way:
 * semantically equivalent queries are not normalized and therefore need not share a hash.
 */
export function sourceQueryHash(query: unknown): SourceQueryHash {
  return sha256(canonicalizeJcs(query)) as SourceQueryHash;
}

export interface EffectivePlanIdentityInput {
  readonly sourceQueryHash: SourceQueryHash;
  readonly languageVersion: string;
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly scopeFingerprint: ScopeFingerprint;
}

/** RFC §3 identity over the resolved logical-plan inputs. */
export function effectivePlanHash(input: EffectivePlanIdentityInput): EffectivePlanHash {
  return sha256(canonicalizeJcs({
    sourceQueryHash: input.sourceQueryHash,
    languageVersion: input.languageVersion,
    catalogVersion: input.catalogVersion,
    policyVersion: input.policyVersion,
    scopeFingerprint: input.scopeFingerprint,
  })) as EffectivePlanHash;
}

export type ExecutionSnapshotIdentity =
  | { readonly kind: 'none' }
  | { readonly kind: 'snapshot'; readonly value: string }
  | { readonly kind: 'watermark'; readonly value: string };

export interface ExecutionIdentityInput {
  readonly effectivePlanHash: EffectivePlanHash;
  readonly bindingVersion: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
  readonly anchor: InstantValue;
  readonly snapshot: ExecutionSnapshotIdentity;
  readonly embeddingSpec?: string;
  readonly qualityProfile?: string;
  readonly channelPolicy: string;
}

/** RFC §3 cache and audit identity for one fully bound execution. */
export function executionFingerprint(input: ExecutionIdentityInput): ExecutionFingerprint {
  return sha256(canonicalizeJcs({
    effectivePlanHash: input.effectivePlanHash,
    bindingVersion: input.bindingVersion,
    engineVersion: input.engineVersion,
    adapterVersion: input.adapterVersion,
    anchor: input.anchor,
    snapshot: input.snapshot,
    ...(input.embeddingSpec === undefined ? {} : { embeddingSpec: input.embeddingSpec }),
    ...(input.qualityProfile === undefined ? {} : { qualityProfile: input.qualityProfile }),
    channelPolicy: input.channelPolicy,
  })) as ExecutionFingerprint;
}

/** RFC §3/§6 identity for the complete, server-resolved scope object. */
export function fingerprintScope(scope: unknown): ScopeFingerprint {
  return sha256(canonicalizeJcs(scope)) as ScopeFingerprint;
}

