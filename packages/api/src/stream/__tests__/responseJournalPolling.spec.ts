import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

it.each([
  { external: true, drained: true },
  { external: true, drained: false },
  { external: false, drained: true },
])(
  'recovers ordinary Responses and retains explicit external authority (external: $external, drained: $drained)',
  async ({ external, drained }) => {
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
        initialMetadata: {
          endpoint: 'responses',
          ...(external && { terminalPersistenceOwner: 'external' as const }),
        },
      });
      await store.transitionStatus(job.streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
        patch: {
          providerDrained: drained,
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
      if (external) expect(reads.mock.calls.length).toBeGreaterThan(0);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
      if (external) expect(onDone).not.toHaveBeenCalled();
      else expect(onDone).toHaveBeenCalledTimes(1);
      expect((await store.getJob(job.streamId))?.terminalPersistencePending).toBe(external);
      subscription?.unsubscribe();
    } finally {
      jest.useRealTimers();
      await manager.destroy();
    }
  },
);
