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
const { createProductTrackingMiddleware } = require('@librechat/api');
const configRoute = require('../config');

const user = { id: 'user123', role: 'USER', tenantId: undefined };

function createApp({ telemetry, createTracker, signedIn }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createProductTrackingMiddleware(telemetry, { createTracker }));
  if (signedIn) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/config', configRoute);
  return app;
}

afterEach(() => {
  jest.resetAllMocks();
});

describe('GET /api/config product tracking', () => {
  const enabled = { productTracking: { enabled: true } };

  it.each([
    [undefined, false, false],
    [enabled, false, false],
    [{ productTracking: { enabled: false } }, true, false],
    [enabled, true, true],
  ])(
    'reports enabled for telemetry %p with a tracker factory %p as %p',
    async (telemetry, withFactory, expected) => {
      for (const signedIn of [false, true]) {
        mockGetAppConfig.mockResolvedValue({ config: { telemetry } });
        const response = await request(
          createApp({
            telemetry,
            signedIn,
            createTracker: withFactory ? () => jest.fn() : undefined,
          }),
        ).get('/api/config');
        expect(response.status).toBe(200);
        expect(response.body.productTracking).toEqual({
          enabled: expected,
          session: { shareAcrossTabs: true, idleTimeoutMs: 1800000, activityIntervalMs: 60000 },
        });
      }
    },
  );
});
