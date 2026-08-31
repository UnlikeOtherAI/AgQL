import type { ResultSchemaField, ResolvedValueType } from '@agql/contracts';
import type { FieldDocument } from '@agql/schemas';

export function fieldResultShape(id: string, field: FieldDocument): ResultSchemaField {
  switch (field.kind) {
    case 'money': {
      const base = { id, kind: 'money' as const, nullable: field.nullable };
      if (field.precision === undefined || field.scale === undefined
        || field.currencies === undefined) return base;
      return {
        ...base,
        precision: field.precision,
        scale: field.scale,
        currencies: field.currencies,
      };
    }
    case 'text':
      return { id, kind: 'text', collation: field.collation, nullable: field.nullable };
    case 'enum':
      return { id, kind: 'enum', values: field.values, nullable: field.nullable };
    case 'instant':
      return { id, kind: 'instant', precision: field.precision, nullable: field.nullable };
    default:
      return { id, kind: field.kind, nullable: field.nullable };
  }
}

export function resolvedResultShape(
  id: string,
  type: ResolvedValueType,
  nullable: boolean,
): ResultSchemaField {
  switch (type.kind) {
    case 'money': {
      const base = { id, kind: 'money' as const, nullable };
      if (type.precision === undefined || type.scale === undefined
        || type.currencies === undefined) return base;
      return {
        ...base,
        precision: type.precision,
        scale: type.scale,
        currencies: type.currencies,
      };
    }
    case 'text':
      return { id, kind: 'text', collation: type.collation, nullable };
    case 'enum':
      return {
        id,
        kind: 'enum',
        values: type.codes.map((code) => ({ code, label: code })),
        nullable,
      };
    case 'instant':
      return { id, kind: 'instant', precision: type.precision, nullable };
    default:
      return { id, kind: type.kind, nullable };
  }
}
