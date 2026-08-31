#!/usr/bin/env -S tsx
import { createPostgresDeployment } from './bindings.ts';
import { createDeploymentServer } from './service.ts';
import {
  ConfigurationError,
  activeReceiptSecret,
  loadServerConfiguration,
} from './config.ts';

async function main(): Promise<void> {
  const { config, catalog } = await loadServerConfiguration();
  const deployment = createPostgresDeployment(catalog, {
    databaseUrl: config.databaseUrl,
    tokenSecret: activeReceiptSecret(config.receiptKeys),
  });
  await deployment.provision();
  const server = createDeploymentServer({ config, catalog, deployment });
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
