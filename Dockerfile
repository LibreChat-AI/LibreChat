# v0.8.9

# ── Stage 1: download crypt_shared ──────────────────────────────────────────
# mongo_crypt_v1.so is the Automatic Encryption Shared Library required for
# CSFLE.  Pinned to 7.0.21 with verified SHA-256 checksums (both amd64 and
# arm64) for reproducible, supply-chain-safe builds.
FROM alpine:3.21 AS crypt-shared

ARG CRYPT_VERSION=7.0.21
ARG CRYPT_BASE_URL=https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux

# SHA-256 digests verified 2026-06-21
ARG CRYPT_SHA256_AMD64=25190407f7131989fdd9c113ef0aa4c7ef618cccee024b35e8de0aeaf3f74764
ARG CRYPT_SHA256_ARM64=81bbf9120dd00e856a36d5f8234c88b0fdd4c9d6677a327e9047a7483a9e88d0

RUN apk add --no-cache curl tar && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64)  MONGO_ARCH=x86_64;  EXPECTED_SHA256="$CRYPT_SHA256_AMD64" ;; \
      aarch64) MONGO_ARCH=aarch64; EXPECTED_SHA256="$CRYPT_SHA256_ARM64" ;; \
      *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    URL="${CRYPT_BASE_URL}-${MONGO_ARCH}-enterprise-ubuntu2204-${CRYPT_VERSION}.tgz" && \
    curl -fsSL "$URL" -o /tmp/crypt_shared.tgz && \
    echo "${EXPECTED_SHA256}  /tmp/crypt_shared.tgz" | sha256sum -c - && \
    mkdir -p /cryptlib /tmp/crypt_extract && \
    tar -xzf /tmp/crypt_shared.tgz -C /tmp/crypt_extract && \
    find /tmp/crypt_extract -name 'mongo_crypt_v1.so' -exec cp {} /cryptlib/mongo_crypt_v1.so \; && \
    rm -rf /tmp/crypt_shared.tgz /tmp/crypt_extract

# ── Stage 2: application ─────────────────────────────────────────────────────
# Base node image
FROM docker.io/library/node:24.22.3-alpine AS node

RUN apk upgrade --no-cache
RUN apk add --no-cache bash jemalloc
RUN apk add --no-cache python3 py3-pip uv
# gcompat provides glibc ABI compatibility so the glibc-built crypt_shared runs on Alpine musl
RUN apk add --no-cache gcompat libgcc

# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
# Disable dependency installation analytics before any npm lifecycle scripts run.
ENV SCARF_ANALYTICS=false

# Add `uv` for extended MCP support
COPY --from=ghcr.io/astral-sh/uv:0.9.5-python3.12-alpine /usr/local/bin/uv /usr/local/bin/uvx /bin/
RUN uv --version

# Set configurable max-old-space-size with default
ARG NODE_MAX_OLD_SPACE_SIZE=6144
ARG NPM_CI_TIMEOUT_SECONDS=1500
ARG NPM_CI_ATTEMPTS=2

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

# Bundle crypt_shared so CSFLE works without a host mount
COPY --from=crypt-shared --chown=node:node /cryptlib/mongo_crypt_v1.so /app/lib/mongo_crypt_v1.so
ENV MONGO_CRYPT_SHARED_LIB_PATH=/app/lib/mongo_crypt_v1.so

USER node

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json
COPY --chown=node:node vendor/code ./vendor/code
COPY --chown=node:node packages/chat/package.json ./packages/chat/package.json

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
    until timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --no-audit ; do \
        status=$? ; \
        if [ "$attempt" -ge "$NPM_CI_ATTEMPTS" ]; then \
            exit "$status" ; \
        fi ; \
        echo "npm ci --no-audit failed with exit code $status; retrying attempt $((attempt + 1))/$NPM_CI_ATTEMPTS" ; \
        attempt=$((attempt + 1)) ; \
        npm cache clean --force || true ; \
        sleep 10 ; \
    done

COPY --chown=node:node . .

ARG VITE_MCP_SANDBOX_URL=
RUN \
    # React client build with configurable memory
    NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend && \
    npm prune --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# Optional build metadata surfaced in Settings -> About for support triage.
# Declared here (after the heavy install/build steps) so that commit/date
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
CMD ["npm", "run", "backend"]

# Optional: for client with nginx routing
# FROM nginx:stable-alpine AS nginx-client
# WORKDIR /usr/share/nginx/html
# COPY --from=node /app/client/dist /usr/share/nginx/html
# COPY client/nginx.conf /etc/nginx/conf.d/default.conf
# ENTRYPOINT ["nginx", "-g", "daemon off;"]
