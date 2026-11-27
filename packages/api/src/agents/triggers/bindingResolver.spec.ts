import { AIMessage } from '@langchain/core/messages';
import type { IConversation } from '@librechat/data-schemas';
import {
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
} from './detachedAction';
import { createAgentTriggerEnvelope, type AgentContinueTriggerEnvelope } from './envelope';
import { createAgentEventContinueResolver } from './bindingResolver';

const bindingId = `evtbind_${'a'.repeat(48)}`;
const sourceKeyId = '507f191e810c19729de860eb';

function envelope(): AgentContinueTriggerEnvelope {
  return createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 1,
    principal: { id: 'user-1', tenantId: 'tenant-1' },
    event: {
      id: 'event-1',
      type: 'chess.turn.ready',
      occurredAt: 1,
      source: { id: 'chess', type: 'webhook' },
    },
    input: 'Your turn.',
    target: {
      agentId: 'agent-player',
      conversationId: 'child-thread',
      parentMessageId: 'placeholder',
      bindingId,
      sourceKeyId,
    },
  }) as AgentContinueTriggerEnvelope;
}

function detachedCompletionEnvelope(generationCreatedAt: number): AgentContinueTriggerEnvelope {
  return createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-completion',
    deliveryId: 'detached_completion:task-1',
    receivedAt: 2,
    principal: { id: 'user-1', tenantId: 'tenant-1' },
    event: {
      id: 'task-1',
      type: EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
      occurredAt: 2,
      source: { id: EVENT_ACTOR_DETACHED_COMPLETION_SOURCE, type: 'internal' },
      payload: {
        version: 1,
        invocationId: 'delivery-1',
        generationCreatedAt,
        wakeGenerationCreatedAt: generationCreatedAt,
        taskId: 'task-1',
        idempotencyKey: 'a'.repeat(64),
      },
    },
    input: 'Detached completion.',
    target: {
      agentId: 'agent-player',
      conversationId: 'child-thread',
      parentMessageId: 'placeholder',
      bindingId,
      sourceKeyId,
    },
  }) as AgentContinueTriggerEnvelope;
}

function boundMethods() {
  return {
    getAgentEventBinding: jest.fn(async () => ({
      conversationId: 'child-thread',
      agentId: 'agent-player',
      tenantId: 'tenant-1',
      binding: { bindingId, sourceKeyId, actorId: 'player' },
      lineage: {
        parentConversationId: 'parent-thread',
        parentAgentId: 'agent-director',
      } as never,
    })),
    getConvo: jest.fn(
      async () =>
        ({
          conversationId: 'parent-thread',
          agent_id: 'agent-director',
          tenantId: 'tenant-1',
        }) as IConversation,
    ),
    getMessages: jest.fn(async () => []) as never,
  };
}

