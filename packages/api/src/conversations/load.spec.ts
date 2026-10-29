import express from 'express';
import request from 'supertest';
import { tenantStorage } from '@librechat/data-schemas';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { GenerationJobMetadata } from '~/types/stream';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createGetConversationHandler } from './load';

const conversationId = '3e2ab396-29ef-48dc-a505-8a4d4d819372';
const owner = { id: 'owner', tenantId: 'tenant-a' };
const managers: GenerationJobManagerClass[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.destroy()));
  jest.restoreAllMocks();
});

async function setup(
  options: {
    stored?: Pick<TConversation, 'conversationId' | 'subagentThread'>;
    user?: typeof owner | null;
    metadata?: Partial<GenerationJobMetadata>;
    expiresAt?: number;
    prompt?: boolean;
  } = {},
) {
  const jobs = new GenerationJobManagerClass();
  const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  jobs.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
  managers.push(jobs);
  const job = await tenantStorage.run({ tenantId: owner.tenantId, userId: owner.id }, () =>
    jobs.createJob(conversationId, owner.id, conversationId, {
      initialMetadata: {
        tenantId: owner.tenantId,
        conversationId,
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-clock',
        model: 'test-model',
        userMessage: {
          messageId: 'input-message',
          parentMessageId: String(Constants.NO_PARENT),
          conversationId,
          text: 'Use the protected clock',
        },
        ...options.metadata,
      },
    }),
  );
  if (options.prompt !== false) {
    await jobs.emitChunk(conversationId, {
      event: 'on_run_step',
      data: {
        id: 'oauth-step',
        runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'oauth-call', name: 'oauth_mcp_clock', args: '' }],
        },
      },
    });
    await jobs.emitChunk(conversationId, {
      event: 'on_run_step_delta',
      data: {
        id: 'oauth-step',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ name: 'oauth_mcp_clock', args: '' }],
          auth: 'https://fixture.example/authorize',
          expires_at: options.expiresAt ?? Date.now() + 60_000,
        },
      },
    });
  }
  const getConvo = jest
    .fn<
      Promise<Pick<TConversation, 'conversationId' | 'subagentThread'> | null>,
      [string, string]
    >()
    .mockResolvedValue(options.stored ?? null);
  const logger = { error: jest.fn() };
  const handler = createGetConversationHandler({ getConvo, jobs, logger });
  const app = express();
  app.get('/:conversationId', async (req, res) => {
    await handler(
      {
        params: req.params,
        user: options.user === null ? undefined : (options.user ?? owner),
      },
      res,
    );
  });
  return { app, jobs, job, store, getConvo, logger };
}

test('recovers a real first-turn OAuth job without writing draft history or exposing its prompt', async () => {
  const { app, jobs, job, getConvo } = await setup();
  const stateSpy = jest.spyOn(jobs, 'getResumeState');
  const result = await request(app).get(`/${conversationId}`).expect(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toEqual({
    conversationId,
    endpoint: 'agents',
    agent_id: 'agent-clock',
    model: 'test-model',
    title: 'New Chat',
    user: owner.id,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.createdAt).toISOString(),
  });
  expect(getConvo).toHaveBeenCalledWith(owner.id, conversationId);
  expect(stateSpy).toHaveBeenCalledWith(conversationId, job.createdAt);
  expect(JSON.stringify(result.body)).not.toMatch(/authorize|authURL|protected clock/);
});

test('returns established history unchanged without a generation lookup', async () => {
  const stored = { conversationId, title: 'Established history', endpoint: EModelEndpoint.agents };
  const { app, jobs } = await setup({ stored });
  const lookup = jest.spyOn(jobs, 'getJob');
  const result = await request(app).get(`/${conversationId}`).expect(200);
  expect(result.body).toEqual(stored);
  expect(lookup).not.toHaveBeenCalled();
});

test('does not recover hidden subagent history through the top-level route', async () => {
  const { app, jobs } = await setup({
    stored: {
      conversationId,
      subagentThread: {
        parentConversationId: 'parent',
        parentMessageId: 'message',
        rootConversationId: 'parent',
        parentToolCallId: 'call',
        subagentType: 'agent',
        subagentKind: 'agent',
        depth: 1,
      },
    },
  });
  const lookup = jest.spyOn(jobs, 'getJob');
  await request(app).get(`/${conversationId}`).expect(404);
  expect(lookup).not.toHaveBeenCalled();
});

