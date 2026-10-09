import {
  AGENT_RUN_ENVELOPE_MAX_NESTING_DEPTH,
  AGENT_RUN_ENVELOPE_VERSION,
  AgentRunEnvelopeError,
  createAgentRunEnvelope,
} from './envelope';

describe('createAgentRunEnvelope', () => {
  const createBaseInput = () => ({
    protocol: 'chat.completions' as const,
    requestId: 'req-123',
    receivedAt: 1_725_000_000_000,
    principal: {
      id: 'user-123',
      role: 'USER',
      tenantId: 'tenant-123',
      password: 'must-not-cross',
      federatedTokens: { access_token: 'must-not-cross' },
    },
    payload: {
      model: 'agent-123',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true,
      ephemeralAgent: { skills: true },
      manualSkills: ['review-code'],
      timezone: 'America/New_York',
    },
  });

  it('creates a versioned JSON envelope with only the trusted principal projection', () => {
    const envelope = createAgentRunEnvelope(createBaseInput());

    expect(envelope).toEqual({
      version: AGENT_RUN_ENVELOPE_VERSION,
      protocol: 'chat.completions',
      requestId: 'req-123',
      receivedAt: 1_725_000_000_000,
      principal: {
        userId: 'user-123',
        role: 'USER',
        tenantId: 'tenant-123',
      },
      payload: {
        model: 'agent-123',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        ephemeralAgent: { skills: true },
        manualSkills: ['review-code'],
        timezone: 'America/New_York',
      },
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toContain('must-not-cross');
    expect(envelope.payload.ephemeralAgent?.skills).toBe(true);
  });

  it('detaches the payload from the Express request body', () => {
    const input = createBaseInput();
    const envelope = createAgentRunEnvelope(input);
    input.payload.messages[0].content = 'Changed after dispatch';

    expect(envelope.payload.messages[0].content).toBe('Hello');
  });

  it.each([
    ['function', () => undefined],
    ['undefined', undefined],
    ['bigint', BigInt(1)],
    ['symbol', Symbol('value')],
    ['non-finite number', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['class instance', new Date()],
  ])('rejects a %s in the payload', (_label, value) => {
    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        payload: { ...createBaseInput().payload, unsafe: value },
      } as unknown as Parameters<typeof createAgentRunEnvelope>[0]),
    ).toThrow(AgentRunEnvelopeError);
  });

  it('rejects circular payloads', () => {
    const payload: Record<string, unknown> = { ...createBaseInput().payload };
    payload.circular = payload;

    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        payload,
      } as unknown as Parameters<typeof createAgentRunEnvelope>[0]),
    ).toThrow('payload.circular contains a circular reference');
  });

  it('rejects payloads that exceed the bounded nesting depth', () => {
    let nested: unknown = 'value';
    for (let depth = 0; depth <= AGENT_RUN_ENVELOPE_MAX_NESTING_DEPTH; depth++) {
      nested = [nested];
    }

    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        payload: { ...createBaseInput().payload, nested },
      } as unknown as Parameters<typeof createAgentRunEnvelope>[0]),
    ).toThrow(`exceeds the maximum nesting depth of ${AGENT_RUN_ENVELOPE_MAX_NESTING_DEPTH}`);
  });

  it('rejects sparse arrays and hidden object state', () => {
    const sparse = Array<string>(1);
    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        payload: { ...createBaseInput().payload, sparse },
      } as unknown as Parameters<typeof createAgentRunEnvelope>[0]),
    ).toThrow('payload.sparse contains sparse array entries');

    const payload = { ...createBaseInput().payload };
    Object.defineProperty(payload, 'hidden', { enumerable: false, value: 'state' });
    expect(() => createAgentRunEnvelope({ ...createBaseInput(), payload })).toThrow(
      'payload.hidden must be an enumerable property',
    );
  });

  it('supports the Responses protocol as a discriminated envelope', () => {
    const payload = {
      model: 'agent-123',
      input: 'Hello',
      stream: false,
      isTemporary: true,
      manualSkills: ['review-code'],
    };
    const envelope = createAgentRunEnvelope({
      protocol: 'responses',
      requestId: 'req-responses',
      receivedAt: 1_725_000_000_001,
      principal: { id: 'user-123' },
      payload,
    });

    expect(envelope.protocol).toBe('responses');
    expect(envelope.payload).toEqual(payload);
    expect(envelope.payload.isTemporary).toBe(true);
  });

  it('requires an authenticated user id', () => {
    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        principal: undefined,
      }),
    ).toThrow('principal.id must be a non-empty string');
  });

  it('rejects unknown protocol tags at runtime', () => {
    expect(() =>
      createAgentRunEnvelope({
        ...createBaseInput(),
        protocol: 'assistants',
      } as unknown as Parameters<typeof createAgentRunEnvelope>[0]),
    ).toThrow('Unsupported agent run protocol: assistants');
  });
});
