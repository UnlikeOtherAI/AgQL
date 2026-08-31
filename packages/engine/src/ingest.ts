import {
  ScopeSchema,
  datasetCapabilitiesAllow,
  validateCatalog,
} from '@agql/catalog';
import type {
  CanonicalIngestPlan,
  ResolvedCanonicalFieldValue,
  ResolvedFieldBinding,
  TypedValue,
} from '@agql/contracts';
import type {
  AgqlLiteral,
  IngestDocument,
  RecordValue,
} from '@agql/schemas';
import {
  canonicalizeJcs,
  fingerprintScope,
  InstantValueSchema,
  MoneyValueSchema,
  SafeIntegerSchema,
  validateIngestDocument,
} from '@agql/schemas';

import {
  fail,
  repairableError,
  semanticError,
  unavailableReference,
} from './errors.ts';
import { availableDatasetReferences } from './policy.ts';
import { expandScope } from './scope.ts';
import type {
  CompileIngestInput,
  CompileIngestOutput,
  EngineDatasetBinding,
  EngineResult,
} from './types.ts';
import { resolveFieldBinding, typeLiteral } from './values.ts';

function hasIfVersion(value: object): value is { readonly ifVersion?: unknown } {
  return Object.hasOwn(value, 'ifVersion');
}

function agqlLiteral(value: RecordValue): AgqlLiteral | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value) || typeof value !== 'object') return undefined;
  const money = MoneyValueSchema.safeParse(value);
  return money.success ? money.data : undefined;
}

function fieldBinding(
  input: CompileIngestInput,
  datasetId: string,
  binding: EngineDatasetBinding,
  fieldId: string,
  path: string,
): EngineResult<ResolvedFieldBinding> {
  const field = input.catalog.datasets[datasetId]?.fields[fieldId];
  const physical = binding.fields[fieldId];
  if (field === undefined || physical === undefined) return fail(unavailableReference(path));
  return { ok: true, value: resolveFieldBinding(fieldId, field, physical) };
}

function typedRecordValue(
  field: ResolvedFieldBinding,
  value: RecordValue,
  path: string,
): EngineResult<TypedValue> {
  const literal = agqlLiteral(value);
  if (literal === undefined) {
    return fail(semanticError(
      'The record value is not a canonical scalar supported by its field kind.',
      path,
      ['Use the canonical scalar wire form declared by the field.'],
    ));
  }
  return typeLiteral(field, literal, path);
}

function compileRecordValues(
  input: CompileIngestInput,
  document: Extract<IngestDocument, { readonly mode: 'insertOnly' | 'replace' }>,
  record: (typeof document.records)[number],
  datasetId: string,
  binding: EngineDatasetBinding,
  recordIndex: number,
): EngineResult<readonly [ResolvedCanonicalFieldValue, ...ResolvedCanonicalFieldValue[]]> {
  const dataset = input.catalog.datasets[datasetId];
  if (dataset === undefined) return fail(unavailableReference('/dataset'));
  const declared = Object.keys(dataset.fields).sort();
  for (const supplied of Object.keys(record.value)) {
    if (dataset.fields[supplied] === undefined) {
      return fail(unavailableReference(`/records/${recordIndex}/value/${supplied}`));
    }
  }
  const values: ResolvedCanonicalFieldValue[] = [];
  for (const fieldId of declared) {
    const field = fieldBinding(
      input,
      datasetId,
      binding,
      fieldId,
      `/records/${recordIndex}/value/${fieldId}`,
    );
    if (!field.ok) return field;
    const raw: RecordValue | undefined = fieldId === dataset.idField
      ? record.id
      : record.value[fieldId];
    if (raw === undefined) {
      return fail(semanticError(
        'Whole-record ingestion requires every declared field.',
        `/records/${recordIndex}/value/${fieldId}`,
        ['Provide the complete record, using null for a nullable missing value.'],
      ));
    }
    const typed = typedRecordValue(
      field.value,
      raw,
      `/records/${recordIndex}/value/${fieldId}`,
    );
    if (!typed.ok) return typed;
    if (fieldId === dataset.idField && Object.hasOwn(record.value, fieldId)) {
      const suppliedRaw = record.value[fieldId];
      if (suppliedRaw === undefined) {
        return fail(semanticError(
          'The supplied id-field value is invalid.',
          `/records/${recordIndex}/value/${fieldId}`,
          ['Provide the same stable id in both positions.'],
        ));
      }
      const suppliedId = typedRecordValue(
        field.value,
        suppliedRaw,
        `/records/${recordIndex}/value/${fieldId}`,
      );
      if (!suppliedId.ok) return suppliedId;
      if (canonicalizeJcs(suppliedId.value) !== canonicalizeJcs(typed.value)) {
        return fail(semanticError(
          'The record id and id-field value must be identical.',
          `/records/${recordIndex}/value/${fieldId}`,
          ['Use the same stable id in both positions.'],
        ));
      }
    }
    values.push({ field: field.value, value: typed.value });
  }
  const first = values[0];
  if (first === undefined) {
    return fail(semanticError(
      'A writable dataset must declare at least its stable id field.',
      '/dataset',
      ['Use a dataset with a declared stable id.'],
    ));
  }
  return { ok: true, value: [first, ...values.slice(1)] };
}

