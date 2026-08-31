import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { CatalogDocumentSchema } from '@agql/schemas';
import { ScopeSchema } from '@agql/catalog';
import type { CatalogPhysicalIdentifier } from '@agql/contracts';
import { Pool } from 'pg';
import { MCP_PROTOCOL_VERSION } from '@agql/mcp';

import {
  BearerKeyAuthenticator,
  createDeploymentServer,
  createPostgresDeployment,
} from './index.ts';
import type {
  ScopeResolver,
  ServerApplication,
  StructuredLogger,
} from './index.ts';

const databaseUrl = process.env.DATABASE_URL;
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
  catalogVersion: 'postgres-server-catalog',
  policyVersion: 'postgres-server-policy',
  datasets: {
    notes: {
      description: 'Server integration notes stored through the canonical ingest route.',
      idField: 'id',
      fields: {
        id: { kind: 'id', description: 'Stable note identifier.', nullable: false },
        body: {
          kind: 'text',
          description: 'Short note body returned to the agent channel.',
          nullable: false,
          collation: { id: 'unicode-codepoint-v0', version: '15.1' },
        },
      },
      profiles: ['records.v0', 'ingest.canonical.v0'],
      embeddings: {},
      rowScope: { kind: 'none', reason: 'Integration data is deliberately unpartitioned.' },
      capabilityTags: ['integration'],
      fieldPolicies: { id: fieldPolicy, body: fieldPolicy },
      embeddingPolicies: {},
    },
  },
  embeddingSpecs: {},
});

const quietLogger: StructuredLogger = { log() { return undefined; } };

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

function query() {
  return {
    version: '0',
    mode: 'records',
    from: 'notes',
    select: ['id', 'body'],
    order: [{ by: 'id', dir: 'asc' }],
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

function scopeResolver(): ScopeResolver {
  return {
    resolveAgentScope(principal) {
      return Promise.resolve(ScopeSchema.parse({
        principal: principal.subject,
        capabilities: ['ingest.canonical.v0'],
        partitions: { kind: 'unpartitioned' },
        budgets: {
          maximumQueries: 100,
          maximumExactScanRecords: 1_000,
          maximumCandidateRecords: 100,
        },
        expiresAt: '9999-12-31T23:59:59Z',
      }));
    },
  };
}

async function listen(application: ServerApplication): Promise<string> {
  await application.listen(0, '127.0.0.1');
  const address = application.address;
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

if (databaseUrl === undefined || databaseUrl.length === 0) {
  test('PostgreSQL-backed server integration (DATABASE_URL not configured)', {
    skip: 'Set DATABASE_URL to exercise server provisioning, ingest, and live Postgres queries.',
  }, () => undefined);
} else {
  test('server provisions through adapter, ingests through HTTP, and preserves protocol identities',
    async () => {
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
        application = createDeploymentServer({
          config: {
            port: 0,
            appKeys: [key],
            catalogPath: 'in-memory',
            databaseUrl,
            embedder: 'deterministic',
            logLevel: 'error',
          },
          catalog,
          deployment,
          identityAuthenticator: new BearerKeyAuthenticator([key]),
          scopeResolver: scopeResolver(),
          logger: quietLogger,
        });
        const base = await listen(application);
        const ingest = await fetch(`${base}/v0/records`, {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({
            source: 'default',
            mode: 'insertOnly',
            dataset: 'notes',
            idempotencyKey: 'postgres-server-test-seed-v1',
            embeddingPolicy: 'catalog',
            records: [{ id: 'note-1', value: { id: 'note-1', body: 'server integration row' } }],
          }),
        });
        assert.equal(ingest.status, 200);
        assert.equal(responseObject(await ingest.json()).status, 'accepted');

        const http = await fetch(`${base}/v0/query/run`, {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({ source: 'default', query: query() }),
        });
        assert.equal(http.status, 200);
        const httpPayload = responseObject(await http.json());
        assert.equal(httpPayload.status, 'ok');
        const preview = httpPayload.preview;
        assert.equal(Array.isArray(preview), true);
        assert.deepEqual(preview, [{ id: 'note-1', body: 'server integration row' }]);

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
              arguments: { source: 'default', query: query() },
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
        const httpProvenance = responseObject(httpPayload.provenance);
        const mcpProvenance = responseObject(mcpPayload.provenance);
        assert.equal(mcpProvenance.sourceQueryHash, httpProvenance.sourceQueryHash);
        assert.equal(mcpProvenance.effectivePlanHash, httpProvenance.effectivePlanHash);
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
