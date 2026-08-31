import type { AdapterOutcome, LogicalPlan } from '@agql/contracts';

import { compileAggregate } from './compile-aggregate.ts';
import { compileRecords } from './compile-records.ts';
import { compileRetrieve } from './compile-retrieve.ts';
import type { RuntimeRegistry } from './registry.ts';
import type { CompiledPostgresQuery } from './types.ts';

function unsupportedProfile<T>(): AdapterOutcome<T> {
  return {
    kind: 'refusal',
    refusal: {
      code: 'UNSUPPORTED_PROFILE',
      message: 'The resolved query profile is not implemented by this PostgreSQL adapter.',
      path: '/profile',
      alternatives: [
        'records.v0',
        'aggregate.v0',
        'retrieve.semantic.v0',
        'retrieve.hybrid.v0',
      ],
      remedy: 'Compile the query against a source advertising its exact profile.',
    },
  };
}

export function compileQuery(
  plan: LogicalPlan,
  registry: RuntimeRegistry,
): AdapterOutcome<CompiledPostgresQuery> {
  const runtimeProfile: unknown = Reflect.get(plan, 'profile');
  if (plan.mode === 'records') {
    return runtimeProfile === 'records.v0' ? compileRecords(plan, registry) : unsupportedProfile();
  }
  if (plan.mode === 'aggregate') {
    return runtimeProfile === 'aggregate.v0'
      ? compileAggregate(plan, registry)
      : unsupportedProfile();
  }
  if (runtimeProfile !== 'retrieve.semantic.v0'
    && runtimeProfile !== 'retrieve.hybrid.v0') return unsupportedProfile();
  return compileRetrieve(plan, registry);
}
