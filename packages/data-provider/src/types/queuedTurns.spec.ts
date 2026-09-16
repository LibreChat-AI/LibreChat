import {
  agentQueuedTurnCapabilitySchema,
  agentQueuedTurnReceiptSchema,
  cancelAgentQueuedTurnSchema,
  enqueueAgentQueuedTurnSchema,
  listAgentQueuedTurnsSchema,
} from './queuedTurns';
import { ReasoningEffort } from '../schemas';

const request = {
  conversationId: 'conversation-1',
  parentMessageId: 'message-1',
  clientRequestId: 'request-1',
  text: 'Continue with this context',
  files: [{ file_id: 'file-1', filename: 'context.txt', llmDeliveryPath: 'text' }],
  quotes: ['quoted context'],
  manualSkills: ['research'],
  reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
  expectedPredecessorCreatedAt: 42,
};

describe('agent queued turn schemas', () => {
  it('accepts the complete enqueue contract', () => {
    expect(enqueueAgentQueuedTurnSchema.parse(request)).toEqual(request);
  });

  it('allows attachment-only queued turns', () => {
    expect(
      enqueueAgentQueuedTurnSchema.parse({
        conversationId: 'conversation-1',
        parentMessageId: 'message-1',
        clientRequestId: 'request-1',
        text: '',
        files: [{ file_id: 'file-1' }],
      }),
    ).toEqual({
      conversationId: 'conversation-1',
      parentMessageId: 'message-1',
      clientRequestId: 'request-1',
      text: '',
      files: [{ file_id: 'file-1' }],
    });
  });

  it('rejects an invalid predecessor epoch', () => {
    expect(() =>
      enqueueAgentQueuedTurnSchema.parse({
        ...request,
        expectedPredecessorCreatedAt: -1,
      }),
    ).toThrow();
  });

  it('rejects an invalid reasoning override', () => {
    expect(() =>
      enqueueAgentQueuedTurnSchema.parse({
        ...request,
        reasoningOverride: { key: 'temperature', value: 0.5 },
      }),
    ).toThrow();
  });

  it('validates list and cancel identities', () => {
    expect(
      listAgentQueuedTurnsSchema.parse({
        conversationId: 'conversation-1',
        clientRequestIds: ['request-1', 'request-1', 'request-2'],
      }),
    ).toEqual({
      conversationId: 'conversation-1',
      clientRequestIds: ['request-1', 'request-2'],
    });
    expect(cancelAgentQueuedTurnSchema.parse({ queuedTurnId: 'turn-1' })).toEqual({
      queuedTurnId: 'turn-1',
    });
    expect(() => listAgentQueuedTurnsSchema.parse({ conversationId: '' })).toThrow();
    expect(() => cancelAgentQueuedTurnSchema.parse({ queuedTurnId: '' })).toThrow();
  });

  it('parses a durable queued receipt', () => {
    const receipt = {
      ...request,
      queuedTurnId: 'turn-1',
      status: 'queued',
      position: 0,
      revision: 1,
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:00:00.000Z',
    };

    expect(agentQueuedTurnReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('parses a bounded terminal failure projection', () => {
    const receipt = {
      ...request,
      queuedTurnId: 'turn-1',
      status: 'dead',
      revision: 1,
      failure: { code: 'PARENT_NOT_FOUND', message: 'The selected branch is unavailable' },
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:01:00.000Z',
    };

    expect(agentQueuedTurnReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('parses the effective boundary consumed by an admitted turn', () => {
    const receipt = {
      ...request,
      queuedTurnId: 'turn-1',
      status: 'admitted',
      effectivePredecessorCreatedAt: 84,
      revision: 2,
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:01:00.000Z',
    };

    expect(agentQueuedTurnReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('parses an explicit root admission without a synthetic timestamp', () => {
    const receipt = {
      ...request,
      queuedTurnId: 'turn-root',
      status: 'admitted',
      rootPredecessor: true,
      revision: 2,
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:01:00.000Z',
    };

    expect(agentQueuedTurnReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('requires durability only when the capability is supported', () => {
    expect(agentQueuedTurnCapabilitySchema.parse({ supported: false })).toEqual({
      supported: false,
    });
    expect(
      agentQueuedTurnCapabilitySchema.parse({
        supported: true,
        durability: 'process_local',
      }),
    ).toEqual({ supported: true, durability: 'process_local' });
    expect(() => agentQueuedTurnCapabilitySchema.parse({ supported: true })).toThrow();
  });
});
