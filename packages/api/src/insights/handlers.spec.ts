import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import type { TInsightsAgent, TInsightsConfig, TInsightsResponse } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createInsightsAccessHandler, createInsightsHandler } from './handlers';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const agents: TInsightsAgent[] = [
  { id: 'agent-a', name: 'Alpha' },
  { id: 'agent-b', name: 'Beta' },
];
const emptyInsights: TInsightsResponse = {
  agents,
  summary: {
    totalUsers: 0,
    totalConversations: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalResponses: 0,
    completedResponses: 0,
    failedResponses: 0,
    interruptedResponses: 0,
    lastUsed: null,
    spendUSD: null,
    feedback: {
      thumbsUp: 0,
      thumbsDown: 0,
      categories: FEEDBACK_REASON_KEYS.map((key) => ({ key, count: 0 })),
    },
  },
  daily: [],
  models: [],
  topUsers: [],
  churnedUsers: [],
  latest: { conversations: [], page: 1, pageSize: 10, pages: 1 },
};

const enabledConfig: TInsightsConfig = {
  enabled: true,
  showDetails: true,
  adminAutoSelectAllAgents: true,
};
const fullAccess = { agents, detailAgentIds: agents.map((agent) => agent.id) };
const resolveAccess = async (user: { role?: string }) => ({
  ...fullAccess,
  ...(user.role === 'ADMIN' && { tenantWide: true as const }),
});
const getInsightsAccess = jest.fn(resolveAccess);
const isLegacyInsightsEnabled = jest.fn(() => false);

const createResponse = () => {
  const status = jest.fn();
  const json = jest.fn();
  status.mockReturnValue({ json });
  return {
    response: { status, json } as Partial<Response> as Response,
    status,
    json,
  };
};

const createRequest = (
  query: ServerRequest['query'] = {},
  insights: TInsightsConfig = enabledConfig,
): ServerRequest =>
  ({
    query,
    config: { interfaceConfig: { insights } },
    user: { id: 'user-id', role: 'USER', tenantId: 'tenant-a' },
  }) as ServerRequest;

const createDashboardHandler = (getInsights = jest.fn().mockResolvedValue(emptyInsights)) => ({
  getInsights,
  handler: createInsightsHandler({ getInsightsAccess, getInsights, isLegacyInsightsEnabled }),
});

