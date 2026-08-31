import type { AgentRequestContext } from './types.ts';
import type {
  AgqlMcpServer,
  JsonRpcFailure,
  JsonRpcResponse,
} from './protocol.ts';
import { MCP_PROTOCOL_VERSION } from './protocol.ts';

export type AgentAuthentication =
  | { readonly ok: true; readonly context: AgentRequestContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export interface McpAgentAuthenticator {
  authenticate(request: Request): Promise<AgentAuthentication>;
}

function response(body: JsonRpcResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function protocolFailure(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error = data === undefined ? { code, message } : { code, message, data };
  return id === undefined
    ? { jsonrpc: '2.0', error }
    : { jsonrpc: '2.0', id, error };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface HeaderFields {
  readonly id?: string | number;
  readonly method?: string;
  readonly name?: string;
  readonly version?: string;
}

function headerFields(value: unknown): HeaderFields {
  if (!isRecord(value)) return {};
  const params = value.params;
  if (!isRecord(params)) return {};
  const meta = params._meta;
  const version = isRecord(meta)
    && typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? meta['io.modelcontextprotocol/protocolVersion']
    : undefined;
  const method = typeof value.method === 'string' ? value.method : undefined;
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? value.id : undefined;
  const candidateName = method === 'resources/read' ? params.uri : params.name;
  const name = typeof candidateName === 'string' ? candidateName : undefined;
  return { ...(id === undefined ? {} : { id }), ...(method === undefined ? {} : { method }),
    ...(name === undefined ? {} : { name }), ...(version === undefined ? {} : { version }) };
}

function validateHeaders(request: Request, fields: HeaderFields): JsonRpcFailure | undefined {
  const protocol = request.headers.get('mcp-protocol-version');
  const method = request.headers.get('mcp-method');
  if (protocol !== fields.version || method !== fields.method) {
    return protocolFailure(fields.id, -32_020,
      'MCP routing headers must match the JSON-RPC request body.');
  }
  if (fields.method === 'tools/call' || fields.method === 'resources/read') {
    if (request.headers.get('mcp-name') !== fields.name) {
      return protocolFailure(fields.id, -32_020,
        'The Mcp-Name header must match the JSON-RPC request body.');
    }
  }
  return undefined;
}

/** Stateless 2026-07-28 Streamable HTTP binding: POST-only, no session identifier. */
export function createMcpHttpHandler(
  server: AgqlMcpServer,
  authenticator: McpAgentAuthenticator,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    let message: unknown;
    try {
      message = JSON.parse(await request.text()) as unknown;
    } catch {
      return response(protocolFailure(undefined, -32_700, 'Invalid JSON.'), 400);
    }
    const fields = headerFields(message);
    const headerError = validateHeaders(request, fields);
    if (headerError !== undefined) return response(headerError, 400);
    if (fields.version !== MCP_PROTOCOL_VERSION) {
      return response(protocolFailure(fields.id, -32_022,
        'The requested MCP protocol version is not supported.', {
          supported: [MCP_PROTOCOL_VERSION],
          requested: fields.version,
        }), 400);
    }
    const authentication = await authenticator.authenticate(request);
    if (!authentication.ok) {
      return response(protocolFailure(fields.id, -32_000, authentication.message),
        authentication.status);
    }
    const result = await server.dispatch(message, authentication.context);
    return response(result.body, result.httpStatus);
  };
}
