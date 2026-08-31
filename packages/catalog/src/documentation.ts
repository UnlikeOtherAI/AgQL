import type {
  AccessRule,
  CapabilityProfile,
  CatalogDocument,
  DatasetDocument,
  FieldDocument,
} from '@agql/schemas';

import { deriveEmbeddingSearchPolicy } from './policy.ts';
import type { Scope } from './scope.ts';
import { accessRuleAllows } from './policy.ts';

export interface ModelFieldDocumentation {
  readonly id: string;
  readonly definition: FieldDocument;
  readonly operations: readonly string[];
}

export interface ModelEmbeddingDocumentation {
  readonly name: string;
  readonly spec: string;
}

export interface ModelDatasetDocumentation {
  readonly id: string;
  readonly description: string;
  readonly profiles: readonly CapabilityProfile[];
  readonly fields: readonly ModelFieldDocumentation[];
  readonly embeddings: readonly ModelEmbeddingDocumentation[];
}

export interface ModelCatalogDocumentation {
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly datasets: readonly ModelDatasetDocumentation[];
}

function datasetVisible(dataset: DatasetDocument, scope: Scope): boolean {
  if (scope.partitions.kind === 'nothing') return false;
  if (dataset.rowScope.kind === 'none') return scope.partitions.kind === 'unpartitioned';
  if (scope.partitions.kind !== 'values') return false;
  return dataset.rowScope.dimensions.every(
    (dimension) => (scope.partitions.kind === 'values'
      && (scope.partitions.values[dimension]?.length ?? 0) > 0),
  );
}

function allowed(rule: AccessRule, scope: Scope): boolean {
  return accessRuleAllows(rule, scope);
}

function fieldOperations(dataset: DatasetDocument, field: string, scope: Scope): readonly string[] {
  const policy = dataset.fieldPolicies[field];
  if (policy === undefined) return [];
  const operations: string[] = [];
  if (allowed(policy.select.model, scope)) operations.push('select');
  if (allowed(policy.filter.model, scope)) operations.push('filter');
  if (allowed(policy.group.model, scope)) operations.push('group');
  if (allowed(policy.order.model, scope)) operations.push('order');
  for (const [aggregate, access] of Object.entries(policy.aggregate)) {
    if (allowed(access.model, scope)) operations.push(`aggregate:${aggregate}`);
  }
  if (allowed(policy.lexicalSearch.model, scope)) operations.push('lexicalSearch');
  return operations;
}

function documentedFields(
  dataset: DatasetDocument,
  scope: Scope,
): readonly ModelFieldDocumentation[] {
  const result: ModelFieldDocumentation[] = [];
  for (const [id, field] of Object.entries(dataset.fields)) {
    const operations = fieldOperations(dataset, id, scope);
    if (operations.length === 0) continue;
    result.push({
      id,
      definition: field,
      operations,
    });
  }
  return result;
}

function documentedEmbeddings(
  catalog: CatalogDocument,
  dataset: DatasetDocument,
  scope: Scope,
): readonly ModelEmbeddingDocumentation[] {
  const result: ModelEmbeddingDocumentation[] = [];
  for (const [name, reference] of Object.entries(dataset.embeddings)) {
    const spec = catalog.embeddingSpecs[reference];
    if (spec === undefined) continue;
    const policy = deriveEmbeddingSearchPolicy(dataset, name, spec);
    if (!policy.ok || !allowed(policy.value.model, scope)) continue;
    result.push({ name, spec: reference });
  }
  return result;
}

function documentedProfiles(
  dataset: DatasetDocument,
  fields: readonly ModelFieldDocumentation[],
  embeddings: readonly ModelEmbeddingDocumentation[],
): readonly CapabilityProfile[] {
  const selectable = fields.some((field) => field.operations.includes('select'));
  const orderableId = fields.some(
    (field) => field.id === dataset.idField && field.operations.includes('order'),
  );
  const aggregatable = fields.some((field) => field.operations.some(
    (operation) => operation === 'group' || operation.startsWith('aggregate:'),
  ));
  const lexical = fields.some((field) => field.operations.includes('lexicalSearch'));
  return dataset.profiles.filter((profile) => {
    if (profile === 'records.v0') return selectable && orderableId;
    if (profile === 'aggregate.v0') return aggregatable;
    if (profile === 'retrieve.semantic.v0') return embeddings.length > 0;
    if (profile === 'retrieve.hybrid.v0') return embeddings.length > 0 && lexical;
    return false;
  });
}

/** RFC §4/§6 progressive disclosure from the same scoped vocabulary used to compile. */
export function deriveModelCatalogDocumentation(
  catalog: CatalogDocument,
  scope: Scope,
): ModelCatalogDocumentation {
  const datasets: ModelDatasetDocumentation[] = [];
  for (const [id, dataset] of Object.entries(catalog.datasets)) {
    if (!datasetVisible(dataset, scope)) continue;
    const fields = documentedFields(dataset, scope);
    const embeddings = documentedEmbeddings(catalog, dataset, scope);
    const profiles = documentedProfiles(dataset, fields, embeddings);
    if (profiles.length === 0) continue;
    datasets.push({
      id,
      description: dataset.description,
      profiles,
      fields,
      embeddings,
    });
  }
  return {
    catalogVersion: catalog.catalogVersion,
    policyVersion: catalog.policyVersion,
    datasets,
  };
}
