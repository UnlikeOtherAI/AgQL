import type { SafeInteger } from '@agql/schemas';

import { fail, repairableError, semanticError } from './errors.ts';
import type { EngineResult } from './types.ts';

/** The minimal v0 resolution uses the conventional RRF rank constant. */
export const RRF_V0_K = 60 as const;

export interface RankedStableId {
  readonly id: string;
  readonly rank: SafeInteger;
}

interface RationalScore {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function addRank(score: RationalScore, rank: SafeInteger): RationalScore {
  const denominator = BigInt(RRF_V0_K + rank);
  return {
    numerator: score.numerator * denominator + score.denominator,
    denominator: score.denominator * denominator,
  };
}

function validateList(
  list: readonly RankedStableId[],
  path: string,
): EngineResult<true> {
  const ids = new Set<string>();
  const ranks = new Set<number>();
  for (const [index, item] of list.entries()) {
    if (item.id.length === 0 || item.rank <= 0 || ids.has(item.id) || ranks.has(item.rank)) {
      return fail(semanticError(
        'Each ranked list requires unique nonempty ids and unique positive ranks.',
        `${path}/${index}`,
        ['Provide a bounded ranked list with unique ids and ranks.'],
      ));
    }
    ids.add(item.id);
    ranks.add(item.rank);
  }
  return { ok: true, value: true };
}

function intermediateBytes(lists: readonly (readonly RankedStableId[])[]): number {
  const encoder = new TextEncoder();
  return lists.reduce((total, list) => total + list.reduce(
    (listTotal, item) => listTotal + encoder.encode(item.id).byteLength + 16,
    0,
  ), 0);
}

export function fuseRrfV0(
  semantic: readonly RankedStableId[],
  lexical: readonly RankedStableId[],
  take: SafeInteger,
  maximumIntermediateBytes: SafeInteger,
): EngineResult<readonly RankedStableId[]> {
  const semanticValid = validateList(semantic, '/semantic');
  if (!semanticValid.ok) return semanticValid;
  const lexicalValid = validateList(lexical, '/lexical');
  if (!lexicalValid.ok) return lexicalValid;
  if (take <= 0) {
    return fail(semanticError('Fusion take must be positive.', '/take', ['Use a positive take.']));
  }
  if (intermediateBytes([semantic, lexical]) > maximumIntermediateBytes) {
    return fail(repairableError(
      'COST_GATE_REFUSAL',
      'RRF fusion would exceed the bounded intermediate-byte limit.',
      '/take',
      ['Lower take.', 'Use shorter bounded candidate lists.'],
      'Reduce the bounded semantic or lexical candidate list.',
    ));
  }
  const scores = new Map<string, RationalScore>();
  for (const item of [...semantic, ...lexical]) {
    const current = scores.get(item.id) ?? { numerator: 0n, denominator: 1n };
    scores.set(item.id, addRank(current, item.rank));
  }
  const sorted = [...scores.entries()].sort(([leftId, left], [rightId, right]) => {
    const comparison = left.numerator * right.denominator
      - right.numerator * left.denominator;
    if (comparison > 0n) return -1;
    if (comparison < 0n) return 1;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return {
    ok: true,
    value: sorted.slice(0, take).map(([id], index) => ({
      id,
      rank: (index + 1) as SafeInteger,
    })),
  };
}
