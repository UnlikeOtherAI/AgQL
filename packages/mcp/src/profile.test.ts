import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CatalogDocumentSchema,
  InstantValueSchema,
  SafeIntegerSchema,
  effectivePlanHash,
  executionFingerprint,
  fingerprintScope,
  queryDocumentJsonSchema,
  validateAndCanonicalizeQuery,
} from '@agql/schemas';
import type { AccessRule, QueryDocument } from '@agql/schemas';
import type {
  ModelReleasedValue,
  ResultEnvelope,
} from '@agql/contracts';

import {
  AgqlMcpServer,
  HmacExecutionReceiptCodec,
  InMemorySavedQueryRepository,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
  ScopedCatalogProfile,
  VerifiedSavedQueryStore,
  createMcpHttpHandler,
  toolInputJsonSchemas,
} from './index.ts';
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
} from './index.ts';

const timings: RuntimeTimings = {
  validationPolicyMs: 2,
  queryEmbeddingMs: 0,
  adapterCompileMs: 3,
  backendMs: 5,
  fusionReleaseMs: 1,
};

const allow = (requiredCapabilities: readonly string[] = []): AccessRule => ({
  effect: 'allow',
  requiredCapabilities: [...requiredCapabilities],
});
const deny: AccessRule = { effect: 'deny' };
const channels = (rule: AccessRule) => ({ model: rule, principal: allow() });
const fieldPolicy = (rule: AccessRule) => ({
  select: channels(rule),
  filter: channels(rule),
  group: channels(rule),
  order: channels(rule),
  aggregate: {
    count: channels(rule),
    countDistinct: channels(rule),
    sum: channels(rule),
    avg: channels(rule),
    min: channels(rule),
    max: channels(rule),
  },
  lexicalSearch: channels(rule),
});

function catalogDocument() {
  const dataset = (
    id: string,
    description: string,
    rule: AccessRule,
    capability: string,
  ) => ({
    description,
    idField: `${id}.id`,
    fields: {
      [`${id}.id`]: { kind: 'id' as const, description: 'Stable id.', nullable: false },
      [`${id}.body`]: {
        kind: 'text' as const,
        description: 'Visible note body.',
        nullable: false,
        collation: { id: 'unicode', version: '15.1' },
      },
      [`${id}.status`]: {
        kind: 'enum' as const,
        description: 'Visible note status.',
        nullable: false,
        values: [{ code: 'open', label: 'Open' }],
      },
    },
    profiles: ['records.v0' as const],
    embeddings: {},
    rowScope: { kind: 'none' as const, reason: 'Explicitly unpartitioned.' },
    capabilityTags: [capability],
    fieldPolicies: {
      [`${id}.id`]: fieldPolicy(rule),
      [`${id}.body`]: fieldPolicy(rule),
      [`${id}.status`]: fieldPolicy(rule),
    },
    embeddingPolicies: {},
  });
  return CatalogDocumentSchema.parse({
    schemaVersion: '0',
    catalogVersion: 'catalog-1',
    policyVersion: 'policy-1',
    datasets: {
      notes: dataset('notes', 'Scope-visible notes.', allow(), 'notes:read'),
      payroll: dataset('payroll', 'Scope-hidden payroll.', deny, 'payroll:read'),
    },
    embeddingSpecs: {},
  });
}

function context(principal = 'person:creator'): AgentRequestContext {
  return {
    credentialKind: 'agent',
    scope: {
      principal,
      capabilities: ['notes:read'],
      partitions: { kind: 'unpartitioned' },
      budgets: {
        maximumQueries: SafeIntegerSchema.parse(20),
        maximumExactScanRecords: SafeIntegerSchema.parse(1_000),
        maximumCandidateRecords: SafeIntegerSchema.parse(100),
      },
      expiresAt: InstantValueSchema.parse('2030-01-01T00:00:00Z'),
    },
    requestAnchor: InstantValueSchema.parse('2029-01-01T00:00:00Z'),
    authMs: 1,
  };
}

