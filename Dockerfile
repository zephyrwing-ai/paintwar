# syntax=docker/dockerfile:1.7

# Keep the runtime above Node 22.18 so the server can execute TypeScript through
# Node's built-in type stripping without a separate transpilation artifact.
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.18.0

FROM ${NODE_IMAGE} AS pnpm
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}"

FROM pnpm AS client-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=paintwar-client-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM pnpm AS build
ARG PUBLICATION_ORIGIN=https://zephyrwing-ai.github.io/paintwar
ENV PUBLICATION_ORIGIN="${PUBLICATION_ORIGIN}"
COPY --from=client-deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM pnpm AS server-deps
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN --mount=type=cache,id=paintwar-server-pnpm,target=/pnpm/store \
    pnpm --dir server install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_ROOT=/app/dist
WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=server-deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --chown=node:node server/package.json server/server.ts ./server/
COPY --chown=node:node shared ./shared

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3000') + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.ts"]
