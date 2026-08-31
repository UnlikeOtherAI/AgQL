import {
  accessRuleAllows,
  deriveEmbeddingSearchPolicy,
} from '@agql/catalog';
import type { FieldPolicy } from '@agql/schemas';
import type {
  ResolvedEmbeddingBinding,
  ResolvedFieldBinding,
} from '@agql/contracts';

import type { CompileContext } from './compile-context.ts';
import { fail, repairableError, unavailableReference } from './errors.ts';
import type { EngineResult } from './types.ts';
import { resolveFieldBinding } from './values.ts';

export type FieldOperation =
  | 'select'
  | 'filter'
  | 'group'
  | 'order'
  | 'lexicalSearch'
  | { readonly aggregate: keyof FieldPolicy['aggregate'] };

/**
 * Dataset capability tags are a policy boundary, not a transport concern.
 * Keep hidden and nonexistent datasets indistinguishable: scoped catalog
 * discovery is the only place that may disclose reachable names.
 */
export function authorizedDataset(
  context: Pick<CompileContext, 'dataset' | 'scope'>,
): EngineResult<true> {
  const allowed = context.dataset.capabilityTags.every((tag) =>
    context.scope.capabilities.includes(tag));
  return allowed
    ? { ok: true, value: true }
    : fail(unavailableReference('/from'));
}

function operationRule(policy: FieldPolicy, operation: FieldOperation) {
  return typeof operation === 'string'
    ? policy[operation]
    : policy.aggregate[operation.aggregate];
}

export function boundField(
  context: Pick<CompileContext, 'dataset' | 'binding'>,
  fieldId: string,
  path: string,
): EngineResult<ResolvedFieldBinding> {
  const field = context.dataset.fields[fieldId];
  const physical = context.binding.fields[fieldId];
  if (field === undefined || physical === undefined) {
    return fail(unavailableReference(path));
  }
  return { ok: true, value: resolveFieldBinding(fieldId, field, physical) };
}

export function authorizedField(
  context: CompileContext,
  fieldId: string,
  operation: FieldOperation,
  path: string,
): EngineResult<ResolvedFieldBinding> {
  const document = context.dataset.fields[fieldId];
  const physical = context.binding.fields[fieldId];
  const policy = context.dataset.fieldPolicies[fieldId];
  const available = Object.entries(context.dataset.fields)
    .filter(([id]) => {
      const candidate = context.dataset.fieldPolicies[id];
      return candidate !== undefined
        && context.binding.fields[id] !== undefined
        && accessRuleAllows(
          operationRule(candidate, operation)[context.input.channel], context.scope,
        );
    })
    .map(([id]) => id)
    .sort();
  if (document === undefined || physical === undefined || policy === undefined) {
    return fail(unavailableReference(path, available));
  }
  const access = operationRule(policy, operation)[context.input.channel];
  if (!accessRuleAllows(access, context.scope)) return fail(unavailableReference(path, available));
  return { ok: true, value: resolveFieldBinding(fieldId, document, physical) };
}

interface AuthorizedEmbedding {
  readonly binding: ResolvedEmbeddingBinding;
  readonly name: string;
}

export function authorizedEmbedding(
  context: CompileContext,
  reference: string,
  path: string,
): EngineResult<AuthorizedEmbedding> {
  const matches = Object.entries(context.dataset.embeddings)
    .filter(([, specReference]) => specReference === reference);
  const match = matches[0];
  if (match === undefined || matches.length !== 1) return fail(unavailableReference(path));
  const [name, specReference] = match;
  const spec = context.input.catalog.embeddingSpecs[specReference];
  const physical = context.binding.embeddings[name];
  if (spec === undefined || physical === undefined) return fail(unavailableReference(path));
  const policy = deriveEmbeddingSearchPolicy(context.dataset, name, spec);
  if (!policy.ok || !accessRuleAllows(policy.value[context.input.channel], context.scope)) {
    return fail(unavailableReference(path));
  }
  if (!physical.indexed) {
    return fail(repairableError(
      'EMBEDDING_NOT_INDEXED',
      'The requested EmbeddingSpec is not indexed by this binding.',
      path,
      ['Choose an indexed EmbeddingSpec.'],
      'Wait for this exact EmbeddingSpec version to become indexed.',
    ));
  }
  return {
    ok: true,
    value: {
      name,
      binding: {
        name,
        specReference,
        specVersion: spec.version,
        physical: physical.physical,
        dimension: spec.dimension,
        metric: spec.metric,
        vectorEncoding: spec.vectorEncoding,
        model: spec.model,
        inputTransformId: spec.inputTransformId,
        privacyClass: spec.privacyClass,
      },
    },
  };
}
