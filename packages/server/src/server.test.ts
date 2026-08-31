import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { CatalogDocumentSchema } from '@agql/schemas';
import {
  effectivePlanHash,
  executionFingerprint,
  fingerprintScope,
  sourceQueryHash,
} from '@agql/schemas';
import type { ResultEnvelope } from '@agql/contracts';
import type {
  AgentRequestContext,
  ExplainQueryValue,
  PutRecordsOperationInput,
  QueryOperationInput,
  QueryRuntime,
  RunQueryValue,
  RuntimeOutcome,
} from '@agql/mcp';
import { MCP_PROTOCOL_VERSION } from '@agql/mcp';

import {
  ApplicationScopeResolver,
  BearerKeyAuthenticator,
  ServerAgentAuthenticator,
  ServerApplication,
} from './index.ts';

const allow = { effect: 'allow' as const, requiredCapabilities: [] };
const channels = { model: allow, principal: allow };
const fieldPolicy = {
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
  catalogVersion: 'server-test-catalog',
  policyVersion: 'server-test-policy',
  datasets: {
    notes: {
      description: 'Short operational notes for server transport testing.',
      idField: 'id',
      fields: {
        id: { kind: 'id', description: 'Stable note identifier.', nullable: false },
      },
      profiles: ['records.v0'],
      embeddings: {},
      rowScope: { kind: 'none', reason: 'The transport fixture is explicitly unpartitioned.' },
      capabilityTags: ['test'],
      fieldPolicies: { id: fieldPolicy },
      embeddingPolicies: {},
    },
  },
  embeddingSpecs: {},
});

const query = {
  version: '0' as const,
  mode: 'records' as const,
  from: 'notes',
  select: ['id'],
  order: [{ by: 'id', dir: 'asc' as const }],
  take: 1,
};

const runtimeTimings = {
  validationPolicyMs: 1,
  queryEmbeddingMs: 0,
  adapterCompileMs: 1,
  backendMs: 1,
  fusionReleaseMs: 1,
};

function envelope(context: AgentRequestContext, input: QueryOperationInput): ResultEnvelope {
  const source = sourceQueryHash(input.query);
  const scope = fingerprintScope(context.scope);
  const effective = effectivePlanHash({
    sourceQueryHash: source,
    languageVersion: '0',
    catalogVersion: catalog.catalogVersion,
    policyVersion: catalog.policyVersion,
    scopeFingerprint: scope,
  });
  return {
    schema: [{ id: 'id', kind: 'id', nullable: false }],
    preview: [{ id: 'note-1' as ResultEnvelope['preview'][number]['id'] }],
    truncated: false,
    freshness: {
      writeVisibility: { kind: 'unconstrained' },
      executionSnapshot: { kind: 'none' },
    },
    principalResultAvailable: false,
    determinism: { query: 'exact' },
    provenance: {
      sourceQueryHash: source,
      effectivePlanHash: effective,
      executionFingerprint: executionFingerprint({
        effectivePlanHash: effective,
        bindingVersion: 'server-test-binding',
        engineVersion: 'server-test-engine',
        adapterVersion: 'server-test-adapter',
        anchor: context.requestAnchor,
        snapshot: { kind: 'none' },
        channelPolicyFingerprint: 'server-test-channel-policy',
      }),
      catalogVersion: catalog.catalogVersion,
      policyVersion: catalog.policyVersion,
      bindingVersion: 'server-test-binding',
      engineVersion: 'server-test-engine',
      adapterVersion: 'server-test-adapter',
      scopeFingerprint: scope,
      anchor: context.requestAnchor,
      replayTier: 'exactReplay',
    },
  };
}

