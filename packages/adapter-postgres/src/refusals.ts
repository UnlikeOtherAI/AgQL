import type {
  AdapterOutcome,
  AdapterRefusal,
  AdapterRefusalCode,
  AdapterStandardRemedy,
} from '@agql/contracts';

export function refusal<T>(
  code: Exclude<AdapterRefusalCode, 'AFTER_WRITE_TIMEOUT'>,
  message: string,
  path: string,
  alternatives: AdapterRefusal['alternatives'],
  remedy: AdapterStandardRemedy,
): AdapterOutcome<T> {
  return {
    kind: 'refusal',
    refusal: { code, message, path, alternatives, remedy } as AdapterRefusal,
  };
}

export function unsafePlan<T>(path: string, message: string): AdapterOutcome<T> {
  return refusal(
    'COST_GATE_REFUSAL',
    message,
    path,
    ['Compile a fully resolved plan accepted by this adapter.'],
    'Re-run engine validation and binding resolution before adapter compilation.',
  );
}

function missingRelation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return Reflect.get(error, 'code') === '42P01';
}

export function backendRefusal<T>(error?: unknown): AdapterOutcome<T> {
  if (missingRelation(error)) {
    return refusal(
      'SCHEMA_NOT_PROVISIONED',
      'The required AgQL PostgreSQL relation is not provisioned.',
      '',
      ['Retry after the deployment provisioner completes.'],
      'Run the deployment provisioner for the active catalog binding before accepting traffic.',
    );
  }
  return refusal(
    'COST_GATE_REFUSAL',
    'PostgreSQL could not complete the bounded adapter operation.',
    '',
    ['Retry the bounded operation or inspect operator diagnostics.'],
    'An operator should inspect the private PostgreSQL diagnostic log.',
  );
}
