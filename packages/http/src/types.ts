import type { Scope } from '@agql/catalog';
import type {
  ResultSchemaField,
  ResultValue,
} from '@agql/contracts';
import type { InstantValue } from '@agql/schemas';
import type {
  RuntimeOutcome,
} from '@agql/mcp';

export interface PrincipalRequestContext {
  readonly credentialKind: 'principal';
  readonly scope: Scope;
  readonly requestAnchor: InstantValue;
  readonly authMs: number;
}

export type PrincipalAuthentication =
  | { readonly ok: true; readonly context: PrincipalRequestContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export interface PrincipalAuthenticator {
  authenticatePrincipal(request: Request): Promise<PrincipalAuthentication>;
}

export type PrincipalRow = Readonly<Record<string, ResultValue>>;

export interface PrincipalOpenValue {
  readonly handle: string;
  readonly schema: readonly ResultSchemaField[];
  readonly rows: readonly PrincipalRow[];
  readonly nextCursor?: string;
}

export interface PrincipalPageValue {
  readonly schema: readonly ResultSchemaField[];
  readonly rows: readonly PrincipalRow[];
  readonly nextCursor?: string;
}

export interface PrincipalStreamValue {
  readonly schema: readonly ResultSchemaField[];
  readonly rows: AsyncIterable<PrincipalRow>;
}

export interface PrincipalResultPort {
  open(
    context: PrincipalRequestContext,
    input: { readonly executionReceipt: string; readonly pageSize: number },
  ): Promise<RuntimeOutcome<PrincipalOpenValue>>;
  page(
    context: PrincipalRequestContext,
    input: { readonly handle: string; readonly cursor?: string },
  ): Promise<RuntimeOutcome<PrincipalPageValue>>;
  stream(
    context: PrincipalRequestContext,
    input: { readonly handle: string },
  ): Promise<RuntimeOutcome<PrincipalStreamValue>>;
}
