import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

import {
  InstantValueSchema,
  canonicalizeJcs,
  effectivePlanHash,
  fingerprintScope,
  validateAndCanonicalizeQuery,
} from '@agql/schemas';
import type {
  AgqlError,
  EffectivePlanHash,
  QueryDocument,
  SourceQueryHash,
} from '@agql/schemas';
import { z } from 'zod';

import type {
  AgentRequestContext,
  QueryOperationInput,
  RuntimeOutcome,
  SaveQueryOperationInput,
  SavedQueryPort,
  SavedQueryValue,
} from './types.ts';
import { EMPTY_RUNTIME_TIMINGS } from './types.ts';

export interface ExecutionReceiptClaims {
  readonly version: '0';
  readonly source: string;
  readonly sourceQueryHash: string;
  readonly effectivePlanHash: string;
  readonly scopeFingerprint: string;
  readonly principal: string;
  readonly expiresAt: string;
  readonly catalogVersion: string;
  readonly policyVersion: string;
}

const ExecutionReceiptClaimsSchema = z.object({
  version: z.literal('0'),
  source: z.string().min(1),
  sourceQueryHash: z.string().min(1),
  effectivePlanHash: z.string().min(1),
  scopeFingerprint: z.string().min(1),
  principal: z.string().min(1),
  expiresAt: InstantValueSchema,
  catalogVersion: z.string().min(1),
  policyVersion: z.string().min(1),
}).strict();

export type ReceiptVerification =
  | { readonly ok: true; readonly claims: ExecutionReceiptClaims }
  | { readonly ok: false };

export interface ExecutionReceiptVerifier {
  verify(receipt: string): ReceiptVerification;
}

export interface ExecutionReceiptSigningKey {
  readonly id: string;
  readonly secret: Uint8Array;
}

function signature(key: Uint8Array, payload: string): Buffer {
  return createHmac('sha256', key).update(payload, 'utf8').digest();
}

/** HMAC codec for portable, session-independent execution receipts. */
export class HmacExecutionReceiptCodec implements ExecutionReceiptVerifier {
  readonly #active: ExecutionReceiptSigningKey;
  readonly #keys: ReadonlyMap<string, Uint8Array>;

  public constructor(keys: readonly ExecutionReceiptSigningKey[]) {
    const active = keys[0];
    if (active === undefined) throw new TypeError('Execution receipt signing requires a key.');
    const resolved = new Map<string, Uint8Array>();
    for (const key of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key.id)) {
        throw new TypeError('Execution receipt key ids must use the safe identifier grammar.');
      }
      if (key.secret.byteLength < 32) {
        throw new TypeError('Execution receipt keys must contain 32 bytes.');
      }
      if (resolved.has(key.id)) throw new TypeError('Execution receipt key ids must be unique.');
      resolved.set(key.id, key.secret.slice());
    }
    this.#active = { id: active.id, secret: active.secret.slice() };
    this.#keys = resolved;
  }

  public sign(claims: ExecutionReceiptClaims): string {
    const parsed = ExecutionReceiptClaimsSchema.parse(claims);
    const payload = Buffer.from(canonicalizeJcs(parsed), 'utf8').toString('base64url');
    return `er_v0.${this.#active.id}.${payload}.${signature(this.#active.secret, payload)
      .toString('base64url')}`;
  }

  public verify(receipt: string): ReceiptVerification {
    const parts = receipt.split('.');
    const prefix = parts[0];
    const keyId = parts[1];
    const payload = parts[2];
    const encodedSignature = parts[3];
    const key = keyId === undefined ? undefined : this.#keys.get(keyId);
    if (parts.length !== 4
      || prefix !== 'er_v0'
      || key === undefined
      || payload === undefined
      || encodedSignature === undefined) return { ok: false };
    let supplied: Buffer;
    let decoded: unknown;
    try {
      supplied = Buffer.from(encodedSignature, 'base64url');
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      return { ok: false };
    }
    const expected = signature(key, payload);
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      return { ok: false };
    }
    const claims = ExecutionReceiptClaimsSchema.safeParse(decoded);
    return claims.success ? { ok: true, claims: claims.data } : { ok: false };
  }
}

export interface CatalogIdentity {
  readonly catalogVersion: string;
  readonly policyVersion: string;
}

export interface CatalogIdentityProvider {
  identity(source: string): CatalogIdentity | undefined;
}

export interface SavedQueryRecord {
  readonly source: string;
  readonly name: string;
  readonly query: QueryDocument;
  readonly sourceQueryHash: SourceQueryHash;
  readonly verifiedEffectivePlanHash: EffectivePlanHash;
}

export interface SavedQueryRepository {
  put(record: SavedQueryRecord): Promise<void>;
  get(source: string, name: string): Promise<SavedQueryRecord | undefined>;
}