describe('Insights handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isLegacyInsightsEnabled.mockReturnValue(false);
    getInsightsAccess.mockImplementation(resolveAccess);
  });

  it('returns only agent choices without running statistics when an admin must choose agents', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({}, { ...enabledConfig, adminAutoSelectAllAgents: false });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    const { response, json } = createResponse();
    await handler(req, response);
    expect(getInsights).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ selectionRequired: true, agents });
  });

  it('returns access when at least one agent is accessible', async () => {
    const handler = createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json).toHaveBeenCalledWith({ access: true });
  });

  it('returns 403 from the access endpoint when no agent is accessible', async () => {
    getInsightsAccess.mockResolvedValueOnce({ agents: [], detailAgentIds: [] });
    const handler = createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled });
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(403);
  });

  it('returns 404 from the access endpoint when Insights is disabled', async () => {
    const handler = createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled });
    const { response, status, json } = createResponse();

    await handler(createRequest({}, { enabled: false }), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ message: 'Not found' });
    expect(getInsightsAccess).not.toHaveBeenCalled();
  });

  it('returns 404 without resolving access when Insights is disabled', async () => {
    const getInsights = jest.fn();
    const handler = createInsightsHandler({
      getInsightsAccess,
      getInsights,
      isLegacyInsightsEnabled,
    });
    const { response, status } = createResponse();

    await handler(createRequest({}, { enabled: false }), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getInsightsAccess).not.toHaveBeenCalled();
    expect(getInsights).not.toHaveBeenCalled();
  });

  it.each([
    [true, {}, true],
    [true, { enabled: false }, false],
    [false, { enabled: true }, true],
    [false, {}, false],
  ])(
    'applies YAML precedence to both endpoints (legacy=%s, config=%p)',
    async (legacy, config, enabled) => {
      isLegacyInsightsEnabled.mockReturnValue(legacy);
      const access = createResponse();
      const dashboard = createResponse();
      await createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled })(
        createRequest({}, config),
        access.response,
      );
      await createDashboardHandler().handler(createRequest({}, config), dashboard.response);
      if (enabled) {
        expect(access.json).toHaveBeenCalledWith({ access: true });
        expect(dashboard.json).toHaveBeenCalledWith(emptyInsights);
      } else {
        expect(access.status).toHaveBeenCalledWith(404);
        expect(dashboard.status).toHaveBeenCalledWith(404);
      }
    },
  );

  it('loads all accessible agents for the authenticated tenant', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response, json } = createResponse();

    await handler(
      createRequest({ page: '3', pageSize: '500', tenantId: 'forged-tenant', range: '30d' }),
      response,
    );

    expect(getInsights).toHaveBeenCalledWith({
      showDetails: true,
      page: 3,
      pageSize: 50,
      tenantId: 'tenant-a',
      agents,
      agentIds: ['agent-a', 'agent-b'],
      search: undefined,
      range: '30d',
      fromTimestamp: undefined,
      toTimestamp: undefined,
      timeZone: undefined,
    });
    expect(json).toHaveBeenCalledWith(emptyInsights);
  });

  it('sorts and deduplicates an authorized agent subset', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response } = createResponse();

    await handler(createRequest({ agentIds: ['agent-b', 'agent-a', 'agent-b'] }), response);

    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-a', 'agent-b'] }),
    );
  });

  it('returns 403 before loading data for an unauthorized agent', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response, status } = createResponse();

    await handler(createRequest({ agentIds: ['agent-c'] }), response);

    expect(status).toHaveBeenCalledWith(403);
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('passes custom dates and a valid timezone to the data layer', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response } = createResponse();

    await handler(
      createRequest({
        range: 'custom',
        fromTimestamp: '2026-06-01T00:00:00.000Z',
        toTimestamp: '2026-06-10T00:00:00.000Z',
        timeZone: 'America/Los_Angeles',
      }),
      response,
    );

    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({
        range: 'custom',
        fromTimestamp: '2026-06-01T00:00:00.000Z',
        toTimestamp: '2026-06-10T00:00:00.000Z',
        timeZone: 'America/Los_Angeles',
      }),
    );
  });

  it('uses pagination defaults and discards an invalid timezone', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response } = createResponse();

    await handler(
      createRequest({ page: '-1', pageSize: 'invalid', timeZone: 'Not/A-Timezone' }),
      response,
    );

    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10, timeZone: undefined }),
    );
  });

  it('normalizes and bounds search input', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response } = createResponse();

    await handler(createRequest({ search: `  ${'message'.repeat(40)}  ` }), response);

    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'message'.repeat(40).slice(0, 200) }),
    );
  });

  it('does not run searches shorter than the minimum length', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const { response } = createResponse();

    await handler(createRequest({ search: 'ab' }), response);

    expect(getInsights).toHaveBeenCalledWith(expect.objectContaining({ search: undefined }));
  });

  it.each([
    ['only an agent with detail rights', ['agent-a'], true],
    ['that agent plus one without detail rights', ['agent-a', 'agent-b'], false],
    ['all agents (no selection)', undefined, false],
  ] as const)(
    'shows details only when every selected agent allows them: %s',
    async (_name, selected, expectedDetail) => {
      getInsightsAccess.mockResolvedValueOnce({ agents, detailAgentIds: ['agent-a'] });
      const { handler, getInsights } = createDashboardHandler();
      const { response } = createResponse();
      await handler(createRequest(selected ? { agentIds: [...selected] } : {}), response);

      expect(getInsights).toHaveBeenCalledWith(
        expect.objectContaining({
          showDetails: expectedDetail,
          agentIds: selected ? [...selected] : ['agent-a', 'agent-b'],
        }),
      );
      expect(getInsightsAccess).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'access check',
      createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled }),
      'Failed to load insights access',
    ],
    [
      'dashboard',
      createInsightsHandler({ getInsightsAccess, getInsights: jest.fn(), isLegacyInsightsEnabled }),
      'Failed to load insights',
    ],
  ] as const)(
    'answers a failed %s with a generic message only',
    async (_name, handler, message) => {
      getInsightsAccess.mockRejectedValueOnce(new Error('private detail'));
      const { response, status, json } = createResponse();
      await handler(createRequest(), response);
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ message });
    },
  );
});
