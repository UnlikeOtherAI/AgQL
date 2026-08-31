#!/usr/bin/env -S tsx
import {
  createDeploymentServer,
  JsonLogger,
} from './service.ts';
import {
  ConfigurationError,
  loadCatalog,
  readServerConfig,
} from './config.ts';

async function main(): Promise<void> {
  const config = readServerConfig();
  const catalog = await loadCatalog(config.catalogPath);
  const logger = new JsonLogger(config.logLevel);
  const server = createDeploymentServer({ config, catalog, logger });
  await server.listen(config.port);
  logger.log('info', 'server.listening', { catalogVersion: catalog.catalogVersion });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
      logger.log('info', 'server.stopped', { catalogVersion: catalog.catalogVersion });
    } catch {
      logger.log('error', 'server.shutdown_failed', { catalogVersion: catalog.catalogVersion });
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
