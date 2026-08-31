# Deploying AgQL

This deployment runs AgQL and PostgreSQL in Docker. The API has no host port:
the host's shared Caddy instance terminates TLS and reaches `agql-api` over its
existing external Docker network, `edge`. PostgreSQL is attached only to AgQL's
private `db` network.

## Prerequisites

- A Linux host with Docker Engine and the Docker Compose plugin.
- A shared Caddy instance already attached to the external Docker network named
  `edge`.
- A DNS record for the hostname you will put in
  [`Caddyfile.snippet`](Caddyfile.snippet), pointing at the host.
- `git`, `openssl`, and `curl` installed on the host.
- Read access to the AgQL repository.

Confirm that the shared network is available before continuing:

```sh
docker network inspect edge >/dev/null
```

If that command fails, stop here: the Caddy operator must connect its shared
proxy to an external network named `edge` before AgQL can be deployed.

## First deployment

Clone the repository and select the revision to deploy. This example uses the
current `main` branch:

```sh
git clone git@github.com:UnlikeOtherAI/AgQL.git /opt/agql
cd /opt/agql
git checkout main
git pull --ff-only origin main
```

Create the deployment environment file. Its blank key and password fields are
intentional: AgQL must not boot without an application key, and no usable
credential is supplied by this repository. `AGQL_APP_CAPABILITIES` is an exact,
comma-separated subset of the loaded catalog's capability tags; it is not a
wildcard. Empty capabilities mean nothing is visible, so the server rejects an
empty value before opening a listener.

```sh
cp deploy/.env.example deploy/.env
app_key="$(openssl rand -hex 32)"
postgres_password="$(openssl rand -hex 32)"
sed -i.bak \
  -e "s|^AGQL_APP_KEYS=$|AGQL_APP_KEYS=${app_key}|" \
  -e "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${postgres_password}|" \
  -e "s|^DATABASE_URL=$|DATABASE_URL=postgresql://agql:${postgres_password}@agql-postgres:5432/agql|" \
  deploy/.env
rm deploy/.env.bak
chmod 600 deploy/.env
```

`AGQL_APP_KEYS` accepts a comma-separated key set for rotation. Generate every
key with `openssl rand -hex 32`; do not reuse the database password as an
application key. The starter catalog exposes `portfolio`, `starter`, and
`work-items` tags, and the example grants all three. Configure only the tags
your deployment intentionally grants.

Before exposing the service, paste the site block from
[`Caddyfile.snippet`](Caddyfile.snippet) into the shared Caddyfile, replacing
`agql.example.com` with the DNS hostname you created. Reload Caddy using the
shared proxy's established reload procedure. The snippet deliberately has no
TLS directives because the shared Caddy configuration owns certificates.

Build, start, health-check, and seed the deployment:

```sh
./deploy/deploy.sh --seed
```

The seed command is run once by this invocation after the API becomes healthy.
Run `--seed` only when you want to import the starter data; the normal repeatable
deployment command is:

```sh
./deploy/deploy.sh
```

## Verification

There is intentionally no `localhost:8787` host listener. Verify health through
the public Caddy hostname, replacing `agql.example.com` exactly once with the
hostname configured in the snippet:

```sh
curl --fail --silent --show-error https://agql.example.com/health
```

The response must be JSON with `"ok":true`. To verify the authenticated MCP
endpoint, read the first configured application key and call `run_query` using
the stateless MCP binding. The routing headers must match the JSON-RPC body,
and every authenticated operation needs an explicit `AgQL-Anchor` containing a
canonical UTC instant; the engine never reads a clock:

```sh
app_key="$(awk -F= '$1 == "AGQL_APP_KEYS" { print $2; exit }' deploy/.env | cut -d, -f1)"
curl --fail --silent --show-error \
  -X POST https://agql.example.com/mcp \
  -H "Authorization: Bearer ${app_key}" \
  -H 'AgQL-Anchor: 2026-01-01T00:00:00Z' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/call' \
  -H 'MCP-Name: run_query' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_query","arguments":{"source":"default","query":{"version":"0","mode":"records","from":"projects","select":["projects.id","projects.name"],"order":[{"by":"projects.id","dir":"asc"}],"take":3}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The command must return a successful `tools/call` response containing the three
starter project rows. A 401 response means the bearer key was not copied
correctly; do not remove authentication to work around it.

## Operations

Follow the API log stream:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f agql-api
```

Follow PostgreSQL logs:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f agql-postgres
```

Show container and health status:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

To deploy a newer revision, record the current revision, switch to the desired
commit or release tag, then rerun the idempotent deploy command:

```sh
git rev-parse HEAD
git fetch origin --tags
git checkout <release-tag-or-commit>
./deploy/deploy.sh
```

To roll back, check out the previously recorded commit or tag and deploy it the
same way. This rebuilds only the API image; the named PostgreSQL volume remains
in place:

```sh
git checkout <previous-release-tag-or-commit>
./deploy/deploy.sh
```

To stop the deployment while retaining database data for a later restart:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down
```

For permanent removal, including the AgQL PostgreSQL data volume, run the
following destructive command only after taking any needed backup. It does not
remove the shared external `edge` network or unrelated containers:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down --volumes
```
