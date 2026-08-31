import {
  CatalogDocumentSchema,
  type AgqlError,
  type CatalogDocument,
  type DatasetDocument,
  type LegalAlternatives,
  type ValidationResult,
  type WhereExpression,
  jsonPointer,
  validateDocument,
} from '@agql/schemas';

function semanticError(
  message: string,
  path: string,
  alternatives: LegalAlternatives,
): AgqlError {
  return { code: 'SEMANTIC_INVALID', message, path, alternatives };
}

function availableAlternatives(
  values: readonly string[],
  whenEmpty: string,
): LegalAlternatives {
  const first = values[0];
  return first === undefined ? [whenEmpty] : [first, ...values.slice(1)];
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function validateFieldCoverage(
  datasetId: string,
  dataset: DatasetDocument,
): AgqlError | undefined {
  if (dataset.fields[dataset.idField] === undefined) {
    return semanticError(
      'The dataset idField must reference a declared field.',
      jsonPointer(['datasets', datasetId, 'idField']),
      availableAlternatives(
        Object.keys(dataset.fields),
        'Declare at least one field before selecting idField.',
      ),
    );
  }
  for (const fieldId of Object.keys(dataset.fields)) {
    if (dataset.fieldPolicies[fieldId] === undefined) {
      return semanticError(
        'Every dataset field must have a field policy.',
        jsonPointer(['datasets', datasetId, 'fieldPolicies', fieldId]),
        ['Declare the missing field policy.'],
      );
    }
  }
  for (const policyField of Object.keys(dataset.fieldPolicies)) {
    if (dataset.fields[policyField] === undefined) {
      return semanticError(
        'A field policy must reference a field in the same dataset.',
        jsonPointer(['datasets', datasetId, 'fieldPolicies', policyField]),
        availableAlternatives(Object.keys(dataset.fields), 'Declare a field before its policy.'),
      );
    }
  }
  return undefined;
}

function validateDatasetLists(
  datasetId: string,
  dataset: DatasetDocument,
): AgqlError | undefined {
  const duplicateProfile = firstDuplicate(dataset.profiles);
  if (duplicateProfile !== undefined) {
    return semanticError(
      'Dataset profiles must not contain duplicates.',
      jsonPointer(['datasets', datasetId, 'profiles']),
      ['List each advertised profile once.'],
    );
  }
  const duplicateTag = firstDuplicate(dataset.capabilityTags);
  if (duplicateTag !== undefined) {
    return semanticError(
      'Dataset capability tags must not contain duplicates.',
      jsonPointer(['datasets', datasetId, 'capabilityTags']),
      ['List each capability tag once.'],
    );
  }
  for (const [fieldId, field] of Object.entries(dataset.fields)) {
    if (field.kind !== 'enum') continue;
    const duplicateCode = firstDuplicate(field.values.map((value) => value.code));
    if (duplicateCode !== undefined) {
      return semanticError(
        'Enum codes must be unique within one field.',
        jsonPointer(['datasets', datasetId, 'fields', fieldId, 'values']),
        ['Give every enum value one stable code.'],
      );
    }
  }
  return undefined;
}

function validateScopeDimensions(
  datasetId: string,
  dataset: DatasetDocument,
): AgqlError | undefined {
  if (dataset.rowScope.kind === 'none') return undefined;
  for (const [index, dimension] of dataset.rowScope.dimensions.entries()) {
    if (dataset.fields[dimension] === undefined) {
      return semanticError(
        'A row-scope dimension must reference a field in the same dataset.',
        jsonPointer(['datasets', datasetId, 'rowScope', 'dimensions', index]),
        availableAlternatives(Object.keys(dataset.fields), 'Declare a row-scope field.'),
      );
    }
  }
  return undefined;
}

interface PredicateReference {
  readonly field: string;
  readonly path: readonly (string | number)[];
}

function predicateReferences(
  expression: WhereExpression,
  path: readonly (string | number)[] = [],
): readonly PredicateReference[] {
  if (expression.kind === 'predicate') return [{ field: expression.field, path }];
  if (expression.kind === 'not') return predicateReferences(expression.item, [...path, 'item']);
  return expression.items.flatMap((item, index) =>
    predicateReferences(item, [...path, 'items', index]));
}

function validateDefaultFilters(
  datasetId: string,
  dataset: DatasetDocument,
): AgqlError | undefined {
  if (dataset.defaultFilters === undefined) return undefined;
  for (const reference of predicateReferences(dataset.defaultFilters)) {
    if (dataset.fields[reference.field] === undefined) {
      return semanticError(
        'A catalog default filter must reference a field in the same dataset.',
        jsonPointer(['datasets', datasetId, 'defaultFilters', ...reference.path, 'field']),
        availableAlternatives(Object.keys(dataset.fields), 'Declare a default-filter field.'),
      );
    }
  }
  return undefined;
}

function validateEmbeddings(
  catalog: CatalogDocument,
  datasetId: string,
  dataset: DatasetDocument,
): AgqlError | undefined {
  for (const [name, reference] of Object.entries(dataset.embeddings)) {
    const spec = catalog.embeddingSpecs[reference];
    if (spec === undefined) {
      return semanticError(
        'A dataset embedding must reference a declared EmbeddingSpec.',
        jsonPointer(['datasets', datasetId, 'embeddings', name]),
        availableAlternatives(
          Object.keys(catalog.embeddingSpecs),
          'Declare an EmbeddingSpec before binding it.',
        ),
      );
    }
    for (const [index, field] of spec.sourceFields.entries()) {
      if (dataset.fields[field] === undefined) {
        return semanticError(
          'An EmbeddingSpec source field must exist in every dataset that binds the spec.',
          jsonPointer(['embeddingSpecs', reference, 'sourceFields', index]),
          availableAlternatives(
            Object.keys(dataset.fields),
            'Declare an embedding source field.',
          ),
        );
      }
    }
  }
  for (const policyName of Object.keys(dataset.embeddingPolicies)) {
    if (dataset.embeddings[policyName] === undefined) {
      return semanticError(
        'An embedding policy must reference an embedding name in the same dataset.',
        jsonPointer(['datasets', datasetId, 'embeddingPolicies', policyName]),
        availableAlternatives(
          Object.keys(dataset.embeddings),
          'Bind an embedding before its policy.',
        ),
      );
    }
  }
  return undefined;
}

function firstSemanticError(catalog: CatalogDocument): AgqlError | undefined {
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    const error = validateFieldCoverage(datasetId, dataset)
      ?? validateDatasetLists(datasetId, dataset)
      ?? validateEmbeddings(catalog, datasetId, dataset)
      ?? validateDefaultFilters(datasetId, dataset)
      ?? validateScopeDimensions(datasetId, dataset);
    if (error !== undefined) return error;
  }
  return undefined;
}

/** RFC §10: all Zod structural issues, then at most the first semantic issue. */
export function validateCatalog(value: unknown): ValidationResult<CatalogDocument> {
  const structural = validateDocument(CatalogDocumentSchema, value);
  if (!structural.ok) return structural;
  const semantic = firstSemanticError(structural.value);
  return semantic === undefined
    ? structural
    : { ok: false, errors: [semantic] };
}
