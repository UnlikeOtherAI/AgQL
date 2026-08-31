import {
  deriveModelCatalogDocumentation,
} from '@agql/catalog';
import type {
  ModelCatalogDocumentation,
  ModelDatasetDocumentation,
} from '@agql/catalog';
import {
  canonicalizeJcs,
  referenceNotAvailable,
} from '@agql/schemas';
import type { CatalogDocument } from '@agql/schemas';

import type {
  AgentRequestContext,
  CatalogDescriptionValue,
  CatalogSearchItem,
  CatalogSearchValue,
  LookupValuesValue,
} from './types.ts';
import type { InputResult } from './input.ts';

export interface CatalogSource {
  readonly id: string;
  readonly catalog: CatalogDocument;
}

export interface CatalogResourceDescriptor {
  readonly name: string;
  readonly title: string;
  readonly uri: string;
  readonly description: string;
  readonly mimeType: 'application/json';
  readonly annotations: {
    readonly audience: readonly ['assistant'];
    readonly priority: number;
  };
}

export interface CatalogResourceContents {
  readonly uri: string;
  readonly mimeType: 'application/json';
  readonly text: string;
}

function unavailable(path: string): InputResult<never> {
  return { ok: false, errors: [referenceNotAvailable(path)] };
}

function folded(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function matches(value: string, query: string): boolean {
  return folded(value).includes(folded(query));
}

function datasetOperations(dataset: ModelDatasetDocumentation): readonly string[] {
  return dataset.profiles.map((profile) => `profile:${profile}`);
}

function searchItems(documentation: ModelCatalogDocumentation): readonly CatalogSearchItem[] {
  const result: CatalogSearchItem[] = [];
  for (const dataset of documentation.datasets) {
    result.push({
      kind: 'dataset',
      ref: dataset.id,
      description: dataset.description,
      operations: datasetOperations(dataset),
    });
    for (const field of dataset.fields) {
      result.push({
        kind: 'field',
        ref: `${dataset.id}.${field.id}`,
        description: field.definition.description,
        operations: field.operations,
      });
    }
    for (const embedding of dataset.embeddings) {
      result.push({
        kind: 'embedding',
        ref: `${dataset.id}.${embedding.name}`,
        description: `Semantic search surface backed by ${embedding.spec}.`,
        operations: ['semanticSearch'],
      });
    }
  }
  return result;
}

function narrowedDataset(
  dataset: ModelDatasetDocumentation,
  fieldRef: string,
): ModelDatasetDocumentation | undefined {
  const field = dataset.fields.find((candidate) =>
    `${dataset.id}.${candidate.id}` === fieldRef);
  if (field !== undefined) return { ...dataset, fields: [field], embeddings: [] };
  const embedding = dataset.embeddings.find((candidate) =>
    `${dataset.id}.${candidate.name}` === fieldRef);
  if (embedding !== undefined) return { ...dataset, fields: [], embeddings: [embedding] };
  return undefined;
}

function mergeDescription(
  selected: Map<string, ModelDatasetDocumentation>,
  candidate: ModelDatasetDocumentation,
): void {
  const current = selected.get(candidate.id);
  if (current === undefined) {
    selected.set(candidate.id, candidate);
    return;
  }
  const fields = new Map(current.fields.map((field) => [field.id, field]));
  for (const field of candidate.fields) fields.set(field.id, field);
  const embeddings = new Map(current.embeddings.map((item) => [item.name, item]));
  for (const embedding of candidate.embeddings) embeddings.set(embedding.name, embedding);
  selected.set(candidate.id, {
    ...current,
    fields: [...fields.values()],
    embeddings: [...embeddings.values()],
  });
}

function resourceUri(source: string, dataset?: string): string {
  const root = `agql://catalog/${encodeURIComponent(source)}`;
  return dataset === undefined ? root : `${root}/datasets/${encodeURIComponent(dataset)}`;
}

/** Scope-derived discovery used by tools, MCP resources, and the HTTP equivalent. */
export class ScopedCatalogProfile {
  readonly #sources: readonly CatalogSource[];

  public constructor(sources: readonly CatalogSource[]) {
    this.#sources = [...sources];
  }

  #documentation(
    context: AgentRequestContext,
    source: string,
  ): InputResult<ModelCatalogDocumentation> {
    const found = this.#sources.find((candidate) => candidate.id === source);
    if (found === undefined) return unavailable('/source');
    const documentation = deriveModelCatalogDocumentation(found.catalog, context.scope);
    if (documentation.datasets.length === 0) return unavailable('/source');
    return { ok: true, value: documentation };
  }

  public search(
    context: AgentRequestContext,
    source: string,
    query: string,
    limit: number,
  ): InputResult<CatalogSearchValue> {
    const documentation = this.#documentation(context, source);
    if (!documentation.ok) return documentation;
    const found = searchItems(documentation.value).filter((item) =>
      matches(item.ref, query) || matches(item.description, query));
    return {
      ok: true,
      value: {
        catalogVersion: documentation.value.catalogVersion,
        policyVersion: documentation.value.policyVersion,
        matches: found.slice(0, limit),
      },
    };
  }

  public describe(
    context: AgentRequestContext,
    source: string,
    refs: readonly string[],
  ): InputResult<CatalogDescriptionValue> {
    const documentation = this.#documentation(context, source);
    if (!documentation.ok) return documentation;
    const selected = new Map<string, ModelDatasetDocumentation>();
    for (const [index, ref] of refs.entries()) {
      const whole = documentation.value.datasets.find((dataset) => dataset.id === ref);
      if (whole !== undefined) {
        selected.set(whole.id, whole);
        continue;
      }
      const narrowed = documentation.value.datasets
        .map((dataset) => narrowedDataset(dataset, ref))
        .find((dataset) => dataset !== undefined);
      if (narrowed === undefined) return unavailable(`/refs/${index}`);
      mergeDescription(selected, narrowed);
    }
    return {
      ok: true,
      value: {
        catalogVersion: documentation.value.catalogVersion,
        policyVersion: documentation.value.policyVersion,
        datasets: [...selected.values()],
      },
    };
  }

  public lookupValues(
    context: AgentRequestContext,
    source: string,
    fieldRef: string,
    query: string,
    limit: number,
  ): InputResult<LookupValuesValue> {
    const documentation = this.#documentation(context, source);
    if (!documentation.ok) return documentation;
    for (const dataset of documentation.value.datasets) {
      const field = dataset.fields.find((candidate) =>
        `${dataset.id}.${candidate.id}` === fieldRef);
      if (field?.definition.kind !== 'enum') continue;
      const values = field.definition.values.filter((value) =>
        matches(value.code, query) || matches(value.label, query));
      return { ok: true, value: { field: fieldRef, values: values.slice(0, limit) } };
    }
    return unavailable('/field');
  }

  public resources(context: AgentRequestContext): readonly CatalogResourceDescriptor[] {
    const resources: CatalogResourceDescriptor[] = [];
    for (const source of this.#sources) {
      const documentation = this.#documentation(context, source.id);
      if (!documentation.ok) continue;
      resources.push({
        name: `catalog:${source.id}`,
        title: `AgQL catalog ${source.id}`,
        uri: resourceUri(source.id),
        description: 'Scope-narrowed AgQL catalog index generated from the catalog kernel.',
        mimeType: 'application/json',
        annotations: { audience: ['assistant'], priority: 1 },
      });
      for (const dataset of documentation.value.datasets) {
        resources.push({
          name: `catalog:${source.id}:${dataset.id}`,
          title: `AgQL dataset ${dataset.id}`,
          uri: resourceUri(source.id, dataset.id),
          description: dataset.description,
          mimeType: 'application/json',
          annotations: { audience: ['assistant'], priority: 0.8 },
        });
      }
    }
    return resources;
  }

  public readResource(
    context: AgentRequestContext,
    uri: string,
  ): InputResult<CatalogResourceContents> {
    for (const source of this.#sources) {
      const documentation = this.#documentation(context, source.id);
      if (!documentation.ok) continue;
      if (uri === resourceUri(source.id)) {
        return {
          ok: true,
          value: { uri, mimeType: 'application/json', text: canonicalizeJcs(documentation.value) },
        };
      }
      for (const dataset of documentation.value.datasets) {
        if (uri !== resourceUri(source.id, dataset.id)) continue;
        return {
          ok: true,
          value: {
            uri,
            mimeType: 'application/json',
            text: canonicalizeJcs({
              catalogVersion: documentation.value.catalogVersion,
              policyVersion: documentation.value.policyVersion,
              dataset,
            }),
          },
        };
      }
    }
    return unavailable('/uri');
  }
}
