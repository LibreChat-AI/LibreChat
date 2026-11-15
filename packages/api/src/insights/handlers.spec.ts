import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import type { TInsightsAgent, TInsightsResponse } from 'librechat-data-provider';
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

const insightsEnabled = jest.fn(() => ({
  enabled: true,
  showDetails: true,
  adminAllowAllAgents: true,
}));
const insightsDisabled = jest.fn(() => ({
  enabled: false,
  showDetails: false,
  adminAllowAllAgents: true,
}));
const fullAccess = { agents, detailAgentIds: agents.map((agent) => agent.id) };
const getInsightsAccess = jest.fn().mockResolvedValue(fullAccess);

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

const createRequest = (query: ServerRequest['query'] = {}): ServerRequest =>
  ({
    query,
    user: { id: 'user-id', role: 'USER', tenantId: 'tenant-a' },
  }) as ServerRequest;

const createDashboardHandler = (getInsights = jest.fn().mockResolvedValue(emptyInsights)) => ({
  getInsights,
  handler: createInsightsHandler({
    resolveInsightsConfig: insightsEnabled,
    getInsightsAccess,
    getInsights,
  }),
});

describe('Insights handlers', () => {
  it('returns only agent choices without running statistics when an admin must choose agents', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: true,
      adminAllowAllAgents: false,
    });
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest();
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    const { response, json } = createResponse();
    await handler(req, response);
    expect(getInsights).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ agents, selectionRequired: true, allAgentsAllowed: false }),
    );
  });

  it('loads an individually selected agent when the admin all-agents view is disabled', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: false,
    });
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({ agentIds: ['agent-a'] });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    const { response, json } = createResponse();
    await handler(req, response);
    expect(getInsights).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['agent-a'] }));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ allAgentsAllowed: false }));
  });

  it.each([
    ['agent-a', 'agent-b'],
    ['agent-b', 'agent-a', 'agent-a'],
  ])('rejects an admin all-agents request before querying statistics: %j', async (...agentIds) => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: false,
    });
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({ agentIds });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    const { response, status } = createResponse();
    await handler(req, response);
    expect(status).toHaveBeenCalledWith(403);
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('allows subsets without restricting admins to a single agent', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: false,
    });
    getInsightsAccess.mockResolvedValueOnce({
      agents: [...agents, { id: 'agent-c', name: 'Gamma' }],
      detailAgentIds: [],
    });
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({ agentIds: ['agent-a', 'agent-b'] });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    await handler(req, createResponse().response);
    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-a', 'agent-b'] }),
    );
  });

  it('allows the only available agent even when the admin all-agents view is disabled', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: false,
    });
    getInsightsAccess.mockResolvedValueOnce({ agents: [agents[0]], detailAgentIds: [] });
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({ agentIds: ['agent-a'] });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    await handler(req, createResponse().response);
    expect(getInsights).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['agent-a'] }));
  });

  it('allows the admin all-agents view when configured', async () => {
    const { handler, getInsights } = createDashboardHandler();
    const req = createRequest({ agentIds: ['agent-a', 'agent-b'] });
    req.user = { ...req.user, role: 'ADMIN' } as NonNullable<ServerRequest['user']>;
    await handler(req, createResponse().response);
    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-a', 'agent-b'] }),
    );
  });

  it('retains the all-agents view for non-admin viewers when disabled for admins', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: false,
    });
    const { handler, getInsights } = createDashboardHandler();
    await handler(createRequest(), createResponse().response);
    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-a', 'agent-b'] }),
    );
  });
  beforeEach(() => {
    jest.clearAllMocks();
    getInsightsAccess.mockResolvedValue(fullAccess);
  });

  it('returns access when at least one agent is accessible', async () => {
    const handler = createInsightsAccessHandler({
      resolveInsightsConfig: insightsEnabled,
      getInsightsAccess,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json).toHaveBeenCalledWith({ access: true });
  });

  it('returns 403 from the access endpoint when no agent is accessible', async () => {
    getInsightsAccess.mockResolvedValueOnce({ agents: [], detailAgentIds: [] });
    const handler = createInsightsAccessHandler({
      resolveInsightsConfig: insightsEnabled,
      getInsightsAccess,
    });
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(403);
  });

  it('returns 404 from the access endpoint when Insights is disabled', async () => {
    const handler = createInsightsAccessHandler({
      resolveInsightsConfig: insightsDisabled,
      getInsightsAccess,
    });
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ message: 'Not found' });
    expect(getInsightsAccess).not.toHaveBeenCalled();
  });

  it('returns 404 without resolving access when Insights is disabled', async () => {
    const getInsights = jest.fn();
    const handler = createInsightsHandler({
      resolveInsightsConfig: insightsDisabled,
      getInsightsAccess,
      getInsights,
    });
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getInsightsAccess).not.toHaveBeenCalled();
    expect(getInsights).not.toHaveBeenCalled();
  });

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

  it.each(['USER', 'ADMIN'])(
    'returns only whitelisted aggregate fields for %s when detail is disabled',
    async (role) => {
      insightsEnabled.mockReturnValueOnce({
        enabled: true,
        showDetails: false,
        adminAllowAllAgents: true,
      });
      const privateValue = 'private-content-must-not-cross-api';
      const feedback = {
        thumbsUp: 1,
        thumbsDown: 1,
        categories: FEEDBACK_REASON_KEYS.map((key) => ({
          key,
          count: key === 'inaccurate' || key === 'accurate_reliable' ? 1 : 0,
        })),
      };
      const unsafeFeedback = {
        ...feedback,
        text: privateValue,
        userId: privateValue,
        categories: [
          ...feedback.categories.map((category) => ({
            ...category,
            label: privateValue,
            text: privateValue,
          })),
          { key: privateValue, count: 1 },
        ],
      };
      const summary = {
        totalUsers: 1,
        totalConversations: 1,
        totalMessages: 4,
        totalTokens: 5,
        totalResponses: 3,
        completedResponses: 1,
        failedResponses: 1,
        interruptedResponses: 1,
        lastUsed: '2026-10-01T12:00:00.000Z',
        spendUSD: 1.25,
        feedback,
      };
      const getInsights = jest.fn().mockResolvedValue({
        ...emptyInsights,
        agents: [{ id: 'agent-a', name: 'Alpha', email: privateValue }],
        summary: {
          ...summary,
          userId: privateValue,
          feedback: unsafeFeedback,
          transactions: [{ user: privateValue }],
        },
        daily: [
          {
            date: '2026-10-01',
            conversations: 1,
            users: 1,
            messages: 4,
            totalTokens: 5,
            responses: 3,
            completedResponses: 1,
            failedResponses: 1,
            interruptedResponses: 1,
            text: privateValue,
            feedback: unsafeFeedback,
            spendUSD: 1.25,
            transactions: [{ conversationId: privateValue, messageId: privateValue }],
          },
        ],
        models: [
          {
            model: 'model-x',
            responses: 3,
            completedResponses: 1,
            failedResponses: 1,
            interruptedResponses: 1,
            thumbsUp: 1,
            thumbsDown: 0,
            usageTokens: 7,
            spendUSD: 1.25,
            userId: privateValue,
            messageIds: [privateValue],
          },
        ],
        topUsers: [{ name: privateValue }],
        agentVersions: [
          {
            agentId: 'agent-a',
            version: 2,
            savedAt: '2026-10-01T12:00:00.000Z',
            instructions: privateValue,
            updatedBy: privateValue,
          },
        ],
        churnedUsers: [{ email: privateValue }],
        latest: { conversations: [{ firstMessage: privateValue, conversationId: privateValue }] },
        feedbackText: privateValue,
      });
      const { handler } = createDashboardHandler(getInsights);
      const req = createRequest({
        search: privateValue,
        page: '20',
        pageSize: '50',
        showDetails: 'true',
      });
      req.user = { ...req.user, role } as NonNullable<ServerRequest['user']>;
      const { response, json } = createResponse();
      await handler(req, response);
      expect(getInsights).toHaveBeenCalledWith(
        expect.objectContaining({
          showDetails: false,
          search: undefined,
          page: 1,
          pageSize: 10,
        }),
      );
      expect(json).toHaveBeenCalledWith({
        agents: [{ id: 'agent-a', name: 'Alpha' }],
        agentVersions: [{ agentId: 'agent-a', version: 2, savedAt: '2026-10-01T12:00:00.000Z' }],
        summary,
        daily: [
          {
            date: '2026-10-01',
            conversations: 1,
            users: 1,
            messages: 4,
            totalTokens: 5,
            responses: 3,
            completedResponses: 1,
            failedResponses: 1,
            interruptedResponses: 1,
            feedback,
            spendUSD: 1.25,
          },
        ],
        models: [
          {
            model: 'model-x',
            responses: 3,
            completedResponses: 1,
            failedResponses: 1,
            interruptedResponses: 1,
            thumbsUp: 1,
            thumbsDown: 0,
            usageTokens: 7,
            spendUSD: 1.25,
          },
        ],
      });
      expect(JSON.stringify(json.mock.calls)).not.toContain(privateValue);
    },
  );

  it('does not let request parameters enable a disabled feature', async () => {
    insightsEnabled.mockReturnValueOnce({
      enabled: false,
      showDetails: false,
      adminAllowAllAgents: true,
    });
    const { handler, getInsights } = createDashboardHandler();
    const { response, status } = createResponse();
    await handler(createRequest({ enabled: 'true', showDetails: 'true' }), response);
    expect(status).toHaveBeenCalledWith(404);
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('returns access to aggregate-only agents without disclosing inspection eligibility', async () => {
    getInsightsAccess.mockResolvedValueOnce({ agents, detailAgentIds: [] });
    const handler = createInsightsAccessHandler({
      resolveInsightsConfig: insightsEnabled,
      getInsightsAccess,
    });
    const { response, json } = createResponse();
    await handler(createRequest(), response);
    expect(json).toHaveBeenCalledWith({ access: true });
  });

  it.each([
    [['agent-a'], true],
    [['agent-b'], false],
    [['agent-a', 'agent-b'], false],
    [undefined, false],
  ] as const)('limits detail to eligible selected agents %p', async (selected, expectedDetail) => {
    getInsightsAccess.mockResolvedValueOnce({ agents, detailAgentIds: ['agent-a'] });
    const { handler, getInsights } = createDashboardHandler();
    const { response, json } = createResponse();
    await handler(
      createRequest({
        ...(selected ? { agentIds: [...selected] } : {}),
        search: 'private identity',
        page: '20',
        pageSize: '50',
        showDetails: 'true',
      }),
      response,
    );

    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({
        showDetails: expectedDetail,
        agentIds: selected ? [...selected] : ['agent-a', 'agent-b'],
        search: expectedDetail ? 'private identity' : undefined,
        page: expectedDetail ? 20 : 1,
        pageSize: expectedDetail ? 50 : 10,
      }),
    );
    expect(json).toHaveBeenCalledWith(
      expectedDetail
        ? emptyInsights
        : {
            agents,
            summary: emptyInsights.summary,
            daily: emptyInsights.daily,
            models: emptyInsights.models,
          },
    );
    expect(getInsightsAccess).toHaveBeenCalledTimes(1);
  });

  it('rejects a dashboard request without statistics eligibility before querying data', async () => {
    getInsightsAccess.mockResolvedValueOnce({ agents: [], detailAgentIds: [] });
    const { handler, getInsights } = createDashboardHandler();
    const { response, status } = createResponse();
    await handler(createRequest(), response);
    expect(status).toHaveBeenCalledWith(403);
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('does not query statistics when access resolution fails', async () => {
    getInsightsAccess.mockRejectedValueOnce(new Error('private ACL error'));
    const { handler, getInsights } = createDashboardHandler();
    const { response, status, json } = createResponse();
    await handler(createRequest(), response);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ message: 'Failed to load insights' });
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('returns a generic error without disclosing private query failures', async () => {
    const { handler } = createDashboardHandler(
      jest.fn().mockRejectedValue(new Error('private prompt')),
    );
    const { response, status, json } = createResponse();
    await handler(createRequest(), response);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ message: 'Failed to load insights' });
    expect(JSON.stringify(json.mock.calls)).not.toContain('private prompt');
  });
});
