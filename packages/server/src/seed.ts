import { readFile } from 'node:fs/promises';

import { ScopeSchema } from '@agql/catalog';
import { HmacExecutionReceiptCodec } from '@agql/mcp';
import {
  InstantValueSchema,
  validateIngestDocument,
} from '@agql/schemas';
import type { IngestDocument } from '@agql/schemas';

import { createPostgresDeployment } from './bindings.ts';
import {
  DEFAULT_SOURCE_ID,
  loadCatalog,
  readServerConfig,
} from './config.ts';
import { DeterministicEmbedderRegistry, validateDeterministicCatalog } from './embedder.ts';
import { ServerRuntime } from './runtime.ts';
import { applicationSecret } from './service.ts';

interface SeedRecord {
  readonly dataset: string;
  readonly id: string;
  readonly value: Readonly<Record<string, unknown>>;
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

async function records(): Promise<readonly SeedRecord[]> {
  const path = new URL('../../../examples/starter/seed.jsonl', import.meta.url);
  const content = await readFile(path, 'utf8');
  return content.split('\n').flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [seedRecord(JSON.parse(line) as unknown, index + 1)];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TypeError(`examples/starter/seed.jsonl line ${index + 1}: ${detail}`);
    }
  });
}

function documents(rows: readonly SeedRecord[]): readonly IngestDocument[] {
  const groups = new Map<string, SeedRecord[]>();
  for (const row of rows) {
    const existing = groups.get(row.dataset);
    if (existing === undefined) groups.set(row.dataset, [row]);
    else existing.push(row);
  }
  return [...groups.entries()].map(([dataset, entries]) => {
    const document = validateIngestDocument({
      mode: 'insertOnly',
      dataset,
      idempotencyKey: `starter-seed-${dataset}-v1`,
      embeddingPolicy: 'catalog',
      records: entries.map((record) => ({ id: record.id, value: record.value })),
    });
    if (!document.ok) {
      throw new TypeError(
        `Starter ingest for ${dataset} is invalid: ${document.errors[0].message}`,
      );
    }
    return document.value;
  });
}

async function main(): Promise<void> {
  const config = readServerConfig();
  const catalog = await loadCatalog(config.catalogPath);
  validateDeterministicCatalog(catalog);
  const deployment = createPostgresDeployment(catalog, {
    databaseUrl: config.databaseUrl,
    tokenSecret: applicationSecret(config.appKeys),
  });
  try {
    await deployment.provision();
    const runtime = new ServerRuntime({
      sourceId: DEFAULT_SOURCE_ID,
      catalog,
      binding: deployment.binding,
      adapter: deployment.adapter,
      embedders: new DeterministicEmbedderRegistry(),
      receiptCodec: new HmacExecutionReceiptCodec(applicationSecret(config.appKeys)),
    });
    const scope = ScopeSchema.parse({
      principal: 'agql:starter-seed',
      capabilities: ['ingest.canonical.v0'],
      partitions: { kind: 'unpartitioned' },
      budgets: {
        maximumQueries: 1_000,
        maximumExactScanRecords: 10_000,
        maximumCandidateRecords: 1_000,
      },
      expiresAt: '9999-12-31T23:59:59Z',
    });
    const seed = await records();
    for (const document of documents(seed)) {
      const result = await runtime.putRecords({
        credentialKind: 'agent',
        scope,
        requestAnchor: InstantValueSchema.parse('2026-01-01T00:00:00Z'),
        authMs: 0,
      }, { source: DEFAULT_SOURCE_ID, document });
      if (!result.ok) throw new TypeError(`Starter ingest was refused: ${result.errors[0].code}`);
    }
    process.stdout.write(`${JSON.stringify({ event: 'seed.completed', records: seed.length })}\n`);
  } finally {
    await deployment.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agql seed failed: ${message}\n`);
  process.exitCode = 1;
});
