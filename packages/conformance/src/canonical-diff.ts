import { canonicalizeJcs } from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

export interface CanonicalComparison {
  readonly equal: boolean;
  readonly expectedBytes: string;
  readonly actualBytes: string;
  readonly diff: string;
}

function firstDifferentIndex(left: string, right: string): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return shared;
}

function excerpt(value: string, index: number): string {
  const start = Math.max(0, index - 32);
  const end = Math.min(value.length, index + 96);
  return value.slice(start, end);
}

export function compareCanonical(
  expected: JsonValue,
  actual: JsonValue,
): CanonicalComparison {
  const expectedBytes = canonicalizeJcs(expected);
  const actualBytes = canonicalizeJcs(actual);
  if (expectedBytes === actualBytes) {
    return { equal: true, expectedBytes, actualBytes, diff: 'JCS bytes are equal.' };
  }
  const index = firstDifferentIndex(expectedBytes, actualBytes);
  return {
    equal: false,
    expectedBytes,
    actualBytes,
    diff: `first differing UTF-8/JCS character offset ${index}; expected excerpt `
      + `${JSON.stringify(excerpt(expectedBytes, index))}, actual excerpt `
      + JSON.stringify(excerpt(actualBytes, index)),
  };
}
