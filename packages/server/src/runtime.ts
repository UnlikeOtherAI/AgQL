import { createHash } from 'node:crypto';

import type { PostgresAdapter } from '@agql/adapter-postgres';
import type {
  ResolvedEmbeddingBinding,
  RuntimeOwnedVector,
  WriteReceipt,
} from '@agql/contracts';
import {
  assembleResult,
  compileQuery,
  executeIngest,
  executeQuery,
} from '@agql/engine';
import type {
  EngineBinding,
  EngineError,
  EngineQueryAdapter,
  RuntimeEmbedderRegistry,
} from '@agql/engine';
import type {
  HmacExecutionReceiptCodec,
} from '@agql/mcp';
import type {
  AgentRequestContext,
  ExplainQueryValue,
  PutRecordsOperationInput,
  QueryOperationInput,
  QueryRuntime,
  RunQueryValue,
  RuntimeOutcome,
  RuntimeTimings,
} from '@agql/mcp';
import {
  QUERY_LIMITS,
  NormalizedTextSchema,
  SafeIntegerSchema,
  canonicalizeJcs,
  referenceNotAvailable,
} from '@agql/schemas';
import type {
  CatalogDocument,
  IngestDocument,
  QueryDocument,
  RecordValue,
} from '@agql/schemas';

import { transformedEmbeddingText } from './embedder.ts';

const ENGINE_VERSION = '0.0.0';
const MODEL_PREVIEW_LIMIT = SafeIntegerSchema.parse(100);
const MAX_INTERMEDIATE_BYTES = SafeIntegerSchema.parse(64_000_000);
const MAX_ESTIMATED_ROWS = SafeIntegerSchema.parse(1_000);

function safeDuration(startedAt: number): number {
  return SafeIntegerSchema.parse(Math.max(0, Math.round(performance.now() - startedAt)));
}

function timings(validationPolicyMs: number): RuntimeTimings {
  return {
    validationPolicyMs,
    queryEmbeddingMs: 0,
    adapterCompileMs: 0,
    backendMs: 0,
    fusionReleaseMs: 0,
  };
}

function rejected<T>(
  errors: readonly [EngineError, ...EngineError[]],
  current: RuntimeTimings,
): RuntimeOutcome<T> {
  return { ok: false, errors, timings: current };
}

function unavailableSource<T>(current: RuntimeTimings): RuntimeOutcome<T> {
  return { ok: false, errors: [referenceNotAvailable('/source')], timings: current };
}

function limits() {
  return {
    booleanNesting: SafeIntegerSchema.parse(QUERY_LIMITS.booleanNesting),
    inList: SafeIntegerSchema.parse(QUERY_LIMITS.inList),
    predicateNodes: SafeIntegerSchema.parse(QUERY_LIMITS.predicateNodes),
    select: SafeIntegerSchema.parse(QUERY_LIMITS.select),
    take: {
      records: SafeIntegerSchema.parse(QUERY_LIMITS.take.records),
      aggregate: SafeIntegerSchema.parse(QUERY_LIMITS.take.aggregate),
      retrieve: SafeIntegerSchema.parse(QUERY_LIMITS.take.retrieve),
    },
  } as const;
}

function channelPolicyHash(catalog: CatalogDocument): string {
  return `sha256:${createHash('sha256')
    .update(canonicalizeJcs({
      policyVersion: catalog.policyVersion,
      datasets: Object.fromEntries(Object.entries(catalog.datasets).map(([id, dataset]) => [id, {
        fieldPolicies: dataset.fieldPolicies,
        embeddingPolicies: dataset.embeddingPolicies,
      }])),
    }), 'utf8')
    .digest('hex')}`;
}

function resolvedEmbedding(
  catalog: CatalogDocument,
  binding: EngineBinding,
  datasetId: string,
  reference: string,
): ResolvedEmbeddingBinding | undefined {
  const dataset = catalog.datasets[datasetId];
  const datasetBinding = binding.datasets[datasetId];
  if (dataset === undefined || datasetBinding === undefined) return undefined;
  const matched = Object.entries(dataset.embeddings)
    .find(([, candidate]) => candidate === reference);
  if (matched === undefined) return undefined;
  const [name] = matched;
  const spec = catalog.embeddingSpecs[reference];
  const physical = datasetBinding.embeddings[name];
  if (spec === undefined || physical === undefined) return undefined;
  return {
    name,
    specReference: reference,
    specVersion: spec.version,
    physical: physical.physical,
    dimension: spec.dimension,
    metric: spec.metric,
    vectorEncoding: spec.vectorEncoding,
    model: spec.model,
    inputTransformId: spec.inputTransformId,
    privacyClass: spec.privacyClass,
  };
}

