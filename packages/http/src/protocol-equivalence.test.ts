import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccessRule, QueryDocument } from '@agql/schemas';
import {
  CatalogDocumentSchema,
  InstantValueSchema,
  SafeIntegerSchema,
  effectivePlanHash,
  executionFingerprint,
  fingerprintScope,
  validateAndCanonicalizeQuery,
} from '@agql/schemas';
import type { ModelReleasedValue, ResultEnvelope } from '@agql/contracts';
import {
  AgqlMcpServer,
  MCP_PROTOCOL_VERSION,
  ScopedCatalogProfile,
} from '@agql/mcp';
import type {
  AgentRequestContext,
  ExplainQueryValue,
  McpDispatchResponse,
  QueryOperationInput,
  QueryRuntime,
  RuntimeOutcome,
  RuntimeTimings,
  RunQueryValue,
  SavedQueryPort,
} from '@agql/mcp';

import {
  createAgentHttpHandler,
  createPrincipalResultHttpHandler,
} from './index.ts';
import type {
  PrincipalRequestContext,
  PrincipalResultPort,
} from './index.ts';

const timings: RuntimeTimings = {
  validationPolicyMs: 2,
  queryEmbeddingMs: 0,
  adapterCompileMs: 3,
  backendMs: 5,
  fusionReleaseMs: 1,
};

const allow: AccessRule = { effect: 'allow', requiredCapabilities: [] };
const channels = { model: allow, principal: allow };
const policy = {
  select: channels,
  filter: channels,
  group: channels,
  order: channels,
  aggregate: {
    count: channels,
    countDistinct: channels,
    sum: channels,
    avg: channels,
    min: channels,
    max: channels,
  },
  lexicalSearch: channels,
};

const catalog = CatalogDocumentSchema.parse({
  schemaVersion: '0',
  catalogVersion: 'catalog-1',
  policyVersion: 'policy-1',
  datasets: {
    notes: {
      description: 'Notes available to the current scope.',
      idField: 'id',
      fields: { id: { kind: 'id', description: 'Stable note id.', nullable: false } },
      profiles: ['records.v0'],
      embeddings: {},
      rowScope: { kind: 'none', reason: 'Explicitly unpartitioned.' },
      capabilityTags: [],
      fieldPolicies: { id: policy },
      embeddingPolicies: {},
    },
  },
  embeddingSpecs: {},
});

function agentContext(): AgentRequestContext {
  return {
    credentialKind: 'agent',
    scope: {
      principal: 'person:one',
      capabilities: [],
      partitions: { kind: 'unpartitioned' },
      budgets: {
        maximumQueries: SafeIntegerSchema.parse(10),
        maximumExactScanRecords: SafeIntegerSchema.parse(1_000),
        maximumCandidateRecords: SafeIntegerSchema.parse(100),
      },
      expiresAt: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
    },
    requestAnchor: InstantValueSchema.parse('2029-01-01T00:00:00Z'),
    authMs: 1,
  };
}

function principalContext(): PrincipalRequestContext {
  const agent = agentContext();
  return {
    credentialKind: 'principal',
    scope: agent.scope,
    requestAnchor: agent.requestAnchor,
    authMs: agent.authMs,
  };
}

function query(): QueryDocument {
  return {
    version: '0',
    mode: 'records',
    from: 'notes',
    select: ['id'],
    order: [{ by: 'id', dir: 'asc' }],
    take: SafeIntegerSchema.parse(1),
  };
}

function queryIdentity(input: QueryOperationInput, context: AgentRequestContext) {
  const canonical = validateAndCanonicalizeQuery(input.query);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new TypeError('The fixture query must be valid.');
  const effective = effectivePlanHash({
    sourceQueryHash: canonical.value.sourceQueryHash,
    languageVersion: '0',
    catalogVersion: catalog.catalogVersion,
    policyVersion: catalog.policyVersion,
    scopeFingerprint: fingerprintScope(context.scope),
  });
  return { source: canonical.value.sourceQueryHash, effective };
}

class EquivalentRuntime implements QueryRuntime {
  public explainQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<ExplainQueryValue>> {
    const identity = queryIdentity(input, context);
    return Promise.resolve({
      ok: true,
      value: {
        sourceQueryHash: identity.source,
        effectivePlanHash: identity.effective,
        resultSchema: [{ id: 'id', kind: 'id', nullable: false }],
        determinism: { query: 'exact' },
        projection: 'from notes | select id | order id asc | take 1',
        pushdown: ['projection', 'order', 'limit'],
        compensation: [],
        cost: { verdict: 'ok', estimatedRows: 1 },
        notes: [],
      },
      timings,
    });
  }

