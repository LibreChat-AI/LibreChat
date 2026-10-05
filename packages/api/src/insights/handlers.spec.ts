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
  },
  daily: [],
  topUsers: [],
  churnedUsers: [],
  latest: { conversations: [], page: 1, pageSize: 10, pages: 1 },
};

const insightsEnabled = jest.fn(() => true);
const insightsDisabled = jest.fn(() => false);
const getAccess = jest.fn().mockResolvedValue({ agents, media: false });

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
    isInsightsEnabled: insightsEnabled,
    getAccess,
    getInsights,
  }),
});

describe('Insights handlers', () => {
  it('accepts tenant Insights readers without agents and scopes media to the authenticated tenant', async () => {
    const getInsights = jest.fn().mockResolvedValue(emptyInsights);
    const handler = createInsightsHandler({
      isInsightsEnabled: insightsEnabled,
      getAccess: async () => ({ agents: [], media: true }),
      getInsights,
    });
    const { response, json } = createResponse();
    await handler(createRequest({ tenantId: 'tenant-b', includeMedia: 'false' }), response);
    expect(getInsights).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', agentIds: [], includeMedia: true }),
    );
    expect(json).toHaveBeenCalledWith(emptyInsights);
  });

  it('does not accept client-authored media access for an agent-specific reader', async () => {
    const { handler, getInsights } = createDashboardHandler();
    await handler(createRequest({ includeMedia: 'true' }), createResponse().response);
    expect(getInsights.mock.calls[0][0]).not.toHaveProperty('includeMedia');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    getAccess.mockResolvedValue({ agents, media: false });
  });

  it('returns access when at least one agent is accessible', async () => {
    const handler = createInsightsAccessHandler({
      isInsightsEnabled: insightsEnabled,
      getAccess,
    });
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json).toHaveBeenCalledWith({ access: true });
  });

  it('returns 403 from the access endpoint when no agent is accessible', async () => {
    getAccess.mockResolvedValueOnce({ agents: [], media: false });
    const handler = createInsightsAccessHandler({
      isInsightsEnabled: insightsEnabled,
      getAccess,
    });
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(403);
  });

  it('returns 404 from the access endpoint when Insights is disabled', async () => {
    const handler = createInsightsAccessHandler({
      isInsightsEnabled: insightsDisabled,
      getAccess,
    });
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ message: 'Not found' });
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('returns 404 without resolving access when Insights is disabled', async () => {
    const getInsights = jest.fn();
    const handler = createInsightsHandler({
      isInsightsEnabled: insightsDisabled,
      getAccess,
      getInsights,
    });
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(getAccess).not.toHaveBeenCalled();
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
});
