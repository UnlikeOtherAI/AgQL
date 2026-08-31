#!/usr/bin/env -S tsx
import {
  createDeploymentServer,
} from './service.ts';
import {
  ConfigurationError,
  loadCatalog,
  readServerConfig,
} from './config.ts';

async function main(): Promise<void> {
  const config = readServerConfig();
  const catalog = await loadCatalog(config.catalogPath);
  const server = createDeploymentServer({ config, catalog });
  await server.listen(config.port);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

void main().catch((error: unknown) => {
  const message = error instanceof ConfigurationError || error instanceof Error
    ? error.message
    : String(error);
  process.stderr.write(`agql-server failed to start: ${message}\n`);
  process.exitCode = 1;
});
