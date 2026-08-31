# Deploying AgQL

This deployment runs AgQL and PostgreSQL in Docker. The API has no host port:
the host's shared Caddy instance terminates TLS and reaches `agql-api` over its
existing external Docker network, `edge`. PostgreSQL is attached only to AgQL's
private `db` network.

`/health` is a cheap liveness endpoint and deliberately does not contact the
database. `/ready` is the deployment gate: it verifies the PostgreSQL connection,
`SET ROLE agql_query`, and `SELECT 1`; it returns a non-200 status when the
schema or database roles are unavailable. Both the API container healthcheck and
`deploy.sh` therefore use `/ready`.

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

Clone the public repository over HTTPS and select the revision to deploy. The
live host path is `/srv/agql/AgQL`; use another path only if that host has an
intentional alternative layout.

```sh
git clone https://github.com/UnlikeOtherAI/AgQL.git /srv/agql/AgQL
cd /srv/agql/AgQL
git checkout main
git pull --ff-only origin main
```

Create the deployment environment file. Its blank secret fields are
intentional: AgQL fails closed without an application key or receipt secret, and
this repository supplies no usable credential. Restrict its permissions before
generating or inserting any secret.

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
app_key="$(openssl rand -hex 32)"
receipt_secret="$(openssl rand -hex 32)"
postgres_password="$(openssl rand -hex 32)"
sed -i.bak \
  -e "s|^AGQL_APP_KEYS=$|AGQL_APP_KEYS=${app_key}|" \
  -e "s|^AGQL_RECEIPT_SECRET=$|AGQL_RECEIPT_SECRET=${receipt_secret}|" \
  -e "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${postgres_password}|" \
  -e "s|^DATABASE_URL=$|DATABASE_URL=postgresql://agql:${postgres_password}@agql-postgres:5432/agql|" \
  deploy/.env
rm deploy/.env.bak
```

`AGQL_APP_KEYS` accepts a comma-separated key set for rotation. Generate every
key with `openssl rand -hex 32`; do not reuse the database password or receipt
secret as an application key. `AGQL_RECEIPT_SECRET` signs execution receipts and
must remain distinct from all application keys. The starter catalog exposes
`portfolio`, `starter`, and `work-items` tags, and the example grants all three.
`AGQL_APP_CAPABILITIES` is an exact, comma-separated subset of the loaded
catalog's capability tags; it is not a wildcard. Empty capabilities mean
nothing is visible, so the server rejects an empty value before opening a
listener.

Before exposing the service, paste the site block from
[`Caddyfile.snippet`](Caddyfile.snippet) into the shared Caddyfile, replacing
`agql.example.com` with the DNS hostname you created. Reload Caddy using the
shared proxy's established reload procedure. The snippet deliberately has no
TLS directives because the shared Caddy configuration owns certificates. It
does send a one-year HSTS header with `includeSubDomains`; clients must still
use `https://` on their first connection, because HSTS cannot protect a bearer
key already sent over plaintext HTTP.

Run the normal deploy command:

```sh
./deploy/deploy.sh
```

Normal deployment provisions the catalog's PostgreSQL schema before the API can
become ready. The script waits for `/ready` and then sends an authenticated MCP
`run_query` over the private API address. Its exit status therefore means the
container both passed the database role/schema readiness probe and answered a
query; it does not merely mean that a process parsed a JSON file.

Starter data is deliberately separate from provisioning. To populate the three
starter `projects` rows on a fresh installation, use:

```sh
./deploy/deploy.sh --seed
```

`--seed` runs after the normal schema provision and before the same authenticated
query gate. It is safe to repeat for the supplied starter data, but it is not a
data-migration mechanism.

## Verification

There is intentionally no `localhost:8787` host listener. Verify database-backed
readiness through the public Caddy hostname, replacing `agql.example.com` once
with the hostname configured in the snippet:

```sh
curl --fail --silent --show-error https://agql.example.com/ready
```

The response must be JSON with `"ok":true`. `/health` is available for cheap
liveness monitoring only; a 200 from it says nothing about the database schema
or roles.

