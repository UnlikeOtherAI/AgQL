import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ConfigurationError,
  loadServerConfiguration,
} from './config.ts';

const starterCatalogPath = fileURLToPath(
  new URL('../../../examples/starter/catalog.json', import.meta.url),
);

function environment(
  capabilities?: string,
): NodeJS.ProcessEnv {
  return {
    AGQL_APP_KEYS: 'configuration-test-key',
    AGQL_CATALOG_PATH: starterCatalogPath,
    DATABASE_URL: 'postgresql://agql:unused@localhost:5432/agql',
    ...(capabilities === undefined ? {} : { AGQL_APP_CAPABILITIES: capabilities }),
  };
}

test('deployment capabilities require catalog-declared tags', async () => {
  await assert.rejects(
    loadServerConfiguration(environment()),
    (error: unknown) => error instanceof ConfigurationError
      && error.message === 'AGQL_APP_CAPABILITIES is required and must name one or more capability '
        + 'tags declared by the loaded catalog. Available tags: portfolio, starter, work-items.',
  );
});

test('deployment capabilities reject unknown tags without a database connection', async () => {
  await assert.rejects(
    loadServerConfiguration(environment('portfolio,not-a-catalog-tag')),
    (error: unknown) => error instanceof ConfigurationError
      && error.message === 'AGQL_APP_CAPABILITIES contains unknown capability tag '
        + '"not-a-catalog-tag". '
        + 'Legal alternatives: portfolio, starter, work-items.',
  );
});

test('deployment capabilities preserve explicitly configured catalog tags', async () => {
  const loaded = await loadServerConfiguration(environment('starter, portfolio'));
  assert.deepEqual(loaded.config.appCapabilities, ['starter', 'portfolio']);
});
