import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

for (const scenario of ['normal', 'seed', 'missing-image']) {
  test(`manual deploy with published image: ${scenario}`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.deploy-test-'));
    try {
      await mkdir(join(dir, 'deploy'));
      const script = await readFile('deploy/deploy.sh', 'utf8');
      await writeFile(join(dir, 'deploy', 'deploy.sh'), script);
      await writeFile(join(dir, 'deploy', '.env.example'), 'REQUIRED_VALUE=\n');
      await writeFile(join(dir, 'deploy', '.env'), 'REQUIRED_VALUE=test\n');
      const harness = `
set -euo pipefail
export TRACE="$PWD/trace"
export AGQL_IMAGE='ghcr.io/unlikeotherai/agql@sha256:${'a'.repeat(64)}'
export SCENARIO='${scenario}'
docker() {
  echo "$*" >> "$TRACE"
  case "$*" in
    *'pull agql-api') [ "$SCENARIO" != missing-image ]; return ;;
    *'ps -q agql-api') echo test-container ;;
    'inspect '*) echo healthy ;;
    *'exec -T agql-api node -') cat >/dev/null ;;
  esac
}
export -f docker
bash deploy/deploy.sh ${scenario === 'seed' ? '--seed' : ''}
`;
      await writeFile(join(dir, 'harness.sh'), harness);
      const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
      const result = spawnSync(bash, ['harness.sh'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
      const trace = await readFile(join(dir, 'trace'), 'utf8');
      assert.equal(result.status, scenario === 'missing-image' ? 1 : 0, result.stderr);
      assert.doesNotMatch(trace, / build /);
      assert.match(trace, /pull agql-api/);
      if (scenario === 'missing-image') {
        assert.doesNotMatch(trace, /up -d/);
      } else {
        assert.match(trace, /up -d --no-build --pull never/);
        assert.match(trace, /exec -T agql-api node -/);
        assert.equal(trace.includes('exec -T agql-api pnpm seed'), scenario === 'seed');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('production Compose has an image-only API and preserves private Postgres storage', async () => {
  const source = (await readFile('deploy/docker-compose.yml', 'utf8')).replace('      - .env', '      - deploy/.env.example');
  const image = `ghcr.io/unlikeotherai/agql@sha256:${'a'.repeat(64)}`;
  const result = spawnSync('docker', ['compose', '-f', '-', 'config', '--format', 'json'], {
    input: source, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AGQL_IMAGE: image, POSTGRES_DB: 'test', POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test' },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.services['agql-api'].image, image);
  assert.equal(config.services['agql-api'].build, undefined);
  assert.equal(config.services['agql-api'].ports, undefined);
  assert.equal(config.networks.db.internal, true);
  assert.ok(config.services['agql-postgres'].volumes.some(volume => volume.target === '/var/lib/postgresql/data'));
});
