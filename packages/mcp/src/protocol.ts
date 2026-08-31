import type { AgqlError } from '@agql/schemas';

import type { ScopedCatalogProfile } from './catalog.ts';
import {
  TOOL_NAMES,
  parseDescribeCatalog,
  parseLookupValues,
  parsePutRecords,
  parseQueryOperation,
  parseSaveQuery,
  parseSearchCatalog,
  toolInputJsonSchemas,
} from './input.ts';
import type { ToolName } from './input.ts';
import {
  catalogPayload,
  projectExplainOutcome,
  projectPutOutcome,
  projectRunOutcome,
  projectSaveOutcome,
  rejectedPayload,
} from './projection.ts';
import type {
  AgentRequestContext,
  QueryRuntime,
  SavedQueryPort,
  ToolPayload,
} from './types.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface McpToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
}

const descriptions: Readonly<Record<ToolName, string>> = {
  search_catalog: 'Search the scope-narrowed catalog index without issuing a query.',
  describe_catalog: 'Describe exact scope-visible catalog references.',
  lookup_values: 'Resolve scope-visible enum codes and labels without issuing a query.',
  explain_query: 'Compile an AgQL v0 query and return its cost and result contract.',
  run_query: 'Execute an AgQL v0 query and return only the bounded model channel.',
  put_records: 'Ingest canonical records with idempotency and a visibility receipt.',
  save_query: 'Persist a query only after verifying its signed execution receipt.',
};

function annotations(name: ToolName): McpToolDefinition['annotations'] {
  const readOnly = name !== 'put_records' && name !== 'save_query';
  return {
    readOnlyHint: readOnly,
    destructiveHint: name === 'put_records',
    idempotentHint: name === 'put_records',
    openWorldHint: false,
  };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: descriptions[name],
  inputSchema: toolInputJsonSchemas[name],
  annotations: annotations(name),
}));

export interface McpServerOptions {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly discoveryTtlMs: number;
  readonly toolListTtlMs: number;
  readonly catalogTtlMs: number;
}

export interface McpCallToolResult {
  readonly resultType: 'complete';
  readonly content: readonly [{
    readonly type: 'text';
    readonly text: string;
    readonly annotations: { readonly audience: readonly ['assistant']; readonly priority: 1 };
  }];
  readonly structuredContent: ToolPayload;
  readonly isError: false;
  readonly _meta: {
    readonly 'io.modelcontextprotocol/serverInfo': {
      readonly name: string;
      readonly version: string;
    };
  };
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result: object;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpDispatchResponse {
  readonly httpStatus: number;
  readonly body: JsonRpcResponse;
}

interface ParsedRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(
  code: number,
  message: string,
  httpStatus: number,
  id?: string | number,
  data?: unknown,
): McpDispatchResponse {
  const error = data === undefined ? { code, message } : { code, message, data };
  return {
    httpStatus,
    body: id === undefined
      ? { jsonrpc: '2.0', error }
      : { jsonrpc: '2.0', id, error },
  };
}

function parseRequest(value: unknown): ParsedRequest | McpDispatchResponse {
  if (!isRecord(value)
    || value.jsonrpc !== '2.0'
    || (typeof value.id !== 'string' && typeof value.id !== 'number')
    || typeof value.method !== 'string'
    || !isRecord(value.params)) {
    return failure(-32_600, 'Invalid JSON-RPC request.', 400);
  }
  return { id: value.id, method: value.method, params: value.params };
}

function requestVersion(params: Readonly<Record<string, unknown>>): string | undefined {
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  if (!isRecord(capabilities)) return undefined;
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  return typeof version === 'string' ? version : undefined;
}

function success(id: string | number, result: object): McpDispatchResponse {
  return { httpStatus: 200, body: { jsonrpc: '2.0', id, result } };
}

function errorsFromInput(
  result: { readonly ok: false; readonly errors: readonly [AgqlError, ...AgqlError[]] },
  context: AgentRequestContext,
): ToolPayload {
  return rejectedPayload(context, result.errors);
}

export class AgqlMcpServer {
  readonly #runtime: QueryRuntime;
  readonly #catalog: ScopedCatalogProfile;
  readonly #savedQueries: SavedQueryPort;
  readonly #options: McpServerOptions;

  public constructor(
    runtime: QueryRuntime,
    catalog: ScopedCatalogProfile,
    savedQueries: SavedQueryPort,
    options: McpServerOptions,
  ) {
    this.#runtime = runtime;
    this.#catalog = catalog;
    this.#savedQueries = savedQueries;
    this.#options = options;
  }

  #resultMeta() {
    return {
      'io.modelcontextprotocol/serverInfo': {
        name: this.#options.serverName,
        version: this.#options.serverVersion,
      },
    } as const;
  }

