import { getRequestId, getTenantId, getUserId } from '@librechat/data-schemas';
import { Constants, EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { AgentTriggerExecutionHostDeps, AgentTriggerFetch } from './host';
import {
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
} from './detachedAction';
import { createAgentTriggerEnvelope, getAgentTriggerIdempotencyKey } from './envelope';
import { AgentTriggerExecutionError, createAgentTriggerExecutionHost } from './host';

const createFireEnvelope = () =>
  createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 20,
    principal: { id: 'user-1', role: 'member', tenantId: 'tenant-1' },
    target: { agentId: 'agent-1' },
    run: {
      conversationId: 'scheduled-conversation-1',
      timezone: 'Europe/Paris',
      chatProjectId: 'project-1',
      files: [{ file_id: 'file-1' }],
      metadata: { manual: false },
    },
    event: {
      id: 'event-1',
      type: 'resource.ready',
      occurredAt: 10,
      source: { id: 'source-1', type: 'webhook' },
      payload: { resourceId: 'resource-1' },
    },
    input: 'Handle the ready resource.',
  });

const createSteerEnvelope = () =>
  createAgentTriggerEnvelope({
    mode: 'steer',
    requestId: 'request-2',
    deliveryId: 'delivery-2',
    receivedAt: 30,
    principal: { id: 'user-1', role: 'member', tenantId: 'tenant-1' },
    target: {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 25,
      preempt: true,
    },
    event: {
      id: 'event-2',
      type: 'opponent.moved',
      occurredAt: 21,
      source: { id: 'game-1', type: 'mcp' },
    },
    input: 'The opponent moved. Take your turn.',
  });

const createContinueEnvelope = () =>
  createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-3',
    deliveryId: 'delivery-3',
    receivedAt: 35,
    principal: { id: 'user-1', role: 'member', tenantId: 'tenant-1' },
    target: {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
    },
    event: {
      id: 'event-3',
      type: 'subagent.completed',
      occurredAt: 31,
      source: { id: 'subagent-completion', type: 'internal' },
    },
    input: 'Collect the completed child task.',
  });

