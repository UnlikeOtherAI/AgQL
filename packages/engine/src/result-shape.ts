import type { ResultSchemaField, ResolvedValueType } from '@agql/contracts';
import type { FieldDocument } from '@agql/schemas';

export function fieldResultShape(id: string, field: FieldDocument): ResultSchemaField {
  switch (field.kind) {
    case 'money':
      return { id, kind: 'money', currency: field.currency, nullable: field.nullable };
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
    case 'money':
      return { id, kind: 'money', currency: type.currency, nullable };
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
