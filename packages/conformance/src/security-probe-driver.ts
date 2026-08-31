import { canonicalizeJcs } from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

import type { ExactAdapterDriver, ExactQueryObservation } from './exact-driver.ts';
import type { ExactFixture } from './exact-fixtures.ts';
import { isJsonArray, isJsonObject, jsonObject } from './json-shape.ts';
import type { SecurityCase } from './security-expansion.ts';
import type { SecurityFixture } from './security-fixtures.ts';
import type {
  SecurityCaseObservation,
  SecurityExecutionMetadata,
  SecurityProbeExecutor,
} from './security.ts';

const RECEIPT_FAMILIES = new Set([
  'security.write-to-search',
  'security.delete-to-search',
  'security.embedding-migration-split',
]);
const COMPILE_REFUSAL_FAMILIES = new Set([
  'security.embedding-permission-compile-refusal',
  'security.hidden-catalog-probe-shape',
]);

function selectedText(probe: SecurityCase, name: string, fallback: string): string {
  const value = probe.selected[name];
  return typeof value === 'string' ? value : fallback;
}

function generatedFixture(fixture: SecurityFixture, probe: SecurityCase): ExactFixture {
  const allowed = selectedText(probe, 'allowedTenant', 'allowed');
  const denied = selectedText(probe, 'deniedTenant', 'denied');
  const expectedId = `eligible-${probe.caseIndex}`;
  const query: Record<string, JsonValue> = {
    version: '0', mode: 'retrieve', from: 'documents', select: ['documents.id'],
    search: {
      kind: 'semantic',
      using: COMPILE_REFUSAL_FAMILIES.has(fixture.id) ? 'not-available@9' : 'body@1',
      text: `security ${fixture.id} ${probe.caseIndex}`,
      accuracy: 'exact', quality: 'exact-oracle-v0',
    },
    take: 3,
  };
  if (RECEIPT_FAMILIES.has(fixture.id)) {
    query.afterWrite = {
      receipt: 'wr_0123456789abcdefghijklmnopqrstuvwxyz', require: ['record'], timeoutMs: 0,
    };
  }
  const source: JsonValue = {
    format: 'agql-exact-fixture/0.1', id: `${fixture.id}.${probe.caseIndex}`,
    rule: fixture.rule, requiresProfile: 'retrieve.semantic.v0',
    catalog: {
      version: 'security-probe-v1',
      embeddingSpecs: [{
        id: 'body@1', sourceFields: ['documents.body'], inputTransform: 'security-runtime-v1',
        model: { id: 'security-runtime', revision: 'security-runtime-revision' }, dimension: 2,
        metric: 'cosine', vectorEncoding: 'float32', chunking: 'none', privacyClass: 'internal',
      }],
      datasets: [{
        id: 'documents', description: 'Security probe records.', idField: 'documents.id',
        profiles: ['retrieve.semantic.v0'], embeddings: { body: 'body@1' },
        rowScope: { kind: 'partitions', dimensions: ['documents.tenant'] },
        fields: [
          { id: 'documents.id', description: 'Stable id.', kind: 'id', nullable: false },
          { id: 'documents.tenant', description: 'Tenant.', kind: 'text', nullable: false,
            normalization: 'NFC', collation: 'unicode-codepoint-v0' },
          { id: 'documents.body', description: 'Body.', kind: 'text', nullable: false,
            normalization: 'NFC', collation: 'unicode-codepoint-v0' },
        ],
      }],
    },
    scope: {
      principal: 'security:probe', capabilities: ['semanticSearch:body@1'],
      partitions: { 'documents.tenant': [allowed] }, budgets: { rows: 10 },
      expiresAt: '2099-01-01T00:00:00Z',
    },
    seed: [
      { record: { id: expectedId, tenant: allowed, body: 'eligible' },
        derived: { 'embedding:body@1': [1, 0] } },
      { record: { id: `unauthorized-${probe.caseIndex}`, tenant: denied, body: 'secret' },
        derived: { 'embedding:body@1': [1, 0] } },
    ],
    query,
    execution: { anchor: '2024-01-01T00:00:00Z',
      runtimeEmbedder: { spec: 'body@1', queryVector: [1, 0] } },
    expected: {},
  };
  return {
    sourcePath: `generated:${fixture.id}`, id: fixture.id, rule: fixture.rule,
    requiresProfile: 'retrieve.semantic.v0', value: jsonObject(source, `generated:${fixture.id}`),
    expected: {},
  };
}