function response(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function fetchMock(implementation: AgentTriggerFetch): jest.MockedFunction<AgentTriggerFetch> {
  return jest.fn(implementation);
}

function deps(
  fetcher: jest.MockedFunction<AgentTriggerFetch>,
  overrides: Partial<AgentTriggerExecutionHostDeps> = {},
): AgentTriggerExecutionHostDeps {
  return {
    getBaseUrl: () => 'http://127.0.0.1:3080',
    mintToken: () => 'signed-token',
    fetch: fetcher,
    ...overrides,
  };
}

function expectExecutionError(error: unknown, expected: Partial<AgentTriggerExecutionError>): void {
  expect(error).toBeInstanceOf(AgentTriggerExecutionError);
  expect(error).toMatchObject(expected);
}

describe('createAgentTriggerExecutionHost fire adapter', () => {
  it('rejects malformed serialized envelopes through its promise contract', async () => {
    const host = createAgentTriggerExecutionHost(deps(fetchMock(async () => response({}))));
    const malformed = { ...createFireEnvelope() };
    Reflect.deleteProperty(malformed, 'requestId');

    await expect(host.dispatch(malformed)).rejects.toThrow('requestId must be a non-empty string');
  });

  it('starts a new run with stable identity, principal context, and no source coupling', async () => {
    const envelope = createFireEnvelope();
    const idempotencyKey = getAgentTriggerIdempotencyKey(envelope);
    const fetcher = fetchMock(async () =>
      response({
        streamId: 'stream-1',
        conversationId: 'conversation-1',
        generationCreatedAt: 40,
        status: 'started',
      }),
    );
    const mintToken = jest.fn(() => {
      expect(getUserId()).toBe('user-1');
      expect(getTenantId()).toBe('tenant-1');
      expect(getRequestId()).toBe(idempotencyKey);
      return 'signed-token';
    });
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        getBaseUrl: () => 'https://chat.example.test/base/?ignored=true',
        mintToken,
        getTimezone: async () => ' America/New_York ',
      }),
    );

    await expect(host.dispatch(envelope)).resolves.toEqual({
      mode: 'fire',
      streamId: 'stream-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 40,
      status: 'started',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe('https://chat.example.test/base/api/agents/chat/agents');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer signed-token');
    expect(headers.get('x-lc-agent-trigger')).toBe('1');
    expect(headers.get('x-request-id')).toBe(idempotencyKey);
    expect(headers.get('x-librechat-generation-protocol')).toBe('2');
    expect(headers.get('user-agent')).toContain('LibreChat-Agent-Trigger/1');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: envelope.input,
      endpoint: EModelEndpoint.agents,
      agent_id: envelope.target.agentId,
      parentMessageId: Constants.NO_PARENT,
      isContinued: false,
      isRegenerate: false,
      clientRequestId: idempotencyKey,
      generationProtocolVersion: 2,
      agentTrigger: {
        version: envelope.version,
        deliveryId: envelope.deliveryId,
        event: {
          id: envelope.event.id,
          type: envelope.event.type,
          occurredAt: envelope.event.occurredAt,
          source: envelope.event.source,
        },
        metadata: { manual: false },
      },
      newConversationId: 'scheduled-conversation-1',
      chatProjectId: 'project-1',
      files: [{ file_id: 'file-1' }],
      timezone: 'Europe/Paris',
    });
    expect(mintToken).toHaveBeenCalledWith(envelope.principal, envelope);
  });

  it('reuses the same generation identity when an ambiguous delivery is retried', async () => {
    const envelope = createFireEnvelope();
    const fetcher = fetchMock(
      jest
        .fn()
        .mockResolvedValueOnce(
          response({
            streamId: 'stream-1',
            conversationId: 'conversation-1',
            generationCreatedAt: 40,
            status: 'started',
          }),
        )
        .mockResolvedValueOnce(
          response({
            streamId: 'stream-1',
            conversationId: 'conversation-1',
            generationCreatedAt: 40,
            status: 'resumed',
          }),
        ),
    );
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await host.dispatch(envelope);
    await expect(host.dispatch(envelope)).resolves.toMatchObject({
      status: 'resumed',
      conversationId: 'conversation-1',
    });

    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    expect(bodies).toEqual([
      expect.objectContaining({
        clientRequestId: getAgentTriggerIdempotencyKey(envelope),
      }),
      expect.objectContaining({
        clientRequestId: getAgentTriggerIdempotencyKey(envelope),
      }),
    ]);
  });

  it('classifies a server rejection as definite and preserves retry guidance', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () =>
      response(
        { code: 'SERVER_NOT_READY', error: 'Try shortly.' },
        { status: 503, headers: { 'retry-after': '2' } },
      ),
    );
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'SERVER_NOT_READY',
        status: 503,
        retryAfter: '2',
      });
    });
  });

  it('does not mark an authorization rejection retryable', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({ code: 'FORBIDDEN' }, { status: 403 }));
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'definite',
        retryable: false,
        code: 'FORBIDDEN',
        status: 403,
      });
    });
  });

  it('retries an expired delivery token so the next attempt can remint it', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({ code: 'UNAUTHORIZED' }, { status: 401 }));
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });
  });

  it('treats malformed success as ambiguous because the generation may have started', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({ status: 'started' }));
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
        status: 200,
      });
    });
  });

  it('keeps the timeout active while reading the accepted response body', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            const abort = () => controller.error(new Error('body aborted'));
            if (signal?.aborted === true) {
              abort();
            } else {
              signal?.addEventListener('abort', abort, { once: true });
            }
          },
        }),
      );
    });
    const host = createAgentTriggerExecutionHost(deps(fetcher, { timeoutMs: 10 }));

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'ambiguous',
        retryable: true,
        code: 'TIMEOUT',
        status: 200,
      });
    });
  });

  it('applies the timeout while asynchronous setup is still pending', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        mintToken: () => new Promise<string>(() => undefined),
        timeoutMs: 10,
      }),
    );

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'TIMEOUT',
      });
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('releases a prepared result that arrives after setup has timed out', async () => {
    let finishPreparation!: (value: {
      status: 'ready';
      input: string;
      parentMessageId: string;
      releaseOnDefiniteFailure: () => Promise<void>;
    }) => void;
    const preparation = new Promise<{
      status: 'ready';
      input: string;
      parentMessageId: string;
      releaseOnDefiniteFailure: () => Promise<void>;
    }>((resolve) => {
      finishPreparation = resolve;
    });
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        prepareContinue: () => preparation,
        timeoutMs: 10,
      }),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      mode: 'continue',
      certainty: 'definite',
      retryable: true,
      code: 'TIMEOUT',
    });
    finishPreparation({
      status: 'ready',
      input: 'late durable child result',
      parentMessageId: 'response-1',
      releaseOnDefiniteFailure,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(releaseOnDefiniteFailure).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('starts independent token, timezone, and origin setup concurrently', async () => {
    let resolveToken!: (value: string) => void;
    let resolveTimezone!: (value: string) => void;
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const timezone = new Promise<string>((resolve) => {
      resolveTimezone = resolve;
    });
    const mintToken = jest.fn(() => token);
    const getTimezone = jest.fn(() => timezone);
    const getBaseUrl = jest.fn(() => 'http://127.0.0.1:3080');
    const fetcher = fetchMock(async () =>
      response({
        status: 'started',
        streamId: 'stream-1',
        conversationId: 'conversation-1',
      }),
    );
    const host = createAgentTriggerExecutionHost({
      mintToken,
      getTimezone,
      getBaseUrl,
      fetch: fetcher,
    });

    const pending = host.dispatch(createFireEnvelope());
    await Promise.resolve();
    await Promise.resolve();

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(getTimezone).toHaveBeenCalledTimes(1);
    expect(getBaseUrl).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();

    resolveToken('signed-token');
    resolveTimezone('UTC');
    await expect(pending).resolves.toMatchObject({
      mode: 'fire',
      status: 'started',
    });
  });

  it('observes caller cancellation while asynchronous setup is pending', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, { mintToken: () => new Promise<string>(() => undefined) }),
    );
    const controller = new AbortController();
    const pending = host.dispatch(createFireEnvelope(), {
      signal: controller.signal,
    });
    controller.abort();

    await pending.catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'ABORTED',
      });
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('marks thrown setup dependency failures retryable without sending', async () => {
    expect.hasAssertions();
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        mintToken: () => new Promise<string>(() => undefined),
        getTimezone: async () => Promise.reject(new Error('timezone store unavailable')),
      }),
    );

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'SETUP_FAILED',
      });
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels an oversized success body instead of buffering it without a bound', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(fetchMock(async () => response({ padding: 'x'.repeat(70 * 1024) }))),
    );

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'fire',
        certainty: 'ambiguous',
        retryable: true,
        code: 'RESPONSE_TOO_LARGE',
        status: 200,
      });
    });
  });

  it('rejects invalid host configuration before making a network request', async () => {
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, { getBaseUrl: () => 'file:///tmp/not-http' }),
    );

    await host.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'definite',
        retryable: false,
        code: 'INVALID_BASE_URL',
      });
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('distinguishes pre-connect failures from unknown network outcomes', async () => {
    expect.hasAssertions();
    const refused = new TypeError('fetch failed');
    Object.assign(refused, { cause: { code: 'ECONNREFUSED' } });
    const preconnect = createAgentTriggerExecutionHost(
      deps(fetchMock(async () => Promise.reject(refused))),
    );
    const reset = createAgentTriggerExecutionHost(
      deps(fetchMock(async () => Promise.reject(new TypeError('connection reset')))),
    );

    await preconnect.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'definite',
        retryable: true,
        code: 'NETWORK_ERROR',
      });
    });
    await reset.dispatch(createFireEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'ambiguous',
        retryable: true,
        code: 'NETWORK_ERROR',
      });
    });
  });

  it('does not send when the delivery was already aborted', async () => {
    const fetcher = fetchMock(async () => response({}));
    const host = createAgentTriggerExecutionHost(deps(fetcher));
    const controller = new AbortController();
    controller.abort();

    await host
      .dispatch(createFireEnvelope(), { signal: controller.signal })
      .catch((error: unknown) => {
        expectExecutionError(error, {
          certainty: 'definite',
          retryable: true,
          code: 'ABORTED',
        });
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('createAgentTriggerExecutionHost continue adapter', () => {
  it('appends an idempotent turn to the exact existing conversation branch', async () => {
    const envelope = createContinueEnvelope();
    const idempotencyKey = getAgentTriggerIdempotencyKey(envelope);
    const fetcher = fetchMock(async () =>
      response({
        streamId: 'conversation-1',
        conversationId: 'conversation-1',
        generationCreatedAt: 50,
        status: 'started',
      }),
    );
    const host = createAgentTriggerExecutionHost(deps(fetcher));

    await expect(host.dispatch(envelope)).resolves.toEqual({
      mode: 'continue',
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 50,
      status: 'started',
    });
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe('http://127.0.0.1:3080/api/agents/chat/agents');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: envelope.input,
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent-1',
      parentMessageId: 'response-1',
      conversationId: 'conversation-1',
      isContinued: false,
      isRegenerate: false,
      clientRequestId: idempotencyKey,
      generationProtocolVersion: 2,
    });
  });

  it('carries a prepared queued-turn payload and settles it after admission', async () => {
    const envelope = createContinueEnvelope();
    const admitted = {
      mode: 'continue' as const,
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 50,
      status: 'started' as const,
    };
    const settleOnAdmission = jest.fn(async () => undefined);
    const getBaseUrl = jest.fn(() => 'http://127.0.0.1:3080');
    const admissionSource = {
      source: 'agent-queued-turn',
      sourceId: 'queued-turn-1',
      claimId: 'queued-delivery-1',
      claimBy: 'queued-worker-1',
    };
    const prepareContinue = jest.fn(async () => ({
      status: 'ready' as const,
      input: 'queued user turn',
      parentMessageId: 'latest-response',
      expectedPredecessorCreatedAt: 49,
      files: [{ file_id: 'file-1' }],
      quotes: ['quoted context'],
      manualSkills: ['research'],
      reasoningOverride: { key: 'reasoning_effort' as const, value: ReasoningEffort.high },
      admissionSource,
      settleOnAdmission,
    }));
    const fetcher = fetchMock(async () => response(admitted));
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        prepareContinue,
        getBaseUrl,
      }),
    );

    await expect(host.dispatch(envelope, { attempt: 3, maxAttempts: 3 })).resolves.toEqual(
      admitted,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      text: 'queued user turn',
      parentMessageId: 'latest-response',
      expectedPredecessorCreatedAt: 49,
      files: [{ file_id: 'file-1' }],
      quotes: ['quoted context'],
      manualSkills: ['research'],
      reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      agentContinuationAdmission: admissionSource,
    });
    expect(getBaseUrl).toHaveBeenCalledWith({ localOnly: true });
    expect(prepareContinue).toHaveBeenCalledWith(envelope, {
      idempotencyKey: getAgentTriggerIdempotencyKey(envelope),
      attempt: 3,
      maxAttempts: 3,
    });
    expect(settleOnAdmission).toHaveBeenCalledWith(admitted);
  });

  it('keeps a prepared queued turn claimed when admission settlement is unavailable', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response({
            mode: 'continue',
            streamId: 'conversation-1',
            conversationId: 'conversation-1',
            status: 'started',
          }),
        ),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'queued user turn',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
            settleOnAdmission: async () => {
              throw new Error('mongo unavailable');
            },
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'ambiguous',
      retryable: true,
      code: 'PREPARATION_SETTLEMENT_FAILED',
    });
    expect(releaseOnDefiniteFailure).not.toHaveBeenCalled();
  });

  it('carries server-resolved binding identity only on bound child continuations', async () => {
    const base = createContinueEnvelope();
    if (base.mode !== 'continue') {
      throw new Error('Expected a continue envelope');
    }
    const envelope = {
      ...base,
      event: { ...base.event, payload: { blob: 'x'.repeat(4096) } },
      expectedAction: {
        toolName: 'submit_move',
        argumentSubset: { gameId: 'game-1', expectedPly: 7 },
      },
      target: {
        ...base.target,
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
    };
    const fetcher = fetchMock(async () =>
      response({
        streamId: 'conversation-1',
        conversationId: 'conversation-1',
        status: 'started',
      }),
    );

    await createAgentTriggerExecutionHost(deps(fetcher)).dispatch(envelope);

    const headers = fetcher.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['x-lc-agent-event-binding']).toBe(`evtbind_${'a'.repeat(48)}`);
    expect(headers['x-lc-agent-event-source-key']).toBe('source-key');
    /** The unbounded source payload never rides the delivery body; the actor
     * binds an invocation from event identity alone. */
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      agentEventDelivery: {
        deliveryKey: getAgentTriggerIdempotencyKey(envelope),
        event: {
          id: envelope.event.id,
          type: envelope.event.type,
          occurredAt: envelope.event.occurredAt,
          source: envelope.event.source,
        },
        expectedAction: envelope.expectedAction,
      },
    });
    expect(
      JSON.parse(String(fetcher.mock.calls[0][1]?.body)).agentEventDelivery.event,
    ).not.toHaveProperty('payload');
  });

  it('projects only the bounded internal detached-completion authority', async () => {
    const base = createContinueEnvelope();
    if (base.mode !== 'continue') {
      throw new Error('Expected a continue envelope');
    }
    const completion = {
      version: 1 as const,
      invocationId: 'original-delivery-1',
      generationCreatedAt: 1_787_000_000_000,
      wakeGenerationCreatedAt: 1_787_000_000_000,
      taskId: 'event-actor-task-1',
      idempotencyKey: 'a'.repeat(64),
    };
    const envelope = {
      ...base,
      target: {
        ...base.target,
        bindingId: 'binding-1',
        sourceKeyId: 'source-key-1',
      },
      event: {
        id: completion.taskId,
        type: EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
        occurredAt: completion.generationCreatedAt + 1,
        source: {
          id: EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
          type: 'internal',
        },
        payload: completion,
      },
      expectedAction: { toolName: 'submit_move' },
    };
    const fetcher = fetchMock(async () =>
      response({
        streamId: 'conversation-1',
        conversationId: 'conversation-1',
        generationCreatedAt: completion.generationCreatedAt + 2,
        status: 'started',
      }),
    );
    const getBaseUrl = jest.fn(() => 'http://127.0.0.1:3080');

    await createAgentTriggerExecutionHost(deps(fetcher, { getBaseUrl })).dispatch(envelope);

    expect(getBaseUrl).toHaveBeenCalledWith({ localOnly: true });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.clientRequestId).toBe(getAgentTriggerIdempotencyKey(envelope));
    expect(body.agentEventDelivery).toMatchObject({
      deliveryKey: getAgentTriggerIdempotencyKey(envelope),
      internalCompletion: completion,
    });
    expect(body.agentEventDelivery.event).not.toHaveProperty('payload');
  });

  it.each(['PARENT_NOT_READY', 'EVENT_ACTOR_NOT_READY'])(
    'retries without consuming the logical delivery for temporary admission code %s',
    async (code) => {
      expect.hasAssertions();
      const host = createAgentTriggerExecutionHost(
        deps(
          fetchMock(async () =>
            response({ code, error: 'The actor is still busy.' }, { status: 409 }),
          ),
        ),
      );

      await host.dispatch(createContinueEnvelope()).catch((error: unknown) => {
        expectExecutionError(error, {
          mode: 'continue',
          certainty: 'definite',
          retryable: true,
          deferWithoutAttempt: true,
          code,
          status: 409,
        });
      });
    },
  );

  it('releases a prepared durable result after a definite admission rejection', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () => response({ code: 'AGENT_NOT_FOUND' }, { status: 404 })),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'durable child result',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'definite',
      code: 'AGENT_NOT_FOUND',
    });
    expect(releaseOnDefiniteFailure).toHaveBeenCalledTimes(1);
  });

  it('retains a prepared durable result after an ambiguous admission outcome', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () => Promise.reject(new Error('connection reset'))),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'durable child result',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'ambiguous',
      code: 'NETWORK_ERROR',
    });
    expect(releaseOnDefiniteFailure).not.toHaveBeenCalled();
  });

  it('retains a prepared durable result when a retry gets a definite 5xx response', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response(
            { code: 'SERVER_NOT_READY', error: 'Generation is finalizing.' },
            { status: 503, headers: { 'retry-after': '1' } },
          ),
        ),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'durable child result',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'definite',
      retryable: true,
      code: 'SERVER_NOT_READY',
      status: 503,
    });
    expect(releaseOnDefiniteFailure).not.toHaveBeenCalled();
  });

  it('releases a prepared durable result when parent state fails before admission', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response(
            {
              code: 'PARENT_STATE_UNAVAILABLE',
              error: 'Parent state is unavailable.',
            },
            { status: 503, headers: { 'retry-after': '1' } },
          ),
        ),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'durable child result',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'definite',
      retryable: true,
      code: 'PARENT_STATE_UNAVAILABLE',
      status: 503,
    });
    expect(releaseOnDefiniteFailure).toHaveBeenCalledTimes(1);
  });

  it('retains a prepared durable result when an earlier admitted run was replaced', async () => {
    const releaseOnDefiniteFailure = jest.fn(async () => undefined);
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () => response({ code: 'RUN_REPLACED' }, { status: 409 })),
        {
          prepareContinue: async () => ({
            status: 'ready',
            input: 'durable child result',
            parentMessageId: 'response-1',
            releaseOnDefiniteFailure,
          }),
        },
      ),
    );

    await expect(host.dispatch(createContinueEnvelope())).rejects.toMatchObject({
      certainty: 'definite',
      retryable: false,
      code: 'RUN_REPLACED',
      status: 409,
    });
    expect(releaseOnDefiniteFailure).not.toHaveBeenCalled();
  });

  it('rejects a mismatched continued conversation as an ambiguous outcome', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response({
            streamId: 'other',
            conversationId: 'other',
            status: 'started',
          }),
        ),
      ),
    );

    await host.dispatch(createContinueEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'continue',
        certainty: 'ambiguous',
        retryable: true,
        code: 'INVALID_RESPONSE',
      });
    });
  });
});

