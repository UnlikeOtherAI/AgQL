import type { z } from 'zod';

export const ERROR_CODES = [
  'STRUCTURAL_INVALID',
  'SCHEMA_TYPE_MISMATCH',
  'LIMIT_OUT_OF_RANGE',
  'SEMANTIC_INVALID',
  'OUTPUT_ID_COLLISION',
  'OUTPUT_ID_INVALID',
  'ENUM_VALUE_INVALID',
  'UNSUPPORTED_IN_V0',
  'REFERENCE_NOT_AVAILABLE',
  'UNSUPPORTED_PROFILE',
  'SCOPE_UNENFORCEABLE',
  'EXACT_SCAN_BUDGET_EXCEEDED',
  'EXACT_SCAN_LIMIT_EXCEEDED',
  'MONEY_CURRENCY_MIXED',
  'QUERY_WRITE_FORBIDDEN',
  'NATIVE_PASSTHROUGH_FORBIDDEN',
  'REGEX_FORBIDDEN',
  'UDF_FORBIDDEN',
  'EVALUABLE_CONSTRUCT_FORBIDDEN',
  'FRESHNESS_UNAVAILABLE',
  'EMBEDDING_NOT_INDEXED',
  'FILTER_SHAPE_UNCERTIFIED',
  'COST_GATE_REFUSAL',
  'SCHEMA_NOT_PROVISIONED',
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
 * Its alternatives name only vocabulary already visible in the caller's scope.
 */
export interface ReferenceNotAvailableError
  extends Omit<AgqlErrorBase<'REFERENCE_NOT_AVAILABLE'>, 'alternatives'> {
  readonly alternatives: readonly string[];
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
  const mapped = error.issues.map((issue): AgqlError => structuralErrorForIssue(issue));
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

function structuralErrorForIssue(issue: z.ZodIssue): AgqlError {
  const path = jsonPointer(issue.path);
  if (path === '/take' && (issue.code === 'too_small' || issue.code === 'too_big')) {
    return {
      code: 'LIMIT_OUT_OF_RANGE',
      message: 'The bounded integer is outside the permitted range.',
      path,
      alternatives: ['Use an integer from 1 through 1000.'],
    };
  }
  const typePaths: Readonly<Record<string, string>> = {
    '/version': 'Use the JSON string "0".',
    '/select': 'Use a JSON array of field ids.',
    '/order': 'Use a JSON array of order items.',
  };
  const alternative = typePaths[path];
  if (alternative !== undefined
    && (issue.code === 'invalid_type' || issue.code === 'invalid_literal')) {
    return {
      code: 'SCHEMA_TYPE_MISMATCH',
      message: 'The value has the wrong JSON type.',
      path,
      alternatives: [alternative],
    };
  }
  return {
    code: 'STRUCTURAL_INVALID',
    message: `The document is structurally invalid: ${issue.message}`,
    path,
    alternatives: structuralAlternatives(issue),
  };
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

export function referenceNotAvailable(
  path: string,
  alternatives: readonly string[] = [],
): ReferenceNotAvailableError {
  return {
    code: 'REFERENCE_NOT_AVAILABLE',
    message: 'The referenced catalog item is not available in this scope.',
    path,
    alternatives,
  };
}
