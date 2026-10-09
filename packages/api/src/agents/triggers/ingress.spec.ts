import express from 'express';
import request from 'supertest';
import type { Application } from 'express';
import type { AgentTriggerIngressDependencies } from './ingress';
import type { AgentTriggerStoredRecord } from './service';
import { AgentTriggerServiceUnavailableError } from './service';
import { createAgentTriggerIngressHandlers } from './ingress';

const USER_ID = '507f1f77bcf86cd799439011';
const API_KEY_ID = '68a1c312abc123abc123abcf';
const DELIVERY_KEY = `trigger_${'a'.repeat(64)}`;
const AVAILABLE_AT = new Date('2026-08-17T12:00:00.000Z');
const CREATED_AT = new Date('2026-08-17T11:59:59.000Z');

function delivery(overrides: Partial<AgentTriggerStoredRecord> = {}): AgentTriggerStoredRecord {
  return {
    id: '68a1c312abc123abc123abc1',
    user: USER_ID,
    deliveryKey: DELIVERY_KEY,
    fingerprint: 'fingerprint',
    orderingKey: 'ordering-key',
    laneSequence: 1,
    envelope: { secret: 'not-public' },
    status: 'pending',
    attempts: 0,
    availableAt: AVAILABLE_AT,
    createdAt: CREATED_AT,
    history: [
      {
        attempt: 1,
        outcome: 'retry',
        at: CREATED_AT,
        workerId: 'private-worker-id',
      },
    ],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<AgentTriggerIngressDependencies> = {},
): AgentTriggerIngressDependencies {
  return {
    enqueue: jest.fn(async () => ({
      id: '68a1c312abc123abc123abc1',
      deliveryKey: DELIVERY_KEY,
      status: 'pending' as const,
      availableAt: AVAILABLE_AT,
      replayed: false,
    })),
    getDeliveryStatus: jest.fn(async () => delivery()),
    now: () => 1_755_430_000_000,
    createRequestId: () => 'generated-request-id',
    ...overrides,
  };
}

function createApp(
  deps: AgentTriggerIngressDependencies,
  user: { id: string; role?: string; tenantId?: string } | null = {
    id: USER_ID,
    role: 'USER',
    tenantId: 'tenant-1',
  },
  bindingResolved = false,
): Application {
  const app = express();
  const handlers = createAgentTriggerIngressHandlers(deps);
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      user: user ?? undefined,
      apiKeyId: API_KEY_ID,
      requestId: 'request-from-context',
      _agentEventBindingResolved: bindingResolved,
    });
    next();
  });
  app.post('/api/agents/v1/events', handlers.enqueueEvent);
  app.get('/api/agents/v1/events/:id', handlers.getEvent);
  return app;
}

function fireEvent() {
  return {
    mode: 'fire',
    event: {
      id: 'event-1',
      type: 'resource.ready',
      occurredAt: 1_755_429_900_000,
      source: { id: 'webhook-1', type: 'webhook' },
      payload: { resourceId: 'resource-1' },
    },
    target: { agentId: 'agent-1' },
    input: 'Handle resource-1.',
    orderingKey: 'resource-1',
    principal: { id: 'attacker-controlled' },
  };
}