describe('createAgentTriggerExecutionHost steer adapter', () => {
  it('steers through the authenticated admission route with a strict v2 receipt', async () => {
    const envelope = createSteerEnvelope();
    const idempotencyKey = getAgentTriggerIdempotencyKey(envelope);
    const mintToken = jest.fn(() => {
      expect(getUserId()).toBe('user-1');
      expect(getTenantId()).toBe('tenant-1');
      expect(getRequestId()).toBe(idempotencyKey);
      return 'signed-token';
    });
    const fetcher = fetchMock(async () =>
      response(
        {
          status: 'queued',
          conversationId: 'conversation-1',
          steerId: 'steer-1',
          position: 1,
          preempt: true,
          preemptRevision: 4,
          generationProtocolVersion: 2,
        },
        { status: 202 },
      ),
    );
    const host = createAgentTriggerExecutionHost(
      deps(fetcher, {
        getBaseUrl: () => 'https://chat.example.test/base/',
        mintToken,
      }),
    );

    await expect(host.dispatch(envelope)).resolves.toEqual({
      mode: 'steer',
      status: 'queued',
      conversationId: 'conversation-1',
      steerId: 'steer-1',
      position: 1,
      preempt: true,
      preemptRevision: 4,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe('https://chat.example.test/base/api/agents/chat/steer/deliver');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer signed-token');
    expect(headers.get('x-lc-agent-trigger')).toBe('1');
    expect(headers.get('x-request-id')).toBe(idempotencyKey);
    expect(headers.get('x-librechat-generation-protocol')).toBe('2');
    expect(JSON.parse(String(init?.body))).toEqual({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 25,
      text: envelope.input,
      clientSteerId: idempotencyKey,
      preempt: true,
      generationProtocolVersion: 2,
    });
    expect(mintToken).toHaveBeenCalledWith(envelope.principal, envelope);
  });

  it('surfaces temporary steer backpressure as a retryable definite rejection', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response(
            { code: 'STEER_QUEUE_FULL', generationProtocolVersion: 2 },
            { status: 429, headers: { 'retry-after': '3' } },
          ),
        ),
      ),
    );

    await host.dispatch(createSteerEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        certainty: 'definite',
        retryable: true,
        code: 'STEER_QUEUE_FULL',
        status: 429,
        retryAfter: '3',
      });
    });
  });

  it('retries a steer while the same generation is paused for human review', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response({ code: 'RUN_PAUSED', generationProtocolVersion: 2 }, { status: 409 }),
        ),
      ),
    );

    await host.dispatch(createSteerEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'steer',
        certainty: 'definite',
        retryable: true,
        code: 'RUN_PAUSED',
        status: 409,
      });
    });
  });

  it('retries a missing strict route during a rolling deployment without mutating legacy state', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(fetchMock(async () => response('Not Found', { status: 404 }))),
    );

    await host.dispatch(createSteerEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'steer',
        certainty: 'definite',
        retryable: true,
        code: 'STEER_ADMISSION_UNAVAILABLE',
        status: 404,
      });
    });
  });

  it('classifies a reset during steer admission as ambiguous and safe to retry', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(fetchMock(async () => Promise.reject(new Error('connection reset')))),
    );

    await host.dispatch(createSteerEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: true,
        code: 'NETWORK_ERROR',
      });
    });
  });

  it('refuses to retry a success that lacks the v2 receipt guarantee', async () => {
    expect.hasAssertions();
    const host = createAgentTriggerExecutionHost(
      deps(
        fetchMock(async () =>
          response(
            {
              status: 'queued',
              conversationId: 'conversation-1',
              steerId: 'steer-1',
              position: 1,
              preempt: false,
              generationProtocolVersion: 1,
            },
            { status: 202 },
          ),
        ),
      ),
    );

    await host.dispatch(createSteerEnvelope()).catch((error: unknown) => {
      expectExecutionError(error, {
        mode: 'steer',
        certainty: 'ambiguous',
        retryable: false,
        code: 'STEER_IDEMPOTENCY_UNAVAILABLE',
        status: 202,
      });
    });
  });
});
