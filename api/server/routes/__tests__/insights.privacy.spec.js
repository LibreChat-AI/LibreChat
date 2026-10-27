const express = require('express');
const request = require('supertest');
const { Types } = require('mongoose');
const { PermissionBits, PrincipalType } = require('librechat-data-provider');

const mockGetAppConfig = jest.fn();
const mockGetAgents = jest.fn();
const mockGetUserPrincipals = jest.fn();
const mockHasGlobalAccess = jest.fn();
const mockFindAccessibleResources = jest.fn();
const mockGetInsights = jest.fn();
let mockUser;

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
  findAccessibleResources: (...args) => mockFindAccessibleResources(...args),
  getAgents: (...args) => mockGetAgents(...args),
  getInsights: (...args) => mockGetInsights(...args),
  getUserPrincipals: (...args) => mockGetUserPrincipals(...args),
  hasCapabilityForPrincipals: (...args) => mockHasGlobalAccess(...args),
}));

const insightsRouter = require('../insights');
const savedEnableInsights = process.env.ENABLE_INSIGHTS;
const agents = [{ id: 'agent-a', name: 'Alpha' }];
const records = [
  { _id: new Types.ObjectId(), ...agents[0], tenantId: 'tenant-a' },
  { _id: new Types.ObjectId(), id: 'agent-b', name: 'Beta', tenantId: 'tenant-a' },
];
const privateValue = 'private-content-sentinel';
const detailed = {
  agents,
  summary: {
    totalUsers: 1,
    totalConversations: 1,
    totalMessages: 4,
    totalTokens: 8,
    totalResponses: 3,
    completedResponses: 1,
    failedResponses: 1,
    interruptedResponses: 1,
    lastUsed: '2026-10-01T12:00:00.000Z',
  },
  daily: [
    {
      date: '2026-10-01',
      conversations: 1,
      users: 1,
      messages: 4,
      totalTokens: 8,
      responses: 3,
      completedResponses: 1,
      failedResponses: 1,
      interruptedResponses: 1,
    },
  ],
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
    mockGetAgents.mockResolvedValue([records[0]]);
    mockGetUserPrincipals.mockResolvedValue([
      { principalType: PrincipalType.USER, principalId: 'user-id' },
    ]);
    mockHasGlobalAccess.mockResolvedValue(false);
    mockFindAccessibleResources.mockImplementation(async (_principals, _type, required) =>
      required === (PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS) ? [records[0]._id] : [],
    );
    mockGetInsights.mockImplementation(async (options) => ({
      ...detailed,
      agents: options.agents,
    }));
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
      expect(mockGetAgents).not.toHaveBeenCalled();
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
    expect(mockGetAgents).not.toHaveBeenCalled();
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

  it.each(
    [PrincipalType.USER, PrincipalType.GROUP, PrincipalType.ROLE].flatMap((type) =>
      [3, 15].map((permBits) => [type, permBits]),
    ),
  )(
    'enables numbers-only access through %s grant %s even when YAML allows detail',
    async (type, permBits) => {
      mockGetAppConfig.mockResolvedValue({
        interfaceConfig: { insights: { enabled: true, showDetails: true } },
      });
      const principal = {
        principalType: type,
        principalId: type === PrincipalType.USER ? mockUser.id : 'shared-principal',
      };
      mockGetUserPrincipals.mockResolvedValue([principal, { principalType: PrincipalType.PUBLIC }]);
      mockFindAccessibleResources.mockImplementation(async (_principals, _type, required) =>
        (permBits & required) === required ? [records[0]._id] : [],
      );
      const app = createApp();

      const access = await request(app).get('/api/insights/access');
      expect(access.status).toBe(200);
      expect(access.body).toEqual({ access: true });
      const response = await request(app).get('/api/insights').query({
        showDetails: 'true',
        search: privateValue,
        page: 20,
        pageSize: 50,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ agents, summary: detailed.summary, daily: detailed.daily });
      expect(response.text).not.toContain(privateValue);
      expect(mockGetInsights).toHaveBeenCalledWith(
        expect.objectContaining({
          agentIds: ['agent-a'],
          showDetails: false,
          search: undefined,
          page: 1,
          pageSize: 10,
        }),
      );
      expect(mockFindAccessibleResources).toHaveBeenCalledWith(
        [principal],
        'agent',
        PermissionBits.VIEW | PermissionBits.EDIT,
        [records[0]._id],
      );
    },
  );

  it.each([
    [PrincipalType.USER, PermissionBits.VIEW],
    [PrincipalType.PUBLIC, PermissionBits.VIEW | PermissionBits.EDIT],
  ])(
    'denies statistics through %s grant %s without an eligible non-public grant',
    async (type, permBits) => {
      mockGetUserPrincipals.mockResolvedValue([
        { principalType: type, principalId: 'principal-id' },
      ]);
      mockFindAccessibleResources.mockImplementation(async (_principals, _type, required) =>
        (permBits & required) === required ? [records[0]._id] : [],
      );
      for (const path of ['/api/insights/access', '/api/insights']) {
        const response = await request(createApp()).get(path);
        expect(response.status).toBe(403);
      }
      expect(mockGetInsights).not.toHaveBeenCalled();
    },
  );

  it.each([
    [['agent-a'], true],
    [['agent-b'], false],
    [['agent-a', 'agent-b'], false],
    [undefined, false],
  ])('applies inspection eligibility to selected agents %p', async (selected, expectedDetail) => {
    mockGetAppConfig.mockResolvedValue({
      interfaceConfig: { insights: { enabled: true, showDetails: true } },
    });
    mockGetAgents.mockResolvedValue(records);
    mockFindAccessibleResources.mockImplementation(async (_principals, _type, required) =>
      required === (PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS)
        ? [records[0]._id]
        : [records[1]._id],
    );
    const response = await request(createApp())
      .get('/api/insights')
      .query(selected ? { agentIds: selected } : {});

    expect(response.status).toBe(200);
    expect(mockGetInsights).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: selected ?? ['agent-a', 'agent-b'],
        showDetails: expectedDetail,
      }),
    );
    expect(Object.hasOwn(response.body, 'latest')).toBe(expectedDetail);
    if (!expectedDetail) {
      expect(Object.keys(response.body).sort()).toEqual(['agents', 'daily', 'summary']);
      expect(response.text).not.toContain(privateValue);
    }
    expect(response.body).not.toHaveProperty('detailAgentIds');
  });

  it.each(['ADMIN', 'global-reader'])(
    'retains separately authorized detail for %s when YAML allows it',
    async (role) => {
      mockUser.role = role;
      mockHasGlobalAccess.mockResolvedValue(role === 'global-reader');
      mockGetAppConfig.mockResolvedValue({
        interfaceConfig: { insights: { enabled: true, showDetails: true } },
      });
      const response = await request(createApp()).get('/api/insights');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(detailed);
      expect(mockFindAccessibleResources).not.toHaveBeenCalled();
    },
  );

  it('bounds ACL lookups to the authenticated tenant and rejects another agent', async () => {
    mockFindAccessibleResources.mockResolvedValue([records[1]._id]);
    const response = await request(createApp())
      .get('/api/insights')
      .query({ agentIds: ['agent-b'], tenantId: 'tenant-b' });
    expect(response.status).toBe(403);
    expect(mockGetAgents).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, '_id id name tenantId');
    expect(mockFindAccessibleResources).toHaveBeenCalledWith(
      expect.any(Array),
      'agent',
      PermissionBits.VIEW | PermissionBits.EDIT,
      [records[0]._id],
    );
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it.each(['/api/insights/access', '/api/insights'])(
    'does not broaden access after an ACL error on %s',
    async (path) => {
      mockFindAccessibleResources.mockRejectedValue(new Error(privateValue));
      const response = await request(createApp()).get(path);
      expect(response.status).toBe(500);
      expect(response.text).not.toContain(privateValue);
      expect(mockGetInsights).not.toHaveBeenCalled();
    },
  );
});
