import { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';

import type { AdapterExecutionResult, AdapterOutcome, TypedValue } from '@agql/contracts';
import { SafeIntegerSchema } from '@agql/schemas';

import { typedValueFromSqlite } from './scalars.ts';
import type {
  CompiledRecordsQuery,
  CompiledSemanticQuery,
  SqliteParameter,
} from './types.ts';

type SqliteRow = Readonly<Record<string, null | number | bigint | string | Uint8Array>>;

export const SQLITE_DISTANCE_TOLERANCE = {
  absolute: 1e-12,
  relative: 1e-12,
} as const;

function rows(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SqliteParameter[],
): readonly SqliteRow[] {
  return database.prepare(sql).all(...parameters);
}

function value(row: SqliteRow, name: string): null | number | bigint | string | Uint8Array {
  const result = row[name];
  if (result === undefined) throw new TypeError(`SQLite result omitted expected column ${name}.`);
  return result;
}

function databasePathExecution<T>(
  databasePath: string,
  operation: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    readOnly: true,
    defensive: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function projectionRows(
  resultRows: readonly SqliteRow[],
  projection: CompiledRecordsQuery['projection'],
): readonly (readonly TypedValue[])[] {
  return resultRows.map((row) => projection.map((item, index) =>
    typedValueFromSqlite(value(row, `c${index}`), item.field)));
}

export function executeRecords(
  databasePath: string,
  compiled: CompiledRecordsQuery,
): AdapterOutcome<AdapterExecutionResult> {
  return databasePathExecution(databasePath, (database) => {
    const resultRows = rows(database, compiled.sql, compiled.parameters);
    const truncated = resultRows.length > compiled.plan.take;
    const visible = truncated ? resultRows.slice(0, compiled.plan.take) : resultRows;
    return {
      kind: 'success',
      value: {
        rows: projectionRows(visible, compiled.projection),
        truncated,
        snapshot: { kind: 'none' },
      },
    };
  });
}

function vectorValues(bytes: Uint8Array, encoding: string, dimension: number): readonly number[] {
  if (encoding === 'binary') {
    if (bytes.byteLength !== Math.ceil(dimension / 8)) {
      throw new TypeError('Stored binary vector byte length does not match its EmbeddingSpec.');
    }
    const values: number[] = [];
    for (let index = 0; index < dimension; index += 1) {
      const byte = bytes[Math.floor(index / 8)];
      if (byte === undefined) throw new TypeError('Stored binary vector ended unexpectedly.');
      values.push((byte >>> (index % 8)) & 1);
    }
    return values;
  }
  const byteWidth = encoding === 'float64' ? 8 : encoding === 'float32' ? 4 : 1;
  if (bytes.byteLength !== dimension * byteWidth) {
    throw new TypeError('Stored vector byte length does not match its EmbeddingSpec.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    const offset = index * byteWidth;
    const item = encoding === 'float64'
      ? view.getFloat64(offset, true)
      : encoding === 'float32'
        ? view.getFloat32(offset, true)
        : view.getInt8(offset);
    if (!Number.isFinite(item)) {
      throw new TypeError('Stored vectors must not contain non-finite values.');
    }
    values.push(item);
  }
  return values;
}

function score(
  candidate: readonly number[],
  query: readonly number[],
  metric: 'cosine' | 'dot' | 'euclidean',
): number {
  let dot = 0;
  let candidateNorm = 0;
  let queryNorm = 0;
  let squareDistance = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const candidateValue = candidate[index];
    const queryValue = query[index];
    if (candidateValue === undefined || queryValue === undefined) {
      throw new TypeError('Vector dimensions must match exactly.');
    }
    dot += candidateValue * queryValue;
    candidateNorm += candidateValue * candidateValue;
    queryNorm += queryValue * queryValue;
    squareDistance += (candidateValue - queryValue) ** 2;
  }
  if (metric === 'dot') return dot;
  if (metric === 'euclidean') return Math.sqrt(squareDistance);
  if (candidateNorm === 0 || queryNorm === 0) {
    throw new TypeError('Cosine exact retrieval does not accept a zero-norm vector.');
  }
  return dot / Math.sqrt(candidateNorm * queryNorm);
}

interface RankedRow {
  readonly row: SqliteRow;
  readonly id: string;
  readonly score: number;
}

function candidateRows(
  rowsToRank: readonly SqliteRow[],
  compiled: CompiledSemanticQuery,
): readonly RankedRow[] {
  const query = vectorValues(
    compiled.plan.search.vector.bytes,
    compiled.plan.search.vector.encoding,
    compiled.plan.search.vector.dimension,
  );
  return rowsToRank.map((row) => {
    const stableId = typedValueFromSqlite(
      value(row, 'stable_id'),
      compiled.plan.stableId,
    );
    if (stableId.kind !== 'id') {
      throw new TypeError('The retrieval stable-id binding must be id typed.');
    }
    const stored = value(row, 'vector');
    if (!(stored instanceof Uint8Array)) throw new TypeError('SQLite stored vector is not a BLOB.');
    const candidate = vectorValues(
      stored,
      compiled.plan.search.embedding.vectorEncoding,
      compiled.plan.search.embedding.dimension,
    );
    return {
      row,
      id: stableId.value,
      score: score(candidate, query, compiled.plan.search.embedding.metric),
    };
  });
}

function rankedOrder(
  metric: 'cosine' | 'dot' | 'euclidean',
): (left: RankedRow, right: RankedRow) => number {
  return (left, right) => {
    if (left.score !== right.score) {
      if (metric === 'euclidean') return left.score < right.score ? -1 : 1;
      return left.score > right.score ? -1 : 1;
    }
    return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
  };
}

function embeddingIsIndexed(
  database: DatabaseSync,
  compiled: CompiledSemanticQuery,
): boolean {
  const row = database.prepare(
    'SELECT 1 AS present FROM pragma_table_xinfo(?) WHERE name = ? LIMIT 1',
  ).get(compiled.plan.dataset.physical, compiled.plan.search.embedding.physical);
  return row !== undefined;
}

export function executeSemantic(
  databasePath: string,
  compiled: CompiledSemanticQuery,
): AdapterOutcome<AdapterExecutionResult> {
  return databasePathExecution(databasePath, (database) => {
    if (compiled.plan.scope.visibility === 'nothing') {
      return {
        kind: 'success',
        value: {
          rows: [],
          ranks: [],
          truncated: false,
          snapshot: { kind: 'none' },
        },
      };
    }
    if (!embeddingIsIndexed(database, compiled)) {
      return {
        kind: 'refusal',
        refusal: {
          code: 'EMBEDDING_NOT_INDEXED',
          message: 'The resolved EmbeddingSpec has no indexed SQLite column for this source.',
          path: '/search/embedding',
          alternatives: ['Index the resolved EmbeddingSpec.', 'Use an indexed EmbeddingSpec.'],
          remedy: 'Populate the catalog-resolved vector column before querying it.',
        },
      };
    }
    const countRow = rows(database, compiled.countSql, compiled.countParameters)[0];
    if (countRow === undefined) throw new TypeError('SQLite eligibility count produced no row.');
    const countValue = value(countRow, 'eligible_count');
    if (typeof countValue !== 'number' || !Number.isSafeInteger(countValue)) {
      throw new TypeError('SQLite eligibility count is not a safe integer.');
    }
    const eligibleCount = SafeIntegerSchema.parse(countValue);
    if (eligibleCount > compiled.plan.search.hardCandidateLimit) {
      return {
        kind: 'refusal',
        refusal: {
          code: 'EXACT_SCAN_BUDGET_EXCEEDED',
          message: 'Exact semantic retrieval exceeds the engine-approved eligible-set bound.',
          path: '/search/accuracy',
          alternatives: ['Add a selective predicate.', 'Use an approximate retrieval adapter.'],
          remedy: 'Reduce the eligible set or route to an approximate retrieval adapter.',
        },
      };
    }
    const ranked = [...candidateRows(rows(database, compiled.sql, compiled.parameters), compiled)]
      .sort(rankedOrder(compiled.plan.search.embedding.metric));
    const selected = ranked.slice(0, compiled.plan.take);
    return {
      kind: 'success',
      value: {
        rows: selected.map((item) => compiled.projection.map((projection, index) =>
          typedValueFromSqlite(value(item.row, `c${index}`), projection.field))),
        ranks: selected.map((_, index) => SafeIntegerSchema.parse(index + 1)),
        truncated: ranked.length > compiled.plan.take,
        snapshot: { kind: 'none' },
      },
    };
  });
}
