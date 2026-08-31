import { createSqliteExactDriver } from './sqlite-exact-driver.ts';
import { createSecurityProbeExecutor } from './security-probe-driver.ts';

export function createSqliteSecurityProbeExecutor() {
  return createSecurityProbeExecutor(createSqliteExactDriver());
}
