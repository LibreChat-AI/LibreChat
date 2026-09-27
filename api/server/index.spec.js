const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('~/server/services/Config', () => ({
  syncStaticTools: jest.fn().mockResolvedValue(undefined),
  mergeAppTools: jest.fn().mockResolvedValue(undefined),
  loadCustomConfig: jest.fn(() => Promise.resolve({})),
  getAppConfig: jest.fn().mockResolvedValue({
    paths: {
      uploads: '/tmp',
      dist: '/tmp/dist',
      fonts: '/tmp/fonts',
      assets: '/tmp/assets',
    },
    fileStrategy: 'local',
    imageOutputType: 'PNG',
  }),
  setCachedTools: jest.fn(),
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

jest.mock('~/server/services/Agents/triggers', () => ({
  initializeAgentTriggerService: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/services/Schedules', () => ({
  initializeScheduleEngine: jest.fn().mockResolvedValue(undefined),
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

describe('Telemetry wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  it('loads credentials before telemetry and other server imports', () => {
    const firstStatements = source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2);

    expect(firstStatements).toEqual([
      "require('../config/credentials');",
      "const telemetry = require('./telemetry');",
    ]);
  });

  it('mounts telemetry middleware after static assets and before routes', () => {
    const telemetryMiddlewareIndex = source.indexOf('app.use(telemetry.telemetryMiddleware);');
    const staticAssetsIndex = source.indexOf('app.use(staticCache(appConfig.paths.assets));');
    const apiRoutesIndex = source.indexOf("app.use('/api/auth'");

    expect(telemetryMiddlewareIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeGreaterThan(-1);
    expect(apiRoutesIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeLessThan(telemetryMiddlewareIndex);
    expect(telemetryMiddlewareIndex).toBeLessThan(apiRoutesIndex);
  });

  it('mounts telemetry error middleware before ErrorController', () => {
    const telemetryErrorMiddlewareIndex = source.indexOf(
      'app.use(telemetry.telemetryErrorMiddleware);',
    );
    const errorControllerIndex = source.indexOf('app.use(ErrorController);');

    expect(telemetryErrorMiddlewareIndex).toBeGreaterThan(-1);
    expect(errorControllerIndex).toBeGreaterThan(-1);
    expect(telemetryErrorMiddlewareIndex).toBeLessThan(errorControllerIndex);
  });

  it('captures agent ingress before parsing and creates its recorder before auth routes', () => {
    const ingressIndex = source.indexOf(
      "app.use('/api/agents/chat', agentStartupIngressMiddleware);",
    );
    const jsonParserIndex = source.indexOf("app.use(express.json({ limit: '3mb' }));");
    const recorderIndex = source.indexOf(
      "app.use('/api/agents/chat', agentStartupTelemetryMiddleware);",
    );
    const tracingIndex = source.indexOf('app.use(telemetry.telemetryMiddleware);');
    const agentsRouteIndex = source.indexOf("app.use('/api/agents', routes.agents);");

    expect(ingressIndex).toBeGreaterThan(-1);
    expect(recorderIndex).toBeGreaterThan(-1);
    expect(ingressIndex).toBeLessThan(jsonParserIndex);
    expect(tracingIndex).toBeLessThan(recorderIndex);
    expect(recorderIndex).toBeLessThan(agentsRouteIndex);
  });
});

describe('Startup readiness wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  it('starts code-environment lifecycle reconciliation only after Mongo connects', () => {
    const connectIndex = source.indexOf('await connectDb();');
    const reconcileIndex = source.indexOf('startCodeEnvironmentLifecycleReconciler({ mongoose });');
    const listenIndex = source.indexOf('const server = app.listen');

    expect(connectIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(connectIndex);
    expect(listenIndex).toBeGreaterThan(reconcileIndex);
    expect(
      source.match(/startCodeEnvironmentLifecycleReconciler\(\{ mongoose \}\);/g),
    ).toHaveLength(1);
  });

  it('configures social logins with the app config loaded at startup in both server entries', () => {
    const experimental = fs.readFileSync(path.join(__dirname, 'experimental.js'), 'utf8');

    for (const [name, contents] of [
      ['index.js', source],
      ['experimental.js', experimental],
    ]) {
      const appConfigIndex = contents.indexOf('const appConfig = await getAppConfig(');
      const socialLoginsIndex = contents.indexOf('await configureSocialLogins(app, appConfig);');

      expect([name, appConfigIndex > -1]).toEqual([name, true]);
      expect([name, socialLoginsIndex > appConfigIndex]).toEqual([name, true]);
    }
  });

  it('awaits the shared Redis client before startup cache access', () => {
    const redisReadyIndex = source.indexOf('await waitForKeyvRedisClient();');
    const connectDbIndex = source.indexOf('await connectDb();');
    const appConfigIndex = source.indexOf('await getAppConfig({ baseOnly: true });');

    expect(redisReadyIndex).toBeGreaterThan(-1);
    expect(connectDbIndex).toBeGreaterThan(redisReadyIndex);
    expect(appConfigIndex).toBeGreaterThan(redisReadyIndex);
  });

  it('configures generation streams before the server accepts requests', () => {
    const streamConfigIndex = source.indexOf('configureGenerationStreams();');
    const listenIndex = source.indexOf('const server = app.listen');
    const postListenMcpIndex = source.indexOf('await initializeMCPs();');

    expect(streamConfigIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(postListenMcpIndex).toBeGreaterThan(-1);
    expect(streamConfigIndex).toBeLessThan(listenIndex);
    expect(streamConfigIndex).toBeLessThan(postListenMcpIndex);
  });

  it('configures subagent task routing before the server accepts requests', () => {
    const routingIndex = source.indexOf('await configureSubagentTaskRouting();');
    const listenIndex = source.indexOf('const server = app.listen');

    expect(routingIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(routingIndex);
  });

  it('registers generation stream cleanup with the graceful shutdown coordinator', () => {
    const shutdownRegistrationIndex = source.indexOf(
      "registerShutdownTask('generation job manager'",
    );
    const listenIndex = source.indexOf('const server = app.listen');

    expect(shutdownRegistrationIndex).toBeGreaterThan(-1);
    expect(shutdownRegistrationIndex).toBeLessThan(listenIndex);
  });

  it('registers background task draining with the graceful shutdown coordinator', () => {
    const registrationIndex = source.indexOf('registerBackgroundTaskShutdown({');
    const listenIndex = source.indexOf('const server = app.listen');

    expect(registrationIndex).toBeGreaterThan(-1);
    expect(registrationIndex).toBeLessThan(listenIndex);
    expect(source).toContain(
      'interruptGraceMs: appConfig?.endpoints?.agents?.backgroundTasks?.shutdownInterruptGraceMs',
    );
  });

  it('configures HTTP timeouts before graceful shutdown handling', () => {
    const listenIndex = source.indexOf('const server = app.listen');
    const timeoutConfigIndex = source.indexOf('configureServerTimeouts(server);');
    const shutdownIndex = source.indexOf('setupGracefulShutdown(server);');

    expect(listenIndex).toBeGreaterThan(-1);
    expect(timeoutConfigIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeLessThan(timeoutConfigIndex);
    expect(timeoutConfigIndex).toBeLessThan(shutdownIndex);
  });

  it('registers security headers ahead of the health endpoints in both server entries', () => {
    const experimental = fs.readFileSync(path.join(__dirname, 'experimental.js'), 'utf8');

    for (const [name, contents] of [
      ['index.js', source],
      ['experimental.js', experimental],
    ]) {
      const headersIndex = contents.indexOf('const securityHeaders = createSecurityHeaders();');
      const healthIndex = contents.indexOf("app.get('/health'");

      expect([name, headersIndex > -1]).toEqual([name, true]);
      expect([name, healthIndex > -1]).toEqual([name, true]);
      expect([name, headersIndex < healthIndex]).toEqual([name, true]);
    }
  });

  it('mounts the chat-start readiness gate before agent routes', () => {
    const readinessGateIndex = source.indexOf(
      "app.use('/api/agents/chat', rejectChatStartsUntilReady);",
    );
    const agentsRouteIndex = source.indexOf("app.use('/api/agents', routes.agents);");

    expect(readinessGateIndex).toBeGreaterThan(-1);
    expect(agentsRouteIndex).toBeGreaterThan(-1);
    expect(readinessGateIndex).toBeLessThan(agentsRouteIndex);
  });

  it('awaits durable trigger delivery before reporting readiness', () => {
    const triggerDeliveryIndex = source.indexOf('await initializeAgentTriggerService(');
    const readyIndex = source.indexOf('serverReady = true;');

    expect(triggerDeliveryIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(triggerDeliveryIndex);
  });
});

describe('Server Configuration', () => {
  // Increase the default timeout to allow for Mongo cleanup
  jest.setTimeout(30_000);

  let mongoServer;
  let app;
  let server;

  /** Mocked fs.readFileSync for index.html */
  const originalReadFileSync = fs.readFileSync;
  beforeAll(() => {
    fs.readFileSync = function (filepath, options) {
      if (filepath.includes('index.html')) {
        return '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>';
      }
      return originalReadFileSync(filepath, options);
    };
  });

  afterAll(() => {
    // Restore original fs.readFileSync
    fs.readFileSync = originalReadFileSync;
  });

  beforeAll(async () => {
    // Create the required directories and files for the test
    const fs = require('fs');
    const path = require('path');

    const dirs = ['/tmp/dist', '/tmp/fonts', '/tmp/assets'];
    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    fs.writeFileSync(
      path.join('/tmp/dist', 'index.html'),
      '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>',
    );

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    process.env.PORT = '0'; // Use a random available port
    /* This deployment configures a footer, so the shell it serves has to say so
       before any `/api/config` request: the composer lays out against it. */
    process.env.CUSTOM_FOOTER = 'Operator policy footer';
    /* index.js listens at module scope and exports only the app, so capture the server to close it. */
    const listenSpy = jest.spyOn(express.application, 'listen');
    app = require('~/server');

    // Wait for the app to be healthy
    await healthCheckPoll(app);
    server = listenSpy.mock.results[0].value;
    listenSpy.mockRestore();
  });

  afterAll(async () => {
    await promisify(server.close).call(server);
    await mongoServer.stop();
    await mongoose.disconnect();
    delete process.env.CUSTOM_FOOTER;
  });

  it('should return OK for /health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');
  });

  it('should set baseline security headers on health checks', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('should set baseline security headers on the index page without a CSP', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('should not cache index page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers['pragma']).toBe('no-cache');
    expect(response.headers['expires']).toBe('0');
  });

  it('should return 404 JSON for undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for nested undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent/nested/path');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for non-GET methods on undefined API routes', async () => {
    const post = await request(app).post('/api/nonexistent');
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ message: 'Endpoint not found' });

    const del = await request(app).delete('/api/nonexistent');
    expect(del.status).toBe(404);
    expect(del.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for the /api root path', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should serve SPA HTML for non-API unmatched routes', async () => {
    const response = await request(app).get('/this/does/not/exist');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });

  it('should gate React Query Devtools config in SPA HTML by debug header', async () => {
    const defaultResponse = await request(app).get('/this/does/not/exist');
    const debugResponse = await request(app)
      .get('/this/does/not/exist')
      .set('x-librechat-enable-query-devtools', '1');
    const directIndexResponse = await request(app)
      .get('/index.html')
      .set('x-librechat-enable-query-devtools', '1');

    expect(defaultResponse.status).toBe(200);
    expect(defaultResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(defaultResponse.text).not.toContain('enableQueryDevtools');

    expect(debugResponse.status).toBe(200);
    expect(debugResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(debugResponse.text).toContain('window.__LIBRECHAT_CONFIG__');
    expect(debugResponse.text).toContain('data-librechat-query-devtools="true"');
    expect(debugResponse.text).toContain('"enableQueryDevtools":true');

    expect(directIndexResponse.status).toBe(200);
    expect(directIndexResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(directIndexResponse.text).toContain('window.__LIBRECHAT_CONFIG__');
    expect(directIndexResponse.text).toContain('data-librechat-query-devtools="true"');
    expect(directIndexResponse.text).toContain('"enableQueryDevtools":true');
  });

  it('serves the configured-footer answer with the shell', async () => {
    const [fallbackResponse, indexResponse] = await Promise.all([
      request(app).get('/this/does/not/exist'),
      request(app).get('/index.html'),
    ]);

    for (const response of [fallbackResponse, indexResponse]) {
      expect(response.status).toBe(200);
      expect(response.text).toContain('window.__LIBRECHAT_CONFIG__');
      expect(response.text).toContain('"hasConfiguredFooter":true');
    }
  });

  it('should return 500 for unknown errors via ErrorController', async () => {
    // Testing the error handling here on top of unit tests to ensure the middleware is correctly integrated

    // Mock MongoDB operations to fail
    const originalFindOne = mongoose.models.User.findOne;
    const mockError = new Error('MongoDB operation failed');
    mongoose.models.User.findOne = jest.fn().mockImplementation(() => {
      throw mockError;
    });

    try {
      const response = await request(app).post('/api/auth/login').send({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(500);
      expect(response.text).toBe('An unknown error occurred.');
    } finally {
      // Restore original function
      mongoose.models.User.findOne = originalFindOne;
    }
  });
});

// Polls the /health endpoint every 30ms for up to 10 seconds to wait for the server to start completely
async function healthCheckPoll(app, retries = 0) {
  const maxRetries = Math.floor(10000 / 30); // 10 seconds / 30ms
  try {
    const response = await request(app).get('/health');
    if (response.status === 200) {
      return; // App is healthy
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
