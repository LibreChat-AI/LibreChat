import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

it('retains drained Responses journal authority without a millisecond read loop after timeout', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const manager = new GenerationJobManagerClass();
  const store = new InMemoryJobStore({ ttlAfterComplete: 120_000 });
  manager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  manager.initialize();
  try {
    const job = await manager.createJob('pending-journal', 'user', 'conversation', {
      initialMetadata: { endpoint: 'responses' },
    });
    await store.transitionStatus(job.streamId, {
      from: 'running',
      to: 'complete',
      expectCreatedAt: job.createdAt,
      patch: {
        providerDrained: true,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 40_000,
        completedAt: Date.now() - 40_000,
      },
    });
    const onDone = jest.fn();
    const subscription = await manager.subscribe(job.streamId, () => undefined, onDone);
    expect(subscription).not.toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reads = jest.spyOn(store, 'getJob');
    await jest.advanceTimersByTimeAsync(1000);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
    expect(onDone).not.toHaveBeenCalled();
    expect((await store.getJob(job.streamId))?.terminalPersistencePending).toBe(true);
    subscription?.unsubscribe();
  } finally {
    jest.useRealTimers();
    await manager.destroy();
  }
});
