const express = require('express');
const request = require('supertest');
const { Permissions, PermissionTypes } = require('librechat-data-provider');

const mockConsentHandler = jest.fn((_req, res) => res.status(200).json({ ok: true }));
const mockGetRoleByName = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createSchedulesHandlers: jest.fn(
    () => new Proxy({}, { get: () => (_req, res) => res.status(204).end() }),
  ),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'schedule-owner', role: 'SCHEDULE_TEST_ROLE', tenantId: 'tenant-a' };
    next();
  },
  configMiddleware: (_req, _res, next) => next(),
  messageIpLimiter: (_req, _res, next) => next(),
}));
jest.mock('~/server/services/Schedules', () => ({}));
jest.mock('~/server/services/Schedules/access', () => ({ resolveAgentFireAccess: jest.fn() }));
jest.mock('~/server/services/Schedules/mcp', () => ({}));
jest.mock('~/server/services/Schedules/consent', () => ({
  consent: {
    handlers: {
      draft: mockConsentHandler,
      get: mockConsentHandler,
      confirm: mockConsentHandler,
      revoke: mockConsentHandler,
    },
  },
}));
jest.mock('~/models', () => ({ getRoleByName: (...args) => mockGetRoleByName(...args) }));

const schedulesRouter = require('../schedules');

const app = express();
app.use(express.json());
app.use('/api/schedules', schedulesRouter);

const withSchedulePermissions = (permissions) =>
  mockGetRoleByName.mockResolvedValue({
    name: 'SCHEDULE_TEST_ROLE',
    permissions: { [PermissionTypes.SCHEDULES]: permissions },
  });

describe('schedule MCP consent routes enforce the SCHEDULES role gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['get', {}],
    ['delete', { [Permissions.USE]: true }],
  ])('%s /:id/mcp-consent returns 403 without the required permission', async (method, perms) => {
    withSchedulePermissions(perms);

    const res = await request(app)[method]('/api/schedules/schedule-1/mcp-consent');

    expect(res.status).toBe(403);
    expect(mockConsentHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['get', { [Permissions.USE]: true }],
    ['delete', { [Permissions.USE]: true, [Permissions.CREATE]: true }],
  ])(
    '%s /:id/mcp-consent reaches the handler with the required permission',
    async (method, perms) => {
      withSchedulePermissions(perms);

      const res = await request(app)[method]('/api/schedules/schedule-1/mcp-consent');

      expect(res.status).toBe(200);
      expect(mockConsentHandler).toHaveBeenCalledTimes(1);
    },
  );
});
