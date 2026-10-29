FROM node:24.22.1-alpine AS build

ENV SCARF_ANALYTICS=false HUSKY=0
WORKDIR /build

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY client/package.json ./client/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/chat/package.json ./packages/chat/package.json
COPY packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY packages/data-provider/package.json ./packages/data-provider/package.json
COPY packages/channel-gateway/package.json ./packages/channel-gateway/package.json
COPY vendor/code ./vendor/code
RUN npm ci --ignore-scripts --no-audit --workspace @librechat/channel-gateway --workspace librechat-data-provider --include-workspace-root=false

COPY packages/data-provider ./packages/data-provider
COPY packages/channel-gateway ./packages/channel-gateway
COPY scripts/typecheck.mts ./scripts/typecheck.mts
RUN npm run build --workspace librechat-data-provider \
    && npm run typecheck --workspace @librechat/channel-gateway \
    && npm run build --workspace @librechat/channel-gateway

FROM node:24.22.1-alpine AS runtime

ENV NODE_ENV=production PORT=8080 LISTEN_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /build/packages/channel-gateway/dist/main.cjs ./main.cjs
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"
CMD ["node", "main.cjs"]
