#!/usr/bin/env bash

set -euo pipefail

readonly health_timeout_seconds=180
readonly health_poll_seconds=2

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
compose_file="${script_dir}/docker-compose.yml"
env_file="${script_dir}/.env"
seed=false

usage() {
  cat <<'USAGE'
Usage: ./deploy/deploy.sh [--seed]

Builds and starts AgQL with Docker Compose, then waits for the API healthcheck.
  --seed  Run the workspace starter seed command after the API is healthy.
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

require_env_value() {
  local name="$1"
  local value

  value="$(awk -F= -v key="${name}" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "${env_file}")"
  if [[ -z "${value}" ]]; then
    echo "${name} must be set in ${env_file}." >&2
    exit 1
  fi
}

require_env_value AGQL_APP_KEYS
require_env_value POSTGRES_DB
require_env_value POSTGRES_USER
require_env_value POSTGRES_PASSWORD
require_env_value DATABASE_URL

cd "${repo_dir}"
compose=(docker compose --env-file "${env_file}" -f "${compose_file}")

echo "Pulling the pinned PostgreSQL image..."
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

deadline=$(( $(date +%s) + health_timeout_seconds ))
echo "Waiting up to ${health_timeout_seconds}s for the API healthcheck..."

while true; do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}" 2>/dev/null || true)"

  case "${health_status}" in
    healthy)
      break
      ;;
    unhealthy)
      echo "AgQL API healthcheck reported unhealthy." >&2
      "${compose[@]}" ps >&2 || true
      "${compose[@]}" logs --tail=100 agql-api agql-postgres >&2 || true
      exit 1
      ;;
  esac

  if (( $(date +%s) >= deadline )); then
    echo "Timed out waiting for the AgQL API healthcheck (last state: ${health_status:-unavailable})." >&2
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --tail=100 agql-api agql-postgres >&2 || true
    exit 1
  fi

  sleep "${health_poll_seconds}"
done

if [[ "${seed}" == true ]]; then
  echo "Running the starter seed command..."
  "${compose[@]}" exec -T agql-api pnpm seed
fi

"${compose[@]}" ps
echo "AgQL is healthy. It is reachable only through a reverse proxy connected to the edge network."
