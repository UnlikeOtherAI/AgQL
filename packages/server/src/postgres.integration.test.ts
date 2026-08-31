import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { ScopeSchema } from '@agql/catalog';
import type { CatalogPhysicalIdentifier } from '@agql/contracts';
import { HmacExecutionReceiptCodec, MCP_PROTOCOL_VERSION } from '@agql/mcp';
import {
  CatalogDocumentSchema,
  InstantValueSchema,
  validateIngestDocument,
} from '@agql/schemas';
import type { CatalogDocument } from '@agql/schemas';
import { Pool } from 'pg';

import {
  applicationSecret,
  createDeploymentServer,
  createPostgresDeployment,
  DeterministicEmbedderRegistry,
  ServerRuntime,
} from './index.ts';
import type {
  PostgresDeployment,
  ServerApplication,
  StructuredLogger,
} from './index.ts';

const databaseUrl = process.env.DATABASE_URL;
const quietLogger: StructuredLogger = { log() { return undefined; } };
const starterCatalogPath = new URL('../../../examples/starter/catalog.json', import.meta.url);
const starterSeedPath = new URL('../../../examples/starter/seed.jsonl', import.meta.url);

interface SeedRecord {
  readonly dataset: string;
  readonly id: string;
  readonly value: Readonly<Record<string, unknown>>;
}

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function roleSql(value: string): string {
  assert.match(value, /^[a-z][a-z0-9_]+$/u);
  return `"${value}"`;
}

function responseObject(value: unknown): Readonly<Record<string, unknown>> {
  assert.notEqual(value, null);
  assert.equal(typeof value, 'object');
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seedRecord(value: unknown, line: number): SeedRecord {
  if (!isRecord(value) || typeof value.dataset !== 'string' || value.dataset.length === 0
    || typeof value.id !== 'string' || value.id.length === 0 || !isRecord(value.value)) {
    throw new TypeError(`examples/starter/seed.jsonl line ${line} is not a seed record.`);
  }
  return { dataset: value.dataset, id: value.id, value: value.value };
}

async function starterCatalog(): Promise<CatalogDocument> {
  const source = await readFile(starterCatalogPath, 'utf8');
  return CatalogDocumentSchema.parse(JSON.parse(source) as unknown);
}

async function starterSeedRecords(): Promise<readonly SeedRecord[]> {
  const source = await readFile(starterSeedPath, 'utf8');
  return source.split('\n').flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    return [seedRecord(JSON.parse(line) as unknown, index + 1)];
  });
}

function projectQuery() {
  return {
    version: '0',
    mode: 'records',
    from: 'projects',
    select: ['projects.id', 'projects.name'],
    order: [{ by: 'projects.id', dir: 'asc' }],
    take: 10,
  };
}

function taskQuery() {
  return {
    version: '0',
    mode: 'records',
    from: 'tasks',
    select: ['tasks.id', 'tasks.title'],
    order: [{ by: 'tasks.id', dir: 'asc' }],
    take: 10,
  };
}

function headers(key: string): Headers {
  return new Headers({
    authorization: `Bearer ${key}`,
    'agql-anchor': '2026-01-01T00:00:00Z',
    'content-type': 'application/json',
  });
}

