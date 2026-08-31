/** JSON values accepted by RFC 8785 canonicalization. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('JCS cannot canonicalize an unpaired UTF-16 high surrogate.');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('JCS cannot canonicalize an unpaired UTF-16 low surrogate.');
    }
  }
}

function canonicalString(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError('JCS cannot canonicalize a non-finite number.');
  }
  return JSON.stringify(value);
}

function canonicalArray(value: readonly unknown[]): string {
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError('JCS cannot canonicalize a sparse JSON array.');
    }
    items.push(canonicalizeJcs(value[index]));
  }
  return `[${items.join(',')}]`;
}

function isUnknownRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}

function canonicalObject(value: Record<string, unknown>): string {
  if (Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('JCS only canonicalizes plain JSON objects.');
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    throw new TypeError('JCS only canonicalizes objects with string property names.');
  }
  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return `{${entries.map(([key, item]) =>
    `${canonicalString(key)}:${canonicalizeJcs(item)}`).join(',')}}`;
}

/**
 * RFC 8785 (JCS) serialization. Callers pass schema-validated trees with defaults already
 * materialized. Property ordering follows UTF-16 code units, as required by JCS/ECMAScript.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) return canonicalArray(value);
    if (isUnknownRecord(value)) return canonicalObject(value);
  }
  throw new TypeError('JCS only canonicalizes JSON values.');
}