export class InMemorySavedQueryRepository implements SavedQueryRepository {
  readonly #records = new Map<string, SavedQueryRecord>();

  public put(record: SavedQueryRecord): Promise<void> {
    this.#records.set(canonicalizeJcs([record.source, record.name]), record);
    return Promise.resolve();
  }

  public get(source: string, name: string): Promise<SavedQueryRecord | undefined> {
    return Promise.resolve(this.#records.get(canonicalizeJcs([source, name])));
  }
}

function receiptError(message: string): AgqlError {
  return {
    code: 'SEMANTIC_INVALID',
    message,
    path: '/executionReceipt',
    alternatives: ['Run the query successfully again and use its new execution receipt.'],
  };
}

function rejected<T>(error: AgqlError): RuntimeOutcome<T> {
  return { ok: false, errors: [error], timings: EMPTY_RUNTIME_TIMINGS };
}

function instantKey(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
    .exec(value);
  if (match === null) return undefined;
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}`
    + (match[7] ?? '').padEnd(9, '0');
}

function expired(expiresAt: string, requestAnchor: string): boolean {
  const expiry = instantKey(expiresAt);
  const anchor = instantKey(requestAnchor);
  if (expiry === undefined || anchor === undefined) return true;
  return expiry <= anchor;
}

export interface SavedQueryCompiler<T> {
  compile(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<T>>;
}

/**
 * Persists only the source query. Execution always calls the compiler with the reader's
 * current context; a creator's plan or scope is never an execution authority.
 */
export class VerifiedSavedQueryStore implements SavedQueryPort {
  readonly #receipts: ExecutionReceiptVerifier;
  readonly #catalogs: CatalogIdentityProvider;
  readonly #repository: SavedQueryRepository;

  public constructor(
    receipts: ExecutionReceiptVerifier,
    catalogs: CatalogIdentityProvider,
    repository: SavedQueryRepository,
  ) {
    this.#receipts = receipts;
    this.#catalogs = catalogs;
    this.#repository = repository;
  }

  public async saveQuery(
    context: AgentRequestContext,
    input: SaveQueryOperationInput,
  ): Promise<RuntimeOutcome<SavedQueryValue>> {
    const canonical = validateAndCanonicalizeQuery(input.query);
    if (!canonical.ok) {
      return { ok: false, errors: canonical.errors, timings: EMPTY_RUNTIME_TIMINGS };
    }
    const verified = this.#receipts.verify(input.executionReceipt);
    if (!verified.ok) return rejected(receiptError('The execution receipt is invalid.'));
    const identity = this.#catalogs.identity(input.source);
    if (identity === undefined) {
      return rejected(receiptError('The execution receipt source is not available.'));
    }
    const claims = verified.claims;
    const scopeFingerprint = fingerprintScope(context.scope);
    const expectedPlanHash = effectivePlanHash({
      sourceQueryHash: canonical.value.sourceQueryHash,
      languageVersion: '0',
      catalogVersion: identity.catalogVersion,
      policyVersion: identity.policyVersion,
      scopeFingerprint,
    });
    const mismatch = claims.source !== input.source
      || claims.sourceQueryHash !== canonical.value.sourceQueryHash
      || claims.effectivePlanHash !== expectedPlanHash
      || claims.scopeFingerprint !== scopeFingerprint
      || claims.principal !== context.scope.principal
      || claims.catalogVersion !== identity.catalogVersion
      || claims.policyVersion !== identity.policyVersion;
    if (mismatch) {
      return rejected(receiptError(
        'The execution receipt does not match this query, principal, scope, or catalog policy.',
      ));
    }
    if (expired(claims.expiresAt, context.requestAnchor)) {
      return rejected(receiptError('The execution receipt has expired.'));
    }
    const record: SavedQueryRecord = {
      source: input.source,
      name: input.name,
      query: canonical.value.document,
      sourceQueryHash: canonical.value.sourceQueryHash,
      verifiedEffectivePlanHash: claims.effectivePlanHash as EffectivePlanHash,
    };
    await this.#repository.put(record);
    return {
      ok: true,
      value: {
        source: record.source,
        name: record.name,
        sourceQueryHash: record.sourceQueryHash,
        effectivePlanHash: record.verifiedEffectivePlanHash,
      },
      timings: EMPTY_RUNTIME_TIMINGS,
    };
  }

  public async compileForReader<T>(
    context: AgentRequestContext,
    source: string,
    name: string,
    compiler: SavedQueryCompiler<T>,
  ): Promise<RuntimeOutcome<T>> {
    const record = await this.#repository.get(source, name);
    if (record === undefined) {
      return rejected({
        code: 'REFERENCE_NOT_AVAILABLE',
        message: 'The referenced item is not available in the effective catalog.',
        path: '/name',
        alternatives: [],
      });
    }
    return compiler.compile(context, { source: record.source, query: record.query });
  }
}
