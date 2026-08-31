import type {
  CatalogPhysicalIdentifier,
  LogicalFilter,
  ResolvedFieldBinding,
  ResolvedPredicate,
  TypedValue,
} from '@agql/contracts';
import type { CanonicalDecimal, NormalizedText } from '@agql/schemas';

import type { SqliteParameter, SqliteTextCollation } from './types.ts';

export const DELETED_COLUMN = '__agql_deleted';
export const VERSION_COLUMN = '__agql_version';

export function quoteIdentifier(identifier: CatalogPhysicalIdentifier): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteRuntimeIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isSupportedTextCollation(
  field: ResolvedFieldBinding,
  supported: readonly SqliteTextCollation[],
): boolean {
  const valueType = field.type;
  if (valueType.kind !== 'text') return true;
  return supported.some((collation) => collation.id === valueType.collation.id
    && collation.version === valueType.collation.version);
}

export function requiresSupportedCollation(
  fields: readonly ResolvedFieldBinding[],
  supported: readonly SqliteTextCollation[],
): boolean {
  return fields.every((field) => isSupportedTextCollation(field, supported));
}

export function scalarParameter(value: TypedValue): SqliteParameter {
  switch (value.kind) {
    case 'id':
    case 'enum':
    case 'text':
    case 'date':
    case 'instant':
    case 'decimal':
      return value.value;
    case 'boolean':
      return value.value ? 1 : 0;
    case 'integer':
      return value.value;
    case 'money':
      return JSON.stringify(value.value);
    case 'null':
      return null;
  }
}

function appendParameters(
  target: SqliteParameter[],
  values: readonly SqliteParameter[],
): void {
  for (const value of values) target.push(value);
}

function decimalParts(value: CanonicalDecimal): {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
} {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const point = unsigned.indexOf('.');
  if (point < 0) return { negative, integer: unsigned, fraction: '' };
  return {
    negative,
    integer: unsigned.slice(0, point),
    fraction: unsigned.slice(point + 1),
  };
}

/**
 * SQLite has no exact decimal type. This expression compares canonical decimal strings using
 * sign, integer width, code-unit integer digits, and fractional-prefix order; no REAL value is
 * ever introduced.
 */
function decimalComparison(
  column: string,
  operator: 'lt' | 'lte' | 'gt' | 'gte',
  value: CanonicalDecimal,
): { readonly sql: string; readonly parameters: readonly SqliteParameter[] } {
  const parts = decimalParts(value);
  const valueIntegerLength = parts.integer.length;
  const valueInteger = parts.integer;
  const valueFraction = parts.fraction;
  const sign = `CASE WHEN substr(${column}, 1, 1) = '-' THEN 0 ELSE 1 END`;
  const unsigned = `CASE WHEN ${sign} = 0 THEN substr(${column}, 2) ELSE ${column} END`;
  const point = `instr(${unsigned}, '.')`;
  const integer = `CASE WHEN ${point} = 0 THEN ${unsigned}`
    + ` ELSE substr(${unsigned}, 1, ${point} - 1) END`;
  const fraction = `CASE WHEN ${point} = 0 THEN ''`
    + ` ELSE substr(${unsigned}, ${point} + 1) END`;
  const absoluteGreater = `(length(${integer}) > ? OR (length(${integer}) = ? AND (`
    + `${integer} > ? OR (${integer} = ? AND ${fraction} > ?))))`;
  const absoluteEqual = `${column} = ?`;
  const absoluteLess = `(NOT ${absoluteGreater} AND NOT (${absoluteEqual}))`;
  const greater = parts.negative
    ? `(${sign} = 1 OR (${sign} = 0 AND ${absoluteLess}))`
    : `(${sign} = 1 AND ${absoluteGreater})`;
  const less = parts.negative
    ? `(${sign} = 0 AND ${absoluteGreater})`
    : `(${sign} = 0 OR (${sign} = 1 AND ${absoluteLess}))`;
  const equal = `${column} = ?`;
  const base = operator === 'gt' || operator === 'gte' ? greater : less;
  const equality = operator === 'gte' || operator === 'lte' ? ` OR ${equal}` : '';
  const absoluteParameters: readonly SqliteParameter[] = [
    valueIntegerLength,
    valueIntegerLength,
    valueInteger,
    valueInteger,
    valueFraction,
  ];
  const needsLess = (operator === 'lt' || operator === 'lte') !== parts.negative;
  const comparisonParameters = needsLess
    ? [...absoluteParameters, value]
    : absoluteParameters;
  const parameters = operator === 'gte' || operator === 'lte'
    ? [...comparisonParameters, value]
    : comparisonParameters;
  return { sql: `(${base}${equality})`, parameters };
}

function moneyAmountColumn(column: string): string {
  return `json_extract(${column}, '$.amount')`;
}

function comparisonSql(
  field: ResolvedFieldBinding,
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  value: TypedValue,
): { readonly sql: string; readonly parameters: readonly SqliteParameter[] } {
  const column = quoteIdentifier(field.physical);
  if (value.kind === 'null') {
    const sql = operator === 'eq' ? `${column} IS NULL` : `${column} IS NOT NULL`;
    return { sql, parameters: [] };
  }
  if (field.type.kind === 'decimal' && value.kind === 'decimal'
    && operator !== 'eq' && operator !== 'ne') {
    return decimalComparison(column, operator, value.value);
  }
  if (field.type.kind === 'money' && value.kind === 'money') {
    if (value.value.currency !== field.type.currency) {
      return { sql: '0 = 1', parameters: [] };
    }
    const amount = moneyAmountColumn(column);
    if (operator !== 'eq' && operator !== 'ne') {
      return decimalComparison(amount, operator, value.value.amount);
    }
  }
  const parameter = scalarParameter(value);
  const operatorSql = {
    eq: '=',
    ne: '<>',
    lt: '<',
    lte: '<=',
    gt: '>',
    gte: '>=',
  }[operator];
  return { sql: `${column} ${operatorSql} ?`, parameters: [parameter] };
}

