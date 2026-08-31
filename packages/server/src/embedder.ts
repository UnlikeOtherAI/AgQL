import { createHash } from 'node:crypto';

import type {
  QueryVectorDigest,
  ResolvedEmbeddingBinding,
  RuntimeOwnedVector,
} from '@agql/contracts';
import type {
  EmbeddingRequest,
  RuntimeEmbedder,
  RuntimeEmbedderRegistry,
} from '@agql/engine';
import { NormalizedTextSchema } from '@agql/schemas';
import type {
  CatalogDocument,
  EmbeddingSpecDocument,
  RecordValue,
} from '@agql/schemas';

export const DETERMINISTIC_MODEL_ID = 'deterministic-local-nonsemantic';
export const DETERMINISTIC_MODEL_REVISION = 'provider:deterministic-local-nonsemantic-4f2a9c7b';
export const DETERMINISTIC_INPUT_TRANSFORM = 'deterministic-join-nfc-v1';

function digest(value: Uint8Array): QueryVectorDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as QueryVectorDigest;
}

function seedFor(request: EmbeddingRequest): Buffer {
  return createHash('sha256')
    .update('agql-deterministic-embedder-v1\u0000', 'utf8')
    .update(request.embedding.specReference, 'utf8')
    .update('\u0000', 'utf8')
    .update(request.embedding.specVersion, 'utf8')
    .update('\u0000', 'utf8')
    .update(request.text, 'utf8')
    .digest();
}

function nextWord(state: number): number {
  let value = state ^ (state << 13);
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function vectorBytes(request: EmbeddingRequest): Uint8Array {
  const bytes = new Uint8Array(request.embedding.dimension * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seed = seedFor(request);
  let state = seed.readUInt32BE(0) ^ seed.readUInt32BE(4) ^ seed.readUInt32BE(8)
    ^ seed.readUInt32BE(12);
  for (let index = 0; index < request.embedding.dimension; index += 1) {
    state = nextWord(state);
    const unit = (state >>> 0) / 0x1_0000_0000;
    const value = unit * 2 - 1;
    view.setFloat32(index * 4, value === 0 ? 0.5 : value, true);
  }
  return bytes;
}

function vectorDigest(dimension: number, bytes: Uint8Array): QueryVectorDigest {
  const preimage = new Uint8Array('agql-vector-f32le-v0'.length + 1 + 4 + bytes.byteLength);
  const encoder = new TextEncoder();
  preimage.set(encoder.encode('agql-vector-f32le-v0'));
  const view = new DataView(preimage.buffer);
  view.setUint32('agql-vector-f32le-v0'.length + 1, dimension, false);
  preimage.set(bytes, 'agql-vector-f32le-v0'.length + 1 + 4);
  return digest(preimage);
}

function isDeterministicEmbedding(embedding: ResolvedEmbeddingBinding): boolean {
  return embedding.model.id === DETERMINISTIC_MODEL_ID
    && embedding.model.revision === DETERMINISTIC_MODEL_REVISION
    && embedding.inputTransformId === DETERMINISTIC_INPUT_TRANSFORM
    && embedding.vectorEncoding === 'float32';
}

/**
 * Reproducible local vectors for starter deployments. They encode bytes deterministically,
 * not semantic meaning; deployments must bind a real RuntimeEmbedder before relying on rank.
 */
export class DeterministicEmbedder implements RuntimeEmbedder {
  readonly #embedding: ResolvedEmbeddingBinding;

  public constructor(embedding: ResolvedEmbeddingBinding) {
    if (!isDeterministicEmbedding(embedding)) {
      throw new TypeError('A deterministic embedder may bind only the declared nonsemantic spec.');
    }
    this.#embedding = embedding;
  }

  public get specReference(): string {
    return this.#embedding.specReference;
  }

  public get specVersion(): string {
    return this.#embedding.specVersion;
  }

  public embed(request: EmbeddingRequest): Promise<RuntimeOwnedVector> {
    if (request.embedding.specReference !== this.#embedding.specReference
      || request.embedding.specVersion !== this.#embedding.specVersion
      || !isDeterministicEmbedding(request.embedding)) {
      return Promise.reject(
        new TypeError('The deterministic embedder was asked for another spec.'),
      );
    }
    const bytes = vectorBytes(request);
    return Promise.resolve({
      bytes,
      encoding: 'float32',
      dimension: this.#embedding.dimension,
      digest: vectorDigest(this.#embedding.dimension, bytes),
    });
  }
}

export class DeterministicEmbedderRegistry implements RuntimeEmbedderRegistry {
  public resolve(embedding: ResolvedEmbeddingBinding): RuntimeEmbedder | undefined {
    return isDeterministicEmbedding(embedding) ? new DeterministicEmbedder(embedding) : undefined;
  }
}

function deterministicSpec(spec: EmbeddingSpecDocument): boolean {
  return spec.model.id === DETERMINISTIC_MODEL_ID
    && spec.model.revision === DETERMINISTIC_MODEL_REVISION
    && spec.inputTransformId === DETERMINISTIC_INPUT_TRANSFORM
    && spec.vectorEncoding === 'float32';
}

/** Prevent a local nonsemantic generator from being mislabeled as a real embedding model. */
export function validateDeterministicCatalog(catalog: CatalogDocument): void {
  for (const [reference, spec] of Object.entries(catalog.embeddingSpecs)) {
    if (!deterministicSpec(spec)) {
      throw new TypeError(
        `EmbeddingSpec ${reference} does not declare the deterministic local nonsemantic model.`,
      );
    }
  }
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    for (const [name, reference] of Object.entries(dataset.embeddings)) {
      const spec = catalog.embeddingSpecs[reference];
      if (spec === undefined) throw new TypeError(`EmbeddingSpec ${reference} is unavailable.`);
      for (const fieldId of spec.sourceFields) {
        if (dataset.fields[fieldId]?.kind !== 'text') {
          throw new TypeError(
            `Deterministic embedding ${datasetId}.${name} requires text source field ${fieldId}.`,
          );
        }
      }
    }
  }
}

export function transformedEmbeddingText(
  spec: EmbeddingSpecDocument,
  value: Readonly<Record<string, RecordValue>>,
): string {
  if (!deterministicSpec(spec)) {
    throw new TypeError('The requested embedding uses an unsupported input transform.');
  }
  const fields: string[] = [];
  for (const field of spec.sourceFields) {
    const source = value[field];
    if (typeof source !== 'string') {
      throw new TypeError('A deterministic embedding source field must be a text value.');
    }
    fields.push(source);
  }
  return NormalizedTextSchema.parse(fields.join('\n'));
}
