import {
  AgqlLiteralSchema,
  InstantValueSchema,
  NonnegativeSafeIntegerSchema,
} from '@agql/schemas';
import type { AgqlLiteral } from '@agql/schemas';
import { z } from 'zod';

export const ScopeBudgetsSchema = z.object({
  maximumQueries: NonnegativeSafeIntegerSchema,
  maximumExactScanRecords: NonnegativeSafeIntegerSchema,
  maximumCandidateRecords: NonnegativeSafeIntegerSchema,
}).strict();

export type ScopeBudgets = z.infer<typeof ScopeBudgetsSchema>;

/**
 * RFC §6 partition visibility. There is intentionally no wildcard or empty-object case.
 * `nothing` is what an empty wire partition map resolves to; unpartitioned access must be
 * stated explicitly and can only apply to a dataset whose catalog row scope is `none`.
 */
export const ScopePartitionsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nothing') }).strict(),
  z.object({
    kind: z.literal('values'),
    values: z.record(z.string().min(1), z.array(AgqlLiteralSchema).min(1)),
  }).strict(),
  z.object({ kind: z.literal('unpartitioned') }).strict(),
]);

export type ScopePartitions = z.infer<typeof ScopePartitionsSchema>;

/** RFC §6 server-resolved security object required by every operation. */
export const ScopeSchema = z.object({
  principal: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  partitions: ScopePartitionsSchema,
  budgets: ScopeBudgetsSchema,
  expiresAt: InstantValueSchema,
}).strict();

export type Scope = z.infer<typeof ScopeSchema>;

/** Resolves an empty wire map to explicit no-visibility, never to unrestricted access. */
export function resolvePartitionValues(
  values: Readonly<Record<string, readonly AgqlLiteral[]>>,
): ScopePartitions {
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.some(([, allowed]) => allowed.length === 0)) {
    return { kind: 'nothing' };
  }
  return {
    kind: 'values',
    values: Object.fromEntries(entries.map(([dimension, allowed]) => [
      dimension,
      [...allowed],
    ])),
  };
}
