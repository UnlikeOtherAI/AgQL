import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type {
  AdapterOutcome,
  CatalogPhysicalIdentifier,
  QueryVectorDigest,
  RecordsLogicalPlan,
  ResolvedDatasetBinding,
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
  SemanticRetrieveLogicalPlan,
} from '@agql/contracts';
import {
  effectivePlanHash,
  fingerprintScope,
  InstantValueSchema,
  NormalizedTextSchema,
  SafeIntegerSchema,
  sourceQueryHash,
} from '@agql/schemas';
import { Pool } from 'pg';

import { createPostgresAdapter } from './adapter.ts';
import { PostgresProvisioner } from './provisioner.ts';
import type {
  PostgresAdapterConfig,
  PostgresCollationBinding,
  PostgresDatasetBinding,
} from './types.ts';

const databaseUrl = process.env.DATABASE_URL;

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function safe(value: number) {
  return SafeIntegerSchema.parse(value);
}

function success<T>(outcome: AdapterOutcome<T>): T {
  if (outcome.kind === 'refusal') {
    assert.fail(`${outcome.refusal.code}: ${outcome.refusal.message}`);
  }
  return outcome.value;
}

function roleSql(value: string): string {
  assert.match(value, /^[a-z][a-z0-9_]+$/u);
  return `"${value}"`;
}

function vector(values: readonly number[]) {
  const floats = new Float32Array(values);
  return {
    bytes: new Uint8Array(floats.buffer),
    encoding: 'float32' as const,
    dimension: safe(values.length),
    digest: `digest-${values.join('-')}` as QueryVectorDigest,
  };
}

