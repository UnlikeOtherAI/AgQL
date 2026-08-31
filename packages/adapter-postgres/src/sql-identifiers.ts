import type { CatalogPhysicalIdentifier } from '@agql/contracts';

import type { PostgresCollationBinding } from './types.ts';

/** Quotes a catalog/operator-owned identifier. This function never accepts model vocabulary. */
export function quoteIdentifier(identifier: CatalogPhysicalIdentifier): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

export function quoteQualified(
  namespace: CatalogPhysicalIdentifier,
  identifier: CatalogPhysicalIdentifier,
): string {
  return `${quoteIdentifier(namespace)}.${quoteIdentifier(identifier)}`;
}

export function quoteCollation(binding: PostgresCollationBinding): string {
  if (binding.schema === undefined) return quoteIdentifier(binding.name);
  return quoteQualified(binding.schema, binding.name);
}

export function internalColumn(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('Internal SQL column indexes must be nonnegative safe integers.');
  }
  return `"_agql_c${index}"`;
}
