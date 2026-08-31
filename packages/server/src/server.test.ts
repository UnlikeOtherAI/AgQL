import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { CatalogDocumentSchema, validateIngestDocument } from '@agql/schemas';
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
  QueryOperationInput,
  QueryRuntime,
  RunQueryValue,
  RuntimeOutcome,
} from '@agql/mcp';
import { HmacExecutionReceiptCodec, MCP_PROTOCOL_VERSION } from '@agql/mcp';

import {
  ApplicationScopeResolver,
  BearerKeyAuthenticator,
  ServerAgentAuthenticator,
  ServerApplication,
  validateDeterministicCatalog,
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

const agentSecret = 'correct-key-0123456789abcdef0123456789';
const agentKey = {
  id: 'server-test-key-v1',
  secret: new TextEncoder().encode(agentSecret),
};
const receiptKey = {
  id: 'server-test-receipt-v1',
  secret: new TextEncoder().encode('receipt-secret-0123456789abcdef0123456789'),
};

function envelope(
  context: AgentRequestContext,
  input: QueryOperationInput,
): ResultEnvelope & { readonly principalOnly: { readonly id: 'principal-secret' } } {
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
    principalOnly: { id: 'principal-secret' },
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

  public putRecords(): Promise<RuntimeOutcome<never>> {
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

test('server listener protects MCP, HTTP, and principal channels', async () => {
  const events: string[] = [];
  const application = new ServerApplication({
    catalog,
    runtime: new TransportRuntime(),
    agentAuthenticator: new ServerAgentAuthenticator(
      new BearerKeyAuthenticator([agentKey]),
      new ApplicationScopeResolver(['test']),
    ),
    receiptCodec: new HmacExecutionReceiptCodec([receiptKey]),
    ready: () => Promise.resolve(),
    logger: {
      log(_level, event, fields) {
        events.push(`${event}:${JSON.stringify(fields)}`);
      },
    },
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

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
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
    assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer realm="agql"');
    assert.equal(object((await unauthenticated.json())).errors instanceof Array, true);

    const badKey = await fetch(`${base}/v0/query/run`, {
      method: 'POST',
      headers: headers('wrong-key'),
      body: JSON.stringify({ source: 'default', query }),
    });
    assert.equal(badKey.status, 401);
    assert.equal(badKey.headers.get('www-authenticate'), 'Bearer realm="agql"');

    const mcpHeaders = headers(agentSecret);
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
      headers: headers(agentSecret),
      body: JSON.stringify({ source: 'default', query }),
    });
    assert.equal(http.status, 200);
    const httpPayload = object(await http.json());
    assert.deepEqual(httpPayload, mcpPayload);
    assert.equal(typeof object(httpPayload.provenance).sourceQueryHash, 'string');
    assert.equal(typeof object(httpPayload.provenance).effectivePlanHash, 'string');

    const principalAttempt = await fetch(`${base}/v0/principal-results`, {
      method: 'POST',
      headers: headers(agentSecret),
      body: JSON.stringify({ executionReceipt: 'server-test-receipt', pageSize: 1 }),
    });
    assert.equal(principalAttempt.status, 401);
    assert.equal(JSON.stringify(httpPayload).includes('principal-secret'), false);
    assert.equal(JSON.stringify(mcpPayload).includes('principal-secret'), false);
    assert.equal(events.some((event) => event.includes('"principal":"app:server-test-key-v1"')),
      true);
    assert.equal(events.some((event) => event.includes(agentSecret)), false);
  } finally {
    await application.close();
  }
});

test('starter catalog and seed records validate through catalog and ingest boundaries',
  async () => {
  const catalogPath = new URL('../../../examples/starter/catalog.json', import.meta.url);
  const catalogValue = JSON.parse(await readFile(catalogPath, 'utf8')) as unknown;
  const starter = CatalogDocumentSchema.parse(catalogValue);
  validateDeterministicCatalog(starter);
  const seedPath = new URL('../../../examples/starter/seed.jsonl', import.meta.url);
  const seed = await readFile(seedPath, 'utf8');
  const rows = seed.split('\n').filter((line) => line.length > 0).map((line) =>
    JSON.parse(line) as Readonly<Record<string, unknown>>);
  const grouped = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
  for (const row of rows) {
    const dataset = row.dataset;
    assert.equal(typeof dataset, 'string');
    if (typeof dataset !== 'string') continue;
    grouped.set(dataset, [...(grouped.get(dataset) ?? []), row]);
  }
  for (const [dataset, records] of grouped) {
    const result = validateIngestDocument({
      mode: 'insertOnly',
      dataset,
      idempotencyKey: `starter-seed-${dataset}-v1`,
      embeddingPolicy: 'catalog',
      records: records.map((record) => ({ id: record.id, value: record.value })),
    });
    assert.equal(result.ok, true);
  }
});
