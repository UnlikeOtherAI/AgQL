import type { ErrorCode, LegalAlternatives } from '@agql/schemas';
import { referenceNotAvailable } from '@agql/schemas';

import type { EngineError, EngineResult } from './types.ts';

export function fail<T>(error: EngineError): EngineResult<T> {
  return { ok: false, errors: [error] };
}

export function failMany<T>(
  errors: readonly [EngineError, ...EngineError[]],
): EngineResult<T> {
  return { ok: false, errors };
}

export function semanticError(
  message: string,
  path: string,
  alternatives: LegalAlternatives,
): EngineError {
  return { code: 'SEMANTIC_INVALID', message, path, alternatives };
}

export function structuralError(
  message: string,
  path: string,
  alternatives: LegalAlternatives,
): EngineError {
  return { code: 'STRUCTURAL_INVALID', message, path, alternatives };
}

type RepairableCode = Extract<
  ErrorCode,
  | 'UNSUPPORTED_PROFILE'
  | 'SCOPE_UNENFORCEABLE'
  | 'EXACT_SCAN_BUDGET_EXCEEDED'
  | 'FRESHNESS_UNAVAILABLE'
  | 'EMBEDDING_NOT_INDEXED'
  | 'FILTER_SHAPE_UNCERTIFIED'
  | 'COST_GATE_REFUSAL'
  | 'AFTER_WRITE_TIMEOUT'
>;

export function repairableError(
  code: RepairableCode,
  message: string,
  path: string,
  alternatives: LegalAlternatives,
  remedy: NonNullable<EngineError['remedy']>,
): EngineError {
  return { code, message, path, alternatives, remedy };
}

export function unavailableReference(path: string): EngineError {
  return referenceNotAvailable(path);
}
