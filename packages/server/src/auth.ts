import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';

import { ScopeSchema } from '@agql/catalog';
import type { Scope } from '@agql/catalog';
import type {
  AgentAuthentication,
  AgentRequestContext,
  McpAgentAuthenticator,
} from '@agql/mcp';
import {
  InstantValueSchema,
} from '@agql/schemas';
import type { InstantValue } from '@agql/schemas';

export type ServerAuthenticationCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_INVALID'
  | 'ANCHOR_REQUIRED'
  | 'SCOPE_RESOLUTION_FAILED';

export interface ServerAuthenticationRefusal {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly code: ServerAuthenticationCode;
  readonly message: string;
}

export interface AuthenticatedAgent {
  readonly subject: string;
  readonly credentialFingerprint: string;
}

export type AgentIdentityAuthentication =
  | { readonly ok: true; readonly principal: AuthenticatedAgent }
  | ServerAuthenticationRefusal;

/** Replaces bearer keys cleanly when a deployment binds UOA or another identity authority. */
export interface AgentIdentityAuthenticator {
  authenticateAgent(request: Request): Promise<AgentIdentityAuthentication>;
}

/** Resolves the complete mandatory scope from identity, never from the request payload. */
export interface ScopeResolver {
  resolveAgentScope(
    principal: AuthenticatedAgent,
    request: Request,
  ): Promise<Scope>;
}

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1];
}

export class BearerKeyAuthenticator implements AgentIdentityAuthenticator {
  readonly #digests: readonly Buffer[];

  public constructor(keys: readonly string[]) {
    if (keys.length === 0) throw new TypeError('Bearer authentication requires at least one key.');
    this.#digests = keys.map(credentialDigest);
  }

  public authenticateAgent(request: Request): Promise<AgentIdentityAuthentication> {
    const token = bearerToken(request);
    if (token === undefined) {
      return Promise.resolve({
        ok: false,
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Bearer authentication is required.',
      });
    }
    const supplied = credentialDigest(token);
    let matched = false;
    for (const candidate of this.#digests) {
      matched = timingSafeEqual(supplied, candidate) || matched;
    }
    if (!matched) {
      return Promise.resolve({
        ok: false,
        status: 403,
        code: 'AUTHENTICATION_INVALID',
        message: 'The supplied bearer credential is not accepted.',
      });
    }
    const fingerprint = supplied.toString('hex');
    return Promise.resolve({
      ok: true,
      principal: {
        subject: `app:${fingerprint}`,
        credentialFingerprint: `sha256:${fingerprint}`,
      },
    });
  }
}

const DEFAULT_SCOPE_EXPIRY = InstantValueSchema.parse('9999-12-31T23:59:59Z');

/**
 * The bearer-key default grants only deployment-configured capabilities and unpartitioned
 * visibility. A deployment bound to an identity authority supplies its own ScopeResolver.
 */
export class ApplicationScopeResolver implements ScopeResolver {
  readonly #capabilities: readonly string[];

  public constructor(capabilities: readonly string[]) {
    this.#capabilities = [...capabilities];
  }

  public resolveAgentScope(principal: AuthenticatedAgent): Promise<Scope> {
    return Promise.resolve(ScopeSchema.parse({
      principal: principal.subject,
      capabilities: this.#capabilities,
      partitions: { kind: 'unpartitioned' },
      budgets: {
        maximumQueries: 1_000,
        maximumExactScanRecords: 10_000,
        maximumCandidateRecords: 1_000,
      },
      expiresAt: DEFAULT_SCOPE_EXPIRY,
    }));
  }
}

function requestAnchor(request: Request): InstantValue | ServerAuthenticationRefusal {
  const value = request.headers.get('agql-anchor');
  if (value === null) {
    return {
      ok: false,
      status: 403,
      code: 'ANCHOR_REQUIRED',
      message: 'AgQL-Anchor must contain an explicit canonical UTC instant.',
    };
  }
  const parsed = InstantValueSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      status: 403,
      code: 'ANCHOR_REQUIRED',
      message: 'AgQL-Anchor must contain an explicit canonical UTC instant.',
    };
  }
  return parsed.data;
}

export type ServerAgentAuthentication =
  | { readonly ok: true; readonly context: AgentRequestContext }
  | ServerAuthenticationRefusal;

export class ServerAgentAuthenticator implements McpAgentAuthenticator {
  readonly #identity: AgentIdentityAuthenticator;
  readonly #scopeResolver: ScopeResolver;

  public constructor(identity: AgentIdentityAuthenticator, scopeResolver: ScopeResolver) {
    this.#identity = identity;
    this.#scopeResolver = scopeResolver;
  }

  public async authenticate(request: Request): Promise<AgentAuthentication> {
    const result = await this.authenticateServerRequest(request);
    return result.ok
      ? result
      : { ok: false, status: result.status, message: result.message };
  }

  public async authenticateServerRequest(request: Request): Promise<ServerAgentAuthentication> {
    const identity = await this.#identity.authenticateAgent(request);
    if (!identity.ok) return identity;
    const anchor = requestAnchor(request);
    if (typeof anchor !== 'string') return anchor;
    let scope: Scope;
    try {
      scope = await this.#scopeResolver.resolveAgentScope(identity.principal, request);
    } catch {
      return {
        ok: false,
        status: 403,
        code: 'SCOPE_RESOLUTION_FAILED',
        message: 'The authenticated principal does not have an applicable AgQL scope.',
      };
    }
    const parsedScope = ScopeSchema.safeParse(scope);
    if (!parsedScope.success) {
      return {
        ok: false,
        status: 403,
        code: 'SCOPE_RESOLUTION_FAILED',
        message: 'The authenticated principal does not have an applicable AgQL scope.',
      };
    }
    return {
      ok: true,
      context: {
        credentialKind: 'agent',
        scope: parsedScope.data,
        requestAnchor: anchor,
        authMs: 0,
      },
    };
  }
}
