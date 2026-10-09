import type { AgentContinueTriggerEnvelope } from './envelope';
import type { AgentTriggerDispatchContext } from './dispatch';
import { createAgentContinuationResolver } from './continuation';

function envelope(options: {
  sourceId: string;
  sourceType?: 'internal' | 'webhook';
  binding?: boolean;
}): AgentContinueTriggerEnvelope {
  return {
    mode: 'continue',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 1,
    principal: { userId: 'user-1' },
    event: {
      id: 'event-1',
      type: 'task.completed',
      occurredAt: 1,
      source: { id: options.sourceId, type: options.sourceType ?? 'internal' },
    },
    target: {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentMessageId: 'message-1',
      ...(options.binding
        ? { bindingId: 'evtbind_123', sourceKeyId: '507f191e810c19729de860eb' }
        : {}),
    },
    input: 'Continue.',
  } as AgentContinueTriggerEnvelope;
}

describe('agent continuation admission', () => {
  const context = { idempotencyKey: 'delivery-1' } as AgentTriggerDispatchContext;

  it('routes bound work exclusively through the event actor adapter', async () => {
    const eventActor = jest.fn(async () => ({ status: 'settled' as const }));
    const internal = jest.fn(async () => ({ status: 'settled' as const }));
    const resolve = createAgentContinuationResolver({
      eventActor,
      internalSources: new Map([['completion', internal]]),
    });

    await expect(
      resolve(envelope({ sourceId: 'completion', binding: true }), context),
    ).resolves.toEqual({ status: 'settled' });
    expect(eventActor).toHaveBeenCalledTimes(1);
    expect(internal).not.toHaveBeenCalled();
  });

  it('routes internal work by its stable source identity', async () => {
    const eventActor = jest.fn();
    const internal = jest.fn(async () => ({ status: 'settled' as const }));
    const resolve = createAgentContinuationResolver({
      eventActor,
      internalSources: new Map([['completion', internal]]),
    });

    await expect(resolve(envelope({ sourceId: 'completion' }), context)).resolves.toEqual({
      status: 'settled',
    });
    expect(internal).toHaveBeenCalledTimes(1);
    expect(eventActor).not.toHaveBeenCalled();
  });

  it('leaves unknown and external source-neutral continuations unchanged', async () => {
    const eventActor = jest.fn();
    const internal = jest.fn();
    const resolve = createAgentContinuationResolver({
      eventActor,
      internalSources: new Map([['completion', internal]]),
    });

    expect(resolve(envelope({ sourceId: 'unknown' }), context)).toBeUndefined();
    expect(
      resolve(envelope({ sourceId: 'completion', sourceType: 'webhook' }), context),
    ).toBeUndefined();
    expect(eventActor).not.toHaveBeenCalled();
    expect(internal).not.toHaveBeenCalled();
  });
});