  public runQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<RunQueryValue>> {
    const identity = queryIdentity(input, context);
    const envelope: ResultEnvelope = {
      schema: [{ id: 'id', kind: 'id', nullable: false }],
      preview: [{ id: 'note-1' as ModelReleasedValue }],
      truncated: false,
      freshness: {
        writeVisibility: { kind: 'unconstrained' },
        executionSnapshot: { kind: 'none' },
      },
      principalResultAvailable: true,
      determinism: { query: 'exact' },
      provenance: {
        sourceQueryHash: identity.source,
        effectivePlanHash: identity.effective,
        executionFingerprint: executionFingerprint({
          effectivePlanHash: identity.effective,
          bindingVersion: 'binding-1',
          engineVersion: 'engine-1',
          adapterVersion: 'adapter-1',
          anchor: context.requestAnchor,
          snapshot: { kind: 'none' },
          channelPolicyFingerprint: 'model-policy-1',
        }),
        catalogVersion: catalog.catalogVersion,
        policyVersion: catalog.policyVersion,
        bindingVersion: 'binding-1',
        engineVersion: 'engine-1',
        adapterVersion: 'adapter-1',
        scopeFingerprint: fingerprintScope(context.scope),
        anchor: context.requestAnchor,
        replayTier: 'exactReplay',
      },
    };
    return Promise.resolve({
      ok: true,
      value: { envelope, executionReceipt: 'er-test' },
      timings,
    });
  }

  public putRecords(): Promise<RuntimeOutcome<never>> {
    return Promise.resolve({
      ok: false,
      errors: [{
        code: 'UNSUPPORTED_PROFILE',
        message: 'The source does not advertise canonical ingestion.',
        path: '/source',
        alternatives: ['Use a source advertising ingest.canonical.v0.'],
      }],
      timings,
    });
  }
}

class NoSavedQueries implements SavedQueryPort {
  public saveQuery(): Promise<RuntimeOutcome<never>> {
    return Promise.resolve({
      ok: false,
      errors: [{
        code: 'SEMANTIC_INVALID',
        message: 'The receipt is not configured.',
        path: '/executionReceipt',
        alternatives: ['Use a configured receipt.'],
      }],
      timings,
    });
  }
}

const runtime = new EquivalentRuntime();
const catalogProfile = new ScopedCatalogProfile([{ id: 'ops', catalog }]);
const savedQueries = new NoSavedQueries();
const mcpServer = new AgqlMcpServer(runtime, catalogProfile, savedQueries, {
  serverName: 'agql-test',
  serverVersion: '1',
  discoveryTtlMs: 60_000,
  toolListTtlMs: 60_000,
  catalogTtlMs: 5_000,
});
const agentAuthenticator = {
  authenticate() {
    return Promise.resolve({ ok: true as const, context: agentContext() });
  },
};
const httpHandler = createAgentHttpHandler(
  runtime,
  catalogProfile,
  savedQueries,
  agentAuthenticator,
);

function mcpRequest(argumentsValue: unknown, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'run_query',
      arguments: argumentsValue,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.notEqual(value, null);
  assert.equal(typeof value, 'object');
  return value as Readonly<Record<string, unknown>>;
}

function mcpPayload(response: McpDispatchResponse): Readonly<Record<string, unknown>> {
  assert.ok('result' in response.body);
  return record(record(response.body.result).structuredContent);
}

async function responsePayload(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return record(await response.json() as unknown);
}

test('PROTOCOL EQUIVALENCE: MCP and HTTP return identical identities and semantics', async () => {
  const args = { source: 'ops', query: query() };
  const mcp = mcpPayload(await mcpServer.dispatch(mcpRequest(args), agentContext()));
  const http = await responsePayload(await httpHandler(new Request(
    'https://example.test/v0/query/run',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    },
  )));
  assert.deepEqual(http, mcp);
  const provenance = record(http.provenance);
  assert.equal(typeof provenance.sourceQueryHash, 'string');
  assert.equal(typeof provenance.effectivePlanHash, 'string');
  assert.deepEqual(http.determinism, { query: 'exact' });
});