if (databaseUrl === undefined || databaseUrl.length === 0) {
  test('real PostgreSQL + pgvector integration (DATABASE_URL not configured)', {
    skip: 'Set DATABASE_URL to run the real role, MVCC, receipt, FTS, and pgvector suite.',
  }, () => undefined);
} else {
  test('real PostgreSQL roles, MVCC queries, ingest receipts, and filtered pgvector',
    async (context) => {
      const suffix = randomBytes(6).toString('hex');
      const queryRole = `agql_q_${suffix}`;
      const writerRole = `agql_w_${suffix}`;
      const namespace = physical(`agql_test_${suffix}`);
      const tablePhysical = physical(`dataset_${suffix}`);
      const admin = new Pool({ connectionString: databaseUrl });
      const currentUser = await admin.query<{ readonly name: string }>(
        'SELECT current_user::text AS name',
      );
      const provisionerRole = currentUser.rows[0]?.name;
      assert.ok(provisionerRole !== undefined);
      await admin.query(`CREATE ROLE ${roleSql(queryRole)} NOLOGIN`);
      await admin.query(`CREATE ROLE ${roleSql(writerRole)} NOLOGIN`);
      const queryPool = new Pool({
        connectionString: databaseUrl,
        options: `-c role=${queryRole}`,
      });
      const writerPool = new Pool({
        connectionString: databaseUrl,
        options: `-c role=${writerRole}`,
      });
      context.after(async () => {
        await queryPool.end();
        await writerPool.end();
        await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS ${roleSql(queryRole)}`);
        await admin.query(`DROP ROLE IF EXISTS ${roleSql(writerRole)}`);
        await admin.end();
      });

      const databaseCollation = await admin.query<{ readonly version: string | null }>({
        text: 'SELECT pg_collation_actual_version($1::regcollation) AS version',
        values: ['pg_catalog."C"'],
      });
      const codeCollation: PostgresCollationBinding = {
        id: 'codepoint',
        version: 'test-codepoint-1',
        databaseVersion: databaseCollation.rows[0]?.version ?? null,
        schema: physical('pg_catalog'),
        name: physical('C'),
      };
      const textCollation: PostgresCollationBinding = {
        ...codeCollation,
        id: 'test-text',
        version: 'test-text-1',
      };
      const dataset: ResolvedDatasetBinding = {
        logicalId: 'notes',
        physical: tablePhysical,
        bindingVersion: 'test-binding-1',
      };
      const idField: ResolvedFieldBinding = {
        logicalId: 'id',
        physical: physical('record_id'),
        type: { kind: 'id' },
        nullable: false,
      };
      const tenantField: ResolvedFieldBinding = {
        logicalId: 'tenant',
        physical: physical('tenant_id'),
        type: { kind: 'text', collation: { id: 'test-text', version: 'test-text-1' } },
        nullable: false,
      };
      const bodyField: ResolvedFieldBinding = {
        logicalId: 'body',
        physical: physical('body_text'),
        type: { kind: 'text', collation: { id: 'test-text', version: 'test-text-1' } },
        nullable: false,
      };
      const embedding: ResolvedEmbeddingBinding = {
        name: 'body',
        specReference: 'body@1',
        specVersion: '1',
        physical: physical('body_vector'),
        dimension: safe(3),
        metric: 'cosine',
        vectorEncoding: 'float32',
        model: { id: 'fixture', revision: 'sha256:fixture' },
        inputTransformId: 'fixture-v1',
        privacyClass: 'internal',
      };
      const binding: PostgresDatasetBinding = {
        dataset,
        idField,
        fields: [idField, tenantField, bodyField],
        lexicalFields: [bodyField.physical],
        embeddings: [{
          embedding,
          visibilityName: 'embedding:body@1',
          annIndex: physical(`ann_${suffix}`),
        }],
      };
      const provisioner = new PostgresProvisioner({
        pool: admin,
        namespace,
        provisionerRole,
        queryRole,
        writerRole,
        codeCollation,
        collations: [textCollation],
      });
      const provisioned = await provisioner.provision({ binding });
      assert.deepEqual(provisioned, { kind: 'success' });
      await assert.rejects(
        queryPool.query(`INSERT INTO "${namespace}"."${tablePhysical}" DEFAULT VALUES`),
        (error: unknown) => error instanceof Error && /permission denied/iu.test(error.message),
      );

      const adapterConfig: PostgresAdapterConfig = {
        queryPool,
        writerPool,
        namespace,
        queryRole,
        writerRole,
        statementTimeoutMs: safe(5_000),
        exactScanAdmissionLimit: safe(100),
        tokenSecret: randomBytes(32),
        vectorByteOrder: 'littleEndian',
        codeCollation,
        collations: [textCollation],
        datasets: [binding],
        qualityProfiles: [{
          id: 'balanced',
          certificationReference: 'integration:balanced-v1',
          efSearch: safe(80),
          maxScanTuples: safe(5_000),
          maximumBooleanDepth: safe(2),
          certifiedPredicates: ['comparison', 'list', 'null', 'substring', 'instantRange'],
        }],
      };
      const adapter = createPostgresAdapter(adapterConfig);
      assert.deepEqual(adapter.descriptor.consistency.snapshots, ['transaction']);

      const scopeFingerprint = fingerprintScope({ tenant: 'a' });
      const ingest = success(await adapter.canonicalIngest.compile({
        mode: 'insertOnly',
        dataset,
        idField,
        scopeFingerprint,
        scope: {
          visibility: 'predicate',
          enforcement: 'mandatoryPushdown',
          predicates: [{
            kind: 'list',
            field: tenantField,
            op: 'in',
            values: [
              { kind: 'text', value: NormalizedTextSchema.parse('a') },
              { kind: 'text', value: NormalizedTextSchema.parse('b') },
            ],
          }],
        },
        idempotencyKey: `insert-${suffix}`,
        embeddingPolicy: 'catalog',
        records: [{
          id: 'a-1',
          values: [
            { field: tenantField, value: { kind: 'text', value: NormalizedTextSchema.parse('a') } },
            {
              field: bodyField,
              value: { kind: 'text', value: NormalizedTextSchema.parse('alpha memory') },
            },
          ],
        }, {
          id: 'b-1',
          values: [
            { field: tenantField, value: { kind: 'text', value: NormalizedTextSchema.parse('b') } },
            {
              field: bodyField,
              value: { kind: 'text', value: NormalizedTextSchema.parse('beta private') },
            },
          ],
        }],
      }));
      const receipt = success(await adapter.canonicalIngest.execute(ingest));
      const replay = success(await adapter.canonicalIngest.execute(ingest));
      assert.equal(replay.writeReceipt.receipt, receipt.writeReceipt.receipt);
      assert.equal(receipt.writeReceipt.records[0]?.visibility.record?.state, 'ready');
      assert.equal(
        receipt.writeReceipt.records[0]?.visibility['embedding:body@1']?.state,
        'pending',
      );

      for (const [recordId, components] of [
        ['a-1', [1, 0, 0]],
        ['b-1', [0.99, 0.01, 0]],
      ] as const) {
        const compiled = success(await adapter.embeddingWrites.compile({
          kind: 'put',
          recordId,
          representation: embedding.physical,
          vector: vector(components),
          sourceVersion: safe(1),
          idempotencyKey: `embedding-${recordId}-${suffix}`,
        }));
        success(await adapter.embeddingWrites.execute(compiled));
      }

      const sourceHash = sourceQueryHash({ integration: suffix });
      const effectiveHash = effectivePlanHash({
        sourceQueryHash: sourceHash,
        languageVersion: '0',
        catalogVersion: 'test-catalog',
        policyVersion: 'test-policy',
        scopeFingerprint,
      });
      const scope = {
        visibility: 'predicate' as const,
        enforcement: 'mandatoryPushdown' as const,
        predicates: [{
          kind: 'comparison' as const,
          field: tenantField,
          op: 'eq' as const,
          value: { kind: 'text' as const, value: NormalizedTextSchema.parse('a') },
        }] as const,
      };
      const recordsPlan: RecordsLogicalPlan = {
        languageVersion: '0',
        sourceQueryHash: sourceHash,
        effectivePlanHash: effectiveHash,
        dataset,
        scope,
        hardRowLimit: safe(10),
        take: safe(5),
        mode: 'records',
        profile: 'records.v0',
        projection: [
          { output: { logicalId: 'id', slot: safe(0) }, field: idField },
          { output: { logicalId: 'body', slot: safe(1) }, field: bodyField },
        ],
        order: [{ field: idField, direction: 'asc', nulls: 'last' }],
        tieBreak: {
          kind: 'recordId',
          order: { field: idField, direction: 'asc', nulls: 'last' },
        },
      };
      const recordsResult = success(
        await adapter.query.execute(success(await adapter.query.compile(recordsPlan))),
      );
      assert.equal(recordsResult.rows.length, 1);
      assert.deepEqual(recordsResult.rows[0]?.[0], { kind: 'id', value: 'a-1' });
      assert.equal(recordsResult.snapshot.kind, 'snapshot');
      if (recordsResult.snapshot.kind !== 'snapshot') assert.fail('Expected an MVCC snapshot.');
      assert.match(recordsResult.snapshot.value, /^snapshot\.v1\./u);

      const retrievalPlan: SemanticRetrieveLogicalPlan = {
        ...recordsPlan,
        mode: 'retrieve',
        profile: 'retrieve.semantic.v0',
        projection: [{ output: { logicalId: 'id', slot: safe(0) }, field: idField }],
        stableId: idField,
        search: {
          kind: 'semantic',
          embedding,
          vector: vector([1, 0, 0]),
          accuracy: 'approximate',
          qualityProfile: 'balanced',
          hardCandidateLimit: safe(9),
        },
      };
      const retrievalResult = success(
        await adapter.query.execute(success(await adapter.query.compile(retrievalPlan))),
      );
      assert.deepEqual(retrievalResult.rows.map((row) => row[0]), [
        { kind: 'id', value: 'a-1' },
      ]);
      assert.deepEqual(retrievalResult.ranks, [safe(1)]);

      let randomState = 0x51f15e;
      for (let probe = 0; probe < 24; probe += 1) {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        const tenant = (randomState & 1) === 0 ? 'a' : 'b';
        const matches = (randomState & 2) === 0;
        const needle = matches
          ? tenant === 'a' ? 'alpha' : 'beta'
          : tenant === 'a' ? 'private' : 'memory';
        const probePlan: SemanticRetrieveLogicalPlan = {
          ...retrievalPlan,
          scope: {
            visibility: 'predicate',
            enforcement: 'mandatoryPushdown',
            predicates: [{
              kind: 'comparison',
              field: tenantField,
              op: 'eq',
              value: { kind: 'text', value: NormalizedTextSchema.parse(tenant) },
            }],
          },
          filter: {
            kind: 'substring',
            field: bodyField,
            op: 'contains',
            value: NormalizedTextSchema.parse(needle),
            semantics: 'escaped-case-sensitive-substring',
          },
        };
        const probeResult = success(
          await adapter.query.execute(success(await adapter.query.compile(probePlan))),
        );
        for (const row of probeResult.rows) {
          assert.deepEqual(row[0], { kind: 'id', value: `${tenant}-1` });
        }
        assert.equal(probeResult.rows.length, matches ? 1 : 0);
      }

      const observed = success(await adapter.visibility?.observe({
        receipt: receipt.writeReceipt.receipt,
        require: ['record', 'embedding:body@1'],
        timeoutMs: safe(250),
        anchor: InstantValueSchema.parse('2026-01-01T00:00:00Z'),
        scopeFingerprint,
        scope: ingest.plan.scope,
        dataset,
        idField,
      }) ?? assert.fail('Visibility operations are required.'));
      assert.equal(observed.records[0]?.visibility['embedding:body@1']?.state, 'ready');
    });
}
