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
  readonly appCapabilities: readonly string[];
  readonly catalogPath: string;
  readonly databaseUrl: string;
  readonly embedder: 'deterministic';
  readonly logLevel: LogLevel;
}

export interface LoadedServerConfiguration {
  readonly config: ServerConfig;
  readonly catalog: CatalogDocument;
}

interface ServerBootstrapConfig {
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

function commaSeparatedValues(
  value: string,
  name: string,
): readonly string[] {
  const values = value.split(',').map((candidate) => candidate.trim());
  if (values.some((candidate) => candidate.length === 0)) {
    throw new ConfigurationError(`${name} must be a comma-separated list of nonempty values.`);
  }
  if (new Set(values).size !== values.length) {
    throw new ConfigurationError(`${name} must not contain duplicate values.`);
  }
  return values;
}

function appKeys(environment: NodeJS.ProcessEnv): readonly string[] {
  const values = required(environment, 'AGQL_APP_KEYS');
  return commaSeparatedValues(values, 'AGQL_APP_KEYS');
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

function readServerBootstrapConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerBootstrapConfig {
  return {
    port: port(environment),
    appKeys: appKeys(environment),
    catalogPath: required(environment, 'AGQL_CATALOG_PATH'),
    databaseUrl: required(environment, 'DATABASE_URL'),
    embedder: embedder(environment),
    logLevel: logLevel(environment),
  };
}

function declaredCapabilityTags(catalog: CatalogDocument): readonly string[] {
  return [...new Set(Object.values(catalog.datasets)
    .flatMap((dataset) => dataset.capabilityTags))].sort();
}

function declaredTagsMessage(tags: readonly string[]): string {
  return tags.length === 0 ? '(none)' : tags.join(', ');
}

/** Validates the deployment-wide bearer-key capabilities against the loaded catalog. */
export function validateApplicationCapabilities(
  capabilities: readonly string[],
  catalog: CatalogDocument,
): readonly string[] {
  const alternatives = declaredCapabilityTags(catalog);
  if (capabilities.length === 0) {
    throw new ConfigurationError(
      'AGQL_APP_CAPABILITIES is required and must name one or more capability tags declared '
      + `by the loaded catalog. Available tags: ${declaredTagsMessage(alternatives)}.`,
    );
  }
  const available = new Set(alternatives);
  for (const capability of capabilities) {
    if (!available.has(capability)) {
      throw new ConfigurationError(
        `AGQL_APP_CAPABILITIES contains unknown capability tag "${capability}". `
        + `Legal alternatives: ${declaredTagsMessage(alternatives)}.`,
      );
    }
  }
  return capabilities;
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

/**
 * Loads and validates all deployment configuration before a database pool or listener opens.
 * Capability validation follows catalog loading so failures can state the legal catalog tags.
 */
export async function loadServerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedServerConfiguration> {
  const bootstrap = readServerBootstrapConfig(environment);
  const catalog = await loadCatalog(bootstrap.catalogPath);
  const configured = environment.AGQL_APP_CAPABILITIES?.trim();
  const appCapabilities = configured === undefined || configured.length === 0
    ? validateApplicationCapabilities([], catalog)
    : validateApplicationCapabilities(
      commaSeparatedValues(configured, 'AGQL_APP_CAPABILITIES'),
      catalog,
    );
  return {
    catalog,
    config: { ...bootstrap, appCapabilities },
  };
}