function substringSql(
  field: ResolvedFieldBinding,
  operation: 'contains' | 'startsWith',
  value: NormalizedText,
): { readonly sql: string; readonly parameters: readonly SqliteParameter[] } {
  const column = quoteIdentifier(field.physical);
  if (operation === 'contains') return { sql: `instr(${column}, ?) > 0`, parameters: [value] };
  return {
    sql: `substr(${column}, 1, length(?)) = ?`,
    parameters: [value, value],
  };
}

function predicateSql(predicate: ResolvedPredicate): {
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
} {
  if (predicate.kind === 'comparison') {
    return comparisonSql(predicate.field, predicate.op, predicate.value);
  }
  if (predicate.kind === 'null') {
    const column = quoteIdentifier(predicate.field.physical);
    return {
      sql: predicate.op === 'isNull' ? `${column} IS NULL` : `${column} IS NOT NULL`,
      parameters: [],
    };
  }
  if (predicate.kind === 'substring') {
    return substringSql(predicate.field, predicate.op, predicate.value);
  }
  if (predicate.kind === 'instantRange') {
    const column = quoteIdentifier(predicate.field.physical);
    return {
      sql: `(${column} >= ? AND ${column} < ?)`,
      parameters: [predicate.startInclusive, predicate.endExclusive],
    };
  }
  const column = quoteIdentifier(predicate.field.physical);
  const values = predicate.values.map(scalarParameter);
  const placeholders = values.map(() => '?').join(', ');
  return {
    sql: `${column} ${predicate.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`,
    parameters: values,
  };
}

export function filterSql(filter: LogicalFilter<ResolvedPredicate> | undefined): {
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
} {
  if (filter === undefined) return { sql: '1 = 1', parameters: [] };
  if (filter.kind !== 'and' && filter.kind !== 'or' && filter.kind !== 'not') {
    return predicateSql(filter);
  }
  if (filter.kind === 'not') {
    const item = filterSql(filter.item);
    return { sql: `NOT (${item.sql})`, parameters: item.parameters };
  }
  const nested = filter.items.map(filterSql);
  const parameters: SqliteParameter[] = [];
  for (const item of nested) appendParameters(parameters, item.parameters);
  const operator = filter.kind === 'and' ? ' AND ' : ' OR ';
  return { sql: `(${nested.map((item) => `(${item.sql})`).join(operator)})`, parameters };
}

export function scopeAndFilterSql(
  scope: { readonly visibility: 'nothing' }
    | {
      readonly visibility: 'predicate';
      readonly predicates: readonly [ResolvedPredicate, ...ResolvedPredicate[]];
    },
  filter: LogicalFilter<ResolvedPredicate> | undefined,
): { readonly sql: string; readonly parameters: readonly SqliteParameter[] } {
  if (scope.visibility === 'nothing') return { sql: '0 = 1', parameters: [] };
  const scopeItems = scope.predicates.map(predicateSql);
  const queryFilter = filterSql(filter);
  const parameters: SqliteParameter[] = [];
  for (const item of scopeItems) appendParameters(parameters, item.parameters);
  appendParameters(parameters, queryFilter.parameters);
  return {
    sql: `(${scopeItems.map((item) => `(${item.sql})`).join(' AND ')}) AND (${queryFilter.sql})`,
    parameters,
  };
}

export function decimalOrderSql(column: string, direction: 'asc' | 'desc'): string {
  const sign = `CASE WHEN substr(${column}, 1, 1) = '-' THEN 0 ELSE 1 END`;
  const unsigned = `CASE WHEN ${sign} = 0 THEN substr(${column}, 2) ELSE ${column} END`;
  const point = `instr(${unsigned}, '.')`;
  const integer = `CASE WHEN ${point} = 0 THEN ${unsigned}`
    + ` ELSE substr(${unsigned}, 1, ${point} - 1) END`;
  const fraction = `CASE WHEN ${point} = 0 THEN ''`
    + ` ELSE substr(${unsigned}, ${point} + 1) END`;
  const ascending = direction === 'asc';
  const signOrder = ascending ? 'ASC' : 'DESC';
  const negativeOrder = ascending ? 'DESC' : 'ASC';
  const positiveOrder = ascending ? 'ASC' : 'DESC';
  return `${sign} ${signOrder}, `
    + `CASE WHEN ${sign} = 0 THEN length(${integer}) END ${negativeOrder}, `
    + `CASE WHEN ${sign} = 0 THEN ${integer} END ${negativeOrder}, `
    + `CASE WHEN ${sign} = 0 THEN ${fraction} END ${negativeOrder}, `
    + `CASE WHEN ${sign} = 1 THEN length(${integer}) END ${positiveOrder}, `
    + `CASE WHEN ${sign} = 1 THEN ${integer} END ${positiveOrder}, `
    + `CASE WHEN ${sign} = 1 THEN ${fraction} END ${positiveOrder}`;
}
