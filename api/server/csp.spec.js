const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

/**
 * Mirrors what a production `client/dist/index.html` actually contains: inline
 * style, inline script, a module entry, and the module preloads Vite emits.
 */
const INDEX_HTML =
  '<!DOCTYPE html><html lang="en-US"><head><title>LibreChat</title>' +
  '<style>body{margin:0}</style>' +
  '<script>window.theme="dark";</script>' +
  '<link rel="modulepreload" crossorigin href="./assets/chunk.js">' +
  '<link rel="stylesheet" crossorigin href="./assets/app.css">' +
  '<script type="module" crossorigin src="./assets/index.js"></script>' +
  '<script defer src="/assets/app.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

jest.mock('~/server/services/Config', () => ({
  syncStaticTools: jest.fn().mockResolvedValue(undefined),
  mergeAppTools: jest.fn().mockResolvedValue(undefined),
  loadCustomConfig: jest.fn(() => Promise.resolve({})),
  getAppConfig: jest.fn().mockResolvedValue({
    paths: {
      uploads: '/tmp',
      dist: '/tmp/dist-csp',
      fonts: '/tmp/fonts-csp',
      assets: '/tmp/assets-csp',
    },
    fileStrategy: 'local',
    imageOutputType: 'PNG',
  }),
  setCachedTools: jest.fn(),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  initializeAgentTriggerService: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/services/Schedules', () => ({
  initializeScheduleEngine: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/app/clients/tools', () => ({
  createOpenAIImageTools: jest.fn(() => []),
  createYouTubeTools: jest.fn(() => []),
  manifestToolMap: {},
  toolkits: [],
}));

jest.mock('~/config', () => ({
  createMCPServersRegistry: jest.fn(),
  createMCPManager: jest.fn().mockResolvedValue({
    getAppToolFunctions: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock(
  '@librechat/api/telemetry',
  () => ({
    initializeTelemetry: jest.fn(() => ({
      enabled: false,
      status: 'disabled',
      shutdown: jest.fn(),
    })),
    telemetryMiddleware: jest.fn((_req, _res, next) => next()),
    telemetryErrorMiddleware: jest.fn((err, _req, _res, next) => next(err)),
  }),
  { virtual: true },
);

describe('Content Security Policy', () => {
  jest.setTimeout(30_000);

  let mongoServer;
  let app;
  let server;

  const originalReadFileSync = fs.readFileSync;

  beforeAll(async () => {
    fs.readFileSync = function (filepath, options) {
      if (filepath.includes('index.html')) {
        return INDEX_HTML;
      }
      return originalReadFileSync(filepath, options);
    };

    for (const dir of ['/tmp/dist-csp', '/tmp/fonts-csp', '/tmp/assets-csp']) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    fs.writeFileSync(path.join('/tmp/dist-csp', 'index.html'), INDEX_HTML);

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    process.env.PORT = '0';

    /* Read once at startup, so they must be set before the server module loads. */
    process.env.CSP_ENABLED = 'true';
    process.env.CSP_REPORT_ONLY = 'false';
    process.env.CSP_CONNECT_SRC_EXTRA = 'https://telemetry.example.com';
    /* A cacheable override that CSP must refuse for the shell. */
    process.env.INDEX_CACHE_CONTROL = 'public, max-age=3600';

    /* index.js listens at module scope and exports only the app, so capture the server to close it. */
    const listenSpy = jest.spyOn(express.application, 'listen');
    app = require('~/server');
    await healthCheckPoll(app);
    server = listenSpy.mock.results[0].value;
    listenSpy.mockRestore();
  });

  afterAll(async () => {
    fs.readFileSync = originalReadFileSync;
    delete process.env.CSP_ENABLED;
    delete process.env.CSP_REPORT_ONLY;
    delete process.env.CSP_CONNECT_SRC_EXTRA;
    delete process.env.INDEX_CACHE_CONTROL;
    await promisify(server.close).call(server);
    await mongoServer.stop();
    await mongoose.disconnect();
  });

  it('sends an enforcing policy whose nonce matches the served scripts', async () => {
    const response = await request(app).get('/');
    const csp = response.headers['content-security-policy'];
    const nonce = csp?.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy-report-only']).toBeUndefined();
    expect(nonce).toBeTruthy();
    expect(response.text).toContain(`<script nonce="${nonce}">window.theme="dark";</script>`);
    expect(response.text).toContain(`<script nonce="${nonce}" defer src="/assets/app.js">`);
  });

  it('leaves style tags and stylesheet links unstamped', async () => {
    const response = await request(app).get('/');

    expect(response.text).toContain('<style>body{margin:0}</style>');
    expect(response.text).toContain('<link rel="stylesheet" crossorigin href="./assets/app.css">');
    expect(response.headers['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
  });

  it("stamps module preloads, which 'strict-dynamic' does not cover", async () => {
    const response = await request(app).get('/');
    const nonce = response.headers['content-security-policy']?.match(
      /script-src 'nonce-([^']+)'/,
    )?.[1];

    expect(nonce).toBeTruthy();
    expect(response.text).toContain(
      `<link nonce="${nonce}" rel="modulepreload" crossorigin href="./assets/chunk.js">`,
    );
    expect(response.text).toContain(
      `<script nonce="${nonce}" type="module" crossorigin src="./assets/index.js">`,
    );
  });

  it('stamps scripts injected after the shell is read', async () => {
    const response = await request(app).get('/').set('x-librechat-enable-query-devtools', '1');
    const nonce = response.headers['content-security-policy']?.match(
      /script-src 'nonce-([^']+)'/,
    )?.[1];

    expect(response.text).toContain('data-librechat-query-devtools="true"');
    expect(response.text).toContain(`<script nonce="${nonce}" data-librechat-query-devtools`);
  });

  it('keeps the shell non-storable despite a cacheable INDEX_CACHE_CONTROL', async () => {
    const response = await request(app).get('/');

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['cache-control']).not.toContain('max-age=3600');
    expect(response.headers['expires']).toBe('0');
  });

  it('rotates the nonce on every response', async () => {
    const [first, second] = await Promise.all([
      request(app).get('/'),
      request(app).get('/index.html'),
    ]);

    const nonceOf = (res) =>
      res.headers['content-security-policy']?.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('serves /index.html through the same nonce-aware handler', async () => {
    const response = await request(app).get('/index.html');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'nonce-");
  });

  it('keeps replacement patterns in the language cookie as literal attribute text', async () => {
    const response = await request(app).get('/').set('Cookie', 'lang=$&');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<html lang="$&amp;">');
    expect(response.text).not.toContain('<html lang="lang="en-US"">');
  });

  it('carries deployment-specific sources and the clickjacking default', async () => {
    const csp = (await request(app).get('/')).headers['content-security-policy'];

    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'self' https: wss: https://telemetry.example.com");
    expect(csp).toContain("object-src 'none'");
  });

  it('does not attach the policy to API responses', async () => {
    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-security-policy']).toBeUndefined();
  });
});

// Polls the /health endpoint every 30ms for up to 10 seconds to wait for the server to start completely
async function healthCheckPoll(app, retries = 0) {
  const maxRetries = Math.floor(10000 / 30);
  try {
    const response = await request(app).get('/health');
    if (response.status === 200) {
      return;
    }
  } catch {
    // Ignore connection errors during polling
  }

  if (retries < maxRetries) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await healthCheckPoll(app, retries + 1);
  } else {
    throw new Error('App did not become healthy within 10 seconds.');
  }
}
