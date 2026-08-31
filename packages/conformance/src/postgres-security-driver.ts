import { createPostgresExactDriver } from './postgres-exact-driver.ts';
import { createSecurityProbeExecutor } from './security-probe-driver.ts';

export function createPostgresSecurityProbeExecutor(databaseUrl = process.env.DATABASE_URL) {
  return createSecurityProbeExecutor(createPostgresExactDriver(databaseUrl));
}
