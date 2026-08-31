import type {
  AdapterDescriptor,
  AdapterExecutionResult,
  AdapterOutcome,
  QueryAdapterOperations,
  VisibilityOperations,
  WriteReceipt,
} from '@agql/contracts';
import type { CapabilityProfile } from '@agql/schemas';

import { compileQuery } from './compile.ts';
import { fail, repairableError } from './errors.ts';
import { evaluateAfterWrite } from './receipts.ts';
import type {
  CompileOutput,
  CompileQueryInput,
  EngineResult,
} from './types.ts';

type QueryProfile = Extract<
  CapabilityProfile,
  'records.v0' | 'aggregate.v0' | 'retrieve.semantic.v0' | 'retrieve.hybrid.v0'
>;

export interface EngineQueryAdapter<Compiled> {
  readonly descriptor: AdapterDescriptor<readonly QueryProfile[]>;
  readonly query: QueryAdapterOperations<Compiled>;
  readonly visibility?: VisibilityOperations;
}

export interface ExecutedQuery {
  readonly compiled: CompileOutput;
  readonly execution: AdapterExecutionResult;
  readonly observedReceipt?: WriteReceipt;
}

function adapterFailure<T>(outcome: Extract<AdapterOutcome<T>, { readonly kind: 'refusal' }>) {
  return fail<T>({ ...outcome.refusal });
}

async function observeVisibility(
  compiled: CompileOutput,
  visibility: VisibilityOperations | undefined,
): Promise<EngineResult<WriteReceipt | undefined>> {
  if (compiled.afterWrite === undefined) return { ok: true, value: undefined };
  if (visibility === undefined) {
    return fail(repairableError(
      'FRESHNESS_UNAVAILABLE',
      'The adapter advertised afterWrite but exposes no visibility observer.',
      '/afterWrite',
      ['Choose a certified adapter with visibility observation.'],
      'Use a binding whose implementation exposes certified receipt observation.',
    ));
  }
  const observed = await visibility.observe(compiled.afterWrite);
  if (observed.kind === 'refusal') return adapterFailure(observed);
  return evaluateAfterWrite(compiled.afterWrite, observed.value);
}

export async function executeQuery<Compiled>(
  input: CompileQueryInput,
  adapter: EngineQueryAdapter<Compiled>,
): Promise<EngineResult<ExecutedQuery>> {
  const compiled = compileQuery({ ...input, adapter: adapter.descriptor });
  if (!compiled.ok) return compiled;
  const observed = await observeVisibility(compiled.value, adapter.visibility);
  if (!observed.ok) return observed;
  if (compiled.value.plan.scope.visibility === 'nothing') {
    return {
      ok: true,
      value: {
        compiled: compiled.value,
        execution: { rows: [], truncated: false, snapshot: { kind: 'none' } },
        ...(observed.value === undefined ? {} : { observedReceipt: observed.value }),
      },
    };
  }
  const native = await adapter.query.compile(compiled.value.plan);
  if (native.kind === 'refusal') return adapterFailure(native);
  const execution = await adapter.query.execute(native.value);
  if (execution.kind === 'refusal') return adapterFailure(execution);
  return {
    ok: true,
    value: {
      compiled: compiled.value,
      execution: execution.value,
      ...(observed.value === undefined ? {} : { observedReceipt: observed.value }),
    },
  };
}
