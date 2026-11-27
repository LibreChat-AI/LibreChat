import jwt from 'jsonwebtoken';
import type { AgentTriggerFetch } from './host';
import {
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
} from './detachedAction';
import { createAgentTriggerEnvelope } from './envelope';
import { AGENT_TRIGGER_SCOPE } from '../../crypto/jwt';
import { createAgentTriggerService } from './service';
import { AgentTriggerExecutionError } from './host';

const envelope = () =>
  createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 20,
    principal: { id: 'user-1', role: 'member', tenantId: 'tenant-1' },
    target: { agentId: 'agent-1' },
    event: {
      id: 'event-1',
      type: 'resource.ready',
      occurredAt: 10,
      source: { id: 'source-1', type: 'webhook' },
    },
    input: 'Handle the ready resource.',
  });

const detachedCompletionEnvelope = () =>
  createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-detached-1',
    deliveryId: 'delivery-detached-1',
    receivedAt: 20,
    principal: { id: 'user-1', role: 'member', tenantId: 'tenant-1' },
    target: {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
      bindingId: 'binding-1',
      sourceKeyId: 'source-key-1',
    },
    event: {
      id: 'event_actor_task_1',
      type: EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
      occurredAt: 10,
      source: { id: EVENT_ACTOR_DETACHED_COMPLETION_SOURCE, type: 'internal' },
      payload: {
        version: 1,
        invocationId: 'trigger-original-1',
        generationCreatedAt: 1,
        wakeGenerationCreatedAt: 2,
        taskId: 'event_actor_task_1',
        idempotencyKey: 'a'.repeat(64),
      },
    },
    input: 'Resume the actor.',
    expectedAction: { toolName: 'submit_move' },
  });

const accepted = () =>
  new Response(
    JSON.stringify({
      status: 'started',
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 25,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('createAgentTriggerService', () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalSelfUrl = process.env.AGENT_TRIGGERS_SELF_URL;

  beforeEach(() => {
    process.env.JWT_SECRET = 'trigger-test-secret';
    delete process.env.AGENT_TRIGGERS_SELF_URL;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
    if (originalSelfUrl == null) {
      delete process.env.AGENT_TRIGGERS_SELF_URL;
    } else {
      process.env.AGENT_TRIGGERS_SELF_URL = originalSelfUrl;
    }
  });

  it('targets the bound listener and mints a scoped user token', async () => {
    const fetcher = jest.fn<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>(
      async () => accepted(),
    );
    const service = createAgentTriggerService({ fetch: fetcher });
    await service.initialize({ address: { address: '::', family: 'IPv6', port: 4123 } });

    await expect(service.dispatch(envelope())).resolves.toMatchObject({
      mode: 'fire',
      status: 'started',
      conversationId: 'conversation-1',
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('http://[::1]:4123/api/agents/chat/agents');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-lc-agent-trigger')).toBe('1');
    const authorization = headers.get('authorization');
    expect(authorization).toMatch(/^Bearer /);
    expect(
      jwt.verify(authorization!.slice('Bearer '.length), process.env.JWT_SECRET!, {
        algorithms: ['HS256'],
      }),
    ).toMatchObject({ id: 'user-1', scope: AGENT_TRIGGER_SCOPE });
  });

  it('honors an operator self-URL override before listener initialization', async () => {
    process.env.AGENT_TRIGGERS_SELF_URL = 'https://triggers.internal/base';
    const fetcher = jest.fn<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>(
      async () => accepted(),
    );
    const service = createAgentTriggerService({ fetch: fetcher, mintToken: () => 'token' });

    await service.dispatch(envelope());

    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://triggers.internal/base/api/agents/chat/agents',
    );
  });

  it('keeps detached completions on the capable local replica despite a self-URL override', async () => {
    process.env.AGENT_TRIGGERS_SELF_URL = 'https://triggers.internal/base';
    const fetcher = jest.fn<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>(
      async () => accepted(),
    );
    const service = createAgentTriggerService({ fetch: fetcher, mintToken: () => 'token' });
    await service.initialize({ address: { address: '0.0.0.0', family: 'IPv4', port: 4123 } });

    await service.dispatch(detachedCompletionEnvelope());

    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:4123/api/agents/chat/agents');
  });

  it('rechecks the durable principal before dispatching queued or direct work', async () => {
    process.env.AGENT_TRIGGERS_SELF_URL = 'https://triggers.internal';
    const fetcher = jest.fn(async () => accepted());
    const service = createAgentTriggerService({
      fetch: fetcher,
      mintToken: () => 'token',
      isPrincipalActive: async () => false,
    });

    await expect(service.dispatch(envelope())).rejects.toThrow(
      'Agent trigger delivery principal is no longer active',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails safely when dispatch starts before a listener or override exists', async () => {
    expect.hasAssertions();
    const service = createAgentTriggerService({
      fetch: jest.fn(async () => accepted()),
      mintToken: () => 'token',
    });

    await service.dispatch(envelope()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AgentTriggerExecutionError);
      expect(error).toMatchObject({
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'SETUP_FAILED',
      });
    });
  });
});
