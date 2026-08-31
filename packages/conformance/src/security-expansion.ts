import type { JsonValue } from '@agql/schemas';

import { isJsonArray, isJsonObject } from './json-shape.ts';
import type { SecurityFixture } from './security-fixtures.ts';

export interface SecurityCase {
  readonly fixtureId: string;
  readonly seedHex: string;
  readonly caseIndex: number;
  readonly selected: Readonly<Record<string, JsonValue>>;
  readonly setup: JsonValue;
}

export class Xorshift32 {
  private state: number;

  public constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffff_ffff) {
      throw new TypeError('xorshift32 seed must be a nonzero unsigned 32-bit integer.');
    }
    this.state = seed >>> 0;
  }

  public nextU32(): number {
    let next = this.state;
    next = (next ^ (next << 13)) >>> 0;
    next = (next ^ (next >>> 17)) >>> 0;
    next = (next ^ (next << 5)) >>> 0;
    this.state = next;
    return next;
  }
}

function replacementText(value: JsonValue, name: string): string {
  if (typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean') return String(value);
  throw new TypeError(`Placeholder ${name} cannot embed a structured value inside text.`);
}

function expandString(
  value: string,
  replacements: Readonly<Record<string, JsonValue>>,
): JsonValue {
  const exact = /^\{\{([^{}]+)\}\}$/u.exec(value);
  if (exact !== null) {
    const name = exact[1];
    if (name === undefined) throw new TypeError('Placeholder name is missing.');
    const replacement = replacements[name];
    if (replacement === undefined) throw new TypeError(`Unknown placeholder ${name}.`);
    return replacement;
  }
  return value.replaceAll(/\{\{([^{}]+)\}\}/gu, (_match, name: string) => {
    const replacement = replacements[name];
    if (replacement === undefined) throw new TypeError(`Unknown placeholder ${name}.`);
    return replacementText(replacement, name);
  });
}

export function expandTemplate(
  value: JsonValue,
  replacements: Readonly<Record<string, JsonValue>>,
): JsonValue {
  if (typeof value === 'string') return expandString(value, replacements);
  if (isJsonArray(value)) return value.map((item) => expandTemplate(item, replacements));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    expandTemplate(item, replacements),
  ]));
}

function selectedCase(fixture: SecurityFixture, prng: Xorshift32): Record<string, JsonValue> {
  const selected: Record<string, JsonValue> = {};
  for (const dimension of fixture.dimensions) {
    const index = prng.nextU32() % dimension.values.length;
    const value = dimension.values[index];
    if (value === undefined) throw new TypeError(`${dimension.name} selection is out of range.`);
    selected[dimension.name] = value;
  }
  return selected;
}

export function* expandSecurityCases(
  fixture: SecurityFixture,
  limit: number,
  onlyCaseIndex?: number,
): Generator<SecurityCase> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > fixture.caseCount) {
    throw new TypeError(`Security expansion limit must be within 0..${fixture.caseCount}.`);
  }
  if (onlyCaseIndex !== undefined
    && (!Number.isSafeInteger(onlyCaseIndex)
      || onlyCaseIndex < 0
      || onlyCaseIndex >= fixture.caseCount)) {
    throw new TypeError(`Security replay case index must be within 0..${fixture.caseCount - 1}.`);
  }
  const prng = new Xorshift32(fixture.seed);
  const stop = onlyCaseIndex === undefined ? limit : onlyCaseIndex + 1;
  for (let caseIndex = 0; caseIndex < stop; caseIndex += 1) {
    const selected = selectedCase(fixture, prng);
    if (onlyCaseIndex !== undefined && caseIndex !== onlyCaseIndex) continue;
    const replacements: Record<string, JsonValue> = {
      ...selected,
      caseIndex,
    };
    yield {
      fixtureId: fixture.id,
      seedHex: fixture.seedHex,
      caseIndex,
      selected,
      setup: expandTemplate(fixture.setup, replacements),
    };
  }
}