  #toolResult(payload: ToolPayload): McpCallToolResult {
    return {
      resultType: 'complete',
      content: [{
        type: 'text',
        text: JSON.stringify(payload),
        annotations: { audience: ['assistant'], priority: 1 },
      }],
      structuredContent: payload,
      isError: false,
      _meta: this.#resultMeta(),
    };
  }

  async #callTool(
    context: AgentRequestContext,
    name: string,
    args: unknown,
  ): Promise<McpCallToolResult | undefined> {
    if (name === 'search_catalog') {
      const input = parseSearchCatalog(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      const result = this.#catalog.search(
        context,
        input.value.source,
        input.value.query,
        input.value.limit,
      );
      return this.#toolResult(result.ok
        ? catalogPayload(context, result.value)
        : errorsFromInput(result, context));
    }
    if (name === 'describe_catalog') {
      const input = parseDescribeCatalog(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      const result = this.#catalog.describe(context, input.value.source, input.value.refs);
      return this.#toolResult(result.ok
        ? catalogPayload(context, result.value)
        : errorsFromInput(result, context));
    }
    if (name === 'lookup_values') {
      const input = parseLookupValues(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      const result = this.#catalog.lookupValues(
        context,
        input.value.source,
        input.value.field,
        input.value.query,
        input.value.limit,
      );
      return this.#toolResult(result.ok
        ? catalogPayload(context, result.value)
        : errorsFromInput(result, context));
    }
    if (name === 'explain_query' || name === 'run_query') {
      const input = parseQueryOperation(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      const outcome = name === 'explain_query'
        ? projectExplainOutcome(context, await this.#runtime.explainQuery(context, input.value))
        : projectRunOutcome(context, await this.#runtime.runQuery(context, input.value));
      return this.#toolResult(outcome);
    }
    if (name === 'put_records') {
      const input = parsePutRecords(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      return this.#toolResult(projectPutOutcome(
        context,
        await this.#runtime.putRecords(context, input.value),
      ));
    }
    if (name === 'save_query') {
      const input = parseSaveQuery(args);
      if (!input.ok) return this.#toolResult(errorsFromInput(input, context));
      return this.#toolResult(projectSaveOutcome(
        context,
        await this.#savedQueries.saveQuery(context, input.value),
      ));
    }
    return undefined;
  }

  public async dispatch(
    value: unknown,
    context: AgentRequestContext,
  ): Promise<McpDispatchResponse> {
    const parsed = parseRequest(value);
    if ('body' in parsed) return parsed;
    const version = requestVersion(parsed.params);
    if (version === undefined) {
      return failure(-32_602, 'Request _meta must declare protocolVersion and capabilities.', 400,
        parsed.id);
    }
    if (version !== MCP_PROTOCOL_VERSION) {
      return failure(-32_022, 'The requested MCP protocol version is not supported.', 400,
        parsed.id, { supported: [MCP_PROTOCOL_VERSION], requested: version });
    }
    if (parsed.method === 'server/discover') {
      return success(parsed.id, {
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {}, resources: {} },
        instructions: 'Use catalog discovery before authoring an AgQL v0 query.',
        ttlMs: this.#options.discoveryTtlMs,
        cacheScope: 'public',
        _meta: this.#resultMeta(),
      });
    }
    if (parsed.method === 'tools/list') {
      return success(parsed.id, {
        resultType: 'complete',
        tools: MCP_TOOLS,
        ttlMs: this.#options.toolListTtlMs,
        cacheScope: 'public',
        _meta: this.#resultMeta(),
      });
    }
    if (parsed.method === 'resources/list') {
      return success(parsed.id, {
        resultType: 'complete',
        resources: this.#catalog.resources(context),
        ttlMs: this.#options.catalogTtlMs,
        cacheScope: 'private',
        _meta: this.#resultMeta(),
      });
    }
    if (parsed.method === 'resources/read') {
      const uri = parsed.params.uri;
      if (typeof uri !== 'string') {
        return failure(-32_602, 'resources/read requires a URI.', 400, parsed.id);
      }
      const resource = this.#catalog.readResource(context, uri);
      if (!resource.ok) {
        return failure(-32_602, resource.errors[0].message, 404, parsed.id,
          { errors: resource.errors });
      }
      return success(parsed.id, {
        resultType: 'complete',
        contents: [resource.value],
        ttlMs: this.#options.catalogTtlMs,
        cacheScope: 'private',
        _meta: this.#resultMeta(),
      });
    }
    if (parsed.method === 'tools/call') {
      const name = parsed.params.name;
      if (typeof name !== 'string') {
        return failure(-32_602, 'tools/call requires a tool name.', 400, parsed.id);
      }
      const result = await this.#callTool(context, name, parsed.params.arguments ?? {});
      return result === undefined
        ? failure(-32_601, 'The requested tool is not available.', 404, parsed.id)
        : success(parsed.id, result);
    }
    return failure(-32_601, 'The requested MCP method is not available.', 404, parsed.id);
  }
}
