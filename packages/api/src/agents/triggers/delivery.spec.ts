import {
  AGENT_TRIGGER_COALESCE_WINDOW_MS,
  AgentTriggerDeliveryError,
  MAX_AGENT_TRIGGER_BATCH_BYTES,
  MAX_AGENT_TRIGGER_ENVELOPE_BYTES,
  prepareAgentTriggerDelivery,
} from './delivery';
import { createAgentTriggerEnvelope } from './envelope';

const envelope = (overrides: Record<string, unknown> = {}) =>
  createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 20,
    principal: { id: '507f1f77bcf86cd799439011', tenantId: 'tenant-1' },
    target: { agentId: 'agent-1' },
    event: {
      id: 'event-1',
      type: 'resource.ready',
      occurredAt: 10,
      source: { id: 'source-1', type: 'webhook' },
      payload: { b: 2, a: 1 },
    },
    input: 'Handle the ready resource.',
    ...overrides,
  });

describe('prepareAgentTriggerDelivery', () => {
  it('prepares a bounded persistent record with a default ordering lane', () => {
    const availableAt = new Date('2026-08-17T12:00:00.000Z');
    const prepared = prepareAgentTriggerDelivery(envelope(), { availableAt });

    expect(prepared).toMatchObject({
      deliveryKey: expect.stringMatching(/^trigger_[a-f0-9]{64}$/),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      orderingKey: expect.stringMatching(/^trigger_lane_[a-f0-9]{64}$/),
      user: '507f1f77bcf86cd799439011',
      tenantId: 'tenant-1',
      availableAt,
    });
    expect(prepared.availableAt).not.toBe(availableAt);
  });

  it('treats fresh ingress metadata and payload key order as the same retry', () => {
    const first = prepareAgentTriggerDelivery(envelope());
    const retried = prepareAgentTriggerDelivery(
      envelope({
        requestId: 'request-2',
        receivedAt: 30,
        event: {
          id: 'event-1',
          type: 'resource.ready',
          occurredAt: 10,
          source: { id: 'source-1', type: 'webhook' },
          payload: { a: 1, b: 2 },
        },
      }),
    );

    expect(retried.deliveryKey).toBe(first.deliveryKey);
    expect(retried.fingerprint).toBe(first.fingerprint);
    expect(retried.orderingKey).toBe(first.orderingKey);
  });

  it('detects execution-content changes under the same delivery identity', () => {
    const first = prepareAgentTriggerDelivery(envelope());
    const changed = prepareAgentTriggerDelivery(envelope({ input: 'Do something else.' }));

    expect(changed.deliveryKey).toBe(first.deliveryKey);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it('supports an explicit cross-source ordering lane scoped to the principal', () => {
    const first = prepareAgentTriggerDelivery(envelope(), { orderingKey: 'game-42' });
    const second = prepareAgentTriggerDelivery(
      envelope({
        deliveryId: 'delivery-2',
        event: {
          id: 'event-2',
          type: 'clock.tick',
          occurredAt: 11,
          source: { id: 'source-2', type: 'scheduler' },
        },
      }),
      { orderingKey: ' game-42 ' },
    );
    const anotherUser = prepareAgentTriggerDelivery(
      envelope({ principal: { id: '507f1f77bcf86cd799439012', tenantId: 'tenant-1' } }),
      { orderingKey: 'game-42' },
    );

    expect(second.orderingKey).toBe(first.orderingKey);
    expect(anotherUser.orderingKey).not.toBe(first.orderingKey);
  });

  it('bounds opt-in coalescing to one authenticated child binding', () => {
    const availableAt = new Date('2026-08-17T12:00:00.000Z');
    const bound = envelope({
      mode: 'continue',
      target: {
        agentId: 'agent-1',
        conversationId: 'child-thread',
        parentMessageId: 'placeholder',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
    });
    const prepared = prepareAgentTriggerDelivery(bound, {
      availableAt,
      coalesce: { key: 'commentary' },
    });

    expect(prepared).toMatchObject({
      coalesceKey: expect.stringMatching(/^trigger_batch_[a-f0-9]{64}$/),
      coalesceFrom: availableAt,
      coalesceUntil: new Date(availableAt.getTime() + AGENT_TRIGGER_COALESCE_WINDOW_MS),
      availableAt: new Date(availableAt.getTime() + AGENT_TRIGGER_COALESCE_WINDOW_MS),
      envelopeBytes: expect.any(Number),
    });
    expect(() =>
      prepareAgentTriggerDelivery(envelope(), { coalesce: { key: 'commentary' } }),
    ).toThrow('only for authenticated bound-child continue events');
    expect(() => prepareAgentTriggerDelivery(bound, { coalesce: { key: ' '.repeat(2) } })).toThrow(
      'coalesce.key',
    );
  });

  it('bounds an explicitly coalesced envelope below the ordinary single-delivery cap', () => {
    const bound = envelope({
      mode: 'continue',
      target: {
        agentId: 'agent-1',
        conversationId: 'child-thread',
        parentMessageId: 'placeholder',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
      input: 'x'.repeat(MAX_AGENT_TRIGGER_BATCH_BYTES),
    });

    expect(() => prepareAgentTriggerDelivery(bound, { coalesce: { key: 'commentary' } })).toThrow(
      `Coalesced agent trigger envelope exceeds ${MAX_AGENT_TRIGGER_BATCH_BYTES} bytes`,
    );
  });

  it('rejects action evidence contracts on observational batches', () => {
    const bound = envelope({
      mode: 'continue',
      target: {
        agentId: 'agent-1',
        conversationId: 'child-thread',
        parentMessageId: 'placeholder',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
      expectedAction: {
        toolName: 'submit_move',
        argumentSubset: { gameId: 'game-1', expectedPly: 7 },
      },
    });

    expect(() => prepareAgentTriggerDelivery(bound, { coalesce: { key: 'commentary' } })).toThrow(
      'Expected actions cannot be coalesced',
    );
  });

  it('accepts action evidence contracts only for bound child continuations', () => {
    expect(() =>
      prepareAgentTriggerDelivery(envelope({ expectedAction: { toolName: 'submit_move' } })),
    ).toThrow('Expected actions require an authenticated bound-child continue event');
  });

  it('rejects invalid scheduling metadata and oversized envelopes', () => {
    expect(() =>
      prepareAgentTriggerDelivery(envelope(), { availableAt: new Date(Number.NaN) }),
    ).toThrow(AgentTriggerDeliveryError);
    expect(() => prepareAgentTriggerDelivery(envelope(), { orderingKey: ' ' })).toThrow(
      AgentTriggerDeliveryError,
    );
    expect(() =>
      prepareAgentTriggerDelivery(
        envelope({ input: 'x'.repeat(MAX_AGENT_TRIGGER_ENVELOPE_BYTES) }),
      ),
    ).toThrow(`Agent trigger envelope exceeds ${MAX_AGENT_TRIGGER_ENVELOPE_BYTES} bytes`);
  });
});
