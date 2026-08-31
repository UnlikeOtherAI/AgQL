import type {
  ResolvedEmbeddingBinding,
  RuntimeOwnedVector,
} from '@agql/contracts';
import type { NormalizedText } from '@agql/schemas';

export interface EmbeddingRequest {
  readonly embedding: ResolvedEmbeddingBinding;
  readonly text: NormalizedText;
}

/** Runtime-owned seam: an adapter never receives text and cannot generate the vector. */
export interface RuntimeEmbedder {
  readonly specReference: string;
  readonly specVersion: string;
  embed(request: EmbeddingRequest): Promise<RuntimeOwnedVector>;
}

export interface RuntimeEmbedderRegistry {
  resolve(embedding: ResolvedEmbeddingBinding): RuntimeEmbedder | undefined;
}
