import type {
  VisibilityObservation,
  VisibilityState,
  WriteReceipt,
} from '@agql/contracts';

import { fail, repairableError, semanticError } from './errors.ts';
import type { EngineResult } from './types.ts';

function sameState(left: VisibilityState, right: VisibilityState): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'ready' && right.state === 'ready') return left.token === right.token;
  if (left.state === 'failed' && right.state === 'failed') {
    return left.code === right.code && left.message === right.message;
  }
  return true;
}

export function validateVisibilityTransition(
  previous: VisibilityState,
  next: VisibilityState,
): EngineResult<true> {
  if (sameState(previous, next)) return { ok: true, value: true };
  const allowed = previous.state === 'accepted'
    ? next.state === 'ready' || next.state === 'failed' || next.state === 'superseded'
    : (previous.state === 'ready' || previous.state === 'failed')
      && next.state === 'superseded';
  if (allowed) return { ok: true, value: true };
  return fail(semanticError(
    'A receipt visibility state cannot move backward or revive after supersession.',
    '/visibility',
    ['Use an allowed monotonic visibility transition.'],
  ));
}

export function evaluateAfterWrite(
  observation: VisibilityObservation,
  receipt: WriteReceipt,
): EngineResult<WriteReceipt> {
  if (receipt.receipt !== observation.receipt) {
    return fail(repairableError(
      'FRESHNESS_UNAVAILABLE',
      'The observed receipt does not match the query afterWrite receipt.',
      '/afterWrite/receipt',
      ['Observe the exact receipt named by the query.'],
      'Retry observation using the exact opaque receipt id.',
    ));
  }
  if (receipt.records.length === 0) {
    return fail(repairableError(
      'AFTER_WRITE_TIMEOUT',
      'The required visibility states were not observed before the timeout.',
      '/afterWrite',
      ['Retry with a larger timeout.', 'Inspect the write receipt state.'],
      'Wait for every required representation of every record to become ready.',
    ));
  }
  const visible = receipt.records.every((record) =>
    observation.require.every((name) => record.visibility[name]?.state === 'ready'));
  if (visible) return { ok: true, value: receipt };
  return fail(repairableError(
    'AFTER_WRITE_TIMEOUT',
    'The required visibility states were not observed before the timeout.',
    '/afterWrite',
    ['Retry with a larger timeout.', 'Inspect the write receipt state.'],
    'Wait for every required representation of every record to become ready.',
  ));
}
