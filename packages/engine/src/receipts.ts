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
    ? next.state === 'pending' || next.state === 'ready'
      || next.state === 'failed' || next.state === 'superseded'
    : previous.state === 'pending'
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
      'FRESHNESS_UNAVAILABLE',
      'The write receipt contains no accepted record outcome to observe.',
      '/afterWrite/receipt',
      ['Issue a write with at least one accepted record.'],
      'Use a receipt containing an accepted record outcome.',
    ));
  }
  const missing = receipt.records.some((record) =>
    observation.require.some((name) => record.visibility[name] === undefined));
  if (missing) {
    return fail(repairableError(
      'FRESHNESS_UNAVAILABLE',
      'A required representation is absent from the write receipt.',
      '/afterWrite',
      ['Require only representations named by this receipt.'],
      'Choose a receipt and binding that contain every required representation.',
    ));
  }
  const terminal = receipt.records.flatMap((record) => observation.require.flatMap((name) => {
    const state = record.visibility[name];
    return state?.state === 'failed' || state?.state === 'superseded' ? [state] : [];
  }));
  if (terminal.length > 0) {
    return fail(repairableError(
      'FRESHNESS_UNAVAILABLE',
      terminal[0]?.state === 'failed'
        ? 'A required write representation failed.'
        : 'A required write representation was superseded.',
      '/afterWrite',
      ['Issue a new write and use its receipt.'],
      'A receipt-state error-code extension is required to represent this terminal outcome.',
    ));
  }
  const visible = receipt.records.every((record) =>
    observation.require.every((name) => record.visibility[name]?.state === 'ready'));
  if (visible) return { ok: true, value: receipt };
  const waiting = [...new Set(receipt.records.flatMap((record) => observation.require.filter(
    (name) => record.visibility[name]?.state !== 'ready',
  )))].sort();
  const first = waiting[0];
  const require = first === undefined
    ? observation.require
    : [first, ...waiting.slice(1)] as readonly [string, ...string[]];
  return fail(repairableError(
    'AFTER_WRITE_TIMEOUT',
    'The afterWrite deadline elapsed before every required visibility state was observable.',
    '/afterWrite',
    ['Retry with the same receipt and requirements.'],
    {
      action: 'retryAfterWrite',
      details: { receipt: observation.receipt, require },
    },
  ));
}