function retrievalReference(query: QueryDocument): string | undefined {
  if (query.mode !== 'retrieve') return undefined;
  return query.search.kind === 'semantic'
    ? query.search.using
    : query.search.semantic.using;
}

function retrievalText(query: QueryDocument): string | undefined {
  if (query.mode !== 'retrieve') return undefined;
  return query.search.kind === 'semantic'
    ? query.search.text
    : query.search.semantic.text;
}

interface ServerRuntimeOptions {
  readonly sourceId: string;
  readonly catalog: CatalogDocument;
  readonly binding: EngineBinding;
  readonly adapter: PostgresAdapter;
  readonly embedders: RuntimeEmbedderRegistry;
  readonly receiptCodec: HmacExecutionReceiptCodec;
}

/** Thin deployment runtime: engine owns meaning, Postgres owns only resolved-plan execution. */
export class ServerRuntime implements QueryRuntime {
  readonly #sourceId: string;
  readonly #catalog: CatalogDocument;
  readonly #binding: EngineBinding;
  readonly #adapter: PostgresAdapter;
  readonly #embedders: RuntimeEmbedderRegistry;
  readonly #receipts: HmacExecutionReceiptCodec;

  public constructor(options: ServerRuntimeOptions) {
    this.#sourceId = options.sourceId;
    this.#catalog = options.catalog;
    this.#binding = options.binding;
    this.#adapter = options.adapter;
    this.#embedders = options.embedders;
    this.#receipts = options.receiptCodec;
  }

  async #queryVector(query: QueryDocument): Promise<RuntimeOwnedVector | undefined> {
    const reference = retrievalReference(query);
    const text = retrievalText(query);
    if (reference === undefined || text === undefined) return undefined;
    const embedding = resolvedEmbedding(this.#catalog, this.#binding, query.from, reference);
    if (embedding === undefined) return undefined;
    const embedder = this.#embedders.resolve(embedding);
    if (embedder === undefined) return undefined;
    return embedder.embed({ embedding, text: NormalizedTextSchema.parse(text) });
  }

  #queryAdapter(): EngineQueryAdapter<Parameters<PostgresAdapter['query']['execute']>[0]> {
    return {
      descriptor: {
        ...this.#adapter.descriptor,
        profiles: ['records.v0', 'aggregate.v0', 'retrieve.semantic.v0', 'retrieve.hybrid.v0'],
      },
      query: this.#adapter.query,
      ...(this.#adapter.visibility === undefined ? {} : { visibility: this.#adapter.visibility }),
    };
  }

