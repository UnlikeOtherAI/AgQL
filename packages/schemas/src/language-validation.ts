import { z } from 'zod';

import {
  type AgqlError,
  type ValidationResult,
  jsonPointer,
  structuralErrors,
} from './errors.ts';
import { sourceQueryHash } from './identities.ts';
import type { SourceQueryHash } from './identities.ts';
import { IngestDocumentSchema } from './ingest.ts';
import type { IngestDocument } from './ingest.ts';
import { canonicalizeJcs } from './jcs.ts';
import { QueryDocumentSchema } from './query.ts';
import type { QueryDocument } from './query.ts';

const UNSUPPORTED_PROPERTIES: ReadonlySet<string> = new Set([
  'join',
  'joins',
  'edge',
  'edges',
  'query',
  'nestedQuery',
  'derive',
  'merge',
  'rerank',
  'multiVector',
  'materializedDataset',
  'artifact',
  'publication',
  'federation',
  'attenuableCredential',
  'differentialPrivacy',
  'derivedPolicyPropagation',
]);

const UNSUPPORTED_KINDS: ReadonlySet<string> = new Set([
  'join',
  'edge',
  'nestedQuery',
  'derive',
  'merge',
  'rerank',
  'multiVector',
  'materializedDataset',
  'artifact',
  'publication',
  'federation',
]);

interface UnsupportedHit {
  readonly name: string;
  readonly path: readonly (string | number)[];
  readonly property?: string;
}

function findUnsupported(
  value: unknown,
  path: readonly (string | number)[] = [],
): UnsupportedHit | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findUnsupported(item, [...path, index]);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = [...path, key];
    if (UNSUPPORTED_PROPERTIES.has(key)) return { name: key, path: itemPath, property: key };
    if (key === 'op' && item === 'percentile') return { name: 'percentile', path: itemPath };
    if (key === 'mode' && item === 'merge') return { name: 'merge', path: itemPath };
    if (key === 'kind' && typeof item === 'string' && UNSUPPORTED_KINDS.has(item)) {
      return { name: item, path: itemPath };
    }
    const nested = findUnsupported(item, itemPath);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function issueBelongsToUnsupported(issue: z.ZodIssue, hit: UnsupportedHit): boolean {
  if (issue.code === z.ZodIssueCode.unrecognized_keys && hit.property !== undefined) {
    return issue.keys.length === 1 && issue.keys[0] === hit.property;
  }
  return jsonPointer(issue.path) === jsonPointer(hit.path);
}

function unsupportedError(hit: UnsupportedHit): AgqlError {
  return {
    code: 'UNSUPPORTED_IN_V0',
    message: `The ${hit.name} construct is not supported in AgQL v0.`,
    path: jsonPointer(hit.path),
    alternatives: ['Remove the deferred construct and use only the documented v0 vocabulary.'],
  };
}

function rejectedWithStructuralAndUnsupported(
  error: z.ZodError,
  hit: UnsupportedHit,
): ValidationResult<never> {
  const remainingIssues = error.issues.filter((issue) => !issueBelongsToUnsupported(issue, hit));
  const semantic = unsupportedError(hit);
  if (remainingIssues.length === 0) return { ok: false, errors: [semantic] };
  const structural = structuralErrors(new z.ZodError(remainingIssues));
  return { ok: false, errors: [...structural, semantic] };
}

export function validateQueryDocument(value: unknown): ValidationResult<QueryDocument> {
  const unsupported = findUnsupported(value);
  const parsed = QueryDocumentSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  if (unsupported !== undefined) {
    return rejectedWithStructuralAndUnsupported(parsed.error, unsupported);
  }
  return { ok: false, errors: structuralErrors(parsed.error) };
}

export function validateIngestDocument(value: unknown): ValidationResult<IngestDocument> {
  const unsupported = findUnsupported(value);
  const parsed = IngestDocumentSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  if (unsupported !== undefined) {
    return rejectedWithStructuralAndUnsupported(parsed.error, unsupported);
  }
  return { ok: false, errors: structuralErrors(parsed.error) };
}

export interface CanonicalQueryDocument {
  readonly document: QueryDocument;
  readonly canonical: string;
  readonly sourceQueryHash: SourceQueryHash;
}

/** RFC §3 validates and materializes Zod defaults before either JCS or hashing. */
export function validateAndCanonicalizeQuery(
  value: unknown,
): ValidationResult<CanonicalQueryDocument> {
  const validated = validateQueryDocument(value);
  if (!validated.ok) return validated;
  return {
    ok: true,
    value: {
      document: validated.value,
      canonical: canonicalizeJcs(validated.value),
      sourceQueryHash: sourceQueryHash(validated.value),
    },
  };
}