async function listen(application: ServerApplication): Promise<string> {
  await application.listen(0, '127.0.0.1');
  const address = application.address;
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function seedStarterCatalog(
  catalog: CatalogDocument,
  deployment: PostgresDeployment,
  key: string,
): Promise<void> {
  const runtime = new ServerRuntime({
    sourceId: 'default',
    catalog,
    binding: deployment.binding,
    adapter: deployment.adapter,
    embedders: new DeterministicEmbedderRegistry(),
    receiptCodec: new HmacExecutionReceiptCodec(applicationSecret([key])),
  });
  const grouped = new Map<string, SeedRecord[]>();
  for (const record of await starterSeedRecords()) {
    const records = grouped.get(record.dataset);
    if (records === undefined) grouped.set(record.dataset, [record]);
    else records.push(record);
  }
  const scope = ScopeSchema.parse({
    principal: 'agql:starter-integration-seed',
    capabilities: ['ingest.canonical.v0'],
    partitions: { kind: 'unpartitioned' },
    budgets: {
      maximumQueries: 1_000,
      maximumExactScanRecords: 10_000,
      maximumCandidateRecords: 1_000,
    },
    expiresAt: '9999-12-31T23:59:59Z',
  });
  for (const [dataset, records] of grouped) {
    const document = validateIngestDocument({
      mode: 'insertOnly',
      dataset,
      idempotencyKey: `starter-integration-seed-${dataset}-v1`,
      embeddingPolicy: 'catalog',
      records: records.map((record) => ({ id: record.id, value: record.value })),
    });
    assert.equal(document.ok, true);
    if (!document.ok) throw new TypeError('The starter seed document is invalid.');
    const result = await runtime.putRecords({
      credentialKind: 'agent',
      scope,
      requestAnchor: InstantValueSchema.parse('2026-01-01T00:00:00Z'),
      authMs: 0,
    }, { source: 'default', document: document.value });
    assert.equal(result.ok, true);
    if (!result.ok) throw new TypeError('The starter seed document was refused.');
  }
}

if (databaseUrl === undefined || databaseUrl.length === 0) {
  test('PostgreSQL-backed starter deployment integration (DATABASE_URL not configured)', {
    skip: 'Skipped: set DATABASE_URL to run the live Postgres starter deployment query test.',
  }, () => undefined);
} else {
  test('starter deployment returns seeded rows and hides unheld capability tags', async () => {
    const suffix = randomBytes(6).toString('hex');
    const namespace = physical(`agql_server_${suffix}`);
    const queryRole = `agql_q_${suffix}`;
    const writerRole = `agql_w_${suffix}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const current = await admin.query<{ readonly name: string }>(
      'SELECT current_user::text AS name',
    );
    const provisionerRole = current.rows[0]?.name;
    assert.notEqual(provisionerRole, undefined);
    if (provisionerRole === undefined) {
      throw new TypeError('PostgreSQL did not identify its role.');
    }
    await admin.query(`CREATE ROLE ${roleSql(queryRole)} NOLOGIN`);
    await admin.query(`CREATE ROLE ${roleSql(writerRole)} NOLOGIN`);
    const catalog = await starterCatalog();
    const deployment = createPostgresDeployment(catalog, {
      databaseUrl,
      tokenSecret: randomBytes(32),
      namespace,
      queryRole,
      writerRole,
      provisionerRole,
    });
    let application: ServerApplication | undefined;
    try {
      await deployment.provision();
      const key = 'postgres-server-test-key';
      await seedStarterCatalog(catalog, deployment, key);
      application = createDeploymentServer({
        config: {
          port: 0,
          appKeys: [key],
          appCapabilities: ['portfolio', 'starter'],
          catalogPath: fileURLToPath(starterCatalogPath),
          databaseUrl,
          embedder: 'deterministic',
          logLevel: 'error',
        },
        catalog,
        deployment,
        logger: quietLogger,
      });
      const base = await listen(application);
      const expectedProjects = [
        { 'projects.id': 'project-atlas', 'projects.name': 'Atlas migration' },
        { 'projects.id': 'project-beacon', 'projects.name': 'Beacon onboarding' },
        { 'projects.id': 'project-cirrus', 'projects.name': 'Cirrus reliability' },
      ];
      const http = await fetch(`${base}/v0/query/run`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ source: 'default', query: projectQuery() }),
      });
      assert.equal(http.status, 200);
      const httpPayload = responseObject(await http.json());
      assert.equal(httpPayload.status, 'ok');
      assert.deepEqual(httpPayload.preview, expectedProjects);

      const explained = await fetch(`${base}/v0/query/explain`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ source: 'default', query: projectQuery() }),
      });
      assert.equal(explained.status, 200);
      const explainedPayload = responseObject(await explained.json());
      assert.equal(explainedPayload.status, 'ok');

      const mcpHeaders = headers(key);
      mcpHeaders.set('mcp-protocol-version', MCP_PROTOCOL_VERSION);
      mcpHeaders.set('mcp-method', 'tools/call');
      mcpHeaders.set('mcp-name', 'run_query');
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'run_query',
            arguments: { source: 'default', query: projectQuery() },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      assert.equal(mcp.status, 200);
      const mcpPayload = responseObject(
        responseObject(responseObject(await mcp.json()).result).structuredContent,
      );
      assert.equal(mcpPayload.status, 'ok');
      assert.deepEqual(mcpPayload.preview, expectedProjects);

      const mcpExplainHeaders = new Headers(mcpHeaders);
      mcpExplainHeaders.set('mcp-name', 'explain_query');
      const mcpExplain = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpExplainHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'explain_query',
            arguments: { source: 'default', query: projectQuery() },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      assert.equal(mcpExplain.status, 200);
      const mcpExplainPayload = responseObject(
        responseObject(responseObject(await mcpExplain.json()).result).structuredContent,
      );
      assert.equal(mcpExplainPayload.status, 'ok');

      const unavailable = await fetch(`${base}/v0/query/run`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ source: 'default', query: taskQuery() }),
      });
      assert.equal(unavailable.status, 200);
      const unavailablePayload = responseObject(await unavailable.json());
      assert.equal(unavailablePayload.status, 'rejected');
      const errors = unavailablePayload.errors;
      if (!Array.isArray(errors) || errors.length === 0) {
        throw new TypeError('The unavailable reference response did not contain errors.');
      }
      const error = responseObject(errors[0]);
      assert.equal(error.code, 'REFERENCE_NOT_AVAILABLE');
      assert.deepEqual(error.alternatives, []);

      const unavailableExplain = await fetch(`${base}/v0/query/explain`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ source: 'default', query: taskQuery() }),
      });
      assert.equal(unavailableExplain.status, 200);
      const unavailableExplainPayload = responseObject(await unavailableExplain.json());
      assert.equal(unavailableExplainPayload.status, 'rejected');
      assert.deepEqual(unavailableExplainPayload.errors, errors);

      const unavailableMcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'run_query',
            arguments: { source: 'default', query: taskQuery() },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      assert.equal(unavailableMcp.status, 200);
      const unavailableMcpPayload = responseObject(
        responseObject(responseObject(await unavailableMcp.json()).result).structuredContent,
      );
      assert.equal(unavailableMcpPayload.status, 'rejected');
      assert.deepEqual(unavailableMcpPayload.errors, errors);

      const unavailableMcpExplain = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpExplainHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'explain_query',
            arguments: { source: 'default', query: taskQuery() },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      assert.equal(unavailableMcpExplain.status, 200);
      const unavailableMcpExplainPayload = responseObject(
        responseObject(responseObject(await unavailableMcpExplain.json()).result).structuredContent,
      );
      assert.equal(unavailableMcpExplainPayload.status, 'rejected');
      assert.deepEqual(unavailableMcpExplainPayload.errors, errors);
    } finally {
      if (application !== undefined) await application.close();
      else await deployment.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${roleSql(queryRole)}`);
      await admin.query(`DROP ROLE IF EXISTS ${roleSql(writerRole)}`);
      await admin.end();
    }
  });
}
