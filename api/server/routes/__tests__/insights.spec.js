const express = require('express');
const request = require('supertest');

const mockCreateInsightsAccessHandler = jest.fn(() => (_req, res) => res.json({ access: true }));
const mockCreateInsightsHandler = jest.fn(() => (_req, res) => res.json({ summary: {} }));
const mockGetAccessibleAgents = jest.fn();
const mockGetInsights = jest.fn();
let mockResolverCreateCount = 0;
let mockAccessHandlerDeps;
let mockDashboardHandlerDeps;
let mockUser = { id: 'user-id', role: 'USER' };

jest.mock('@librechat/api', () => ({
  createInsightsAccessHandler: (...args) => {
    [mockAccessHandlerDeps] = args;
    return mockCreateInsightsAccessHandler(...args);
  },
  createInsightsAgentAccessResolver: () => {
    mockResolverCreateCount += 1;
    return mockGetAccessibleAgents;
  },
  createInsightsHandler: (...args) => {
    [mockDashboardHandlerDeps] = args;
    return mockCreateInsightsHandler(...args);
  },
  isEnabled: (value) => value === 'true',
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = mockUser;
    next();
  },
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

  it('uses one shared agent access resolver for both handlers', () => {
    expect(mockResolverCreateCount).toBe(1);
    expect(mockAccessHandlerDeps).toEqual(
      expect.objectContaining({ getAccessibleAgents: mockGetAccessibleAgents }),
    );
    expect(mockDashboardHandlerDeps).toEqual(
      expect.objectContaining({ getAccessibleAgents: mockGetAccessibleAgents }),
    );
  });
});