To verify the authenticated MCP endpoint, read the first configured application
key and call `run_query` using the custom stateless binding. The following is
copy-pasteable from the deployment checkout after `--seed`; it returns the three
starter project rows. Without starter data, the same successful response has an
empty row array, which is still proof that the deployment can answer queries.

```sh
app_key="$(awk -F= '$1 == "AGQL_APP_KEYS" { print $2; exit }' deploy/.env | cut -d, -f1)"
curl --fail --silent --show-error \
  -X POST https://agql.example.com/mcp \
  -H "Authorization: Bearer ${app_key}" \
  -H 'AgQL-Anchor: 2026-01-01T00:00:00Z' \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: run_query' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_query","arguments":{"source":"default","query":{"version":"0","mode":"records","from":"projects","select":["projects.id","projects.name"],"order":[{"by":"projects.id","dir":"asc"}],"take":3}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The response is a successful `tools/call` result whose
`result.structuredContent` has `"status":"ok"`. A 401 response means the
bearer key was not copied correctly; do not remove authentication to work around
it.

## MCP client binding

`/mcp` is a **custom stateless HTTP binding**, not a drop-in implementation of
the standard MCP session flow. A spec-conformant `initialize` request receives a
404 JSON-RPC `-32601` response, and JSON-RPC notifications are rejected because
every request needs a string or numeric `id`.

The complete supported MCP method set is `server/discover`, `tools/list`,
`resources/list`, `resources/read`, and `tools/call`. Every request is a
`POST /mcp` with `Content-Type: application/json`, a bearer `Authorization`
header, and a canonical UTC `AgQL-Anchor` header. It must also carry these
per-request routing headers:

| Header | Required value |
|---|---|
| `Mcp-Method` | Exactly the JSON-RPC `method` in that request body. |
| `Mcp-Protocol-Version` | Exactly `params._meta["io.modelcontextprotocol/protocolVersion"]`. |
| `Mcp-Name` | For `tools/call`, exactly `params.name`; for `resources/read`, exactly `params.uri`. |

Every request body must put both
`io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` in `params._meta`. In addition to
the header/body equality above, `Authorization` and `AgQL-Anchor` are required
for each request. Do not configure a static routing-header set: `Mcp-Method`,
`Mcp-Protocol-Version`, and where applicable `Mcp-Name` must mirror that
specific body on every request.

## HTTP data-plane routes and write controls

Caddy proxies every path in the supplied snippet. AgQL authenticates the agent
data-plane routes with the bearer key and `AgQL-Anchor`; the principal-result
routes use a separately configured principal authenticator and return 401 by
default in this deployment. The eight route groups below expand to ten
method/path forms because principal-result handles have page and stream forms.

| Method | Path | Purpose | Write? |
|---|---|---|---|
| `POST` | `/v0/catalog/search` | Search the scope-filtered catalog. | No |
| `POST` | `/v0/catalog/describe` | Describe scope-visible catalog references. | No |
| `POST` | `/v0/catalog/values` | Look up scope-visible enum values. | No |
| `POST` | `/v0/query/explain` | Compile and explain a query. | No |
| `POST` | `/v0/query/run` | Run a query. | No |
| `POST` | `/v0/records` | Ingest canonical records. | **Yes** |
| `POST` | `/v0/queries` | Save a verified query. | **Yes** |
| `POST` | `/v0/principal-results` | Open a principal-only result handle. | No |
| `GET` | `/v0/principal-results/{handle}` | Read a page from a principal result. | No |
| `GET` | `/v0/principal-results/{handle}/stream` | Stream a principal result as NDJSON. | No |

If this deployment must be query-only at the edge, add this matcher **before**
the snippet's `reverse_proxy` directive. It blocks both state-changing routes;
AgQL's own authorization remains required for every route that is allowed
through.

```caddyfile
@agql_write_routes path /v0/records /v0/queries
respond @agql_write_routes "AgQL write routes are disabled at this edge." 403
```

## PostgreSQL roles and an existing volume

The provisioner role is the PostgreSQL role in `DATABASE_URL` (normally
`agql`). It owns provisioning DDL but is never used directly by a request path.
The application assumes two `NOLOGIN` roles with `SET ROLE`:

- `agql_query` is read-only and is used by query execution and `/ready`.
- `agql_writer` is read/write and is used only by ingest execution.

[`postgres/init/02-roles.sql`](postgres/init/02-roles.sql) creates those roles
and grants them to the provisioner, but Docker's init scripts run only when the
PostgreSQL data directory is first created. An older existing volume can
therefore be missing them. The real PostgreSQL symptom is:

```text
FATAL: role "agql_query" does not exist
```

At the application layer this can be collapsed into a generic
`PROVISIONING_FAILED`; inspect the PostgreSQL logs rather than treating it as a
seed-data problem. Detect the roles without changing data:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T agql-postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('\''agql_query'\'', '\''agql_writer'\'') ORDER BY rolname;"'
```

