import { jsonPointer } from '@agql/schemas';
import type {
  AccessRule,
  ChannelAccess,
  DatasetDocument,
  EmbeddingSpecDocument,
  ValidationResult,
} from '@agql/schemas';

import type { Scope } from './scope.ts';

export type PolicyChannel = 'model' | 'principal';

/** Dataset capability tags gate the whole scoped dataset vocabulary. */
export function datasetCapabilitiesAllow(
  dataset: Pick<DatasetDocument, 'capabilityTags'>,
  scope: Pick<Scope, 'capabilities'>,
): boolean {
  const held = new Set(scope.capabilities);
  return dataset.capabilityTags.every((tag) => held.has(tag));
}

export function accessRuleAllows(rule: AccessRule, scope: Scope): boolean {
  if (rule.effect === 'deny') return false;
  const held = new Set(scope.capabilities);
  return rule.requiredCapabilities.every((capability) => held.has(capability));
}

function combineRules(rules: readonly AccessRule[]): AccessRule {
  if (rules.some((rule) => rule.effect === 'deny')) return { effect: 'deny' };
  const capabilities = new Set<string>();
  for (const rule of rules) {
    if (rule.effect === 'allow') {
      for (const capability of rule.requiredCapabilities) capabilities.add(capability);
    }
  }
  return { effect: 'allow', requiredCapabilities: [...capabilities].sort() };
}

/**
 * RFC §6 protected-source inheritance. Conjunctive capability union is the most restrictive
 * composable rule, and a deny on any source wins. A reviewed embedding rule replaces it.
 */
export function deriveEmbeddingSearchPolicy(
  dataset: DatasetDocument,
  embeddingName: string,
  spec: EmbeddingSpecDocument,
): ValidationResult<ChannelAccess> {
  const reviewed = dataset.embeddingPolicies[embeddingName];
  if (reviewed !== undefined) return { ok: true, value: reviewed.semanticSearch };

  const sourcePolicies = spec.sourceFields.map((field) => dataset.fieldPolicies[field]);
  if (sourcePolicies.some((policy) => policy === undefined)) {
    return {
      ok: false,
      errors: [{
        code: 'SEMANTIC_INVALID',
        message: 'The embedding source field must have a field policy in its dataset.',
        path: jsonPointer(['embeddingSpecs', embeddingName, 'sourceFields']),
        alternatives: ['Declare a policy for every embedding source field.'],
      }],
    };
  }

  const presentPolicies = sourcePolicies.filter((policy) => policy !== undefined);
  return {
    ok: true,
    value: {
      model: combineRules(presentPolicies.map((policy) => policy.lexicalSearch.model)),
      principal: combineRules(presentPolicies.map((policy) => policy.lexicalSearch.principal)),
    },
  };
}
