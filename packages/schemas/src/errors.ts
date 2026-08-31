import type { z } from 'zod';

export const ERROR_CODES = [
  'STRUCTURAL_INVALID',
  'SEMANTIC_INVALID',
  'UNSUPPORTED_IN_V0',
  'REFERENCE_NOT_AVAILABLE',
  'UNSUPPORTED_PROFILE',
  'SCOPE_UNENFORCEABLE',
  'EXACT_SCAN_BUDGET_EXCEEDED',
  'FRESHNESS_UNAVAILABLE',
  'EMBEDDING_NOT_INDEXED',
  'FILTER_SHAPE_UNCERTIFIED',
  'COST_GATE_REFUSAL',
  'AFTER_WRITE_TIMEOUT',
  'CROSS_CURRENCY_AGGREGATION',
  'ENCODING_SYNTAX',
  'ENCODING_SIZE_LIMIT',
  'ENCODING_DEPTH_LIMIT',
  'ENCODING_ANCHOR_FORBIDDEN',
  'ENCODING_MERGE_KEY_FORBIDDEN',
  'ENCODING_DUPLICATE_KEY',
  'ENCODING_MULTIDOC_FORBIDDEN',
  'ENCODING_TAG_FORBIDDEN',
  'ENCODING_NON_STRING_KEY',
  'ENCODING_FENCE_INVALID',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type LegalAlternatives = readonly [string, ...string[]];

export interface AgqlErrorBase<C extends ErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly path: string;
  readonly alternatives: LegalAlternatives;
}

/**
 * RFC §6/§10 deliberately gives hidden and nonexistent names one shape.
 * Its alternatives are structurally empty, so this result cannot enumerate hidden vocabulary.
 * The already scope-narrowed catalog documentation is the sole source of name suggestions.
 */
export interface ReferenceNotAvailableError
  extends Omit<AgqlErrorBase<'REFERENCE_NOT_AVAILABLE'>, 'alternatives'> {
  readonly alternatives: readonly [];
}

export type AgqlError =
  | ReferenceNotAvailableError
  | AgqlErrorBase<Exclude<ErrorCode, 'REFERENCE_NOT_AVAILABLE'>>;

export interface SuccessResult<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ErrorResult {
  readonly ok: false;
  readonly errors: readonly [AgqlError, ...AgqlError[]];
}

export type ValidationResult<T> = SuccessResult<T> | ErrorResult;

function escapePointerToken(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

export function jsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return '';
  return `/${path.map((part) => escapePointerToken(String(part))).join('/')}`;
}

export function structuralErrors(error: z.ZodError): readonly [AgqlError, ...AgqlError[]] {
  const mapped = error.issues.map((issue): AgqlError => ({
    code: 'STRUCTURAL_INVALID',
    message: `The document is structurally invalid: ${issue.message}`,
    path: jsonPointer(issue.path),
    alternatives: structuralAlternatives(issue),
  }));
  const first = mapped[0];
  if (first === undefined) {
    return [{
      code: 'STRUCTURAL_INVALID',
      message: 'The document is structurally invalid.',
      path: '',
      alternatives: ['Provide a document accepted by the v0 schema.'],
    }];
  }
  return [first, ...mapped.slice(1)];
}

function structuralAlternatives(issue: z.ZodIssue): LegalAlternatives {
  if (issue.code === 'invalid_enum_value' || issue.code === 'invalid_union_discriminator') {
    const values = issue.options.map((option) => String(option));
    const first = values[0];
    if (first !== undefined) return [first, ...values.slice(1)];
  }
  if (issue.code === 'invalid_literal') return [String(issue.expected)];
  return ['Provide a value accepted by the v0 schema at this path.'];
}

export function errorResult(error: AgqlError): ErrorResult {
  return { ok: false, errors: [error] };
}

export function referenceNotAvailable(path: string): ReferenceNotAvailableError {
  return {
    code: 'REFERENCE_NOT_AVAILABLE',
    message: 'The referenced item is not available in the effective catalog.',
    path,
    alternatives: [],
  };
}
