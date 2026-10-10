const express = require('express');
const request = require('supertest');

const mockRequireRumProxyAuth = jest.fn((_req, _res, next) => next());
const mockIsRumProxyEnabled = jest.fn();
const mockIsRumLogsEndpointEnabled = jest.fn(() => true);
const mockProxyRumRequest = jest.fn((_req, res) => res.status(202).send());
const mockRumProxyLimiter = jest.fn((_req, _res, next) => next());
const mockLimiterSetup = [];
const mockCreateRumProxyLimiter = jest.fn((options) => {
  mockLimiterSetup.push(['createRumProxyLimiter', options]);
  return mockRumProxyLimiter;
});
const mockLimiterCache = jest.fn((prefix) => {
  mockLimiterSetup.push(['limiterCache', prefix]);
  return 'limiter-store';
});

jest.mock('~/server/middleware', () => ({
  requireRumProxyAuth: (...args) => mockRequireRumProxyAuth(...args),
}));

jest.mock('@librechat/api', () => ({
  getRumProxyBodyLimit: jest.fn(() => '3mb'),
  limiterCache: (...args) => mockLimiterCache(...args),
  createRumProxyLimiter: (...args) => mockCreateRumProxyLimiter(...args),
  requireRumProxyEnabled: (_req, res, next) =>
    mockIsRumProxyEnabled()
      ? next()
      : res.status(404).json({ message: 'RUM proxy is not configured' }),
  requireRumLogsEnabled: (_req, res, next) =>
    mockIsRumLogsEndpointEnabled()
      ? next()
      : res.status(404).json({ message: 'RUM logs are not enabled' }),
  handleJsonParseError: (err, _req, res, next) =>
    err.type === 'entity.parse.failed' ? res.status(400).end() : next(err),
  proxyRumRequest: (...args) => mockProxyRumRequest(...args),
}));

describe('RUM proxy routes', () => {
  let app;

  beforeAll(() => {
    const rumRouter = require('../rum');

    app = express();
    app.use('/api/rum', rumRouter);
  });

  beforeEach(() => {
    mockRequireRumProxyAuth.mockClear();
    mockIsRumProxyEnabled.mockReset();
    mockProxyRumRequest.mockClear();
    mockRumProxyLimiter.mockClear();
    mockIsRumLogsEndpointEnabled.mockReset();
    mockIsRumLogsEndpointEnabled.mockReturnValue(true);
  });

  it('refuses logs, but not traces, when no browser log source is enabled', async () => {
    mockIsRumProxyEnabled.mockReturnValue(true);
    mockIsRumLogsEndpointEnabled.mockReturnValue(false);

    const logs = await request(app)
      .post('/api/rum/v1/logs')
      .set('Content-Type', 'application/json')
      .send({ resourceLogs: [] });
    const traces = await request(app)
      .post('/api/rum/v1/traces')
      .set('Content-Type', 'application/json')
      .send({ resourceSpans: [] });

    expect(logs.status).toBe(404);
    expect(traces.status).toBe(202);
    expect(mockProxyRumRequest).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    delete process.env.RUM_PROXY_AUTHORIZATION;
  });

  it('returns 404 before auth and proxying when RUM proxy mode is disabled', async () => {
    mockIsRumProxyEnabled.mockReturnValue(false);

    const response = await request(app)
      .post('/api/rum/v1/traces')
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.from('payload'));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'RUM proxy is not configured' });
    expect(mockRequireRumProxyAuth).not.toHaveBeenCalled();
    expect(mockProxyRumRequest).not.toHaveBeenCalled();
  });

  it.each(['traces', 'logs'])(
    'passes server authorization to the %s proxy after auth',
    async (signal) => {
      process.env.RUM_PROXY_AUTHORIZATION = 'server-only-ingestion-key';
      mockIsRumProxyEnabled.mockReturnValue(true);

      const response = await request(app)
        .post(`/api/rum/v1/${signal}`)
        .set('Content-Type', 'application/x-protobuf')
        .send(Buffer.from('payload'));

      expect(response.status).toBe(202);
      expect(mockRequireRumProxyAuth).toHaveBeenCalledTimes(1);
      expect(mockProxyRumRequest).toHaveBeenCalledTimes(1);
      expect(mockProxyRumRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        'server-only-ingestion-key',
      );
    },
  );

  it.each(['traces', 'logs'])(
    'does not export %s when session authentication fails',
    async (signal) => {
      process.env.RUM_PROXY_AUTHORIZATION = 'server-only-ingestion-key';
      mockIsRumProxyEnabled.mockReturnValue(true);
      mockRequireRumProxyAuth.mockImplementationOnce((_req, res) => res.status(401).end());

      const response = await request(app)
        .post(`/api/rum/v1/${signal}`)
        .set('Content-Type', 'application/x-protobuf')
        .send(Buffer.from('payload'));

      expect(response.status).toBe(401);
      expect(mockProxyRumRequest).not.toHaveBeenCalled();
    },
  );

  it('uses RUM-specific auth for logs as well as traces', async () => {
    mockIsRumProxyEnabled.mockReturnValue(true);

    const response = await request(app)
      .post('/api/rum/v1/logs')
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.from('payload'));

    expect(response.status).toBe(202);
    expect(mockRequireRumProxyAuth).toHaveBeenCalledTimes(1);
    expect(mockProxyRumRequest).toHaveBeenCalledTimes(1);
  });

  it('builds the per-user limiter on the shared limiter store', () => {
    expect(mockLimiterSetup).toEqual([
      ['limiterCache', 'rum_proxy_user_limiter'],
      ['createRumProxyLimiter', { store: 'limiter-store' }],
    ]);
  });

  it.each(['traces', 'logs'])('rate limits %s after auth and before proxying', async (signal) => {
    mockIsRumProxyEnabled.mockReturnValue(true);
    const order = [];
    mockRequireRumProxyAuth.mockImplementationOnce((_req, _res, next) => {
      order.push('auth');
      next();
    });
    mockRumProxyLimiter.mockImplementationOnce((_req, res) => {
      order.push('limit');
      res.status(429).json({ message: 'Too many RUM telemetry requests' });
    });

    const response = await request(app)
      .post(`/api/rum/v1/${signal}`)
      .set('Content-Type', 'application/json')
      .send({ resourceLogs: [] });

    expect(response.status).toBe(429);
    expect(order).toEqual(['auth', 'limit']);
    expect(mockProxyRumRequest).not.toHaveBeenCalled();
  });

  it('skips the limiter when session authentication drops the request', async () => {
    mockIsRumProxyEnabled.mockReturnValue(true);
    mockRequireRumProxyAuth.mockImplementationOnce((_req, res) => res.status(204).end());

    const response = await request(app)
      .post('/api/rum/v1/logs')
      .set('Content-Type', 'application/json')
      .send({ resourceLogs: [] });

    expect(response.status).toBe(204);
    expect(mockRumProxyLimiter).not.toHaveBeenCalled();
  });
});
