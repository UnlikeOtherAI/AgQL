import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';

import { ScopedCatalogProfile } from '@agql/mcp';
import {
  AgqlMcpServer,
  HmacExecutionReceiptCodec,
  InMemorySavedQueryRepository,
  VerifiedSavedQueryStore,
  createMcpHttpHandler,
} from '@agql/mcp';
import type {
  AgentAuthentication,
  McpAgentAuthenticator,
  QueryRuntime,
} from '@agql/mcp';
import {
  createAgentHttpHandler,
  createPrincipalResultHttpHandler,
} from '@agql/http';
import type {
  PrincipalAuthenticator,
  PrincipalResultPort,
} from '@agql/http';
import type { CatalogDocument } from '@agql/schemas';

import {
  ApplicationScopeResolver,
  BearerKeyAuthenticator,
  ServerAgentAuthenticator,
} from './auth.ts';
import type {
  AgentIdentityAuthenticator,
  ScopeResolver,
} from './auth.ts';
import { createPostgresDeployment } from './bindings.ts';
import type { PostgresDeployment } from './bindings.ts';
import {
  DEFAULT_SOURCE_ID,
  SERVER_VERSION,
} from './config.ts';
import type { LogLevel, ServerConfig } from './config.ts';
import {
  DeterministicEmbedderRegistry,
  validateDeterministicCatalog,
} from './embedder.ts';
import { ServerRuntime } from './runtime.ts';

interface LogFields {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly catalogVersion?: string;
}

const LOG_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields: LogFields): void;
}

export class JsonLogger implements StructuredLogger {
  readonly #level: LogLevel;

  public constructor(level: LogLevel) {
    this.#level = level;
  }

  public log(level: LogLevel, event: string, fields: LogFields): void {
    if (LOG_SEVERITY[level] < LOG_SEVERITY[this.#level]) return;
    process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
  }
}

function receiptSecret(keys: readonly string[]): Uint8Array {
  const hash = createHash('sha256');
  hash.update('agql-server-execution-receipts-v1\u0000', 'utf8');
  for (const key of keys) {
    hash.update(key, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  return hash.digest();
}

function unavailablePrincipalResults(): PrincipalResultPort {
  const rejected = {
    ok: false as const,
    errors: [{
      code: 'SEMANTIC_INVALID' as const,
      message: 'Principal result delivery is not configured.',
      path: '',
      alternatives: ['Configure a separately authenticated principal result delivery service.'],
    }] as const,
    timings: {
      validationPolicyMs: 0,
      queryEmbeddingMs: 0,
      adapterCompileMs: 0,
      backendMs: 0,
      fusionReleaseMs: 0,
    },
  };
  return {
    open() { return Promise.resolve(rejected); },
    page() { return Promise.resolve(rejected); },
    stream() { return Promise.resolve(rejected); },
  };
}

function denyPrincipalAuthentication(): PrincipalAuthenticator {
  return {
    authenticatePrincipal() {
      return Promise.resolve({
        ok: false as const,
        status: 401 as const,
        message: 'A separately configured principal credential is required.',
      });
    },
  };
}

interface AgentFailure {
  readonly status: 401 | 403;
  readonly code: string;
  readonly message: string;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function agentFailure(path: string, failure: AgentFailure): Response {
  const error = {
    code: failure.code,
    message: failure.message,
    path: '',
    alternatives: [],
  };
  if (path === '/mcp') {
    return json({
      jsonrpc: '2.0',
      error: { code: -32_000, message: failure.message, data: error },
    }, failure.status);
  }
  return json({ status: 'rejected', errors: [error] }, failure.status);
}

function cachedAuthenticator(
  authenticator: ServerAgentAuthenticator,
): {
  readonly cached: McpAgentAuthenticator;
  readonly authorize: (request: Request) => Promise<Response | undefined>;
} {
  const cache = new WeakMap<Request, AgentAuthentication>();
  return {
    cached: {
      async authenticate(request: Request): Promise<AgentAuthentication> {
        const found = cache.get(request);
        if (found !== undefined) return found;
        return authenticator.authenticate(request);
      },
    },
    async authorize(request: Request): Promise<Response | undefined> {
      const result = await authenticator.authenticateServerRequest(request);
      if (!result.ok) return agentFailure(new URL(request.url).pathname, result);
      cache.set(request, result);
      return undefined;
    },
  };
}

async function readIncomingBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    request.once('error', reject);
  });
}

function headersFrom(request: IncomingMessage, requestId: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === 'x-agql-request-id') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.set('x-agql-request-id', requestId);
  return headers;
}

async function fetchRequest(request: IncomingMessage, requestId: string): Promise<Request> {
  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url ?? '/', `http://${host}`);
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await readIncomingBody(request);
  return new Request(url, {
    method: request.method ?? 'GET',
    headers: headersFrom(request, requestId),
    ...(body === undefined ? {} : { body }),
  });
}

async function writeFetchResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  if (response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!target.write(Buffer.from(chunk.value))) await once(target, 'drain');
  }
  target.end();
}

export interface ServerApplicationOptions {
  readonly catalog: CatalogDocument;
  readonly runtime: QueryRuntime;
  readonly agentAuthenticator: ServerAgentAuthenticator;
  readonly sourceId?: string;
  readonly logger?: StructuredLogger;
  readonly closeRuntime?: () => Promise<void>;
  readonly principalAuthenticator?: PrincipalAuthenticator;
  readonly principalResults?: PrincipalResultPort;
  readonly receiptCodec?: HmacExecutionReceiptCodec;
}

