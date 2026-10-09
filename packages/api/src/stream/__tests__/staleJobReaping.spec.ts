/**
 * Tests for the stale running-job failsafe that prevents abandoned/hung
 * generations from leaking their content state in memory until the process OOMs.
 *
 * - InMemoryJobStore reaps jobs stuck in "running" past `staleJobTimeout`
 *   (mirrors RedisJobStore's running-job TTL).
 * - GenerationJobManager aborts the in-flight generation when its job is reaped
 *   or replaced, so client/graph references can be garbage collected.
 *
 * @see https://github.com/LibreChat-AI/LibreChat/issues/13391
 */

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

describe('InMemoryJobStore - stale running-job failsafe', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reaps a running job older than staleJobTimeout', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1');
    await store.updateJob('s1', { createdAt: Date.now() - 5000 });

    const removed = await store.cleanup();

    expect(removed).toBe(1);
    expect(await store.hasJob('s1')).toBe(false);

    await store.destroy();
  });

  it('retains a terminal schedule job until reconciliation releases it', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });

    const job = await store.createJob('scheduled-run', 'u1', 'scheduled-run', undefined, {
      scheduleId: 'schedule-1',
      preserveForScheduleReconcile: true,
    });
    await store.updateJob(
      job.streamId,
      {
        status: 'complete',
        completedAt: Date.now(),
        scheduleOutcome: 'success',
      },
      job.createdAt,
    );

    expect(await store.cleanup()).toBe(0);
    expect(await store.hasJob(job.streamId)).toBe(true);

    await store.updateJob(job.streamId, { preserveForScheduleReconcile: false }, job.createdAt);

    expect(await store.cleanup()).toBe(1);
    expect(await store.hasJob(job.streamId)).toBe(false);

    await store.destroy();
  });

  it('does not reap a running job with recent activity even if created long ago', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ staleJobTimeout: 1000 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1');
    await store.updateJob('s1', { createdAt: Date.now() - 5000 });
    // Actively streaming: a long but live generation must not be reaped.
    store.recordActivity('s1');

    const removed = await store.cleanup();

    expect(removed).toBe(0);
    expect(await store.hasJob('s1')).toBe(true);

    await store.destroy();
  });

  it('does not reap a replacement job that reuses a stale stream id', async () => {
    jest.useFakeTimers();
    try {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 });
      await store.initialize();

      await store.createJob('s1', 'u1', 's1');
      store.recordActivity('s1'); // old generation's activity
      await jest.advanceTimersByTimeAsync(5000); // ...goes stale

      // Replacement reuses the same streamId (old job never terminated).
      await store.createJob('s1', 'u1', 's1');
      const removed = await store.cleanup();

      expect(removed).toBe(0); // fresh replacement must not be reaped immediately
      expect(await store.hasJob('s1')).toBe(true);

      await store.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not refresh replacement activity from a predecessor generation', async () => {
    jest.useFakeTimers();
    try {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 });
      await store.initialize();

      const predecessor = await store.createJob('s1', 'u1', 's1');
      await jest.advanceTimersByTimeAsync(1);
      const replacement = await store.createJob('s1', 'u1', 's1');
      await jest.advanceTimersByTimeAsync(900);

      store.recordActivity('s1', predecessor.createdAt);
      await jest.advanceTimersByTimeAsync(101);

      expect(replacement.createdAt).not.toBe(predecessor.createdAt);
      expect(await store.cleanup()).toBe(1);
      expect(await store.hasJob('s1')).toBe(false);

      await store.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reap a running job within the staleJobTimeout', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ staleJobTimeout: 60000 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1');

    const removed = await store.cleanup();

    expect(removed).toBe(0);
    expect(await store.hasJob('s1')).toBe(true);

    await store.destroy();
  });

  it('treats staleJobTimeout=0 as disabling the running-job failsafe', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ staleJobTimeout: 0 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1');
    await store.updateJob('s1', { createdAt: Date.now() - 3_600_000 });

    const removed = await store.cleanup();

    expect(removed).toBe(0);
    expect(await store.hasJob('s1')).toBe(true);

    await store.destroy();
  });

  it('removes per-user tracking when reaping a stale running job', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ staleJobTimeout: 1000 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1');
    expect(await store.getActiveJobIdsByUser('u1')).toEqual(['s1']);

    await store.updateJob('s1', { createdAt: Date.now() - 5000 });
    await store.cleanup();

    expect(await store.getActiveJobIdsByUser('u1')).toEqual([]);
    expect(await store.getJobCount()).toBe(0);

    await store.destroy();
  });

  it('parks 202-accepted steers before reaping a stale running job', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 });
    await store.initialize();

    await store.createJob('s1', 'u1', 's1', 'tenant-1');
    await store.enqueueSteer('s1', {
      steerId: 'sp1',
      text: 'crash survivor',
      userId: 'u1',
      createdAt: Date.now(),
    });

    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base + 5000);
    try {
      const removed = await store.cleanup();
      expect(removed).toBe(1);
      expect(await store.hasJob('s1')).toBe(false);

      // No finalization ever ran — the crashed run's queue must be claimable.
      const claimed = await store.claimParkedSteers('s1', 'u1', 'tenant-1');
      expect(claimed).toBeDefined();
      const parsed = JSON.parse(claimed as string) as {
        userId: string;
        tenantId?: string;
        steers: Array<{ steerId: string; text: string }>;
      };
      expect(parsed.userId).toBe('u1');
      expect(parsed.tenantId).toBe('tenant-1');
      expect(parsed.steers.map((steer) => steer.text)).toEqual(['crash survivor']);
    } finally {
      nowSpy.mockRestore();
    }

    await store.destroy();
  });

  it('reaps terminal jobs while leaving fresh running jobs intact', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 60000 });
    await store.initialize();

    await store.createJob('done', 'u1', 'done');
    await store.updateJob('done', { status: 'complete', completedAt: Date.now() });
    await store.createJob('live', 'u1', 'live');

    const removed = await store.cleanup();

    expect(removed).toBe(1);
    expect(await store.hasJob('done')).toBe(false);
    expect(await store.hasJob('live')).toBe(true);

    await store.destroy();
  });

  it('does not delete a replacement created while cleanup awaits an earlier victim', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 60000 });
    await store.initialize();

    const now = jest.spyOn(Date, 'now');
    const deleteJob = store.deleteJob.bind(store);
    let releaseFirstDelete!: () => void;
    let markFirstDeleteStarted!: () => void;
    const firstDeleteStarted = new Promise<void>((resolve) => {
      markFirstDeleteStarted = resolve;
    });
    const firstDeleteReleased = new Promise<void>((resolve) => {
      releaseFirstDelete = resolve;
    });

    try {
      now.mockReturnValue(100);
      await store.createJob('first-victim', 'u1');
      await store.updateJob('first-victim', { status: 'complete', completedAt: 100 });

      now.mockReturnValue(200);
      const originalLaterVictim = await store.createJob('later-victim', 'u1');
      await store.updateJob('later-victim', { status: 'complete', completedAt: 200 });

      jest.spyOn(store, 'deleteJob').mockImplementation(async (streamId, expectedCreatedAt) => {
        if (streamId === 'first-victim') {
          markFirstDeleteStarted();
          await firstDeleteReleased;
        }
        return deleteJob(streamId, expectedCreatedAt);
      });

      now.mockReturnValue(1000);
      const cleanup = store.cleanup();
      await firstDeleteStarted;

      now.mockReturnValue(2000);
      const replacement = await store.createJob('later-victim', 'u1');
      releaseFirstDelete();
      await cleanup;

      expect(replacement.createdAt).not.toBe(originalLaterVictim.createdAt);
      await expect(store.getJob('first-victim')).resolves.toBeNull();
      await expect(store.getJob('later-victim')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    } finally {
      now.mockRestore();
      await store.destroy();
    }
  });
});

