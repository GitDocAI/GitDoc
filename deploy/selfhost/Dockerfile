# syntax=docker/dockerfile:1
# Build context: the repository root (see docker-compose.yml).

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY packages/render/package.json packages/render/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# The runtime is just engine/: no node_modules.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=8081 \
    DATA_DIR=/data \
    SINGLE_SITE=true \
    LIST_SITES=true \
    RENDER_CLI_PATH=/app/render.js

WORKDIR /app
COPY --from=build /src/engine/ ./
# GNU tar (in this base image) is what /api/publish uses to unpack uploads.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
# 8080: readers and the CLI.  8081: the admin panel; publish it only to a
# private network or 127.0.0.1 (see docker-compose.yml).
EXPOSE 8080 8081

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(()=>process.exit(0),()=>process.exit(1))"

CMD ["node", "start.mjs"]
