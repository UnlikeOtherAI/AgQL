import type { JsonValue } from '@agql/schemas';

export type JsonObject = Readonly<Record<string, JsonValue>>;

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function jsonObject(value: JsonValue, location: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${location} must be a JSON object.`);
  return value;
}

export function jsonArray(value: JsonValue, location: string): readonly JsonValue[] {
  if (!isJsonArray(value)) throw new TypeError(`${location} must be a JSON array.`);
  return value;
}

export function member(object: JsonObject, key: string, location: string): JsonValue {
  const value = object[key];
  if (value === undefined) throw new TypeError(`${location}/${key} is required.`);
  return value;
}

export function objectMember(object: JsonObject, key: string, location: string): JsonObject {
  return jsonObject(member(object, key, location), `${location}/${key}`);
}

export function arrayMember(
  object: JsonObject,
  key: string,
  location: string,
): readonly JsonValue[] {
  return jsonArray(member(object, key, location), `${location}/${key}`);
}

export function stringMember(object: JsonObject, key: string, location: string): string {
  const value = member(object, key, location);
  if (typeof value !== 'string') throw new TypeError(`${location}/${key} must be a string.`);
  return value;
}

export function numberMember(object: JsonObject, key: string, location: string): number {
  const value = member(object, key, location);
  if (typeof value !== 'number') throw new TypeError(`${location}/${key} must be a number.`);
  return value;
}

export function booleanMember(object: JsonObject, key: string, location: string): boolean {
  const value = member(object, key, location);
  if (typeof value !== 'boolean') throw new TypeError(`${location}/${key} must be a boolean.`);
  return value;
}

export function optionalObject(
  object: JsonObject,
  key: string,
  location: string,
): JsonObject | undefined {
  const value = object[key];
  return value === undefined ? undefined : jsonObject(value, `${location}/${key}`);
}

export function optionalString(
  object: JsonObject,
  key: string,
  location: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${location}/${key} must be a string.`);
  return value;
}

export function containsMarker(value: JsonValue, marker: string): boolean {
  if (value === marker) return true;
  if (isJsonArray(value)) return value.some((item) => containsMarker(item, marker));
  if (!isJsonObject(value)) return false;
  return Object.values(value).some((item) => containsMarker(item, marker));
}
