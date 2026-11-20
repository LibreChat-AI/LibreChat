const express = require('express');
const request = require('supertest');

const mockCreateInsightsAccessHandler = jest.fn(() => (_req, res) => res.json({ access: true }));
const mockCreateInsightsHandler = jest.fn(() => (_req, res) => res.json({ summary: {} }));
const mockGetInsightsAccess = jest.fn();
const mockGetInsights = jest.fn();
let mockResolverCreateCount = 0;
let mockAccessHandlerDeps;
let mockDashboardHandlerDeps;
let mockUser = { id: 'user-id', role: 'USER' };
const mockStrictConfig = jest.fn((req, _res, next) => {
  req.config = { interfaceConfig: { insights: { enabled: true, showDetails: false } } };
  next();
});

jest.mock('@librechat/api', () => ({
  createInsightsAccessHandler: (...args) => {
    [mockAccessHandlerDeps] = args;
    return mockCreateInsightsAccessHandler(...args);
  },
  createInsightsAccessResolver: () => {
    mockResolverCreateCount += 1;
    return mockGetInsightsAccess;
  },
  createInsightsHandler: (...args) => {
    [mockDashboardHandlerDeps] = args;
    return mockCreateInsightsHandler(...args);
  },
  createInsightsConfigResolver: () => (req) => req.config.interfaceConfig.insights,
  isEnabled: (value) => value === 'true',
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!mockUser) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.user = mockUser;
    next();
  },
  strictConfigMiddleware: (...args) => mockStrictConfig(...args),
}));

jest.mock('~/models', () => ({
  findAccessibleResources: jest.fn(),
  getAgents: jest.fn(),
  getInsights: (...args) => mockGetInsights(...args),
  getUserPrincipals: jest.fn(),
  hasCapabilityForPrincipals: jest.fn(),
}));

const insightsRouter = require('../insights');

function createApp() {
  const app = express();
  app.use('/api/insights', insightsRouter);
  return app;
}

describe('Insights routes', () => {
  beforeEach(() => {
    mockUser = { id: 'user-id', role: 'USER' };
    mockStrictConfig.mockClear();
  });

  it('serves the access probe and dashboard for authenticated users', async () => {
    const app = createApp();

    await expect(request(app).get('/api/insights/access')).resolves.toMatchObject({
      status: 200,
      body: { access: true },
    });
    await expect(request(app).get('/api/insights')).resolves.toMatchObject({
      status: 200,
      body: { summary: {} },
    });
  });

  it.each(['/api/insights/access', '/api/insights'])(
    'authenticates before loading the scoped configuration on %s',
    async (path) => {
      const app = createApp();

      mockUser = undefined;
      await expect(request(app).get(path)).resolves.toMatchObject({ status: 401 });
      expect(mockStrictConfig).not.toHaveBeenCalled();

      mockUser = { id: 'user-id', role: 'USER' };
      await expect(request(app).get(path)).resolves.toMatchObject({ status: 200 });
      expect(mockStrictConfig).toHaveBeenCalledTimes(1);
    },
  );

  it('uses one shared agent access resolver for both handlers', () => {
    expect(mockResolverCreateCount).toBe(1);
    expect(mockAccessHandlerDeps).toEqual(
      expect.objectContaining({ getInsightsAccess: mockGetInsightsAccess }),
    );
    expect(mockDashboardHandlerDeps).toEqual(
      expect.objectContaining({ getInsightsAccess: mockGetInsightsAccess }),
    );
  });
});
