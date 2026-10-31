const express = require('express');
const request = require('supertest');
const mockConfig = jest.fn();
const mockDb = {
  findUser: jest.fn(),
  getAgentChannel: jest.fn(),
  getAgentChannelMetadata: jest.fn(),
  getAgent: jest.fn(),
  getRoleByName: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn(),
  createAgentApiKey: jest.fn(),
  getAgentApiKeyById: jest.fn(),
  deleteAgentApiKey: jest.fn(),
  readResponseArtifacts: jest.fn(),
  getMessage: jest.fn(),
  getMessages: jest.fn(),
  listAgentChannelTenants: jest.fn(),
  listDeletingAgentChannels: jest.fn(),
  deleteAgentChannel: jest.fn(),
};
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return { ...actual, createChannelRunHandlers: jest.fn(actual.createChannelRunHandlers) };
});
jest.mock('~/models', () => mockDb);
jest.mock('./Config', () => ({ getAppConfig: (...args) => mockConfig(...args) }));
jest.mock('./PermissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createResponseStorage: () => ({}),
  createChannelRunStorage: () => ({}),
  createChannelIdentityStorage: () => ({}),
  createChannelFeedbackStorage: () => ({}),
  createChannelSummaryStorage: () => ({}),
}));
jest.mock('./Responses', () => ({
  readBackgroundResponse: jest.fn(),
  cancelBackgroundResponse: jest.fn(),
  retireBackgroundResponse: jest.fn(),
  readInteractiveReview: jest.fn(),
  submitInteractiveReview: jest.fn(),
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({ getHeldCapabilities: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
const serviceToken = 'fixture-service-token-32-characters';
const oldToken = process.env.CHANNEL_SERVICE_TOKEN;
const oldOrigin = process.env.DOMAIN_CLIENT;
let handlers;
let app;
let reached;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.CHANNEL_SERVICE_TOKEN = serviceToken;
  process.env.DOMAIN_CLIENT = 'http://192.168.1.50:3080';
  mockConfig.mockResolvedValue({ endpoints: { agents: { channels: { enabled: true } } } });
  handlers = require('./Channels');
  reached = jest.fn((req, res, channel) =>
    res.json({
      tenantId: jest.requireActual('@librechat/data-schemas').getTenantId() || null,
      channelId: channel.channelId,
    }),
  );
  app = express();
  app.get('/service/:channelId', handlers.service(reached));
});
afterEach(() => {
  if (oldToken === undefined) delete process.env.CHANNEL_SERVICE_TOKEN;
  else process.env.CHANNEL_SERVICE_TOKEN = oldToken;
  if (oldOrigin === undefined) delete process.env.DOMAIN_CLIENT;
  else process.env.DOMAIN_CLIENT = oldOrigin;
});
function channel(tenantId) {
  const value = {
    tenantId,
    channelId: 'channel',
    agentId: 'agent',
    createdBy: 'owner',
    status: 'active',
    revision: 'v1',
    slack: { teamId: 'T1' },
  };
  mockDb.getAgentChannel.mockResolvedValue(value);
  mockDb.findUser.mockResolvedValue({ _id: 'owner', role: 'USER', tenantId });
  return value;
}
const call = (tenantId = '_') =>
  request(app)
    .get('/service/channel')
    .auth(serviceToken, { type: 'bearer' })
    .set('x-tenant-id', tenantId);

it.each(['tenant-a', undefined])(
  'establishes canonical application tenant %s before effective owner policy',
  async (tenantId) => {
    channel(tenantId);
    const response = await call(tenantId).expect(200);
    expect(response.body).toEqual({ tenantId: tenantId || null, channelId: 'channel' });
    expect(mockConfig).toHaveBeenCalledWith({
      tenantId,
      userId: 'owner',
      role: 'USER',
      idOnTheSource: undefined,
      failClosed: true,
    });
    expect(reached).toHaveBeenCalledTimes(1);
  },
);
it('denies an effective owner disable instead of falling back to deployment policy', async () => {
  channel();
  mockConfig.mockImplementation(async (options) => ({
    endpoints: { agents: { channels: { enabled: !options?.userId } } },
  }));
  await call().expect(404, { error: 'channels_disabled' });
  expect(reached).not.toHaveBeenCalled();
});
it('authenticates and rejects forged tenant scope before reading policy or executing', async () => {
  channel('tenant-a');
  await request(app).get('/service/channel').expect(401);
  await call('other-tenant').expect(404);
  expect(mockConfig).not.toHaveBeenCalled();
  expect(reached).not.toHaveBeenCalled();
});
it('returns a safe unavailable result when effective owner configuration fails', async () => {
  channel();
  mockConfig.mockRejectedValue(new Error('private configuration details'));
  await call().expect(503, { error: 'channel_operation_failed' });
  expect(reached).not.toHaveBeenCalled();
});

it('installs the channel owner-review URL with the owning review page', () => {
  const { createChannelRunHandlers } = require('@librechat/api');
  expect(createChannelRunHandlers).toHaveBeenCalledWith(
    expect.objectContaining({
      publicBaseUrl: process.env.DOMAIN_CLIENT,
      interactive: {
        readInteractiveReview: expect.any(Function),
        submitInteractiveReview: expect.any(Function),
      },
    }),
  );
});
