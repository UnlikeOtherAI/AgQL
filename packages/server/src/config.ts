import { readFile } from 'node:fs/promises';

import { validateCatalog } from '@agql/catalog';
import type { CatalogDocument } from '@agql/schemas';

export const DEFAULT_PORT = 8787;
export const SERVER_VERSION = '0.0.0';
export const DEFAULT_SOURCE_ID = 'default';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerConfig {
  readonly port: number;
  readonly appKeys: readonly string[];
  readonly catalogPath: string;
  readonly databaseUrl: string;
  readonly embedder: 'deterministic';
  readonly logLevel: LogLevel;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigurationError(`${name} is required.`);
  }
  return value;
}

function port(environment: NodeJS.ProcessEnv): number {
  const value = environment.AGQL_PORT;
  if (value === undefined || value.trim().length === 0) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigurationError('AGQL_PORT must be an integer from 1 through 65535.');
  }
  return parsed;
}

function appKeys(environment: NodeJS.ProcessEnv): readonly string[] {
  const values = required(environment, 'AGQL_APP_KEYS')
    .split(',')
    .map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new ConfigurationError('AGQL_APP_KEYS must be a comma-separated list of nonempty keys.');
  }
  if (new Set(values).size !== values.length) {
    throw new ConfigurationError('AGQL_APP_KEYS must not contain duplicate keys.');
  }
  return values;
}

function embedder(environment: NodeJS.ProcessEnv): 'deterministic' {
  const configured = environment.AGQL_EMBEDDER?.trim() ?? 'deterministic';
  if (configured !== 'deterministic') {
    throw new ConfigurationError(
      'AGQL_EMBEDDER currently supports only deterministic; configure AGQL_EMBEDDER=deterministic.',
    );
  }
  return configured;
}

function logLevel(environment: NodeJS.ProcessEnv): LogLevel {
  const configured = environment.AGQL_LOG_LEVEL?.trim() ?? 'info';
  if (configured === 'debug' || configured === 'info'
    || configured === 'warn' || configured === 'error') return configured;
  throw new ConfigurationError('AGQL_LOG_LEVEL must be debug, info, warn, or error.');
}

export function readServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return {
    port: port(environment),
    appKeys: appKeys(environment),
    catalogPath: required(environment, 'AGQL_CATALOG_PATH'),
    databaseUrl: required(environment, 'DATABASE_URL'),
    embedder: embedder(environment),
    logLevel: logLevel(environment),
  };
}

function catalogErrors(errors: readonly {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}[]): string {
  return errors.map((error) => `${error.code} ${error.path || '/'}: ${error.message}`).join('\n');
}

/** Loads the deployment-owned catalog once, before sockets or database pools are opened. */
export async function loadCatalog(path: string): Promise<CatalogDocument> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read AGQL_CATALOG_PATH: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`AGQL_CATALOG_PATH does not contain valid JSON: ${detail}`);
  }
  const validated = validateCatalog(parsed);
  if (!validated.ok) {
    throw new ConfigurationError(
      `AGQL_CATALOG_PATH is invalid:\n${catalogErrors(validated.errors)}`,
    );
  }
  return validated.value;
}
