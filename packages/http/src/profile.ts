import {
  decodeDocument,
} from '@agql/schemas';
import type {
  AgqlError,
  InputEncoding,
} from '@agql/schemas';
import {
  catalogPayload,
  parseDescribeCatalog,
  parseLookupValues,
  parsePutRecords,
  parseQueryOperation,
  parseSaveQuery,
  parseSearchCatalog,
  projectExplainOutcome,
  projectPutOutcome,
  projectRunOutcome,
  projectSaveOutcome,
  rejectedPayload,
} from '@agql/mcp';
import type {
  AgentAuthentication,
  AgentRequestContext,
  McpAgentAuthenticator,
  QueryRuntime,
  RuntimeOutcome,
  RuntimeTimings,
  SavedQueryPort,
  ScopedCatalogProfile,
  ToolPayload,
} from '@agql/mcp';

import type {
  PrincipalAuthenticator,
  PrincipalPageValue,
  PrincipalRequestContext,
  PrincipalResultPort,
  PrincipalStreamValue,
} from './types.ts';

const JSON_CONTENT_TYPE = 'application/json';
const YAML_CONTENT_TYPE = 'application/agql-yaml';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE },
  });
}

function contentEncoding(request: Request): InputEncoding | undefined {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType === JSON_CONTENT_TYPE) return 'json';
  if (contentType === YAML_CONTENT_TYPE) return 'agql-yaml';
  return undefined;
}

async function decodeBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly [AgqlError, ...AgqlError[]] }
> {
  const encoding = contentEncoding(request);
  if (encoding === undefined) {
    return {
      ok: false,
      errors: [{
        code: 'ENCODING_SYNTAX',
        message: `The HTTP body must use ${JSON_CONTENT_TYPE} or ${YAML_CONTENT_TYPE}.`,
        path: '',
        alternatives: [JSON_CONTENT_TYPE, YAML_CONTENT_TYPE],
      }],
    };
  }
  return decodeDocument(await request.text(), encoding);
}

function inputRejection(
  context: AgentRequestContext,
  result: { readonly ok: false; readonly errors: readonly [AgqlError, ...AgqlError[]] },
): ToolPayload {
  return rejectedPayload(context, result.errors);
}