  async #compile(context: AgentRequestContext, input: QueryOperationInput) {
    const dataset = this.#catalog.datasets[input.query.from];
    if (dataset !== undefined && !dataset.capabilityTags.every((tag) =>
      context.scope.capabilities.includes(tag))) {
      return { ok: false as const, errors: [referenceNotAvailable('/from')] as const };
    }
    const vector = await this.#queryVector(input.query);
    return compileQuery({
      query: input.query,
      catalog: this.#catalog,
      scope: context.scope,
      anchor: context.requestAnchor,
      channel: 'model',
      limits: limits(),
      calendar: {
        timezone: 'UTC',
        timezoneDatabase: 'fixed-offset',
        weekStart: 'monday',
        fiscalDayStart: '00:00:00',
      },
      binding: this.#binding,
      adapter: this.#adapter.descriptor,
      costGate: {
        estimate: {
          estimatedRows: input.query.take,
          estimatedCandidateRecords: input.query.mode === 'retrieve'
            ? input.query.take
            : SafeIntegerSchema.parse(0),
          estimatedIntermediateBytes: SafeIntegerSchema.parse(input.query.take * 65_536),
          selectiveFilterFields: [],
        },
        maximumEstimatedRows: MAX_ESTIMATED_ROWS,
        maximumIntermediateBytes: MAX_INTERMEDIATE_BYTES,
      },
      qualityCertifications: [],
      ...(vector === undefined ? {} : { vector }),
    });
  }

  public async explainQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<ExplainQueryValue>> {
    const startedAt = performance.now();
    const current = timings(safeDuration(startedAt));
    if (input.source !== this.#sourceId) return unavailableSource(current);
    const compiled = await this.#compile(context, input);
    const elapsed = timings(safeDuration(startedAt));
    if (!compiled.ok) return rejected(compiled.errors, elapsed);
    return {
      ok: true,
      value: {
        sourceQueryHash: compiled.value.plan.sourceQueryHash,
        effectivePlanHash: compiled.value.plan.effectivePlanHash,
        resultSchema: compiled.value.explain.resultShape,
        determinism: compiled.value.explain.determinism,
        projection: `Resolved ${compiled.value.plan.mode} query against ${input.source}.`,
        pushdown: compiled.value.explain.pushdown,
        compensation: compiled.value.explain.compensation,
        cost: {
          verdict: 'ok',
          estimatedRows: compiled.value.explain.cost.estimatedRows,
        },
        notes: [],
      },
      timings: elapsed,
    };
  }

  public async runQuery(
    context: AgentRequestContext,
    input: QueryOperationInput,
  ): Promise<RuntimeOutcome<RunQueryValue>> {
    const startedAt = performance.now();
    const current = timings(safeDuration(startedAt));
    if (input.source !== this.#sourceId) return unavailableSource(current);
    const vector = await this.#queryVector(input.query);
    const executed = await executeQuery({
      query: input.query,
      catalog: this.#catalog,
      scope: context.scope,
      anchor: context.requestAnchor,
      channel: 'model',
      limits: limits(),
      calendar: {
        timezone: 'UTC',
        timezoneDatabase: 'fixed-offset',
        weekStart: 'monday',
        fiscalDayStart: '00:00:00',
      },
      binding: this.#binding,
      adapter: this.#adapter.descriptor,
      costGate: {
        estimate: {
          estimatedRows: input.query.take,
          estimatedCandidateRecords: input.query.mode === 'retrieve'
            ? input.query.take
            : SafeIntegerSchema.parse(0),
          estimatedIntermediateBytes: SafeIntegerSchema.parse(input.query.take * 65_536),
          selectiveFilterFields: [],
        },
        maximumEstimatedRows: MAX_ESTIMATED_ROWS,
        maximumIntermediateBytes: MAX_INTERMEDIATE_BYTES,
      },
      qualityCertifications: [],
      ...(vector === undefined ? {} : { vector }),
    }, this.#queryAdapter());
    const elapsed = timings(safeDuration(startedAt));
    if (!executed.ok) return rejected(executed.errors, elapsed);
    const result = assembleResult({
      compiled: executed.value.compiled,
      execution: executed.value.execution,
      engineVersion: ENGINE_VERSION,
      adapterVersion: this.#adapter.descriptor.version,
      release: {
        policies: [],
        previewRowLimit: MODEL_PREVIEW_LIMIT,
        channelPolicyFingerprint: channelPolicyHash(this.#catalog),
      },
      replayTier: 'auditable',
      principalResultAvailable: false,
      timings: {
        authMs: SafeIntegerSchema.parse(context.authMs),
        validationPolicyMs: SafeIntegerSchema.parse(elapsed.validationPolicyMs),
        queryEmbeddingMs: SafeIntegerSchema.parse(0),
        adapterCompileMs: SafeIntegerSchema.parse(0),
        backendMs: SafeIntegerSchema.parse(0),
        fusionReleaseMs: SafeIntegerSchema.parse(0),
      },
      executionSnapshotTier: 'transaction',
      ...(executed.value.observedReceipt === undefined
        ? {}
        : { observedReceipt: executed.value.observedReceipt }),
    });
    if (!result.ok) return rejected(result.errors, elapsed);
    const plan = executed.value.compiled.plan;
    return {
      ok: true,
      value: {
        envelope: result.value.result,
        executionReceipt: this.#receipts.sign({
          version: '0',
          source: input.source,
          sourceQueryHash: plan.sourceQueryHash,
          effectivePlanHash: plan.effectivePlanHash,
          scopeFingerprint: executed.value.compiled.scopeFingerprint,
          principal: context.scope.principal,
          expiresAt: context.scope.expiresAt,
          catalogVersion: this.#catalog.catalogVersion,
          policyVersion: this.#catalog.policyVersion,
        }),
      },
      timings: elapsed,
    };
  }

  async #writeEmbeddings(
    document: IngestDocument,
    outcomes: readonly { readonly id: string; readonly status: 'accepted' | 'refused';
      readonly version: number | null }[],
  ): Promise<EngineError | undefined> {
    const dataset = this.#catalog.datasets[document.dataset];
    const datasetBinding = this.#binding.datasets[document.dataset];
    if (dataset === undefined || datasetBinding === undefined) {
      return undefined;
    }
    const indexWrites = this.#adapter.embeddingWrites;
    if (document.mode === 'delete') {
      for (const [index, record] of document.records.entries()) {
        const outcome = outcomes[index];
        if (outcome?.status !== 'accepted' || outcome.version === null) continue;
        for (const reference of Object.values(dataset.embeddings)) {
          const embedding = resolvedEmbedding(
            this.#catalog,
            this.#binding,
            document.dataset,
            reference,
          );
          if (embedding === undefined) {
            return {
              code: 'SEMANTIC_INVALID',
              message: 'The runtime embedding binding is incomplete.',
              path: '/dataset',
              alternatives: ['Provision the exact catalog binding before ingestion.'],
            };
          }
          const compiled = await indexWrites.compile({
            kind: 'delete',
            recordId: record.id,
            representation: embedding.physical,
            sourceVersion: SafeIntegerSchema.parse(outcome.version),
            idempotencyKey: `${document.idempotencyKey}:embedding:${reference}:${record.id}`,
          });
          if (compiled.kind === 'refusal') return compiled.refusal;
          const executed = await indexWrites.execute(compiled.value);
          if (executed.kind === 'refusal') return executed.refusal;
        }
      }
      return undefined;
    }
    for (const [index, record] of document.records.entries()) {
      const outcome = outcomes[index];
      if (outcome?.status !== 'accepted' || outcome.version === null) continue;
      for (const [name, reference] of Object.entries(dataset.embeddings)) {
        const spec = this.#catalog.embeddingSpecs[reference];
        const physical = datasetBinding.embeddings[name];
        const embedding = resolvedEmbedding(
          this.#catalog,
          this.#binding,
          document.dataset,
          reference,
        );
        if (spec === undefined || physical === undefined || embedding === undefined) {
          return {
            code: 'SEMANTIC_INVALID',
            message: 'The runtime embedding binding is incomplete.',
            path: '/dataset',
            alternatives: ['Provision the exact catalog binding before ingestion.'],
          };
        }
        const mutation = await this.#embeddingPutMutation(
          spec,
          embedding,
          record.id,
          record.value,
          physical.physical,
          SafeIntegerSchema.parse(outcome.version),
          `${document.idempotencyKey}:embedding:${reference}:${record.id}`,
        );
        if (mutation instanceof Error) {
          return {
            code: 'SEMANTIC_INVALID',
            message: 'The runtime could not produce the required deterministic embedding.',
            path: '/embeddingPolicy',
            alternatives: ['Use complete canonical text values for every embedding source field.'],
          };
        }
        const compiled = await indexWrites.compile(mutation);
        if (compiled.kind === 'refusal') return compiled.refusal;
        const executed = await indexWrites.execute(compiled.value);
        if (executed.kind === 'refusal') return executed.refusal;
      }
    }
    return undefined;
  }

  async #embeddingPutMutation(
    spec: NonNullable<CatalogDocument['embeddingSpecs'][string]>,
    embedding: ResolvedEmbeddingBinding,
    recordId: string,
    value: Readonly<Record<string, RecordValue>>,
    representation: ResolvedEmbeddingBinding['physical'],
    sourceVersion: number,
    idempotencyKey: string,
  ) {
    try {
      const embedder = this.#embedders.resolve(embedding);
      if (embedder === undefined) return new Error('No runtime embedder is bound.');
      const vector = await embedder.embed({
        embedding,
        text: NormalizedTextSchema.parse(transformedEmbeddingText(spec, value)),
      });
      return {
        kind: 'put' as const,
        recordId,
        representation,
        vector,
        sourceVersion: SafeIntegerSchema.parse(sourceVersion),
        idempotencyKey,
      };
    } catch {
      return new Error('The deterministic embedder rejected this record.');
    }
  }

  public async putRecords(
    context: AgentRequestContext,
    input: PutRecordsOperationInput,
  ): Promise<RuntimeOutcome<WriteReceipt>> {
    const startedAt = performance.now();
    const current = timings(safeDuration(startedAt));
    if (input.source !== this.#sourceId) return unavailableSource(current);
    const ingested = await executeIngest({
      document: input.document,
      catalog: this.#catalog,
      scope: context.scope,
      anchor: context.requestAnchor,
      binding: this.#binding,
      adapter: this.#adapter.descriptor,
    }, this.#adapter);
    const elapsed = timings(safeDuration(startedAt));
    if (!ingested.ok) return rejected(ingested.errors, elapsed);
    const embeddingError = await this.#writeEmbeddings(input.document, ingested.value.outcomes);
    if (embeddingError !== undefined) return rejected([embeddingError], elapsed);
    return { ok: true, value: ingested.value.writeReceipt, timings: elapsed };
  }
}
