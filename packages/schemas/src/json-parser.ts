import type { JsonValue } from './jcs.ts';

export class JsonDecodeFailure extends Error {
  public constructor(
    public readonly kind: 'syntax' | 'duplicate' | 'depth',
    message: string,
  ) {
    super(message);
  }
}

export class StrictJsonParser {
  private position = 0;

  public constructor(
    private readonly source: string,
    private readonly maximumDepth: number,
  ) {}

  public parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.source.length) this.fail('Unexpected trailing content.');
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.maximumDepth) {
      throw new JsonDecodeFailure('depth', 'The JSON document exceeds the depth limit.');
    }
    const character = this.source[this.position];
    if (character === '"') return this.parseString();
    if (character === '{') return this.parseObject(depth + 1);
    if (character === '[') return this.parseArray(depth + 1);
    if (character === 't') return this.parseKeyword('true', true);
    if (character === 'f') return this.parseKeyword('false', false);
    if (character === 'n') return this.parseKeyword('null', null);
    if (character === '-' || (character !== undefined && /\d/u.test(character))) {
      return this.parseNumber();
    }
    return this.fail('Expected a JSON value.');
  }

  private parseObject(depth: number): JsonValue {
    this.position += 1;
    this.skipWhitespace();
    const result: Record<string, JsonValue> = {};
    const keys = new Set<string>();
    if (this.consume('}')) return result;
    for (;;) {
      if (this.source[this.position] !== '"') this.fail('Expected a JSON object key.');
      const key = this.parseString();
      if (keys.has(key)) {
        throw new JsonDecodeFailure('duplicate', `The JSON object repeats the key ${key}.`);
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume('}')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue {
    this.position += 1;
    this.skipWhitespace();
    const result: JsonValue[] = [];
    if (this.consume(']')) return result;
    for (;;) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume(']')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (!escaped && character === '"') {
        this.position += 1;
        const encoded = this.source.slice(start, this.position);
        try {
          const parsed: unknown = JSON.parse(encoded);
          if (typeof parsed === 'string') return parsed;
          return this.fail('Expected a JSON string.');
        } catch {
          return this.fail('The JSON string escape sequence is invalid.');
        }
      }
      if (!escaped && character !== undefined && character.charCodeAt(0) < 0x20) {
        return this.fail('JSON strings cannot contain unescaped control characters.');
      }
      if (!escaped && character === '\\') {
        escaped = true;
      } else {
        escaped = false;
      }
      this.position += 1;
    }
    return this.fail('The JSON string is not terminated.');
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remainder);
    if (match === null) return this.fail('The JSON number is invalid.');
    const encoded = match[0];
    this.position += encoded.length;
    const value = Number(encoded);
    if (!Number.isFinite(value)) return this.fail('The JSON number is outside the finite range.');
    return value;
  }

  private parseKeyword<T extends boolean | null>(keyword: string, value: T): T {
    if (!this.source.startsWith(keyword, this.position)) this.fail(`Expected ${keyword}.`);
    this.position += keyword.length;
    return value;
  }

  private skipWhitespace(): void {
    for (;;) {
      const character = this.source[this.position];
      if (character !== ' ' && character !== '\t'
        && character !== '\n' && character !== '\r') return;
      this.position += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.source[this.position] !== expected) return false;
    this.position += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) this.fail(`Expected ${expected}.`);
  }

  private fail(message: string): never {
    throw new JsonDecodeFailure('syntax', `${message} At code-unit offset ${this.position}.`);
  }
}