/** An actual HTTP listener around the already-normative MCP and HTTP handlers. */
export class ServerApplication {
  readonly #catalog: CatalogDocument;
  readonly #logger: StructuredLogger;
  readonly #mcp: (request: Request) => Promise<Response>;
  readonly #agent: (request: Request) => Promise<Response>;
  readonly #principal: (request: Request) => Promise<Response>;
  readonly #authorize: (request: Request) => Promise<Response | undefined>;
  readonly #closeRuntime: () => Promise<void>;
  readonly #server: Server;
  #closing = false;

  public constructor(options: ServerApplicationOptions) {
    this.#catalog = options.catalog;
    this.#logger = options.logger ?? new JsonLogger('info');
    this.#closeRuntime = options.closeRuntime ?? (() => Promise.resolve());
    const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID;
    const catalog = new ScopedCatalogProfile([{ id: sourceId, catalog: options.catalog }]);
    const receipts = options.receiptCodec
      ?? new HmacExecutionReceiptCodec(receiptSecret([options.catalog.catalogVersion]));
    const savedQueries = new VerifiedSavedQueryStore(receipts, {
      identity(source) {
        return source === sourceId
          ? {
            catalogVersion: options.catalog.catalogVersion,
            policyVersion: options.catalog.policyVersion,
          }
          : undefined;
      },
    }, new InMemorySavedQueryRepository());
    const mcp = new AgqlMcpServer(options.runtime, catalog, savedQueries, {
      serverName: 'agql-server',
      serverVersion: SERVER_VERSION,
      discoveryTtlMs: 60_000,
      toolListTtlMs: 60_000,
      catalogTtlMs: 5_000,
    });
    const authenticated = cachedAuthenticator(options.agentAuthenticator);
    this.#authorize = authenticated.authorize;
    this.#mcp = createMcpHttpHandler(mcp, authenticated.cached);
    this.#agent = createAgentHttpHandler(
      options.runtime,
      catalog,
      savedQueries,
      authenticated.cached,
    );
    this.#principal = createPrincipalResultHttpHandler(
      options.principalResults ?? unavailablePrincipalResults(),
      options.principalAuthenticator ?? denyPrincipalAuthentication(),
    );
    this.#server = createServer((request, response) => {
      void this.#nodeRequest(request, response);
    });
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        version: SERVER_VERSION,
        catalog: this.#catalog.catalogVersion,
      }, 200);
    }
    if (url.pathname === '/mcp') {
      const denied = await this.#authorize(request);
      return denied ?? this.#mcp(request);
    }
    if (url.pathname.startsWith('/v0/principal-results')) return this.#principal(request);
    if (url.pathname.startsWith('/v0/')) {
      const denied = await this.#authorize(request);
      return denied ?? this.#agent(request);
    }
    return new Response(null, { status: 404 });
  }

  async #nodeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    this.#logger.log('info', 'request.started', {
      requestId,
      method: request.method ?? 'GET',
      path,
    });
    try {
      if (this.#closing) {
        await writeFetchResponse(json({ message: 'Server is shutting down.' }, 503), response);
        return;
      }
      const result = await this.fetch(await fetchRequest(request, requestId));
      await writeFetchResponse(result, response);
      this.#logger.log('info', 'request.completed', {
        requestId,
        method: request.method ?? 'GET',
        path,
        status: result.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } catch {
      if (!response.headersSent) {
        await writeFetchResponse(new Response(null, { status: 500 }), response);
      }
      this.#logger.log('error', 'request.failed', {
        requestId,
        method: request.method ?? 'GET',
        path,
        status: 500,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    }
  }

  public listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
  }

  public get address(): ReturnType<Server['address']> {
    return this.#server.address();
  }

  public async close(): Promise<void> {
    this.#closing = true;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    await this.#closeRuntime();
  }
}

export interface DeploymentServerOptions {
  readonly config: ServerConfig;
  readonly catalog: CatalogDocument;
  readonly identityAuthenticator?: AgentIdentityAuthenticator;
  readonly scopeResolver?: ScopeResolver;
  readonly logger?: StructuredLogger;
  readonly deployment?: PostgresDeployment;
}

export function createDeploymentServer(options: DeploymentServerOptions): ServerApplication {
  validateDeterministicCatalog(options.catalog);
  const deployment = options.deployment ?? createPostgresDeployment(options.catalog, {
    databaseUrl: options.config.databaseUrl,
    tokenSecret: receiptSecret(options.config.appKeys),
  });
  const receiptCodec = new HmacExecutionReceiptCodec(receiptSecret(options.config.appKeys));
  const runtime = new ServerRuntime({
    sourceId: DEFAULT_SOURCE_ID,
    catalog: options.catalog,
    binding: deployment.binding,
    adapter: deployment.adapter,
    embedders: new DeterministicEmbedderRegistry(),
    receiptCodec,
  });
  return new ServerApplication({
    catalog: options.catalog,
    runtime,
    agentAuthenticator: new ServerAgentAuthenticator(
      options.identityAuthenticator ?? new BearerKeyAuthenticator(options.config.appKeys),
      options.scopeResolver ?? new ApplicationScopeResolver(),
    ),
    logger: options.logger ?? new JsonLogger(options.config.logLevel),
    closeRuntime: () => deployment.close(),
    receiptCodec,
  });
}
