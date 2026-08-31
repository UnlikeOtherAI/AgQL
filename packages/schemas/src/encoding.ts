import {
  isScalar,
  parseAllDocuments,
  visit,
} from 'yaml';

import {
  type AgqlError,
  type ErrorCode,
  type ValidationResult,
  errorResult,
} from './errors.ts';
import type { JsonValue } from './jcs.ts';
import { JsonDecodeFailure, StrictJsonParser } from './json-parser.ts';

export const ENCODING_LIMITS = {
  maximumBytes: 1_048_576,
  maximumDepth: 64,
} as const;

export interface EncodingLimits {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
}

export type InputEncoding = 'json' | 'agql-yaml';

function encodingError(
  code: Exclude<ErrorCode, 'REFERENCE_NOT_AVAILABLE'>,
  message: string,
  alternatives: readonly string[],
): AgqlError {
  return { code, message, path: '', alternatives };
}

function effectiveLimits(limits?: Partial<EncodingLimits>): EncodingLimits {
  return {
    maximumBytes: Math.min(
      limits?.maximumBytes ?? ENCODING_LIMITS.maximumBytes,
      ENCODING_LIMITS.maximumBytes,
    ),
    maximumDepth: Math.min(
      limits?.maximumDepth ?? ENCODING_LIMITS.maximumDepth,
      ENCODING_LIMITS.maximumDepth,
    ),
  };
}

function sizeFailure(
  source: string,
  limits: EncodingLimits,
): ValidationResult<JsonValue> | undefined {
  if (Buffer.byteLength(source, 'utf8') <= limits.maximumBytes) return undefined;
  return errorResult(encodingError(
    'ENCODING_SIZE_LIMIT',
    `The encoded document exceeds the ${limits.maximumBytes}-byte limit.`,
    [`Use an encoded document no larger than ${limits.maximumBytes} bytes.`],
  ));
}

export function decodeJson(
  source: string,
  requestedLimits?: Partial<EncodingLimits>,
): ValidationResult<JsonValue> {
  const limits = effectiveLimits(requestedLimits);
  const oversized = sizeFailure(source, limits);
  if (oversized !== undefined) return oversized;
  try {
    return { ok: true, value: new StrictJsonParser(source, limits.maximumDepth).parse() };
  } catch (caught: unknown) {
    if (caught instanceof JsonDecodeFailure) {
      if (caught.kind === 'duplicate') {
        return errorResult(encodingError(
          'ENCODING_DUPLICATE_KEY',
          'The encoded document contains a duplicate mapping key.',
          ['Remove the duplicate key.'],
        ));
      }
      if (caught.kind === 'depth') {
        return errorResult(encodingError(
          'ENCODING_DEPTH_LIMIT',
          `The encoded document exceeds the depth limit of ${limits.maximumDepth}.`,
          [`Reduce nesting to at most ${limits.maximumDepth} levels.`],
        ));
      }
      return errorResult(encodingError(
        'ENCODING_SYNTAX',
        `The JSON encoding is invalid: ${caught.message}`,
        ['Provide exactly one syntactically valid JSON value.'],
      ));
    }
    throw caught;
  }
}