function recordWithinScope(
  input: CompileIngestInput,
  document: IngestDocument,
  recordIndex: number,
  typedValues: readonly ResolvedCanonicalFieldValue[] | undefined,
): EngineResult<true> {
  const dataset = input.catalog.datasets[document.dataset];
  if (dataset === undefined) return fail(unavailableReference('/dataset'));
  if (input.scope.partitions.kind === 'nothing') {
    return fail(repairableError(
      'SCOPE_UNENFORCEABLE',
      'A no-visibility scope cannot authorize ingestion.',
      '/scope/partitions',
      ['Use an explicitly authorized write scope.'],
      'Resolve a nonempty scope before ingestion.',
    ));
  }
  if (dataset.rowScope.kind === 'none') {
    return input.scope.partitions.kind === 'unpartitioned'
      ? { ok: true, value: true }
      : fail(repairableError(
        'SCOPE_UNENFORCEABLE',
        'An unpartitioned dataset requires an unpartitioned write scope.',
        '/scope/partitions',
        ['Use partitions.kind unpartitioned.'],
        'Resolve an unpartitioned write scope for this dataset.',
      ));
  }
  if (input.scope.partitions.kind !== 'values' || typedValues === undefined) {
    return fail(repairableError(
      'SCOPE_UNENFORCEABLE',
      'This partitioned write cannot prove every record is in scope.',
      `/records/${recordIndex}`,
      ['Provide a whole record whose partition values are authorized.'],
      'Use a binding that can enforce scoped delete or include verified partition values.',
    ));
  }
  for (const dimension of dataset.rowScope.dimensions) {
    const value = typedValues.find(({ field }) => field.logicalId === dimension)?.value;
    const allowed = input.scope.partitions.values[dimension];
    if (value === undefined || allowed === undefined) {
      return fail(repairableError(
        'SCOPE_UNENFORCEABLE',
        'A required partition dimension is absent from the write scope or record.',
        `/records/${recordIndex}`,
        ['Provide every declared partition value.'],
        'Resolve all dataset partition dimensions before writing.',
      ));
    }
    const field = typedValues.find(({ field: candidate }) =>
      candidate.logicalId === dimension)?.field;
    if (field === undefined) return fail(unavailableReference(`/records/${recordIndex}`));
    const allowedValues: TypedValue[] = [];
    for (const [allowedIndex, literal] of allowed.entries()) {
      const typed = typeLiteral(field, literal, `/scope/partitions/${dimension}/${allowedIndex}`);
      if (!typed.ok) return typed;
      allowedValues.push(typed.value);
    }
    if (!allowedValues.some((candidate) =>
      canonicalizeJcs(candidate) === canonicalizeJcs(value))) {
      return fail(repairableError(
        'SCOPE_UNENFORCEABLE',
        'A record partition value is outside the authorized write scope.',
        `/records/${recordIndex}/value/${dimension}`,
        ['Write only records inside the resolved partition scope.'],
        'Use an authorized partition value.',
      ));
    }
  }
  return { ok: true, value: true };
}

