# v0.8.9

ARG NPM_CI_TIMEOUT_SECONDS=1500
ARG NPM_CI_ATTEMPTS=2

# Shared base with Alpine runtime libs and workspace manifests
FROM docker.io/library/node:24.22.3-alpine AS base-min

RUN apk upgrade --no-cache && \
    apk add --no-cache bash jemalloc

# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
# Disable dependency installation analytics before any npm lifecycle scripts run.
ENV SCARF_ANALYTICS=false

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json
COPY --chown=node:node packages/client/package.json ./packages/client/package.json
COPY --chown=node:node packages/chat/package.json ./packages/chat/package.json
COPY --chown=node:node packages/channel-gateway/package.json ./packages/channel-gateway/package.json
COPY --chown=node:node vendor/code ./vendor/code

# Builder stage: install all dependencies and build workspace packages + client bundle
FROM base-min AS builder

ARG NODE_MAX_OLD_SPACE_SIZE=6144
ARG NPM_CI_TIMEOUT_SECONDS
ARG NPM_CI_ATTEMPTS

USER node

RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 15000 && \
    attempt=1 ; \
    until timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --no-audit --no-fund ; do \
        status=$? ; \
        if [ "$attempt" -ge "$NPM_CI_ATTEMPTS" ]; then \
            exit "$status" ; \
        fi ; \
        echo "npm ci --no-audit --no-fund failed with exit code $status; retrying attempt $((attempt + 1))/$NPM_CI_ATTEMPTS" ; \
        attempt=$((attempt + 1)) ; \
        npm cache clean --force || true ; \
        sleep 10 ; \
    done && \
    npm cache clean --force

COPY --chown=node:node . .

ARG VITE_MCP_SANDBOX_URL=
RUN NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend

# Final runtime stage (`target: node`)
FROM base-min AS node

ARG NPM_CI_TIMEOUT_SECONDS
ARG NPM_CI_ATTEMPTS

# Keep system python3 for stdio MCP servers that invoke `python3` directly;
# `uv` / `uvx` are copied from the official image below (no duplicate apk uv or pip).
RUN apk add --no-cache python3

# Add `uv` for extended MCP support
COPY --from=ghcr.io/astral-sh/uv:0.9.5-python3.12-alpine /usr/local/bin/uv /usr/local/bin/uvx /bin/
RUN uv --version

USER node

# Install only backend production deps (client is prebuilt into ./client/dist).
# Clear npm's tarball cache and strip node_modules maps/declarations/docs in the
# same layer so overlayfs does not retain them. Workspace dist *.map files stay
# intact for --enable-source-maps debugging.
RUN \
    # Allow mounting of these files, which have no default
    touch .env ; \
    # Create directories for the volumes to inherit the correct permissions
    mkdir -p /app/client/public/images /app/logs /app/uploads /app/skill /app/data ; \
    chmod 1777 /app/data ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    attempt=1 ; \
    until timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --omit=dev --no-audit --no-fund \
        --workspace @librechat/backend \
        --workspace @librechat/api \
        --workspace @librechat/data-schemas \
        --workspace librechat-data-provider \
        --include-workspace-root=false ; do \
        status=$? ; \
        if [ "$attempt" -ge "$NPM_CI_ATTEMPTS" ]; then \
            exit "$status" ; \
        fi ; \
        echo "npm ci --omit=dev --no-audit --no-fund failed with exit code $status; retrying attempt $((attempt + 1))/$NPM_CI_ATTEMPTS" ; \
        attempt=$((attempt + 1)) ; \
        npm cache clean --force || true ; \
        sleep 10 ; \
    done && \
    npm cache clean --force && \
    find /app -path '*/node_modules/*' -type f \( \
        -name '*.map' -o \
        -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o \
        \( -iname '*.md' ! -iname 'licen[cs]e*' \) \
    \) -delete

COPY --chown=node:node api ./api
COPY --chown=node:node config ./config
COPY --chown=node:node skill ./skill
COPY --from=builder --chown=node:node /app/packages/data-provider/dist ./packages/data-provider/dist
COPY --from=builder --chown=node:node /app/packages/data-schemas/dist ./packages/data-schemas/dist
COPY --from=builder --chown=node:node /app/packages/api/dist ./packages/api/dist
COPY --from=builder --chown=node:node /app/client/dist ./client/dist
COPY --chown=node:node client/public ./client/public

# Optional build metadata surfaced in Settings -> About for support triage.
# Declared here (after the heavy install/copy steps) so that commit/date
# changing on every CI run does not bust the cache for dependency install
# and frontend build layers. When unset, the backend falls back to local
# git resolution (if .git is present), and finally to empty values.
ARG BUILD_COMMIT=
ARG BUILD_BRANCH=
ARG BUILD_DATE=
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_BRANCH=${BUILD_BRANCH}
ENV BUILD_DATE=${BUILD_DATE}

# Node API setup
EXPOSE 3080
ENV HOST=0.0.0.0
ENV NODE_ENV=production
CMD ["node", "api/server/index.js"]

# Optional: for client with nginx routing
# FROM nginx:stable-alpine AS nginx-client
# WORKDIR /usr/share/nginx/html
# COPY --from=node /app/client/dist /usr/share/nginx/html
# COPY client/nginx.conf /etc/nginx/conf.d/default.conf
# ENTRYPOINT ["nginx", "-g", "daemon off;"]
