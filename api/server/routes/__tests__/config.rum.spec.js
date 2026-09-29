jest.mock('~/cache/getLogStores');

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/Config/ldap', () => ({
  getLdapConfig: jest.fn(() => null),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTenantId: jest.fn(() => undefined),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getCloudFrontConfig: jest.fn(() => null),
}));

const request = require('supertest');
const express = require('express');
const configRoute = require('../config');

function createApp(user) {
  const app = express();
  app.disable('x-powered-by');
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/config', configRoute);
  return app;
}

const baseAppConfig = {
  registration: { socialLogins: ['google', 'github'] },
  interfaceConfig: { modelSelect: true },
  turnstileConfig: { siteKey: 'test-key' },
  modelSpecs: { list: [{ name: 'test-spec' }] },
};

const mockUser = {
  id: 'user123',
  role: 'USER',
  tenantId: undefined,
};

afterEach(() => {
  jest.resetAllMocks();
  delete process.env.RUM_ENABLED;
  delete process.env.RUM_PROVIDER;
  delete process.env.RUM_URL;
  delete process.env.RUM_PROXY_TARGET_URL;
  delete process.env.RUM_PROXY_AUTHORIZATION;
  delete process.env.RUM_SERVICE_NAME;
  delete process.env.RUM_AUTH_MODE;
  delete process.env.RUM_PUBLIC_TOKEN;
  delete process.env.RUM_TRACE_PROPAGATION_TARGETS;
  delete process.env.RUM_CONSOLE_CAPTURE;
  delete process.env.RUM_DISABLE_REPLAY;
  delete process.env.RUM_ADVANCED_NETWORK_CAPTURE;
  delete process.env.RUM_SAMPLE_RATE;
  delete process.env.RUM_ENVIRONMENT;
});

describe('GET /api/config RUM config', () => {
  it('includes public-token RUM config when enabled with valid env', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'https://rum.example.com';
    process.env.RUM_PUBLIC_TOKEN = 'public-token';
    process.env.RUM_TRACE_PROPAGATION_TARGETS =
      'https://app.example.com,https://api.openai.com,*,http://api.example.com';
    process.env.RUM_SAMPLE_RATE = '0.25';
    process.env.RUM_ENVIRONMENT = 'test';
    const app = createApp(null);

    const response = await request(app).get('/api/config');

    expect(response.body.rum).toEqual({
      provider: 'hyperdx',
      enabled: true,
      url: 'https://rum.example.com',
      serviceName: 'librechat-web',
      authMode: 'publicToken',
      publicToken: 'public-token',
      tracePropagationTargets: ['https://app.example.com', 'https://api.openai.com'],
      consoleCapture: false,
      disableReplay: true,
      advancedNetworkCapture: false,
      sampleRate: 0.25,
      environment: 'test',
    });
  });

  it('omits malformed RUM config', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'not a url';
    process.env.RUM_PUBLIC_TOKEN = 'public-token';
    const app = createApp(null);

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('rum');
  });

  it.each([null, mockUser])(
    'keeps proxy credentials out of startup config for %p',
    async (user) => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.RUM_ENABLED = 'true';
      process.env.RUM_AUTH_MODE = 'proxy';
      process.env.RUM_PROXY_TARGET_URL = 'http://otel-collector:4318';
      process.env.RUM_PROXY_AUTHORIZATION = 'server-only-ingestion-key';
      const app = createApp(user);

      const response = await request(app).get('/api/config');

      expect(JSON.stringify(response.body)).not.toContain('server-only-ingestion-key');
      expect(JSON.stringify(response.body)).not.toContain('otel-collector');
      expect(response.body.rum).toEqual({
        provider: 'hyperdx',
        enabled: true,
        url: '/api/rum',
        serviceName: 'librechat-web',
        authMode: 'proxy',
        consoleCapture: false,
        disableReplay: true,
        advancedNetworkCapture: false,
      });
    },
  );

  it('omits proxy RUM config without a target collector URL', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_AUTH_MODE = 'proxy';
    const app = createApp(mockUser);

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('rum');
  });

  it('omits RUM config when the URL contains credentials', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'https://user:password@rum.example.com';
    process.env.RUM_PUBLIC_TOKEN = 'public-token';
    const app = createApp(null);

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('rum');
  });

  it('allows IPv6 localhost HTTP RUM URLs in public-token mode', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'http://[::1]:4318';
    process.env.RUM_PUBLIC_TOKEN = 'public-token';
    const app = createApp(null);

    const response = await request(app).get('/api/config');

    expect(response.body.rum?.url).toBe('http://[::1]:4318');
  });

  it('omits unsupported userJwt RUM config for authenticated users', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'https://rum.example.com';
    process.env.RUM_AUTH_MODE = 'userJwt';
    const app = createApp(mockUser);

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('rum');
  });

  it('omits unsupported userJwt RUM config for unauthenticated users', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.RUM_ENABLED = 'true';
    process.env.RUM_URL = 'https://rum.example.com';
    process.env.RUM_AUTH_MODE = 'userJwt';
    const app = createApp(null);

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('rum');
  });
});