describe('agent trigger event ingress', () => {
  it('builds a trusted envelope and returns an opaque delivery status URL', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'source-delivery-1')
      .send(fireEvent());

    expect(response.status).toBe(202);
    expect(response.headers.location).toBe(`/api/agents/v1/events/${DELIVERY_KEY}`);
    expect(response.body).toEqual({
      id: DELIVERY_KEY,
      status: 'pending',
      availableAt: AVAILABLE_AT.toISOString(),
      replayed: false,
    });
    expect(deps.enqueue).toHaveBeenCalledWith(
      {
        version: 1,
        mode: 'fire',
        requestId: 'request-from-context',
        deliveryId: 'source-delivery-1',
        receivedAt: 1_755_430_000_000,
        principal: { userId: USER_ID, role: 'USER', tenantId: 'tenant-1' },
        event: {
          ...fireEvent().event,
          source: { id: API_KEY_ID, type: 'remote_api_key' },
        },
        target: { agentId: 'agent-1' },
        input: 'Handle resource-1.',
      },
      { orderingKey: 'resource-1' },
    );
  });

  it('admits fenced steer events through the same source-neutral contract', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'steer-delivery-1')
      .send({
        mode: 'steer',
        event: {
          id: 'clock-expired-1',
          type: 'clock.expired',
          occurredAt: 1_755_429_950_000,
          source: { id: 'match-1', type: 'tournament-controller' },
        },
        target: {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          generationCreatedAt: 1_755_429_940_000,
          preempt: true,
        },
        input: 'Your clock expired. Submit immediately.',
      });

    expect(response.status).toBe(202);
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'steer',
        deliveryId: 'steer-delivery-1',
        target: {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          generationCreatedAt: 1_755_429_940_000,
          preempt: true,
        },
      }),
      {},
    );
  });

  it('admits continue only after a source binding resolved its trusted target', async () => {
    const event = {
      mode: 'continue',
      event: fireEvent().event,
      target: {
        agentId: 'agent-player',
        conversationId: 'child-thread',
        parentMessageId: 'placeholder',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
      input: 'Make the next move.',
    };
    const rejected = dependencies();
    const accepted = dependencies();

    const directResponse = await request(createApp(rejected))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'continue-direct')
      .send(event);
    const boundResponse = await request(createApp(accepted, undefined, true))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'continue-bound')
      .send(event);

    expect(directResponse.status).toBe(400);
    expect(rejected.enqueue).not.toHaveBeenCalled();
    expect(boundResponse.status).toBe(202);
    expect(accepted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'continue', target: event.target }),
      {},
    );
  });

  it('passes explicit observational coalescing only for a resolved bound continuation', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps, undefined, true))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'commentary-game-start-1')
      .send({
        mode: 'continue',
        event: fireEvent().event,
        target: {
          agentId: 'commentator',
          conversationId: 'commentator-thread',
          parentMessageId: 'placeholder',
          bindingId: `evtbind_${'b'.repeat(48)}`,
          sourceKeyId: API_KEY_ID,
        },
        input: 'Comment on this game start.',
        coalesce: { key: 'championship-commentary' },
      });

    expect(response.status).toBe(202);
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'continue' }), {
      coalesce: { key: 'championship-commentary' },
    });
  });

  it('fails closed when the idempotency header is absent or duplicated', async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const missing = await request(app).post('/api/agents/v1/events').send(fireEvent());
    const duplicated = await request(app)
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'delivery-1,delivery-2')
      .send(fireEvent());

    expect(missing.status).toBe(400);
    expect(duplicated.status).toBe(400);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('rejects malformed event bodies before enqueueing', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'delivery-1')
      .send({ ...fireEvent(), mode: 'unknown' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_event');
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('reports idempotency conflicts and temporary delivery unavailability', async () => {
    const conflict = dependencies({
      enqueue: jest.fn(async () => {
        const error = new Error(`Delivery ${DELIVERY_KEY} was reused with different content`);
        error.name = 'AgentTriggerDeliveryConflictError';
        throw error;
      }),
    });
    const unavailable = dependencies({
      enqueue: jest.fn(async () => {
        throw new AgentTriggerServiceUnavailableError('Delivery service is starting');
      }),
    });

    const conflictResponse = await request(createApp(conflict))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'delivery-1')
      .send(fireEvent());
    const unavailableResponse = await request(createApp(unavailable))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'delivery-1')
      .send(fireEvent());

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.code).toBe('idempotency_conflict');
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableResponse.body.error.code).toBe('trigger_delivery_unavailable');
  });

  it('returns a safe owner-scoped delivery projection', async () => {
    const settledAt = new Date('2026-08-17T12:00:01.000Z');
    const attemptedAt = new Date('2026-08-17T12:00:00.500Z');
    const deps = dependencies({
      getDeliveryStatus: jest.fn(async () =>
        delivery({
          status: 'succeeded',
          attempts: 3,
          settledAt,
          handling: {
            status: 'failed',
            conversationId: 'conversation-1',
            streamId: 'conversation-1',
            generationCreatedAt: 1_787_000_000_000,
            startedAt: attemptedAt,
            settledAt,
            error: 'Agent access was revoked',
          },
        }),
      ),
    });

    const response = await request(createApp(deps)).get(`/api/agents/v1/events/${DELIVERY_KEY}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: DELIVERY_KEY,
      status: 'succeeded',
      attempts: 3,
      availableAt: AVAILABLE_AT.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      settledAt: settledAt.toISOString(),
      handling: {
        status: 'failed',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        startedAt: attemptedAt.toISOString(),
        settledAt: settledAt.toISOString(),
        error: 'Agent access was revoked',
      },
    });
    expect(response.body).not.toHaveProperty('envelope');
    expect(response.body).not.toHaveProperty('history');
    expect(response.body).not.toHaveProperty('orderingKey');
  });

  it('uses an API-key, owner, and tenant-scoped status projection and hides missing deliveries', async () => {
    const deps = dependencies({ getDeliveryStatus: jest.fn(async () => null) });
    const response = await request(createApp(deps)).get(`/api/agents/v1/events/${DELIVERY_KEY}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('event_not_found');
    expect(deps.getDeliveryStatus).toHaveBeenCalledWith(
      DELIVERY_KEY,
      USER_ID,
      API_KEY_ID,
      'tenant-1',
    );
  });

  it('rejects malformed delivery ids without querying storage', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps)).get('/api/agents/v1/events/not-a-key');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_event');
    expect(deps.getDeliveryStatus).not.toHaveBeenCalled();
  });

  it('requires an authenticated principal even when mounted incorrectly', async () => {
    const deps = dependencies();
    const response = await request(createApp(deps, null))
      .post('/api/agents/v1/events')
      .set('Idempotency-Key', 'delivery-1')
      .send(fireEvent());

    expect(response.status).toBe(401);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
