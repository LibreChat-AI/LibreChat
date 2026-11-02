FROM node:24.22.1-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    SCARF_ANALYTICS=false \
    HUSKY=0 \
    MONGOMS_DOWNLOAD_DIR=/opt/mongodb-binaries \
    MONGOMS_RUNTIME_DOWNLOAD=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.13.0

WORKDIR /src
COPY . .

RUN npm ci --include=dev --no-audit --no-fund
RUN npm run frontend

# Fetch test binaries while the build still has network access.
RUN MONGOMS_RUNTIME_DOWNLOAD=true node -e \
    "require('mongodb-memory-server-core').MongoBinary.getPath({}).then(console.log).catch(error => { console.error(error); process.exit(1); })" \
    && npx --no-install playwright install --with-deps chromium \
    && chmod -R a+rX /opt/mongodb-binaries /opt/playwright \
    && npm cache clean --force

CMD ["bash"]