class TransportRuntime implements QueryRuntime {
  public explainQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<ExplainQueryValue>> {
    const result = envelope(context, input);
    return Promise.resolve({
      ok: true,
      value: {
        sourceQueryHash: result.provenance.sourceQueryHash,
        effectivePlanHash: result.provenance.effectivePlanHash,
        resultSchema: result.schema,
        determinism: result.determinism,
        projection: 'transport fixture',
        pushdown: ['scope'],
        compensation: [],
        cost: { verdict: 'ok', estimatedRows: 1 },
        notes: [],
      },
      timings: runtimeTimings,
    });
  }

  public runQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<RunQueryValue>> {
    return Promise.resolve({
      ok: true,
      value: { envelope: envelope(context, input), executionReceipt: 'server-test-receipt' },
      timings: runtimeTimings,
    });
  }

  public putRecords(
    _context: AgentRequestContext,
    _input: PutRecordsOperationInput,
  ): Promise<RuntimeOutcome<never>> {
    return Promise.resolve({
      ok: false,
      errors: [{
        code: 'UNSUPPORTED_PROFILE',
        message: 'The transport fixture does not accept writes.',
        path: '/mode',
        alternatives: ['Use the configured Postgres runtime for ingestion.'],
      }],
      timings: runtimeTimings,
    });
  }
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  assert.notEqual(value, null);
  assert.equal(typeof value, 'object');
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function listen(application: ServerApplication): Promise<string> {
  return application.listen(0, '127.0.0.1').then(() => {
    const address = application.address;
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  });
}

function headers(key?: string): Headers {
  const result = new Headers({
    'agql-anchor': '2029-01-01T00:00:00Z',
    'content-type': 'application/json',
  });
  if (key !== undefined) result.set('authorization', `Bearer ${key}`);
  return result;
}

function mcpBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'run_query',
      arguments: { source: 'default', query },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

test('server listener protects routes and keeps MCP, HTTP, and principal channels separate', async () => {
  const application = new ServerApplication({
    catalog,
    runtime: new TransportRuntime(),
    agentAuthenticator: new ServerAgentAuthenticator(
      new BearerKeyAuthenticator(['correct-key']),
      new ApplicationScopeResolver(),
    ),
  });
  const base = await listen(application);
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      version: '0.0.0',
      catalog: 'server-test-catalog',
    });

    const unauthenticated = await fetch(`${base}/v0/query/run`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ source: 'default', query }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(object((await unauthenticated.json())).errors instanceof Array, true);

    const badKey = await fetch(`${base}/v0/query/run`, {
      method: 'POST',
      headers: headers('wrong-key'),
      body: JSON.stringify({ source: 'default', query }),
    });
    assert.equal(badKey.status, 403);

    const mcpHeaders = headers('correct-key');
    mcpHeaders.set('mcp-protocol-version', MCP_PROTOCOL_VERSION);
    mcpHeaders.set('mcp-method', 'tools/call');
    mcpHeaders.set('mcp-name', 'run_query');
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(mcpBody()),
    });
    assert.equal(mcp.status, 200);
    const mcpPayload = object(object(object(await mcp.json()).result).structuredContent);

    const http = await fetch(`${base}/v0/query/run`, {
      method: 'POST',
      headers: headers('correct-key'),
      body: JSON.stringify({ source: 'default', query }),
    });
    assert.equal(http.status, 200);
    const httpPayload = object(await http.json());
    assert.deepEqual(httpPayload, mcpPayload);
    assert.equal(typeof object(httpPayload.provenance).sourceQueryHash, 'string');
    assert.equal(typeof object(httpPayload.provenance).effectivePlanHash, 'string');

    const principalAttempt = await fetch(`${base}/v0/principal-results`, {
      method: 'POST',
      headers: headers('correct-key'),
      body: JSON.stringify({ executionReceipt: 'server-test-receipt', pageSize: 1 }),
    });
    assert.equal(principalAttempt.status, 401);
    assert.equal(JSON.stringify(httpPayload).includes('principal-secret'), false);
    assert.equal(JSON.stringify(mcpPayload).includes('principal-secret'), false);
  } finally {
    await application.close();
  }
});
