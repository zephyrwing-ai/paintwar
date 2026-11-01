# Authoritative WebSocket game server for 涂地大作战. The static client is published separately
# (build -> dist); the gateway routes /ws and /api/* here.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN cd server && npx --yes pnpm@10.17.1 install --frozen-lockfile --prod
COPY shared ./shared
COPY server/server.ts ./server/server.ts
# Browsers connect from the published site's origin; same-host origins are always accepted.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    ALLOWED_ORIGIN_SUFFIXES=.manus.game,.manus.space,.manuspre.space,.manus.computer
EXPOSE 3000
WORKDIR /app/server
CMD ["node", "--disable-warning=ExperimentalWarning", "server.ts"]