export function compileIngest(input: CompileIngestInput): EngineResult<CompileIngestOutput> {
  const validated = validateIngestDocument(input.document);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const catalog = validateCatalog(input.catalog);
  if (!catalog.ok) return { ok: false, errors: catalog.errors };
  const scope = ScopeSchema.safeParse(input.scope);
  if (!scope.success) {
    return fail(semanticError(
      'Ingestion requires a valid server-resolved scope.',
      '/scope',
      ['Resolve a scope accepted by the catalog schema.'],
    ));
  }
  const anchor = InstantValueSchema.safeParse(input.anchor);
  if (!anchor.success
    || new Date(anchor.data).getTime() >= new Date(scope.data.expiresAt).getTime()) {
    return fail(semanticError(
      'Ingestion requires a scope valid at the explicit operation anchor.',
      '/anchor',
      ['Provide an anchor within the scope validity interval.'],
    ));
  }
  const document = validated.value;
  const dataset = catalog.value.datasets[document.dataset];
  const binding = input.binding.datasets[document.dataset];
  if (dataset === undefined || binding === undefined) return fail(unavailableReference('/dataset'));
  if (!datasetCapabilitiesAllow(dataset, scope.data)) {
    return fail(unavailableReference('/dataset', availableDatasetReferences(
      catalog.value,
      input.binding,
      scope.data,
    )));
  }
  if (!dataset.profiles.includes('ingest.canonical.v0')
    || !input.adapter.profiles.includes('ingest.canonical.v0')
    || !scope.data.capabilities.includes('ingest.canonical.v0')) {
    return fail(repairableError(
      'UNSUPPORTED_PROFILE',
      'Canonical ingestion is not jointly advertised and authorized.',
      '/mode',
      ['Use an authorized canonical-store binding.'],
      'Route the write to a source and scope advertising ingest.canonical.v0.',
    ));
  }
  if (document.mode !== 'insertOnly'
    && document.records.some(({ ifVersion }) => ifVersion !== undefined)
    && !input.adapter.consistency.compareAndSwap) {
    return fail(repairableError(
      'UNSUPPORTED_PROFILE',
      'This adapter cannot honor the requested ifVersion compare-and-swap.',
      '/records',
      ['Remove ifVersion explicitly.', 'Choose a compare-and-swap capable adapter.'],
      'Use a canonical-store adapter with compareAndSwap capability.',
    ));
  }
  const idField = fieldBinding(input, document.dataset, binding, dataset.idField, '/dataset');
  if (!idField.ok) return idField;
  if (idField.value.type.kind !== 'id' || idField.value.nullable) {
    return fail(semanticError(
      'Canonical ingestion requires a non-null id-kind stable field.',
      '/dataset',
      ['Correct the dataset idField declaration.'],
    ));
  }
  const expandedScope = expandScope({ dataset, binding, scope: scope.data });
  if (!expandedScope.ok) return expandedScope;
  const base = {
    dataset: {
      logicalId: document.dataset,
      physical: binding.physical,
      bindingVersion: input.binding.version,
    },
    idField: idField.value,
    scopeFingerprint: fingerprintScope(scope.data),
    scope: expandedScope.value,
    idempotencyKey: document.idempotencyKey,
    embeddingPolicy: 'catalog' as const,
  };
  let plan: CanonicalIngestPlan;
  if (document.mode === 'delete') {
    const records = [];
    for (const record of document.records) {
      records.push({ id: record.id, ...(record.ifVersion === undefined
        ? {}
        : { ifVersion: record.ifVersion }) });
    }
    const first = records[0];
    if (first === undefined) return fail(semanticError(
      'Delete requires at least one record.',
      '/records',
      ['Provide a record id.'],
    ));
    plan = { ...base, mode: 'delete', records: [first, ...records.slice(1)] };
  } else {
    const records = [];
    for (const [index, record] of document.records.entries()) {
      const values = compileRecordValues(
        input,
        document,
        record,
        document.dataset,
        binding,
        index,
      );
      if (!values.ok) return values;
      const scoped = recordWithinScope(input, document, index, values.value);
      if (!scoped.ok) return scoped;
      const rawVersion = hasIfVersion(record) ? record.ifVersion : undefined;
      const version = rawVersion === undefined
        ? undefined
        : SafeIntegerSchema.safeParse(rawVersion);
      if (version !== undefined && !version.success) {
        return fail(semanticError(
          'ifVersion must be a safe integer.',
          `/records/${index}/ifVersion`,
          ['Use a nonnegative safe integer version.'],
        ));
      }
      records.push({
        id: record.id,
        ...(version?.success === true
          ? { ifVersion: version.data }
          : {}),
        values: values.value,
      });
    }
    const first = records[0];
    if (first === undefined) return fail(semanticError(
      'Ingestion requires at least one record.',
      '/records',
      ['Provide a complete record.'],
    ));
    plan = document.mode === 'insertOnly'
      ? { ...base, mode: 'insertOnly', records: [first, ...records.slice(1)] }
      : { ...base, mode: 'replace', records: [first, ...records.slice(1)] };
  }
  return {
    ok: true,
    value: {
      plan,
      catalogVersion: catalog.value.catalogVersion,
      policyVersion: catalog.value.policyVersion,
      bindingVersion: input.binding.version,
    },
  };
}
