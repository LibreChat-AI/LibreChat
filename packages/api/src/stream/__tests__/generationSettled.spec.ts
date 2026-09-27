/**
 * Waiting completion deliveries are expedited when a generation settles, so the
 * settled notification must fire exactly once for every terminal path and name
 * the generation's owner — and a failing listener must never disturb cleanup.
 */
import type { GenerationSettledEvent } from '../GenerationJobManager';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return GenerationJobManager;
}

describe('generation settled notifications', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('announces a completed generation once, with its owner', async () => {
    const manager = await configureManager();
    const events: GenerationSettledEvent[] = [];
    manager.onGenerationSettled((event) => events.push(event));
    const job = await manager.createJob('settled-complete', 'user-1', 'conversation-1');

    await manager.completeJob('settled-complete', undefined, job.createdAt);
    await manager.completeJob('settled-complete', undefined, job.createdAt);

    expect(events).toEqual([
      {
        streamId: 'settled-complete',
        conversationId: 'conversation-1',
        userId: 'user-1',
        status: 'complete',
      },
    ]);
    await manager.destroy();
  });

  it('announces a failed generation', async () => {
    const manager = await configureManager();
    const events: GenerationSettledEvent[] = [];
    manager.onGenerationSettled((event) => events.push(event));
    const job = await manager.createJob('settled-error', 'user-2');

    await manager.completeJob('settled-error', 'provider failed', job.createdAt);

    expect(events).toEqual([
      expect.objectContaining({ streamId: 'settled-error', userId: 'user-2', status: 'error' }),
    ]);
    await manager.destroy();
  });

  it('announces an aborted generation', async () => {
    const manager = await configureManager();
    const events: GenerationSettledEvent[] = [];
    manager.onGenerationSettled((event) => events.push(event));
    await manager.createJob('settled-abort', 'user-3');

    const result = await manager.abortJob('settled-abort');

    expect(result.success).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ streamId: 'settled-abort', userId: 'user-3', status: 'aborted' }),
    ]);
    await manager.destroy();
  });

  it('announces a generation whose approval expired', async () => {
    const manager = await configureManager();
    const events: GenerationSettledEvent[] = [];
    manager.onGenerationSettled((event) => events.push(event));
    await manager.createJob('settled-approval', 'user-6', 'conversation-6');
    const action = buildPendingAction(
      buildToolApprovalPayload([
        { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_expire' },
      ]),
      {
        streamId: 'settled-approval',
        conversationId: 'conversation-6',
        runId: 'run-1',
        responseMessageId: 'msg-1',
      },
    );
    await manager.approvals.pause('settled-approval', action);
    expect(events).toEqual([]);

    await expect(manager.expireApproval('settled-approval')).resolves.toBe(true);
    await expect(manager.expireApproval('settled-approval')).resolves.toBe(false);
    /** The next expiry sweep relays the terminal job without announcing it again. */
    await (manager as unknown as { cleanup(): Promise<void> }).cleanup();

    expect(events).toEqual([
      {
        streamId: 'settled-approval',
        conversationId: 'conversation-6',
        userId: 'user-6',
        status: 'aborted',
      },
    ]);
    await manager.destroy();
  });

  it('keeps cleanup and later listeners running when one listener throws', async () => {
    const manager = await configureManager();
    const events: GenerationSettledEvent[] = [];
    manager.onGenerationSettled(() => {
      throw new Error('listener failed');
    });
    manager.onGenerationSettled((event) => events.push(event));
    const job = await manager.createJob('settled-throwing-listener', 'user-4');

    await expect(
      manager.completeJob('settled-throwing-listener', undefined, job.createdAt),
    ).resolves.toBe(true);

    expect(events).toHaveLength(1);
    await manager.destroy();
  });

  it('stops notifying after unsubscribe', async () => {
    const manager = await configureManager();
    const listener = jest.fn();
    const unsubscribe = manager.onGenerationSettled(listener);
    unsubscribe();
    const job = await manager.createJob('settled-unsubscribed', 'user-5');

    await manager.completeJob('settled-unsubscribed', undefined, job.createdAt);

    expect(listener).not.toHaveBeenCalled();
    await manager.destroy();
  });
});