function unwrapFence(source: string): ValidationResult<string> {
  if (!source.trimStart().startsWith('```')) return { ok: true, value: source };
  const match = /^\s*```agql-yaml[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/u.exec(source);
  if (match?.[1] !== undefined) return { ok: true, value: match[1] };
  return errorResult(encodingError(
    'ENCODING_FENCE_INVALID',
    'The AgQL-YAML fence must use one agql-yaml document and an exact closing fence.',
    ['Use ```agql-yaml followed by one document and a closing ```.'],
  ));
}

interface YamlProfileFindings {
  anchor: boolean;
  merge: boolean;
  customTag: boolean;
  nonStringKey: boolean;
  depthExceeded: boolean;
}

const CORE_TAGS: ReadonlySet<string> = new Set([
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
]);

function inspectYaml(
  document: Parameters<typeof visit>[0],
  maximumDepth: number,
): YamlProfileFindings {
  const findings: YamlProfileFindings = {
    anchor: false,
    merge: false,
    customTag: false,
    nonStringKey: false,
    depthExceeded: false,
  };
  visit(document, {
    Alias() {
      findings.anchor = true;
    },
    Node(_key, node, path) {
      if ('anchor' in node && typeof node.anchor === 'string') findings.anchor = true;
      if ('tag' in node && typeof node.tag === 'string' && !CORE_TAGS.has(node.tag)) {
        findings.customTag = true;
      }
      if (path.length > maximumDepth) findings.depthExceeded = true;
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        findings.nonStringKey = true;
      } else if (pair.key.value === '<<') {
        findings.merge = true;
      }
    },
  });
  return findings;
}

function profileFailure(
  findings: YamlProfileFindings,
  maximumDepth: number,
): ValidationResult<JsonValue> | undefined {
  if (findings.anchor) {
    return errorResult(encodingError(
      'ENCODING_ANCHOR_FORBIDDEN',
      'AgQL-YAML forbids anchors and aliases.',
      ['Inline each value without anchors or aliases.'],
    ));
  }
  if (findings.merge) {
    return errorResult(encodingError(
      'ENCODING_MERGE_KEY_FORBIDDEN',
      'AgQL-YAML forbids merge keys.',
      ['Write every mapping key explicitly.'],
    ));
  }
  if (findings.customTag) {
    return errorResult(encodingError(
      'ENCODING_TAG_FORBIDDEN',
      'AgQL-YAML forbids custom and application tags.',
      ['Use only YAML 1.2 core-schema scalars and collections.'],
    ));
  }
  if (findings.nonStringKey) {
    return errorResult(encodingError(
      'ENCODING_NON_STRING_KEY',
      'AgQL-YAML requires every mapping key to be a string.',
      ['Use a string for every mapping key.'],
    ));
  }
  if (findings.depthExceeded) {
    return errorResult(encodingError(
      'ENCODING_DEPTH_LIMIT',
      `The encoded document exceeds the depth limit of ${maximumDepth}.`,
      [`Reduce nesting to at most ${maximumDepth} levels.`],
    ));
  }
  return undefined;
}

function jsonTree(value: unknown, depth: number, maximumDepth: number): JsonValue {
  if (depth > maximumDepth) {
    throw new JsonDecodeFailure('depth', 'The YAML document exceeds the depth limit.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonDecodeFailure('syntax', 'YAML numeric scalars must be finite.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonTree(item, depth + 1, maximumDepth));
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonTree(item, depth + 1, maximumDepth);
    }
    return result;
  }
  throw new JsonDecodeFailure('syntax', 'YAML values must round-trip through JSON.');
}

export function decodeAgqlYaml(
  encodedSource: string,
  requestedLimits?: Partial<EncodingLimits>,
): ValidationResult<JsonValue> {
  const limits = effectiveLimits(requestedLimits);
  const oversizedInput = sizeFailure(encodedSource, limits);
  if (oversizedInput !== undefined) return oversizedInput;
  const fence = unwrapFence(encodedSource);
  if (!fence.ok) return fence;
  const source = fence.value;
  const documents = parseAllDocuments(source, {
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  if ('empty' in documents || documents.length !== 1) {
    return errorResult(encodingError(
      'ENCODING_MULTIDOC_FORBIDDEN',
      'AgQL-YAML accepts exactly one document and forbids document streams.',
      ['Provide exactly one YAML document.'],
    ));
  }
  const document = documents[0];
  if (document === undefined) {
    return errorResult(encodingError(
      'ENCODING_SYNTAX',
      'The AgQL-YAML document is empty.',
      ['Provide one non-empty YAML document.'],
    ));
  }
  const findings = inspectYaml(document, limits.maximumDepth);
  const profileError = profileFailure(findings, limits.maximumDepth);
  if (profileError !== undefined) return profileError;
  const duplicate = document.errors.some((error) => error.code === 'DUPLICATE_KEY');
  if (duplicate) {
    return errorResult(encodingError(
      'ENCODING_DUPLICATE_KEY',
      'The encoded document contains a duplicate mapping key.',
      ['Remove the duplicate key.'],
    ));
  }
  const syntaxError = document.errors[0];
  if (syntaxError !== undefined) {
    return errorResult(encodingError(
      'ENCODING_SYNTAX',
      `The AgQL-YAML encoding is invalid: ${syntaxError.message}`,
      ['Provide one valid YAML 1.2 core-schema document.'],
    ));
  }
  try {
    const materialized: unknown = document.toJS({ maxAliasCount: 0 });
    return { ok: true, value: jsonTree(materialized, 0, limits.maximumDepth) };
  } catch (caught: unknown) {
    if (caught instanceof JsonDecodeFailure) {
      const code = caught.kind === 'depth' ? 'ENCODING_DEPTH_LIMIT' : 'ENCODING_SYNTAX';
      return errorResult(encodingError(
        code,
        `The AgQL-YAML encoding is invalid: ${caught.message}`,
        ['Provide a bounded document containing only JSON-compatible values.'],
      ));
    }
    throw caught;
  }
}

export function decodeDocument(
  source: string,
  encoding: InputEncoding,
  limits?: Partial<EncodingLimits>,
): ValidationResult<JsonValue> {
  return encoding === 'json'
    ? decodeJson(source, limits)
    : decodeAgqlYaml(source, limits);
}
