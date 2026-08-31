import type {
  AdapterDescriptor,
  AdapterOutcome,
  CanonicalIngestOperations,
  IngestResult,
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

function validateIngestResult(
  expectedIds: readonly string[],
  result: IngestResult,
): EngineResult<IngestResult> {
  if (result.outcomes.length !== expectedIds.length) {
    return fail(semanticError(
      'The ingest result must report one outcome for every input record.',
      '/outcomes',
      ['Return exactly one record outcome per requested stable id.'],
    ));
  }
  const actualIds = result.outcomes.map(({ id }) => id);
  if (new Set(actualIds).size !== actualIds.length
    || expectedIds.some((id, index) => actualIds[index] !== id)) {
    return fail(semanticError(
      'Ingest record outcomes must preserve the unique input-id order.',
      '/outcomes',
      ['Return each requested stable id exactly once in request order.'],
    ));
  }
  const accepted = result.outcomes.filter(({ status }) => status === 'accepted');
  const receiptIds = result.writeReceipt.records.map(({ id }) => id);
  if (receiptIds.length !== accepted.length
    || accepted.some((outcome, index) => receiptIds[index] !== outcome.id)) {
    return fail(semanticError(
      'The batch receipt must contain exactly the accepted record outcomes in input order.',
      '/writeReceipt/records',
      ['Include each accepted record once and omit refused records.'],
    ));
  }
  for (const [index, outcome] of result.outcomes.entries()) {
    if (outcome.status === 'refused') {
      continue;
    }
    const record = result.writeReceipt.records[index - result.outcomes
      .slice(0, index).filter(({ status }) => status === 'refused').length];
    if (outcome.version < 0 || record?.version !== outcome.version
      || record.visibility.record === undefined) {
      return fail(semanticError(
        'Every accepted record requires a matching receipt version and record visibility state.',
        `/outcomes/${index}`,
        ['Return the canonical record visibility state for every accepted record.'],
      ));
    }
  }
  return { ok: true, value: result };
}

export async function executeIngest<Compiled>(
  input: CompileIngestInput,
  adapter: EngineIngestAdapter<Compiled>,
): Promise<EngineResult<IngestResult>> {
  const compiled = compileIngest({ ...input, adapter: adapter.descriptor });
  if (!compiled.ok) return compiled;
  const native = await adapter.canonicalIngest.compile(compiled.value.plan);
  if (native.kind === 'refusal') return adapterFailure(native);
  const executed = await adapter.canonicalIngest.execute(native.value);
  if (executed.kind === 'refusal') return adapterFailure(executed);
  return validateIngestResult(
    compiled.value.plan.records.map(({ id }) => id),
    executed.value,
  );
}