describe('agent event continuation resolver', () => {
  it('re-resolves the latest assistant leaf immediately before dispatch', async () => {
    const getMessages = jest.fn(async () => [
      Object.assign(new AIMessage('done'), {
        messageId: 'assistant-1',
        isCreatedByUser: false,
        createdAt: new Date(2),
      }),
    ]) as never;
    const resolver = createAgentEventContinueResolver({
      methods: {
        getAgentEventBinding: jest.fn(async () => ({
          conversationId: 'child-thread',
          agentId: 'agent-player',
          tenantId: 'tenant-1',
          binding: { bindingId, sourceKeyId, actorId: 'player' },
          lineage: {
            parentConversationId: 'parent-thread',
            parentAgentId: 'agent-director',
          } as never,
        })),
        getConvo: jest.fn(
          async () =>
            ({
              conversationId: 'parent-thread',
              agent_id: 'agent-director',
              tenantId: 'tenant-1',
            }) as IConversation,
        ),
        getMessages,
      },
    });

    await expect(resolver(envelope(), { idempotencyKey: 'trigger-1' } as never)).resolves.toEqual({
      status: 'ready',
      input: 'Your turn.',
      parentMessageId: 'assistant-1',
    });
    expect(getMessages).toHaveBeenCalledWith(
      { user: 'user-1', conversationId: 'child-thread', isCreatedByUser: false },
      'messageId createdAt',
      { sort: { createdAt: -1, _id: -1 }, limit: 1 },
    );
  });

  it('fails closed when the durable binding target changed', async () => {
    const resolver = createAgentEventContinueResolver({
      methods: {
        getAgentEventBinding: jest.fn(async () => ({
          conversationId: 'another-thread',
          agentId: 'agent-player',
          binding: { bindingId, sourceKeyId, actorId: 'player' },
          lineage: {} as never,
        })),
        getConvo: jest.fn(),
        getMessages: jest.fn(async () => []) as never,
      },
    });

    await expect(
      resolver(envelope(), { idempotencyKey: 'trigger-1' } as never),
    ).rejects.toMatchObject({ code: 'EVENT_BINDING_INVALID', retryable: false });
  });

  it('defers an event while the actor has an active generation', async () => {
    const resolver = createAgentEventContinueResolver({
      getGenerationJob: jest.fn(async () => ({ status: 'running' })),
      methods: {
        getAgentEventBinding: jest.fn(async () => ({
          conversationId: 'child-thread',
          agentId: 'agent-player',
          tenantId: 'tenant-1',
          binding: { bindingId, sourceKeyId, actorId: 'player' },
          lineage: {
            parentConversationId: 'parent-thread',
            parentAgentId: 'agent-director',
          } as never,
        })),
        getConvo: jest.fn(
          async () =>
            ({
              conversationId: 'parent-thread',
              agent_id: 'agent-director',
              tenantId: 'tenant-1',
            }) as IConversation,
        ),
        getMessages: jest.fn(),
      },
    });

    await expect(
      resolver(envelope(), { idempotencyKey: 'trigger-1' } as never),
    ).rejects.toMatchObject({
      code: 'EVENT_ACTOR_NOT_READY',
      retryable: true,
      deferWithoutAttempt: true,
    });
  });

  it('admits only the exact detached completion through its terminal host-action fence', async () => {
    const createdAt = 77;
    const resolver = createAgentEventContinueResolver({
      getGenerationJob: jest.fn(async () => ({
        status: 'complete',
        createdAt,
        metadata: { terminalPersistencePending: true },
      })),
      methods: boundMethods(),
    });

    await expect(
      resolver(detachedCompletionEnvelope(createdAt), {
        idempotencyKey: 'completion-1',
      } as never),
    ).resolves.toMatchObject({ status: 'ready' });

    await expect(
      resolver(detachedCompletionEnvelope(createdAt + 1), {
        idempotencyKey: 'completion-stale',
      } as never),
    ).rejects.toMatchObject({
      code: 'EVENT_ACTOR_NOT_READY',
      deferWithoutAttempt: true,
    });
  });

  it('fails closed after the binding parent is removed', async () => {
    const resolver = createAgentEventContinueResolver({
      methods: {
        getAgentEventBinding: jest.fn(async () => ({
          conversationId: 'child-thread',
          agentId: 'agent-player',
          tenantId: 'tenant-1',
          binding: { bindingId, sourceKeyId, actorId: 'player' },
          lineage: { parentConversationId: 'missing-parent' } as never,
        })),
        getConvo: jest.fn(async () => null),
        getMessages: jest.fn(),
      },
    });

    await expect(
      resolver(envelope(), { idempotencyKey: 'trigger-1' } as never),
    ).rejects.toMatchObject({ code: 'EVENT_BINDING_INVALID', retryable: false });
  });

  it('fails closed when the binding or its parent passed its retention deadline', async () => {
    const getAgentEventBinding = jest.fn(async () => ({
      conversationId: 'child-thread',
      agentId: 'agent-player',
      tenantId: 'tenant-1',
      expiredAt: new Date(0),
      binding: { bindingId, sourceKeyId, actorId: 'player' },
      lineage: {
        parentConversationId: 'parent-thread',
        parentAgentId: 'agent-director',
      } as never,
    }));
    const resolver = createAgentEventContinueResolver({
      methods: {
        getAgentEventBinding,
        getConvo: jest.fn(),
        getMessages: jest.fn(),
      },
    });

    await expect(
      resolver(envelope(), { idempotencyKey: 'trigger-1' } as never),
    ).rejects.toMatchObject({ code: 'EVENT_BINDING_INVALID', retryable: false });
  });
});
