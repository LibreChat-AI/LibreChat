import type { AgentTriggerDeliveryRecord } from './engine';
import { createAgentTriggerBatchEnvelope } from './batch';
import { createAgentTriggerEnvelope } from './envelope';

const boundEnvelope = (index: number, overrides: { conversationId?: string } = {}) =>
  createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: `request-${index}`,
    deliveryId: `delivery-${index}`,
    receivedAt: 100 + index,
    principal: { id: '507f1f77bcf86cd799439011', tenantId: 'tenant-1' },
    target: {
      agentId: 'commentator',
      conversationId: overrides.conversationId ?? 'child-thread',
      parentMessageId: 'placeholder',
      bindingId: `evtbind_${'a'.repeat(48)}`,
      sourceKeyId: 'source-key',
    },
    event: {
      id: `event-${index}`,
      type: index === 3 ? 'game.completed' : 'game.started',
      occurredAt: index === 1 ? 30 : index * 10,
      source: { id: 'source-key', type: 'remote_api_key' },
      payload: { gameId: `game-${index}` },
    },
    input: `Comment on game ${index}.`,
  });

const delivery = (
  index: number,
  overrides: Partial<AgentTriggerDeliveryRecord> = {},
): AgentTriggerDeliveryRecord => ({
  id: `row-${index}`,
  user: '507f1f77bcf86cd799439011',
  claimToken: 'claim-token',
  deliveryKey: `trigger-${index}`,
  fingerprint: `fingerprint-${index}`,
  orderingKey: 'commentary-lane',
  laneSequence: index,
  envelope: boundEnvelope(index),
  status: 'batched',
  attempts: 0,
  availableAt: new Date(0),
  createdAt: new Date(index),
  ...overrides,
});

describe('createAgentTriggerBatchEnvelope', () => {
  it('renders every event in deterministic source order with a compact type summary', () => {
    const root = delivery(1, { status: 'leased' });
    const envelope = createAgentTriggerBatchEnvelope(root, [delivery(3), delivery(2)]);
    const input = JSON.parse(envelope.input) as {
      kind: string;
      count: number;
      summary: { eventTypes: Array<{ type: string; count: number }> };
      events: Array<{ deliveryId: string; event: { id: string }; input: string }>;
    };

    expect(input).toEqual({
      kind: 'librechat.agent_event_batch',
      version: 1,
      count: 3,
      summary: {
        eventTypes: [
          { type: 'game.completed', count: 1 },
          { type: 'game.started', count: 2 },
        ],
      },
      events: [
        expect.objectContaining({
          deliveryId: 'delivery-2',
          event: {
            id: 'event-2',
            type: 'game.started',
            occurredAt: 20,
            source: { id: 'source-key', type: 'remote_api_key' },
            payload: { gameId: 'game-2' },
          },
        }),
        expect.objectContaining({
          deliveryId: 'delivery-1',
          event: {
            id: 'event-1',
            type: 'game.started',
            occurredAt: 30,
            source: { id: 'source-key', type: 'remote_api_key' },
            payload: { gameId: 'game-1' },
          },
        }),
        expect.objectContaining({
          deliveryId: 'delivery-3',
          event: {
            id: 'event-3',
            type: 'game.completed',
            occurredAt: 30,
            source: { id: 'source-key', type: 'remote_api_key' },
            payload: { gameId: 'game-3' },
          },
        }),
      ],
    });
  });

  it('fails closed if a persisted member does not share the bound child', () => {
    const incompatible = delivery(2, { envelope: boundEnvelope(2, { conversationId: 'other' }) });
    expect(() => createAgentTriggerBatchEnvelope(delivery(1), [incompatible])).toThrow(
      'do not share one bound child',
    );
  });
});
