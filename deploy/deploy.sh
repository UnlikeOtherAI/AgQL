#!/usr/bin/env bash

set -euo pipefail

readonly readiness_timeout_seconds=180
readonly readiness_poll_seconds=2

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
compose_file="${script_dir}/docker-compose.yml"
env_file="${script_dir}/.env"
env_template_file="${script_dir}/.env.example"
seed=false

usage() {
  cat <<'USAGE'
Usage: ./deploy/deploy.sh [--seed]

Builds and starts AgQL with Docker Compose, waits for database-backed readiness,
then confirms that an authenticated MCP run_query succeeds.
  --seed  Run the workspace starter seed command before the run_query check.
USAGE
}

while (($# > 0)); do
  case "$1" in
    --seed)
      seed=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Engine with the Docker Compose plugin is required." >&2
  exit 1
fi

if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}. Copy deploy/.env.example to deploy/.env and set its required values." >&2
  exit 1
fi

if [[ ! -f "${env_template_file}" ]]; then
  echo "Missing deployment environment template: ${env_template_file}." >&2
  exit 1
fi

require_env_value() {
  local name="$1"

  if ! awk -v key="${name}" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      trimmed = value
      sub(/^[[:space:]]+/, "", trimmed)
      sub(/[[:space:]]+$/, "", trimmed)
      exit !(count == 1 && length(trimmed) > 0)
    }
  ' "${env_file}"; then
    echo "${name} must appear exactly once with a nonempty value in ${env_file}." >&2
    exit 1
  fi
}

required_env_names() {
  awk -F= '/^[A-Z][A-Z0-9_]*=/ { print $1 }' "${env_template_file}"
}

while IFS= read -r name; do
  require_env_value "${name}"
done < <(required_env_names)

cd "${repo_dir}"
compose=(docker compose --env-file "${env_file}" -f "${compose_file}")

echo "Pulling the digest-pinned PostgreSQL image..."
"${compose[@]}" pull agql-postgres

echo "Building the AgQL API image..."
"${compose[@]}" build --pull agql-api

echo "Starting AgQL..."
"${compose[@]}" up -d

container_id="$("${compose[@]}" ps -q agql-api)"
if [[ -z "${container_id}" ]]; then
  echo "AgQL API container was not created." >&2
  "${compose[@]}" ps >&2 || true
  exit 1
fi

deadline=$(( $(date +%s) + readiness_timeout_seconds ))
echo "Waiting up to ${readiness_timeout_seconds}s for database-backed API readiness..."

while true; do
  readiness_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}" 2>/dev/null || true)"

  case "${readiness_status}" in
    healthy)
      break
      ;;
    unhealthy)
      echo "AgQL API readiness check reported unhealthy." >&2
      "${compose[@]}" ps >&2 || true
      "${compose[@]}" logs --tail=100 agql-api agql-postgres >&2 || true
      exit 1
      ;;
  esac

  if (( $(date +%s) >= deadline )); then
    echo "Timed out waiting for AgQL API readiness (last state: ${readiness_status:-unavailable})." >&2
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --tail=100 agql-api agql-postgres >&2 || true
    exit 1
  fi

  sleep "${readiness_poll_seconds}"
done

if [[ "${seed}" == true ]]; then
  echo "Running the starter seed command..."
  "${compose[@]}" exec -T agql-api pnpm seed
fi

echo "Verifying an authenticated MCP run_query..."
"${compose[@]}" exec -T agql-api node - <<'NODE'
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

void (async () => {
  // Entries are key-id:secret; the bearer token is the secret alone.
  const appKeyEntry = process.env.AGQL_APP_KEYS?.split(',', 1)[0]?.trim();
  if (appKeyEntry === undefined || appKeyEntry.length === 0) {
    throw new Error('AGQL_APP_KEYS is unavailable in the API container.');
  }
  const separator = appKeyEntry.indexOf(':');
  if (separator <= 0 || separator === appKeyEntry.length - 1) {
    throw new Error('AGQL_APP_KEYS entries must use key-id:secret.');
  }
  const appKey = appKeyEntry.slice(separator + 1);
  const protocolVersion = '2026-07-28';
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'run_query',
      arguments: {
        source: 'default',
        query: {
          version: '0',
          mode: 'records',
          from: 'projects',
          select: ['projects.id', 'projects.name'],
          order: [{ by: 'projects.id', dir: 'asc' }],
          take: 3,
        },
      },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const response = await fetch('http://127.0.0.1:8787/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appKey}`,
      'agql-anchor': '2026-01-01T00:00:00Z',
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion,
      'mcp-method': 'tools/call',
      'mcp-name': 'run_query',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`run_query returned HTTP ${response.status} without a JSON response.`);
  }
  if (!response.ok
    || !isRecord(payload)
    || !isRecord(payload.result)
    || !isRecord(payload.result.structuredContent)
    || payload.result.structuredContent.status !== 'ok') {
    throw new Error(`run_query did not return a successful tools/call result (HTTP ${response.status}).`);
  }
  process.stdout.write('Authenticated MCP run_query succeeded.\n');
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Authenticated MCP run_query failed: ${message}\n`);
  process.exitCode = 1;
});
NODE

"${compose[@]}" ps
echo "AgQL is ready and answered an authenticated query. It is reachable only through a reverse proxy connected to the edge network."
