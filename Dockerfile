# syntax=docker/dockerfile:1

FROM node:24 AS builder

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable

# Copy workspace manifests before source files so dependency installation remains
# cached when application code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/adapter-postgres/package.json packages/adapter-postgres/package.json
COPY packages/adapter-sqlite/package.json packages/adapter-sqlite/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/conformance/package.json packages/conformance/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/http/package.json packages/http/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/server/package.json packages/server/package.json

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM builder AS production-deps

# Retain compiled artifacts while removing development-only dependencies before
# copying the workspace into the runtime image.
RUN pnpm install --prod --frozen-lockfile

FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN groupadd --system agql \
  && useradd --system --gid agql --create-home --home-dir /home/agql agql \
  && corepack enable

COPY --from=production-deps --chown=agql:agql /app /app

USER agql

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "const http=require('node:http');const request=http.get('http://127.0.0.1:8787/health',(response)=>process.exit(response.statusCode===200?0:1));request.on('error',()=>process.exit(1));request.setTimeout(3000,()=>{request.destroy();process.exit(1)});"

CMD ["pnpm", "start"]
