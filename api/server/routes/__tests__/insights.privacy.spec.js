const express = require('express');
const request = require('supertest');

const mockGetAppConfig = jest.fn();
const mockGetAccessibleAgents = jest.fn();
const mockGetInsights = jest.fn();
let mockUser;

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createInsightsAgentAccessResolver: () => mockGetAccessibleAgents,
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!mockUser) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    req.user = mockUser;
    next();
  },
  strictConfigMiddleware: jest.requireActual('~/server/middleware/config/app')
    .strictConfigMiddleware,
}));

jest.mock('~/models', () => ({
  findAccessibleResources: jest.fn(),
  getAgents: jest.fn(),
  getInsights: (...args) => mockGetInsights(...args),
  getUserPrincipals: jest.fn(),
  hasCapabilityForPrincipals: jest.fn(),
}));

const insightsRouter = require('../insights');
const savedEnableInsights = process.env.ENABLE_INSIGHTS;
const agents = [{ id: 'agent-a', name: 'Alpha' }];
const privateValue = 'private-content-sentinel';
const detailed = {
  agents,
  summary: { totalUsers: 1, totalConversations: 1, totalMessages: 2, totalTokens: 8 },
  daily: [{ date: '2026-10-01', conversations: 1, users: 1, messages: 2, totalTokens: 8 }],
  topUsers: [{ userId: privateValue, name: privateValue, email: privateValue }],
  churnedUsers: [],
  latest: {
    conversations: [{ conversationId: privateValue, firstMessage: privateValue }],
    page: 1,
    pageSize: 10,
    pages: 1,
  },
};

function createApp() {
  const app = express();
  app.use('/api/insights', insightsRouter);
  app.use((_error, _req, res, _next) => {
    res.status(500).json({ message: 'Failed to resolve configuration' });
  });
  return app;
}

describe('Insights API privacy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_INSIGHTS;
    mockUser = { id: 'user-id', role: 'USER', tenantId: 'tenant-a' };
    mockGetAppConfig.mockResolvedValue({
      interfaceConfig: { insights: { enabled: true, showDetails: false } },
    });
    mockGetAccessibleAgents.mockResolvedValue(agents);
    mockGetInsights.mockResolvedValue(detailed);
  });

  afterAll(() => {
    if (savedEnableInsights === undefined) {
      delete process.env.ENABLE_INSIGHTS;
    } else {
      process.env.ENABLE_INSIGHTS = savedEnableInsights;
    }
  });

  it.each(['USER', 'ADMIN'])(
    'enforces aggregate-only YAML for %s through the real HTTP handler',
    async (role) => {
      mockUser.role = role;
      process.env.ENABLE_INSIGHTS = 'true';
      const response = await request(createApp()).get('/api/insights').query({
        search: privateValue,
        showDetails: 'true',
        tenantId: 'forged-tenant',
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ agents, summary: detailed.summary, daily: detailed.daily });
      expect(response.text).not.toContain(privateValue);
      expect(mockGetInsights).toHaveBeenCalledWith(
        expect.objectContaining({
          showDetails: false,
          search: undefined,
          tenantId: 'tenant-a',
        }),
      );
      expect(mockGetAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          failClosed: true,
        }),
      );
    },
  );

  it.each(['/api/insights', '/api/insights/access'])(
    'honours YAML disable on %s despite the environment switch',
    async (path) => {
      process.env.ENABLE_INSIGHTS = 'true';
      mockGetAppConfig.mockResolvedValue({
        interfaceConfig: { insights: { enabled: false, showDetails: true } },
      });
      const response = await request(createApp()).get(path);
      expect(response.status).toBe(404);
      expect(mockGetAccessibleAgents).not.toHaveBeenCalled();
      expect(mockGetInsights).not.toHaveBeenCalled();
    },
  );

  it('requires authentication before loading scoped configuration', async () => {
    mockUser = null;
    const response = await request(createApp()).get('/api/insights');
    expect(response.status).toBe(401);
    expect(mockGetAppConfig).not.toHaveBeenCalled();
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it('rejects unauthorized agent IDs before loading statistics', async () => {
    const response = await request(createApp())
      .get('/api/insights')
      .query({ agentIds: ['forbidden'] });
    expect(response.status).toBe(403);
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it('does not fall back to broader configuration after a scoped lookup fails', async () => {
    mockGetAppConfig.mockRejectedValueOnce(new Error(privateValue));
    const response = await request(createApp()).get('/api/insights');
    expect(response.status).toBe(500);
    expect(response.text).not.toContain(privateValue);
    expect(mockGetAppConfig).toHaveBeenCalledTimes(1);
    expect(mockGetAccessibleAgents).not.toHaveBeenCalled();
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it('keeps environment-only enablement private without an explicit detail opt-in', async () => {
    process.env.ENABLE_INSIGHTS = 'true';
    mockGetAppConfig.mockResolvedValue({ interfaceConfig: {} });
    const response = await request(createApp()).get('/api/insights');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('latest');
    expect(response.text).not.toContain(privateValue);
  });

  it('retains detailed responses when the effective configuration explicitly allows them', async () => {
    mockGetAppConfig.mockResolvedValue({
      interfaceConfig: { insights: { enabled: true, showDetails: true } },
    });
    const response = await request(createApp()).get('/api/insights');
    expect(response.status).toBe(200);
    expect(mockGetInsights).toHaveBeenCalledWith(expect.objectContaining({ showDetails: true }));
    expect(response.body).toEqual(detailed);
  });
});
