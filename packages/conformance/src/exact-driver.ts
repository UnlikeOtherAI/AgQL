import type { JsonValue } from '@agql/schemas';

import type { ExactFixture } from './exact-fixtures.ts';

export type ExactQueryObservation =
  | {
      readonly kind: 'success';
      readonly semantic: JsonValue;
      readonly sourceQueryHash: string;
      readonly determinism: 'exact' | 'approximate';
      readonly repeatedSemanticEqual: boolean;
      readonly backendCalls: number;
    }
  | {
      readonly kind: 'refusal';
      readonly errors: readonly JsonValue[];
      readonly backendCalls: number;
    }
  | {
      readonly kind: 'exception';
      readonly message: string;
      readonly backendCalls: number;
    }
  | {
      readonly kind: 'declined';
      readonly reason: string;
      readonly backendCalls: 0;
    };

export interface NamedExactQuery {
  readonly name: string;
  readonly query: JsonValue;
}

export interface ExactAdapterRun {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileAdvertised: boolean;
  readonly observations: Readonly<Record<string, ExactQueryObservation>>;
}

export interface ExactAdapterDriver {
  readonly id: string;
  readonly version: string;
  readonly profiles: readonly string[];
  run(
    fixture: ExactFixture,
    queries: readonly NamedExactQuery[],
  ): Promise<ExactAdapterRun>;
}

export function unavailableAdapterDriver(
  id: string,
  version: string,
  reason: string,
): ExactAdapterDriver {
  return {
    id,
    version,
    profiles: [],
    run(fixture, queries) {
      return Promise.resolve({
        adapterId: id,
        adapterVersion: version,
        profileAdvertised: false,
        observations: Object.fromEntries(queries.map(({ name }) => [name, {
          kind: 'declined' as const,
          reason: `${fixture.requiresProfile}: ${reason}`,
          backendCalls: 0 as const,
        }])),
      });
    },
  };
}
