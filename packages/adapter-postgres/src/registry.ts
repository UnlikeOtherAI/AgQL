import type {
  ResolvedDatasetBinding,
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
} from '@agql/contracts';

import type {
  PostgresAdapterConfig,
  PostgresCollationBinding,
  PostgresDatasetBinding,
  PostgresEmbeddingBinding,
  PostgresQualityProfile,
} from './types.ts';

function sameType(
  left: ResolvedFieldBinding['type'],
  right: ResolvedFieldBinding['type'],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'money' && right.kind === 'money') {
    return left.currency === right.currency;
  }
  if (left.kind === 'text' && right.kind === 'text') {
    return left.collation.id === right.collation.id
      && left.collation.version === right.collation.version;
  }
  if (left.kind === 'enum' && right.kind === 'enum') {
    return left.codes.length === right.codes.length
      && left.codes.every((code, index) => code === right.codes[index]);
  }
  if (left.kind === 'instant' && right.kind === 'instant') {
    return left.precision === right.precision;
  }
  return true;
}

function sameDataset(left: ResolvedDatasetBinding, right: ResolvedDatasetBinding): boolean {
  return left.logicalId === right.logicalId
    && left.physical === right.physical
    && left.bindingVersion === right.bindingVersion;
}

function sameEmbedding(
  left: ResolvedEmbeddingBinding,
  right: ResolvedEmbeddingBinding,
): boolean {
  return left.name === right.name
    && left.specReference === right.specReference
    && left.specVersion === right.specVersion
    && left.physical === right.physical
    && left.dimension === right.dimension
    && left.metric === right.metric
    && left.vectorEncoding === right.vectorEncoding
    && left.model.id === right.model.id
    && left.model.revision === right.model.revision
    && left.inputTransformId === right.inputTransformId
    && left.privacyClass === right.privacyClass;
}

export class RuntimeRegistry {
  readonly #config: PostgresAdapterConfig;

  public constructor(config: PostgresAdapterConfig) {
    this.#config = config;
  }

  public dataset(binding: ResolvedDatasetBinding): PostgresDatasetBinding | undefined {
    return this.#config.datasets.find((candidate) => sameDataset(candidate.dataset, binding));
  }

  public datasetByPhysical(physical: string): PostgresDatasetBinding | undefined {
    return this.#config.datasets.find((candidate) => candidate.dataset.physical === physical);
  }

  public field(
    dataset: PostgresDatasetBinding,
    binding: ResolvedFieldBinding,
  ): ResolvedFieldBinding | undefined {
    return dataset.fields.find((candidate) => candidate.logicalId === binding.logicalId
      && candidate.physical === binding.physical
      && candidate.nullable === binding.nullable
      && sameType(candidate.type, binding.type));
  }

  public embedding(
    dataset: PostgresDatasetBinding,
    binding: ResolvedEmbeddingBinding,
  ): PostgresEmbeddingBinding | undefined {
    return dataset.embeddings.find((candidate) => sameEmbedding(candidate.embedding, binding));
  }

  public embeddingByPhysical(
    physical: ResolvedEmbeddingBinding['physical'],
  ): { readonly dataset: PostgresDatasetBinding; readonly binding: PostgresEmbeddingBinding }
    | undefined {
    for (const dataset of this.#config.datasets) {
      const binding = dataset.embeddings.find(
        (candidate) => candidate.embedding.physical === physical,
      );
      if (binding !== undefined) return { dataset, binding };
    }
    return undefined;
  }

  public collation(id: string, version: string): PostgresCollationBinding | undefined {
    return this.#config.collations.find(
      (candidate) => candidate.id === id && candidate.version === version,
    );
  }

  public quality(id: string): PostgresQualityProfile | undefined {
    return this.#config.qualityProfiles.find((candidate) => candidate.id === id);
  }

  public get config(): PostgresAdapterConfig {
    return this.#config;
  }
}