function query(): QueryDocument {
  return {
    version: '0',
    mode: 'records',
    from: 'notes',
    select: ['notes.id'],
    order: [{ by: 'notes.id', dir: 'asc' }],
    take: SafeIntegerSchema.parse(1),
  };
}

function identities(input: QueryOperationInput, requestContext: AgentRequestContext) {
  const canonical = validateAndCanonicalizeQuery(input.query);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new TypeError('The test query must be canonical.');
  const effective = effectivePlanHash({
    sourceQueryHash: canonical.value.sourceQueryHash,
    languageVersion: '0',
    catalogVersion: 'catalog-1',
    policyVersion: 'policy-1',
    scopeFingerprint: fingerprintScope(requestContext.scope),
  });
  return { source: canonical.value.sourceQueryHash, effective };
}

class FakeRuntime implements QueryRuntime {
  public explainQuery(
    requestContext: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<ExplainQueryValue>> {
    if (input.query.mode === 'records' && (
      input.query.from !== 'notes'
      || input.query.select.some((field) => !['notes.id', 'notes.body', 'notes.status'].includes(field))
      || input.query.order.some((item) => !['notes.id', 'notes.body', 'notes.status'].includes(item.by))
    )) {
      return Promise.resolve({
        ok: false,
        errors: [{
          code: 'REFERENCE_NOT_AVAILABLE',
          message: 'The referenced catalog item is not available in this scope.',
          path: '/select/0',
          alternatives: ['notes.body', 'notes.id', 'notes.status'],
        }],
        timings,
      });
    }
    const identity = identities(input, requestContext);
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
    requestContext: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<RunQueryValue>> {
    const identity = identities(input, requestContext);
    const provenance = {
      sourceQueryHash: identity.source,
      effectivePlanHash: identity.effective,
      executionFingerprint: executionFingerprint({
        effectivePlanHash: identity.effective,
        bindingVersion: 'binding-1',
        engineVersion: 'engine-1',
        adapterVersion: 'adapter-1',
        anchor: requestContext.requestAnchor,
        snapshot: { kind: 'none' },
        channelPolicyFingerprint: 'model-policy-1',
      }),
      catalogVersion: 'catalog-1',
      policyVersion: 'policy-1',
      bindingVersion: 'binding-1',
      engineVersion: 'engine-1',
      adapterVersion: 'adapter-1',
      scopeFingerprint: fingerprintScope(requestContext.scope),
      anchor: requestContext.requestAnchor,
      replayTier: 'exactReplay' as const,
    };
    const envelope: ResultEnvelope = {
      schema: [{ id: 'id', kind: 'id', nullable: false }],
      preview: [{ id: 'note-1' as ModelReleasedValue }],
      truncated: false,
      freshness: {
        writeVisibility: { kind: 'unconstrained' },
        executionSnapshot: { kind: 'none' },
      },
      determinism: { query: 'exact' },
      provenance,
      principalResultAvailable: true,
    };
    const overPermissive = Object.assign(envelope, {
      principalRows: [{ id: 'principal-secret' }],
      principalHandle: 'principal-handle-secret',
    });
    return Promise.resolve({
      ok: true,
      value: { envelope: overPermissive, executionReceipt: 'execution-receipt' },
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

class RejectingSavedQueries implements SavedQueryPort {
  public saveQuery(): Promise<RuntimeOutcome<never>> {
    return Promise.resolve({
      ok: false,
      errors: [{
        code: 'SEMANTIC_INVALID',
        message: 'No receipt was configured for this test.',
        path: '/executionReceipt',
        alternatives: ['Use the saved-query receipt test.'],
      }],
      timings,
    });
  }
}

function server() {
  return new AgqlMcpServer(
    new FakeRuntime(),
    new ScopedCatalogProfile([{ id: 'ops', catalog: catalogDocument() }]),
    new RejectingSavedQueries(),
    {
      serverName: 'agql-test',
      serverVersion: '1',
      discoveryTtlMs: 60_000,
      toolListTtlMs: 60_000,
      catalogTtlMs: 5_000,
    },
  );
}

function request(method: string, params: Readonly<Record<string, unknown>>, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function resultRecord(response: McpDispatchResponse): Readonly<Record<string, unknown>> {
  assert.ok('result' in response.body);
  assert.equal(typeof response.body.result, 'object');
  return response.body.result as Readonly<Record<string, unknown>>;
}

test('the normative tool list is exact and embeds generated language schemas', () => {
  assert.deepEqual(MCP_TOOLS.map((tool) => tool.name), [
    'search_catalog',
    'describe_catalog',
    'lookup_values',
    'explain_query',
    'run_query',
    'put_records',
    'save_query',
  ]);
  const properties = toolInputJsonSchemas.run_query.properties;
  assert.equal(typeof properties, 'object');
  assert.notEqual(properties, null);
  if (properties === null || typeof properties !== 'object') return;
  assert.deepEqual((properties as Readonly<Record<string, unknown>>).query,
    queryDocumentJsonSchema);
  assert.equal(JSON.stringify(toolInputJsonSchemas).includes('rawSql'), false);
});

test('deferred constructs are readable tool results, not protocol errors', async () => {
  const response = await server().dispatch(request('tools/call', {
    name: 'run_query',
    arguments: { source: 'ops', query: { ...query(), join: { dataset: 'other' } } },
  }), context());
  assert.equal(response.httpStatus, 200);
  const result = resultRecord(response);
  const structured = result.structuredContent;
  assert.equal(typeof structured, 'object');
  assert.notEqual(structured, null);
  assert.equal(JSON.stringify(structured).includes('UNSUPPORTED_IN_V0'), true);
});

test('model projection strips principal-only runtime extras structurally', async () => {
  const response = await server().dispatch(request('tools/call', {
    name: 'run_query',
    arguments: { source: 'ops', query: query() },
  }), context());
  const serialized = JSON.stringify(resultRecord(response));
  assert.equal(serialized.includes('principal-secret'), false);
  assert.equal(serialized.includes('principal-handle-secret'), false);
  assert.equal(serialized.includes('principalResultAvailable'), true);
  assert.equal(serialized.includes('execution-receipt'), true);
});

test('catalog resources are generated, scope-narrowed, and privately cacheable', async () => {
  const response = await server().dispatch(request('resources/list', {}), context());
  const result = resultRecord(response);
  assert.equal(result.cacheScope, 'private');
  const serialized = JSON.stringify(result.resources);
  assert.equal(serialized.includes('notes'), true);
  assert.equal(serialized.includes('payroll'), false);
});

test('capability-hidden and nonexistent datasets are indistinguishable on discovery routes', () => {
  const complete = catalogDocument();
  const notes = complete.datasets.notes;
  if (notes === undefined) throw new TypeError('The discovery fixture requires notes.');
  const full = new ScopedCatalogProfile([{ id: 'ops', catalog: complete }]);
  const withoutPayroll = new ScopedCatalogProfile([{
    id: 'ops',
    catalog: CatalogDocumentSchema.parse({ ...complete, datasets: { notes } }),
  }]);
  const requestContext = context();

  assert.deepEqual(
    full.search(requestContext, 'ops', 'payroll', 20),
    full.search(requestContext, 'ops', 'not-a-dataset', 20),
  );
  assert.deepEqual(
    full.describe(requestContext, 'ops', ['payroll']),
    full.describe(requestContext, 'ops', ['not-a-dataset']),
  );
  assert.deepEqual(
    full.lookupValues(requestContext, 'ops', 'payroll.status', '', 20),
    full.lookupValues(requestContext, 'ops', 'not-a-field', '', 20),
  );
  assert.deepEqual(full.resources(requestContext), withoutPayroll.resources(requestContext));
  assert.deepEqual(
    full.readResource(requestContext, 'agql://catalog/ops'),
    withoutPayroll.readResource(requestContext, 'agql://catalog/ops'),
  );
  assert.deepEqual(
    full.readResource(requestContext, 'agql://catalog/ops/datasets/payroll'),
    full.readResource(requestContext, 'agql://catalog/ops/datasets/not-a-dataset'),
  );
});

test('discovered field references round trip through describe and explain_query', async () => {
  const profile = new ScopedCatalogProfile([{ id: 'ops', catalog: catalogDocument() }]);
  const discovery = profile.search(context(), 'ops', 'stable', 20);
  assert.equal(discovery.ok, true);
  if (!discovery.ok) return;
  const id = discovery.value.matches.find((item) => item.kind === 'field')?.ref;
  assert.equal(id, 'notes.id');
  if (id === undefined) return;

  const description = profile.describe(context(), 'ops', [id]);
  assert.equal(description.ok, true);
  if (!description.ok) return;
  assert.deepEqual(description.value.datasets[0]?.fields.map((field) => field.id), [id]);

  const response = await server().dispatch(request('tools/call', {
    name: 'explain_query',
    arguments: {
      source: 'ops',
      query: {
        ...query(),
        select: [id],
        order: [{ by: id, dir: 'asc' }],
      },
    },
  }), context());
  assert.equal(response.httpStatus, 200);
  const result = resultRecord(response);
  assert.equal(JSON.stringify(result.structuredContent).includes('REFERENCE_NOT_AVAILABLE'), false);
});

test('the Streamable HTTP binding is stateless and rejects initialize', async () => {
  const handler = createMcpHttpHandler(server(), {
    authenticate() {
      return Promise.resolve({ ok: true, context: context() });
    },
  });
  const message = request('tools/list', {});
  const httpRequest = new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify(message),
  });
  const listed = await handler(httpRequest);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.has('mcp-session-id'), false);

  const initialize = request('initialize', {}, 2);
  const rejected = await handler(new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'initialize',
    },
    body: JSON.stringify(initialize),
  }));
  assert.equal(rejected.status, 404);
});

test('saved queries verify receipts and always compile with the reader scope', async () => {
  const creator = context('person:creator');
  const canonical = validateAndCanonicalizeQuery(query());
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const planHash = effectivePlanHash({
    sourceQueryHash: canonical.value.sourceQueryHash,
    languageVersion: '0',
    catalogVersion: 'catalog-1',
    policyVersion: 'policy-1',
    scopeFingerprint: fingerprintScope(creator.scope),
  });
  const codec = new HmacExecutionReceiptCodec(new Uint8Array(32).fill(7));
  const receipt = codec.sign({
    version: '0',
    source: 'ops',
    sourceQueryHash: canonical.value.sourceQueryHash,
    effectivePlanHash: planHash,
    scopeFingerprint: fingerprintScope(creator.scope),
    principal: creator.scope.principal,
    expiresAt: '2029-06-01T00:00:00Z',
    catalogVersion: 'catalog-1',
    policyVersion: 'policy-1',
  });
  const store = new VerifiedSavedQueryStore(
    codec,
    { identity: () => ({ catalogVersion: 'catalog-1', policyVersion: 'policy-1' }) },
    new InMemorySavedQueryRepository(),
  );
  const saved = await store.saveQuery(creator, {
    source: 'ops',
    name: 'latest-notes',
    query: canonical.value.document,
    executionReceipt: receipt,
  });
  assert.equal(saved.ok, true);

  const reader = context('person:reader');
  let compiledPrincipal = '';
  const compiled = await store.compileForReader(reader, 'ops', 'latest-notes', {
    compile(readerContext) {
      compiledPrincipal = readerContext.scope.principal;
      return Promise.resolve({ ok: true, value: 'compiled', timings });
    },
  });
  assert.equal(compiled.ok, true);
  assert.equal(compiledPrincipal, 'person:reader');

  const changedPolicy = new VerifiedSavedQueryStore(
    codec,
    { identity: () => ({ catalogVersion: 'catalog-1', policyVersion: 'policy-2' }) },
    new InMemorySavedQueryRepository(),
  );
  const invalidated = await changedPolicy.saveQuery(creator, {
    source: 'ops',
    name: 'stale-policy-query',
    query: canonical.value.document,
    executionReceipt: receipt,
  });
  assert.equal(invalidated.ok, false);
});
