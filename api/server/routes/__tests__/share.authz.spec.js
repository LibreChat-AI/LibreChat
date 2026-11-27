const express = require('express');
const request = require('supertest');

const mockNext = (_req, _res, next) => next();
const mockCanAccessSharedLink = jest.fn((_req, res) => res.status(403).end());

jest.mock('@librechat/api', () => ({
  isEnabled: () => true,
  generateCheckAccess: () => mockNext,
  createSharedLinkConfigMiddleware: () => mockNext,
  createSharedLangfuseSessionResolver: () => jest.fn(),
  buildSharedLinkStartupPayload: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  getSharedMessages: jest.fn(),
  getSharedLinkFile: jest.fn(),
  backfillSharedLinkFiles: jest.fn(),
  getSharedLinks: jest.fn(),
  getSharedLink: jest.fn(),
  createSharedLink: jest.fn(),
  updateSharedLink: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({}));
jest.mock('~/server/utils/files', () => ({}));
jest.mock('~/server/utils/import/fork', () => ({ forkSharedConversation: jest.fn() }));
jest.mock('~/server/middleware/roles/capabilities', () => ({}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/middleware/config/app', () => mockNext);
jest.mock('~/server/middleware/optionalJwtAuth', () => mockNext);
jest.mock('~/server/middleware/optionalShareFileAuth', () => mockNext);
jest.mock(
  '~/server/middleware/requireJwtAuth',
  () => (req, res, next) => (req.user ? next() : res.status(401).end()),
);
jest.mock('~/server/middleware/limiters', () => ({
  createForkLimiters: () => ({ forkIpLimiter: mockNext, forkUserLimiter: mockNext }),
  createShareLimiters: () => ({ shareIpLimiter: mockNext, shareUserLimiter: mockNext }),
}));
jest.mock(
  '~/server/middleware/canAccessSharedLink',
  () =>
    (...args) =>
      mockCanAccessSharedLink(...args),
);

const models = require('~/models');
const { buildSharedLinkStartupPayload } = require('@librechat/api');
const { forkSharedConversation } = require('~/server/utils/import/fork');
const shareRouter = require('../share');

const buildApp = (user) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/share', shareRouter);
  return app;
};

/** [method, route path, sample URL] */
const GATED_ROUTES = [
  ['get', '/:shareId/config', '/api/share/s1/config'],
  ['get', '/:shareId', '/api/share/s1'],
  ['post', '/:shareId/fork', '/api/share/s1/fork'],
  ['get', '/:shareId/files/:file_id/preview', '/api/share/s1/files/f1/preview'],
  ['get', '/:shareId/files/:file_id/download', '/api/share/s1/files/f1/download'],
  ['get', '/:shareId/files/:file_id', '/api/share/s1/files/f1'],
];

/** Owner-scoped management routes: `requireJwtAuth`, then queries keyed by `req.user.id`. */
const OWNER_ROUTES = [
  ['get', '/', '/api/share'],
  ['get', '/link/:conversationId', '/api/share/link/c1'],
  ['post', '/:conversationId', '/api/share/c1'],
  ['patch', '/:shareId', '/api/share/s1'],
  ['delete', '/:shareId', '/api/share/s1'],
];

const expectNothingRead = () => {
  for (const read of Object.values(models)) {
    expect(read).not.toHaveBeenCalled();
  }
  expect(forkSharedConversation).not.toHaveBeenCalled();
  expect(buildSharedLinkStartupPayload).not.toHaveBeenCalled();
};

/** Ties `fork_allow_is_authenticated_view` and the file routes to the router: these check
 *  middleware ordering only, with the gate, the handlers' reads and the fork mocked. */
describe('share routes sit behind the shared-link gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(GATED_ROUTES)(
    '%s %s returns 403 and reads nothing when the gate denies',
    async (method, _path, url) => {
      const response = await request(buildApp({ id: 'user-123' }))[method](url);

      expect(response.status).toBe(403);
      expect(mockCanAccessSharedLink).toHaveBeenCalledTimes(1);
      expectNothingRead();
    },
  );

  it('rejects Continue without a signed-in user before the gate runs', async () => {
    const response = await request(buildApp(null)).post('/api/share/s1/fork');

    expect(response.status).toBe(401);
    expect(mockCanAccessSharedLink).not.toHaveBeenCalled();
  });

  it.each(OWNER_ROUTES)(
    '%s %s rejects an anonymous request before any read',
    async (method, _path, url) => {
      const response = await request(buildApp(null))[method](url);

      expect(response.status).toBe(401);
      expect(mockCanAccessSharedLink).not.toHaveBeenCalled();
      expectNothingRead();
    },
  );

  /** A new share route must be classified as gated or owner-scoped. */
  it('exposes exactly the classified routes', () => {
    const routes = shareRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map((method) => `${method} ${layer.route.path}`),
      )
      .sort();

    expect(routes).toEqual(
      [...GATED_ROUTES, ...OWNER_ROUTES].map(([method, path]) => `${method} ${path}`).sort(),
    );
  });
});
