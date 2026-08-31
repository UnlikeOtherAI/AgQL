import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeJson } from '@agql/schemas';
import type { JsonValue } from '@agql/schemas';

export interface FixtureSource {
  readonly path: string;
  readonly source: string;
}

export interface JsonFixtureSource extends FixtureSource {
  readonly value: JsonValue;
}

export class FixtureLoadError extends Error {
  public constructor(
    public readonly fixturePath: string,
    message: string,
  ) {
    super(`${fixturePath}: ${message}`);
    this.name = 'FixtureLoadError';
  }
}

function decodeUtf8(pathname: string, bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new FixtureLoadError(pathname, 'fixture files must not contain a UTF-8 byte-order mark.');
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FixtureLoadError(pathname, 'fixture bytes are not valid UTF-8.');
  }
  if (source.includes('\r')) {
    throw new FixtureLoadError(pathname, 'fixture files must use LF line endings only.');
  }
  return source;
}

export async function loadFixtureSource(pathname: string): Promise<FixtureSource> {
  const bytes = await readFile(pathname);
  return { path: pathname, source: decodeUtf8(pathname, bytes) };
}

export async function loadJsonFixture(pathname: string): Promise<JsonFixtureSource> {
  const fixture = await loadFixtureSource(pathname);
  const decoded = decodeJson(fixture.source);
  if (!decoded.ok) {
    const details = decoded.errors.map((error) => `${error.code} at ${error.path}`).join(', ');
    throw new FixtureLoadError(pathname, `fixture JSON is invalid: ${details}.`);
  }
  return { ...fixture, value: decoded.value };
}

export async function discoverFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new FixtureLoadError(
        path.join(directory, entry.name),
        'fixture entries must be files.',
      );
    }
    paths.push(path.join(directory, entry.name));
  }
  return paths.sort(comparePath);
}

function comparePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
