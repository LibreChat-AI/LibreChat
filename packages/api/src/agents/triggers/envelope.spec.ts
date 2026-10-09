import type { CreateAgentTriggerEnvelopeInput } from './envelope';
import {
  AGENT_TRIGGER_ENVELOPE_VERSION,
  AgentTriggerEnvelopeError,
  createAgentTriggerEnvelope,
  getAgentTriggerIdempotencyKey,
  parseAgentTriggerEnvelope,
} from './envelope';

describe('createAgentTriggerEnvelope', () => {
  const createFireInput = (): CreateAgentTriggerEnvelopeInput => ({
    mode: 'fire',
    requestId: 'request-1',
    deliveryId: 'subscription-1:event-1',
    receivedAt: 1_725_000_000_010,
    principal: {
      id: 'user-1',
      role: 'USER',
      tenantId: 'tenant-1',
    },
    target: { agentId: 'agent-1' },
    run: {
      conversationId: 'conversation-1',
      timezone: 'America/New_York',
      files: [{ file_id: 'file-1' }],
      metadata: { adapter: 'test' },
    },
    event: {
      id: 'event-1',
      type: 'work.ready',
      occurredAt: 1_725_000_000_000,
      source: { id: 'source-1', type: 'mcp' },
      payload: { resourceId: 'resource-1', attempt: 1 },
    },
    input: 'Inspect the ready work item.',
  });

  it('creates a detached, versioned fire envelope with a projected principal', () => {
    const input = createFireInput();
    const principal = input.principal as NonNullable<
      CreateAgentTriggerEnvelopeInput['principal']
    > & {
      password?: string;
    };
    principal.password = 'must-not-cross';
    const envelope = createAgentTriggerEnvelope(input);
    const payload = input.event.payload as { resourceId: string };
    payload.resourceId = 'changed-after-dispatch';

    expect(envelope).toEqual({
      version: AGENT_TRIGGER_ENVELOPE_VERSION,
      mode: 'fire',
      requestId: 'request-1',
      deliveryId: 'subscription-1:event-1',
      receivedAt: 1_725_000_000_010,
      principal: { userId: 'user-1', role: 'USER', tenantId: 'tenant-1' },
      target: { agentId: 'agent-1' },
      run: {
        conversationId: 'conversation-1',
        timezone: 'America/New_York',
        files: [{ file_id: 'file-1' }],
        metadata: { adapter: 'test' },
      },
      event: {
        id: 'event-1',
        type: 'work.ready',
        occurredAt: 1_725_000_000_000,
        source: { id: 'source-1', type: 'mcp' },
        payload: { resourceId: 'resource-1', attempt: 1 },
      },
      input: 'Inspect the ready work item.',
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toContain('must-not-cross');
  });

  it('parses and detaches a serialized envelope', () => {
    const created = createAgentTriggerEnvelope(createFireInput());
    const serialized = JSON.parse(JSON.stringify(created)) as unknown;
    const parsed = parseAgentTriggerEnvelope(serialized);

    expect(parsed).toEqual(created);
    expect(parsed).not.toBe(serialized);
    expect(parsed.event).not.toBe((serialized as { event: object }).event);
  });

  it('requires a generation fence for steer deliveries', () => {
    const envelope = createAgentTriggerEnvelope({
      ...createFireInput(),
      mode: 'steer',
      target: {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        generationCreatedAt: 1_725_000_000_005,
        preempt: true,
      },
    });

    expect(envelope.mode).toBe('steer');
    expect(envelope.target).toEqual({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 1_725_000_000_005,
      preempt: true,
    });
  });

  it('requires an exact existing branch for continue deliveries', () => {
    const envelope = createAgentTriggerEnvelope({
      ...createFireInput(),
      mode: 'continue',
      target: {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
      },
    });

    expect(envelope.mode).toBe('continue');
    expect(envelope.target).toEqual({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
    });
    expect(parseAgentTriggerEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it('preserves only complete authenticated binding metadata on continuations', () => {
    const envelope = createAgentTriggerEnvelope({
      ...createFireInput(),
      mode: 'continue',
      target: {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
    });

    expect(parseAgentTriggerEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        mode: 'continue',
        target: {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          parentMessageId: 'response-1',
          bindingId: `evtbind_${'a'.repeat(48)}`,
        },
      }),
    ).toThrow('target.bindingId and target.sourceKeyId must be provided together');
  });

  it('validates and detaches an expected tool-action fence', () => {
    const expectedAction = {
      toolName: 'submit_move',
      argumentSubset: { gameId: 'game-1', expectedPly: 7 },
    };
    const envelope = createAgentTriggerEnvelope({
      ...createFireInput(),
      expectedAction,
    });
    expectedAction.argumentSubset = { gameId: 'mutated', expectedPly: 8 };

    expect(envelope.expectedAction).toEqual({
      toolName: 'submit_move',
      argumentSubset: { gameId: 'game-1', expectedPly: 7 },
    });
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        expectedAction: { toolName: 'submit_move', argumentSubset: [] as never },
      }),
    ).toThrow('expectedAction.argumentSubset must be an object');
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        expectedAction: { toolName: 'x'.repeat(257) },
      }),
    ).toThrow('expectedAction.toolName must not exceed 256 characters');
  });

  it('builds a stable generation-compatible idempotency key per delivery target', () => {
    const first = createAgentTriggerEnvelope(createFireInput());
    const retry = createAgentTriggerEnvelope({
      ...createFireInput(),
      requestId: 'request-2',
      receivedAt: 1_725_000_000_020,
    });
    const anotherDelivery = createAgentTriggerEnvelope({
      ...createFireInput(),
      deliveryId: 'subscription-2:event-1',
    });
    const anotherSource = createAgentTriggerEnvelope({
      ...createFireInput(),
      event: {
        ...createFireInput().event,
        source: { id: 'source-2', type: 'webhook' },
      },
    });
    const anotherEvent = createAgentTriggerEnvelope({
      ...createFireInput(),
      event: { ...createFireInput().event, id: 'event-2' },
    });

    const firstKey = getAgentTriggerIdempotencyKey(first);
    expect(getAgentTriggerIdempotencyKey(retry)).toBe(firstKey);
    expect(getAgentTriggerIdempotencyKey(anotherDelivery)).not.toBe(firstKey);
    expect(getAgentTriggerIdempotencyKey(anotherSource)).not.toBe(firstKey);
    expect(getAgentTriggerIdempotencyKey(anotherEvent)).not.toBe(firstKey);
    expect(firstKey).toMatch(/^trigger_[a-f0-9]{64}$/);
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstKey.length).toBeLessThanOrEqual(128);
  });

  it.each([
    ['requestId', { requestId: ' ' }],
    ['deliveryId', { deliveryId: '' }],
    ['principal.id', { principal: undefined }],
    ['target.agentId', { target: { agentId: '' } }],
    ['event', { event: undefined }],
    ['event.id', { event: { ...createFireInput().event, id: '' } }],
    ['event.type', { event: { ...createFireInput().event, type: '' } }],
    ['event.source.id', { event: { ...createFireInput().event, source: { id: '', type: 'mcp' } } }],
    ['input', { input: '' }],
  ])('rejects an invalid %s', (_path, override) => {
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        ...override,
      } as CreateAgentTriggerEnvelopeInput),
    ).toThrow(AgentTriggerEnvelopeError);
  });

  it('rejects invalid timestamps and malformed steer controls', () => {
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        event: { ...createFireInput().event, occurredAt: Number.NaN },
      }),
    ).toThrow('event.occurredAt must be a non-negative integer timestamp');

    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        mode: 'steer',
        target: {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          generationCreatedAt: -1,
          preempt: true,
        },
      }),
    ).toThrow('target.generationCreatedAt must be a non-negative integer timestamp');

    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        mode: 'steer',
        target: {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          generationCreatedAt: 1,
          preempt: 'yes',
        },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('target.preempt must be a boolean');

    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        mode: 'steer',
        target: undefined,
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('target.agentId must be a non-empty string');
  });

  it('validates and detaches trusted fire run context', () => {
    const input = createFireInput();
    const envelope = createAgentTriggerEnvelope(input);
    const files = input.mode === 'fire' ? input.run?.files : undefined;
    if (files != null) {
      (files[0] as { file_id: string }).file_id = 'changed';
    }

    expect(envelope.mode).toBe('fire');
    if (envelope.mode === 'fire') {
      expect(envelope.run?.files).toEqual([{ file_id: 'file-1' }]);
    }

    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        run: { files: 'not-an-array' },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('run.files must be an array');
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        run: { metadata: { callback: () => undefined } },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('run.metadata.callback contains a non-JSON function value');
    // The destination project is host-controlled context, so it must survive the
    // envelope's sanitization intact and be rejected when it is not a string — a
    // silently dropped id would file a scheduled run outside the project the
    // schedule promised.
    const scoped = createAgentTriggerEnvelope({
      ...createFireInput(),
      run: { chatProjectId: 'project-1' },
    } as CreateAgentTriggerEnvelopeInput);
    expect(scoped.mode === 'fire' && scoped.run?.chatProjectId).toBe('project-1');
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        run: { chatProjectId: 42 },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('run.chatProjectId must be a non-empty string');
  });

  it('rejects non-JSON and circular event payloads', () => {
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        event: { ...createFireInput().event, payload: { callback: () => undefined } },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('event.payload.callback contains a non-JSON function value');

    const payload: { self?: object } = {};
    payload.self = payload;
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        event: { ...createFireInput().event, payload },
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('event.payload.self contains a circular reference');
  });

  it('rejects unknown trigger modes at runtime', () => {
    expect(() =>
      createAgentTriggerEnvelope({
        ...createFireInput(),
        mode: 'launch',
      } as unknown as CreateAgentTriggerEnvelopeInput),
    ).toThrow('Unsupported agent trigger mode: launch');
  });
});
