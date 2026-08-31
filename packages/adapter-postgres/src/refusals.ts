import type { AdapterOutcome, AdapterRefusal } from '@agql/contracts';

export function refusal<T>(
  code: AdapterRefusal['code'],
  message: string,
  path: string,
  alternatives: AdapterRefusal['alternatives'],
  remedy: string,
): AdapterOutcome<T> {
  return {
    kind: 'refusal',
    refusal: { code, message, path, alternatives, remedy },
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

export function backendRefusal<T>(): AdapterOutcome<T> {
  return refusal(
    'COST_GATE_REFUSAL',
    'PostgreSQL could not complete the bounded adapter operation.',
    '',
    ['Retry the bounded operation or inspect operator diagnostics.'],
    'An operator should inspect the private PostgreSQL diagnostic log.',
  );
}