The non-destructive fix is to rerun the idempotent role script against that
existing database, then deploy again. Do **not** run `down --volumes` merely to
make the init hook run.

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d agql-postgres
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T agql-postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/02-roles.sql'
./deploy/deploy.sh
```

## Catalog or policy version changes are schema migrations

The PostgreSQL binding version is
`sha256(catalogVersion + NUL + policyVersion)`. It is part of every generated
dataset table name. Changing either version therefore moves a logical dataset
such as `projects` to a different generated `d_*` table; it is not a metadata
only upgrade.

Record the current catalog, policy, and binding versions before changing a
revision. Compare this output with the output after checking out the intended
revision. A changed binding version means a schema migration is required.

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T agql-api node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const catalog = JSON.parse(fs.readFileSync(process.env.AGQL_CATALOG_PATH, 'utf8'));
const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const bindingVersion = `server-${digest(`${catalog.catalogVersion}\0${catalog.policyVersion}`).slice(0, 32)}`;
console.log(`catalogVersion=${catalog.catalogVersion}`);
console.log(`policyVersion=${catalog.policyVersion}`);
console.log(`bindingVersion=${bindingVersion}`);
NODE
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T agql-postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\\dt agql.d_*"'
```

For a binding change, use this sequence:

1. Back up the database with the host's established backup procedure and record
   the current revision and binding output.
2. Check out the target release or commit.
3. Run `./deploy/deploy.sh`. Normal deployment provisions the target binding's
   schema and verifies an authenticated query through it.
4. Re-ingest the authoritative data into the target binding. On the starter
   deployment only, `./deploy/deploy.sh --seed` supplies that re-ingest.
5. Verify the public authenticated `run_query` command above before considering
   the upgrade complete. Keep the old generated tables until the backup and
   re-ingest have been verified.

v0 does **not** carry data from the old binding-version tables into the new
ones. It also never drops those old tables automatically. An upgrade can thus
be ready and queryable while returning no historical rows until the required
re-ingest finishes; that is expected and must be planned as a schema/data
migration, not treated as a rolling application-only deploy.

To roll back after a binding-changing upgrade, check out the recorded revision
and run the normal deploy command. It selects and provisions the older binding
again; it does not transfer records written only to the newer binding.

```sh
git checkout <previous-release-tag-or-commit>
./deploy/deploy.sh
```

## Operations

Follow the API log stream:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f agql-api
```

Follow PostgreSQL logs:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f agql-postgres
```

Show container and readiness status:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

Both containers use Docker's `local` log driver with 10 MiB files and three
files retained. The API has a 512 MiB cgroup limit and the example's
`NODE_OPTIONS=--max-old-space-size=384` reserves the remainder for native and
runtime memory. PostgreSQL is pinned to the digest
`sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b`,
the multi-platform image index resolved from `pgvector/pgvector:pg16` on
2026-08-31. Pinning by digest prevents an AgQL pull from advancing a mutable
`pg16` tag that other stacks may also use; update the digest deliberately when
upgrading PostgreSQL/pgvector.

For a revision that leaves the catalog and policy versions unchanged, record the
current revision, switch to the desired commit or release tag, then rerun the
idempotent normal deploy command:

```sh
git rev-parse HEAD
git fetch origin --tags
git checkout <release-tag-or-commit>
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