async function agentOperation(
  request: Request,
  context: AgentRequestContext,
  runtime: QueryRuntime,
  catalog: ScopedCatalogProfile,
  savedQueries: SavedQueryPort,
): Promise<Response> {
  const body = await decodeBody(request);
  if (!body.ok) return json(inputRejection(context, body));
  const path = new URL(request.url).pathname;
  if (path === '/v0/catalog/search') {
    const input = parseSearchCatalog(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    const outcome = catalog.search(
      context,
      input.value.source,
      input.value.query,
      input.value.limit,
    );
    return json(outcome.ok
      ? catalogPayload(context, outcome.value)
      : inputRejection(context, outcome));
  }
  if (path === '/v0/catalog/describe') {
    const input = parseDescribeCatalog(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    const outcome = catalog.describe(context, input.value.source, input.value.refs);
    return json(outcome.ok
      ? catalogPayload(context, outcome.value)
      : inputRejection(context, outcome));
  }
  if (path === '/v0/catalog/values') {
    const input = parseLookupValues(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    const outcome = catalog.lookupValues(
      context,
      input.value.source,
      input.value.field,
      input.value.query,
      input.value.limit,
    );
    return json(outcome.ok
      ? catalogPayload(context, outcome.value)
      : inputRejection(context, outcome));
  }
  if (path === '/v0/query/explain' || path === '/v0/query/run') {
    const input = parseQueryOperation(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    return path === '/v0/query/explain'
      ? json(projectExplainOutcome(context, await runtime.explainQuery(context, input.value)))
      : json(projectRunOutcome(context, await runtime.runQuery(context, input.value)));
  }
  if (path === '/v0/records') {
    const input = parsePutRecords(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    return json(projectPutOutcome(context, await runtime.putRecords(context, input.value)));
  }
  if (path === '/v0/queries') {
    const input = parseSaveQuery(body.value);
    if (!input.ok) return json(inputRejection(context, input));
    return json(projectSaveOutcome(context, await savedQueries.saveQuery(context, input.value)));
  }
  return new Response(null, { status: 404 });
}

/** Agent data-plane routes. This handler has no principal-result route. */
export function createAgentHttpHandler(
  runtime: QueryRuntime,
  catalog: ScopedCatalogProfile,
  savedQueries: SavedQueryPort,
  authenticator: McpAgentAuthenticator,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const authentication: AgentAuthentication = await authenticator.authenticate(request);
    if (!authentication.ok) return json({ message: authentication.message }, authentication.status);
    return agentOperation(
      request,
      authentication.context,
      runtime,
      catalog,
      savedQueries,
    );
  };
}

function principalTimings(
  context: PrincipalRequestContext,
  timings: RuntimeTimings,
) {
  return {
    authMs: context.authMs,
    validationPolicyMs: timings.validationPolicyMs,
    queryEmbeddingMs: timings.queryEmbeddingMs,
    adapterCompileMs: timings.adapterCompileMs,
    backendMs: timings.backendMs,
    fusionReleaseMs: timings.fusionReleaseMs,
  } as const;
}

type PrincipalPayload<T> =
  | {
    readonly status: 'ok';
    readonly value: T;
    readonly timings: ReturnType<typeof principalTimings>;
  }
  | {
    readonly status: 'rejected';
    readonly errors: readonly AgqlError[];
    readonly timings: ReturnType<typeof principalTimings>;
  };

function principalPayload<T>(
  context: PrincipalRequestContext,
  outcome: RuntimeOutcome<T>,
): PrincipalPayload<T> {
  return outcome.ok
    ? { status: 'ok', value: outcome.value, timings: principalTimings(context, outcome.timings) }
    : {
      status: 'rejected',
      errors: outcome.errors,
      timings: principalTimings(context, outcome.timings),
    };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function openPrincipalResult(
  request: Request,
  context: PrincipalRequestContext,
  results: PrincipalResultPort,
): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return json({ message: 'The principal result request is not valid JSON.' }, 400);
  }
  if (!isRecord(body)
    || typeof body.executionReceipt !== 'string'
    || typeof body.pageSize !== 'number'
    || !Number.isSafeInteger(body.pageSize)
    || body.pageSize <= 0
    || body.pageSize > 1_000) {
    return json({ message: 'executionReceipt and a pageSize from 1 to 1000 are required.' }, 400);
  }
  return json(principalPayload(context, await results.open(context, {
    executionReceipt: body.executionReceipt,
    pageSize: body.pageSize,
  })));
}

function resultRoute(path: string):
  | { readonly kind: 'page' | 'stream'; readonly handle: string }
  | undefined {
  const match = /^\/v0\/principal-results\/([^/]+)(\/stream)?$/u.exec(path);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  try {
    return {
      kind: match?.[2] === undefined ? 'page' : 'stream',
      handle: decodeURIComponent(encoded),
    };
  } catch {
    return undefined;
  }
}

function pageInput(
  url: URL,
  handle: string,
): { readonly handle: string; readonly cursor?: string } {
  const cursor = url.searchParams.get('cursor');
  return cursor === null ? { handle } : { handle, cursor };
}

function streamResponse(
  context: PrincipalRequestContext,
  outcome: RuntimeOutcome<PrincipalStreamValue>,
): Response {
  if (!outcome.ok) return json(principalPayload(context, outcome));
  const encoder = new TextEncoder();
  const iterator = outcome.value.rows[Symbol.asyncIterator]();
  const metadata = {
    type: 'metadata',
    schema: outcome.value.schema,
    timings: principalTimings(context, outcome.timings),
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(metadata)}\n`));
      for (;;) {
        const item = await iterator.next();
        if (item.done) break;
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'row', row: item.value })}\n`));
      }
      controller.close();
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
}

async function principalOperation(
  request: Request,
  context: PrincipalRequestContext,
  results: PrincipalResultPort,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/v0/principal-results') {
    return openPrincipalResult(request, context, results);
  }
  const route = resultRoute(url.pathname);
  if (request.method !== 'GET' || route === undefined) return new Response(null, { status: 404 });
  if (route.kind === 'stream') {
    return streamResponse(context, await results.stream(context, { handle: route.handle }));
  }
  const outcome: RuntimeOutcome<PrincipalPageValue> = await results.page(
    context,
    pageInput(url, route.handle),
  );
  return json(principalPayload(context, outcome));
}

/** Full data is mounted separately and accepts only a principal authenticator. */
export function createPrincipalResultHttpHandler(
  results: PrincipalResultPort,
  authenticator: PrincipalAuthenticator,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const authentication = await authenticator.authenticatePrincipal(request);
    if (!authentication.ok) return json({ message: authentication.message }, authentication.status);
    return principalOperation(request, authentication.context, results);
  };
}