test.each([
  ['another owner', { user: { id: 'other-owner', tenantId: owner.tenantId } }],
  ['same owner in another tenant', { user: { ...owner, tenantId: 'tenant-b' } }],
  ['temporary chat', { metadata: { isTemporary: true } }],
  ['another endpoint', { metadata: { endpoint: 'openAI' } }],
  ['missing agent', { metadata: { agent_id: undefined } }],
  [
    'mismatched message conversation',
    {
      metadata: {
        userMessage: {
          messageId: 'input-message',
          parentMessageId: String(Constants.NO_PARENT),
          conversationId: 'different',
          text: 'Use the protected clock',
        },
      },
    },
  ],
  ['expired prompt', { expiresAt: Date.now() - 60_000 }],
  ['missing prompt', { prompt: false }],
] satisfies Array<[string, Parameters<typeof setup>[0]]>)(
  'fails closed for %s',
  async (_name, options) => {
    const { app } = await setup(options);
    const result = await request(app).get(`/${conversationId}`);
    expect(result.status).toBe(404);
  },
);

test('does not recover completed or deleted jobs', async () => {
  const { app, jobs, job, store } = await setup();
  await jobs.completeJob(conversationId, undefined, job.createdAt);
  expect((await request(app).get(`/${conversationId}`)).status).toBe(404);
  await store.deleteJob(conversationId, job.createdAt);
  expect((await request(app).get(`/${conversationId}`)).status).toBe(404);
});

test('does not recover an aborted job', async () => {
  const { app, jobs, job } = await setup();
  await jobs.abortJob(conversationId, { expectedCreatedAt: job.createdAt });
  expect((await request(app).get(`/${conversationId}`)).status).toBe(404);
});

test('does not return a replacement generations state', async () => {
  const { app, jobs, job } = await setup();
  const originalRead = jobs.getResumeState.bind(jobs);
  jest.spyOn(jobs, 'getResumeState').mockImplementationOnce(async (...args) => {
    await jobs.completeJob(conversationId, undefined, job.createdAt);
    jest.spyOn(Date, 'now').mockReturnValue(job.createdAt + 100);
    const replacement = await tenantStorage.run(
      { tenantId: owner.tenantId, userId: owner.id },
      () => jobs.createJob(conversationId, owner.id, conversationId),
    );
    expect(replacement.createdAt).not.toBe(job.createdAt);
    return originalRead(...args);
  });
  expect((await request(app).get(`/${conversationId}`)).status).toBe(404);
});

test('does not query generation storage for a malformed missing conversation ID', async () => {
  const { app, jobs } = await setup();
  const lookup = jest.spyOn(jobs, 'getJob');
  await request(app).get('/not-a-uuid').expect(404);
  expect(lookup).not.toHaveBeenCalled();
});

test('does not turn a storage outage into a missing-conversation redirect or leak diagnostics', async () => {
  const { app, jobs } = await setup();
  jest.spyOn(jobs, 'getJob').mockRejectedValueOnce(new Error('secret-token provider payload'));
  const result = await request(app).get(`/${conversationId}`).expect(500);
  expect(result.body).toEqual({ error: 'conversation_load_failed' });
});

test('does not attempt recovery after a database lookup failure', async () => {
  const { app, jobs, getConvo } = await setup();
  getConvo.mockRejectedValueOnce(new Error('secret-token query payload'));
  const lookup = jest.spyOn(jobs, 'getJob');
  const result = await request(app).get(`/${conversationId}`).expect(500);
  expect(result.body).toEqual({ error: 'conversation_load_failed' });
  expect(lookup).not.toHaveBeenCalled();
});

test('requires authentication before any data lookup', async () => {
  const { app, getConvo } = await setup({ user: null });
  await request(app).get(`/${conversationId}`).expect(401);
  expect(getConvo).not.toHaveBeenCalled();
});