describe('GenerationJobManager - generation abort on reaping', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('aborts and cleans up a hung running job once the store reaps it', async () => {
    const { GenerationJobManagerClass } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    jest.useFakeTimers();
    try {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();

      const job = await manager.createJob('conv-2', 'user-1', 'conv-2');
      expect(await manager.hasJob('conv-2')).toBe(true);
      expect(job.abortController.signal.aborted).toBe(false);

      // Advance past the stale timeout + the 60s cleanup interval.
      await jest.advanceTimersByTimeAsync(61000);

      expect(job.abortController.signal.aborted).toBe(true);
      expect(await manager.hasJob('conv-2')).toBe(false);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
      expect(manager.getRuntimeStats().eventTransportStreams).toBe(0);

      await manager.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends a terminal error to a still-connected client when its job is reaped', async () => {
    const { GenerationJobManagerClass } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    jest.useFakeTimers();
    try {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();

      await manager.createJob('conv-3', 'user-1', 'conv-3');
      const errors: string[] = [];
      const subscription = await manager.subscribe(
        'conv-3',
        () => undefined,
        () => undefined,
        (error) => errors.push(error),
      );

      // Hung generation: no chunks emitted; advance past the stale timeout + cleanup tick.
      await jest.advanceTimersByTimeAsync(61000);

      expect(errors).toContain('Generation timed out');
      expect(await manager.hasJob('conv-3')).toBe(false);

      subscription?.unsubscribe();
      await manager.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reap a replacement runtime from a stale hasJob result', async () => {
    const { GenerationJobManagerClass } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: transport,
      isRedis: false,
    });
    manager.initialize();

    const streamId = 'replacement-during-cleanup';
    const original = await manager.createJob(streamId, 'user-1', streamId);

    let releaseHasJob!: (exists: boolean) => void;
    let markHasJobStarted!: () => void;
    const hasJobStarted = new Promise<void>((resolve) => {
      markHasJobStarted = resolve;
    });
    const hasJobSpy = jest.spyOn(store, 'hasJob').mockImplementationOnce(() => {
      markHasJobStarted();
      return new Promise<boolean>((resolve) => {
        releaseHasJob = resolve;
      });
    });

    try {
      const cleanupPromise = (
        manager as unknown as {
          cleanup: () => Promise<void>;
        }
      ).cleanup();
      await hasJobStarted;

      // The old lookup is still in flight while a fresh generation replaces
      // both the store record and the manager's runtime under the same ID.
      const replacement = await manager.createJob(streamId, 'user-1', streamId);
      releaseHasJob(false);
      await cleanupPromise;

      expect(original.abortController.signal.aborted).toBe(true);
      expect(replacement.abortController.signal.aborted).toBe(false);
      expect(await manager.hasJob(streamId)).toBe(true);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(manager.getRuntimeStats().eventTransportStreams).toBe(1);
    } finally {
      hasJobSpy.mockRestore();
      await manager.destroy();
    }
  });

  it('keeps the predecessor subscription attached when reaper publication is fenced', async () => {
    const { GenerationJobManagerClass } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
    const { GenerationPublicationFencedError } = await import('../interfaces/IJobStore');

    jest.useFakeTimers();
    try {
      const store = new InMemoryJobStore({ ttlAfterComplete: 0, staleJobTimeout: 1000 });
      const transport = new InMemoryEventTransport();
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
      manager.initialize();

      const streamId = 'replacement-during-reaper-publication';
      const predecessor = await manager.createJob(streamId, 'user-1', streamId);
      const onDone = jest.fn();
      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, onDone, onError);
      let successorCreatedAt = 0;
      jest.spyOn(transport, 'emitError').mockImplementation(async () => {
        const successor = await store.createJob(streamId, 'user-1', streamId);
        successorCreatedAt = successor.createdAt;
        throw new GenerationPublicationFencedError('error', streamId, predecessor.createdAt);
      });

      await jest.advanceTimersByTimeAsync(2000);
      await (
        manager as unknown as {
          cleanup: () => Promise<void>;
        }
      ).cleanup();

      expect(onError).not.toHaveBeenCalled();
      expect(transport.getSubscriberCount(streamId)).toBe(1);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);
      await transport.emitDone(
        streamId,
        { final: true, generationCreatedAt: successorCreatedAt },
        predecessor.createdAt,
      );
      expect(onDone).toHaveBeenCalledWith({
        final: true,
        generationCreatedAt: successorCreatedAt,
      });
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);

      subscription?.unsubscribe();
      await manager.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
