import type {
  AdapterDescriptor,
  AdapterOutcome,
  CanonicalIngestOperations,
  WriteReceipt,
} from '@agql/contracts';
import type { CapabilityProfile } from '@agql/schemas';

import { fail, semanticError } from './errors.ts';
import { compileIngest } from './ingest.ts';
import type {
  CompileIngestInput,
  EngineResult,
} from './types.ts';

export interface EngineIngestAdapter<Compiled> {
  readonly descriptor: AdapterDescriptor<readonly CapabilityProfile[]>;
  readonly canonicalIngest: CanonicalIngestOperations<Compiled>;
}

function adapterFailure<T>(outcome: Extract<AdapterOutcome<T>, { readonly kind: 'refusal' }>) {
  return fail<T>({ ...outcome.refusal });
}

function validateReceipt(
  expectedIds: readonly string[],
  receipt: WriteReceipt,
): EngineResult<WriteReceipt> {
  if (receipt.records.length !== expectedIds.length) {
    return fail(semanticError(
      'The batch receipt must report one outcome for every input record.',
      '/receipt/records',
      ['Return exactly one record receipt per requested stable id.'],
    ));
  }
  const actualIds = receipt.records.map(({ id }) => id);
  if (new Set(actualIds).size !== actualIds.length
    || expectedIds.some((id, index) => actualIds[index] !== id)) {
    return fail(semanticError(
      'Receipt record outcomes must preserve the unique input-id order.',
      '/receipt/records',
      ['Return each requested stable id exactly once in request order.'],
    ));
  }
  for (const [index, record] of receipt.records.entries()) {
    if (record.version < 0 || record.visibility.record === undefined) {
      return fail(semanticError(
        'Every record receipt requires a nonnegative version and record visibility state.',
        `/receipt/records/${index}`,
        ['Return the canonical record visibility state.'],
      ));
    }
  }
  return { ok: true, value: receipt };
}

export async function executeIngest<Compiled>(
  input: CompileIngestInput,
  adapter: EngineIngestAdapter<Compiled>,
): Promise<EngineResult<WriteReceipt>> {
  const compiled = compileIngest({ ...input, adapter: adapter.descriptor });
  if (!compiled.ok) return compiled;
  const native = await adapter.canonicalIngest.compile(compiled.value.plan);
  if (native.kind === 'refusal') return adapterFailure(native);
  const executed = await adapter.canonicalIngest.execute(native.value);
  if (executed.kind === 'refusal') return adapterFailure(executed);
  return validateReceipt(
    compiled.value.plan.records.map(({ id }) => id),
    executed.value,
  );
}
