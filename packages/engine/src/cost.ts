import type { ExpandedScope } from '@agql/contracts';

import { fail, repairableError, semanticError } from './errors.ts';
import type { CompileQueryInput, EngineResult } from './types.ts';

export function applyCostGate(
  input: CompileQueryInput,
  mode: 'records' | 'aggregate' | 'retrieve',
  accuracy: 'exact' | 'approximate' | undefined,
  scope: ExpandedScope,
): EngineResult<true> {
  const estimate = input.costGate.estimate;
  const numericInputs = [
    estimate.estimatedRows,
    estimate.estimatedCandidateRecords,
    estimate.estimatedIntermediateBytes,
    input.costGate.maximumEstimatedRows,
    input.costGate.maximumIntermediateBytes,
    input.scope.budgets.maximumQueries,
    input.scope.budgets.maximumCandidateRecords,
    input.scope.budgets.maximumExactScanRecords,
  ];
  if (numericInputs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return fail(semanticError(
      'Cost estimates must be nonnegative safe integers.',
      '/costGate/estimate',
      ['Provide nonnegative catalog and adapter estimates.'],
    ));
  }
  if (input.scope.budgets.maximumQueries === 0) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The task query budget is exhausted.',
      '/scope/budgets/maximumQueries',
      ['Use a scope with remaining query budget.'],
      'Start a new authorized task budget before retrying.',
    ));
  }
  if (scope.visibility === 'nothing') return { ok: true, value: true };
  if (estimate.estimatedRows > input.costGate.maximumEstimatedRows) {
    const field = estimate.selectiveFilterFields[0];
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The generous row estimate still exceeds the deployment cost gate.',
      '/where',
      ['Narrow the window.', 'Add a selective filter.'],
      field === undefined
        ? 'Narrow the time window or add a selective filter.'
        : `Narrow the window or filter on ${field}.`,
    ));
  }
  if (estimate.estimatedIntermediateBytes > input.costGate.maximumIntermediateBytes) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The bounded intermediate result would exceed its byte limit.',
      '/take',
      ['Lower take.', 'Add a selective filter.'],
      'Lower take or narrow the eligible window.',
    ));
  }
  if (mode === 'retrieve'
    && estimate.estimatedCandidateRecords > input.scope.budgets.maximumCandidateRecords) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'The retrieval estimate exceeds the authorized candidate budget.',
      '/where',
      ['Add a selective filter.', 'Lower take.'],
      'Narrow the eligible set before retrieval.',
    ));
  }
  if (mode === 'retrieve'
    && accuracy === 'exact'
    && estimate.estimatedCandidateRecords > input.scope.budgets.maximumExactScanRecords) {
    return fail(repairableError(
      'EXACT_SCAN_BUDGET_EXCEEDED',
      'The eligible-set estimate exceeds the exact-scan admission budget.',
      '/search/accuracy',
      ['Add a selective where predicate.', 'Request approximate accuracy if policy permits.'],
      'Narrow the eligible set or explicitly request an available approximate tier.',
    ));
  }
  return { ok: true, value: true };
}