function metadata(
  adapter: ExactAdapterDriver, fixture: SecurityFixture, probe: SecurityCase, state: string,
): SecurityExecutionMetadata {
  return {
    adapterVersion: adapter.version, bindingVersion: 'binding:security-probe-v1',
    engineVersion: '0.0.0',
    state: { fixture: fixture.id, caseIndex: probe.caseIndex,
      stateOrder: probe.selected.stateOrder ?? 'not-declared', execution: state },
  };
}

function refusalCode(observation: ExactQueryObservation): string | undefined {
  if (observation.kind !== 'refusal') return undefined;
  const error = observation.errors[0];
  if (error === undefined) return undefined;
  if (!isJsonObject(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function returnedIds(observation: ExactQueryObservation): readonly string[] | undefined {
  if (observation.kind !== 'success' || !isJsonObject(observation.semantic)) return undefined;
  const rows = observation.semantic.rows;
  if (rows === undefined || !isJsonArray(rows)) return undefined;
  const ids: string[] = [];
  for (const row of rows) {
    if (!isJsonObject(row)) return undefined;
    const id = row['documents.id'];
    if (typeof id !== 'string') return undefined;
    ids.push(id);
  }
  return ids;
}

function invariantFailure(
  fixture: SecurityFixture, probe: SecurityCase, observation: ExactQueryObservation,
): string | undefined {
  if (observation.kind === 'exception') return `engine/adapter exception: ${observation.message}`;
  if (COMPILE_REFUSAL_FAMILIES.has(fixture.id)) {
    return observation.backendCalls === 0 && refusalCode(observation) === 'REFERENCE_NOT_AVAILABLE'
      ? undefined : `expected pre-backend reference refusal, got ${observation.kind}`;
  }
  if (RECEIPT_FAMILIES.has(fixture.id)) {
    const code = refusalCode(observation);
    return observation.backendCalls === 0 && (code === 'FRESHNESS_UNAVAILABLE'
      || code === 'AFTER_WRITE_TIMEOUT') ? undefined
      : `afterWrite proceeded before required visibility: ${code ?? observation.kind}`;
  }
  const ids = returnedIds(observation);
  const expected = `eligible-${probe.caseIndex}`;
  if (ids === undefined || ids.some((id) => id !== expected) || observation.backendCalls < 2) {
    return `scope boundary returned ${canonicalizeJcs(ids ?? null)} instead of only ${expected}`;
  }
  if (observation.kind !== 'success') return 'retrieval did not produce a success result';
  return canonicalizeJcs(observation.semantic).includes(`unauthorized-${probe.caseIndex}`)
    ? 'unauthorized logical content crossed the adapter result boundary' : undefined;
}

export function createSecurityProbeExecutor(adapter: ExactAdapterDriver): SecurityProbeExecutor {
  return {
    adapterId: adapter.id,
    async execute(fixture, probe): Promise<SecurityCaseObservation> {
      const generated = generatedFixture(fixture, probe);
      const query = generated.value.query;
      const run = await adapter.run(generated, [{ name: 'probe', query: query ?? null }]);
      const observation = run.observations.probe;
      if (observation === undefined) {
        return { kind: 'violation', actual: 'driver omitted probe observation',
          diff: 'Every expanded probe must execute its engine/adapter request.',
          metadata: metadata(adapter, fixture, probe, 'omitted') };
      }
      if (observation.kind === 'declined') {
        return { kind: 'blocked', capability: 'adapter-profile:retrieve.semantic.v0',
          reason: observation.reason, metadata: metadata(adapter, fixture, probe, 'declined') };
      }
      const failure = invariantFailure(fixture, probe, observation);
      return failure === undefined
        ? { kind: 'pass', metadata: metadata(adapter, fixture, probe, 'executed') }
        : { kind: 'violation', actual: failure,
          diff: 'The live engine/adapter execution did not uphold this probe family invariant.',
          metadata: metadata(adapter, fixture, probe, 'violation') };
    },
  };
}