test('PROTOCOL EQUIVALENCE: AgQL-YAML and JSON produce one sourceQueryHash', async () => {
  const jsonResult = await responsePayload(await httpHandler(new Request(
    'https://example.test/v0/query/run',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ops', query: query() }),
    },
  )));
  const yaml = `source: ops
query:
  version: "0"
  mode: records
  from: notes
  select: [id]
  order:
    - { by: id, dir: asc }
  take: 1
`;
  const yamlResult = await responsePayload(await httpHandler(new Request(
    'https://example.test/v0/query/run',
    {
      method: 'POST',
      headers: { 'content-type': 'application/agql-yaml' },
      body: yaml,
    },
  )));
  assert.equal(
    record(jsonResult.provenance).sourceQueryHash,
    record(yamlResult.provenance).sourceQueryHash,
  );
  assert.deepEqual(yamlResult, jsonResult);
});

test('PROTOCOL EQUIVALENCE: rejection shapes are identical successful results', async () => {
  const invalid = { source: 'ops', query: { ...query(), join: { dataset: 'other' } } };
  const mcpResponse = await mcpServer.dispatch(mcpRequest(invalid), agentContext());
  const mcp = mcpPayload(mcpResponse);
  const httpResponse = await httpHandler(new Request('https://example.test/v0/query/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(invalid),
  }));
  const http = await responsePayload(httpResponse);
  assert.equal(mcpResponse.httpStatus, 200);
  assert.equal(httpResponse.status, 200);
  assert.deepEqual(http, mcp);
  assert.equal(JSON.stringify(http).includes('UNSUPPORTED_IN_V0'), true);
});

class FakePrincipalResults implements PrincipalResultPort {
  public cursorSeen: string | undefined;

  public open(): Promise<RuntimeOutcome<{
    readonly handle: string;
    readonly schema: readonly [{
      readonly id: 'id';
      readonly kind: 'id';
      readonly nullable: false;
    }];
    readonly rows: readonly [{ readonly id: 'principal-secret' }];
    readonly nextCursor: 'cursor-2';
  }>> {
    return Promise.resolve({
      ok: true,
      value: {
        handle: 'principal-handle',
        schema: [{ id: 'id', kind: 'id', nullable: false }],
        rows: [{ id: 'principal-secret' }],
        nextCursor: 'cursor-2',
      },
      timings,
    });
  }

  public page(
    _context: PrincipalRequestContext,
    input: { readonly handle: string; readonly cursor?: string },
  ): Promise<RuntimeOutcome<{
    readonly schema: readonly [];
    readonly rows: readonly [];
  }>> {
    this.cursorSeen = input.cursor;
    return Promise.resolve({
      ok: true,
      value: { schema: [], rows: [] },
      timings,
    });
  }

  public stream() {
    async function* rows() {
      await Promise.resolve();
      yield { id: 'principal-secret' } as const;
    }
    return Promise.resolve({
      ok: true as const,
      value: {
        schema: [{ id: 'id' as const, kind: 'id' as const, nullable: false }],
        rows: rows(),
      },
      timings,
    });
  }
}

test('principal handles, pagination, and streams exist only on the principal handler', async () => {
  const principalResults = new FakePrincipalResults();
  const principalHandler = createPrincipalResultHttpHandler(principalResults, {
    authenticatePrincipal() {
      return Promise.resolve({ ok: true, context: principalContext() });
    },
  });
  const agentAttempt = await httpHandler(new Request(
    'https://example.test/v0/principal-results',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executionReceipt: 'er-test', pageSize: 10 }),
    },
  ));
  assert.equal(agentAttempt.status, 404);

  const opened = await principalHandler(new Request(
    'https://example.test/v0/principal-results',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executionReceipt: 'er-test', pageSize: 10 }),
    },
  ));
  const openText = await opened.text();
  assert.equal(openText.includes('principal-handle'), true);
  assert.equal(openText.includes('principal-secret'), true);

  await principalHandler(new Request(
    'https://example.test/v0/principal-results/principal-handle?cursor=cursor-2',
  ));
  assert.equal(principalResults.cursorSeen, 'cursor-2');
  const streamed = await principalHandler(new Request(
    'https://example.test/v0/principal-results/principal-handle/stream',
  ));
  assert.equal(streamed.headers.get('content-type'), 'application/x-ndjson');
  assert.equal((await streamed.text()).includes('principal-secret'), true);
});
