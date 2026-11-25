import { InMemoryJobStore, PARKED_STEERS_TTL_MS } from '../implementations/InMemoryJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { JobPredecessorMismatchError } from '../interfaces/IJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

function createConditionalJob(
  store: InMemoryJobStore,
  streamId: string,
  expectedPredecessorCreatedAt: number,
) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    { generationProtocolVersion: 2 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'conditional-create-attempt',
    expectedPredecessorCreatedAt,
  );
}

/** An automatic continuation must never replace a parent turn that is still live. */
function createWakeupJob(store: InMemoryJobStore, streamId: string) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    { generationProtocolVersion: 2 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'wakeup-create-attempt',
    undefined,
    true,
  );
}

describe('generation predecessor create fence', () => {
  test('in-memory admission refuses an active predecessor and admits a settled one', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'in-memory-active-predecessor-fence';
    try {
      const parent = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });

      await expect(createWakeupJob(store, streamId)).rejects.toBeInstanceOf(
        JobPredecessorMismatchError,
      );
      /** The controller needs the live state to answer a finite PARENT_NOT_READY. */
      await expect(createWakeupJob(store, streamId)).rejects.toMatchObject({
        currentJob: { active: true, verified: true, status: 'running' },
      });

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'requires_action',
          expectCreatedAt: parent.createdAt,
        }),
      ).resolves.toBe(true);
      await expect(createWakeupJob(store, streamId)).rejects.toMatchObject({
        currentJob: { active: true, status: 'requires_action' },
      });

      await expect(
        store.transitionStatus(streamId, {
          from: 'requires_action',
          to: 'aborted',
          expectCreatedAt: parent.createdAt,
        }),
      ).resolves.toBe(true);
      await store.updateJob(streamId, { terminalPersistencePending: true }, parent.createdAt);
      await expect(createWakeupJob(store, streamId)).rejects.toMatchObject({
        currentJob: { active: true, status: 'aborted' },
      });
      await store.updateJob(streamId, { terminalPersistencePending: false }, parent.createdAt);
      await store.updateJob(streamId, { terminalHostActionPending: true }, parent.createdAt);
      await expect(createWakeupJob(store, streamId)).rejects.toMatchObject({
        currentJob: { active: true, status: 'aborted' },
      });
      await expect(
        store.createJob(streamId, 'owner-1', streamId, undefined, {
          generationProtocolVersion: 2,
        }),
      ).rejects.toMatchObject({
        currentJob: { active: true, status: 'aborted' },
      });
      await store.updateJob(streamId, { terminalHostActionPending: false }, parent.createdAt);
      const wakeup = await createWakeupJob(store, streamId);
      expect(wakeup.createdAt).toBeGreaterThanOrEqual(parent.createdAt);
    } finally {
      await store.destroy();
    }
  });

  test('in-memory admission accepts an absent predecessor', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'in-memory-absent-predecessor-fence';
    try {
      const wakeup = await createWakeupJob(store, streamId);
      expect(wakeup.createdAt).toEqual(expect.any(Number));
    } finally {
      await store.destroy();
    }
  });

  test('in-memory ordinary turns still replace an active predecessor', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'in-memory-ordinary-replacement-unchanged';
    try {
      const first = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      /** Without the policy a user turn keeps replacing a running generation. */
      const second = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      expect(second.createdAt).toBeGreaterThanOrEqual(first.createdAt);
    } finally {
      await store.destroy();
    }
  });

  test('in-memory ordinary appends accept active states and reject retained terminal epochs', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'in-memory-terminal-append-fence';
    try {
      const job = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      await expect(store.appendChunk(streamId, { delta: 'running' }, job.createdAt)).resolves.toBe(
        true,
      );
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'requires_action',
          expectCreatedAt: job.createdAt,
        }),
      ).resolves.toBe(true);
      await expect(store.appendChunk(streamId, { delta: 'paused' }, job.createdAt)).resolves.toBe(
        true,
      );
      await expect(
        store.transitionStatus(streamId, {
          from: 'requires_action',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
        }),
      ).resolves.toBe(true);
      await expect(store.appendChunk(streamId, { delta: 'stale' }, job.createdAt)).resolves.toBe(
        false,
      );
    } finally {
      await store.destroy();
    }
  });

  test('in-memory mismatch rejects before replacing job, content, or queued work', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'predecessor-fence-no-mutation';
    try {
      const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      const content = [{ type: 'text', text: 'keep predecessor content' }];
      const queued = {
        steerId: 'keep-predecessor-steer',
        text: 'keep queued work',
        userId: 'owner-1',
        createdAt: Date.now(),
      };
      store.setContentParts(streamId, content, predecessor.createdAt);
      await expect(store.enqueueSteer(streamId, queued, predecessor.createdAt)).resolves.toBe(1);

      await expect(
        createConditionalJob(store, streamId, predecessor.createdAt + 1),
      ).rejects.toMatchObject({
        code: 'GENERATION_PREDECESSOR_MISMATCH',
        currentJob: {
          createdAt: predecessor.createdAt,
          active: true,
          verified: true,
          status: 'running',
          conversationId: streamId,
        },
      });

      await expect(store.getJob(streamId)).resolves.toMatchObject({
        createdAt: predecessor.createdAt,
        status: 'running',
      });
      await expect(store.getContentParts(streamId, predecessor.createdAt)).resolves.toEqual({
        content,
      });
      await expect(store.peekSteers(streamId, predecessor.createdAt)).resolves.toEqual([queued]);
    } finally {
      await store.destroy();
    }
  });

  test('a retained epoch matching the disappeared predecessor allows a new generation', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'predecessor-fence-absent-allowed';
    try {
      const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);

      const replacement = await createConditionalJob(store, streamId, predecessor.createdAt);
      expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    } finally {
      await store.destroy();
    }
  });

  test('expired predecessor evidence rejects conditionally without creating state', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'predecessor-fence-expired-evidence';
    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);
      nowSpy.mockReturnValue(base + PARKED_STEERS_TTL_MS + 1);

      await expect(
        createConditionalJob(store, streamId, predecessor.createdAt),
      ).rejects.toMatchObject({
        code: 'GENERATION_PREDECESSOR_MISMATCH',
        currentJob: {
          createdAt: predecessor.createdAt,
          active: false,
          verified: false,
        },
      });
      await expect(store.getJob(streamId)).resolves.toBeNull();
    } finally {
      nowSpy.mockRestore();
      await store.destroy();
    }
  });

  test('a retained intervening epoch rejects a delayed create after its job disappeared', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'predecessor-fence-retained-intervening';
    try {
      const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);

      const intervening = await store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      await expect(store.deleteJob(streamId, intervening.createdAt)).resolves.toBe(true);

      await expect(
        createConditionalJob(store, streamId, predecessor.createdAt),
      ).rejects.toMatchObject({
        code: 'GENERATION_PREDECESSOR_MISMATCH',
        currentJob: {
          createdAt: intervening.createdAt,
          active: false,
          verified: true,
        },
      });
      await expect(store.getJob(streamId)).resolves.toBeNull();
    } finally {
      await store.destroy();
    }
  });

  test.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected predecessor epoch %p without creating state',
    async (invalidEpoch) => {
      const store = new InMemoryJobStore();
      const streamId = 'predecessor-fence-invalid';
      try {
        await expect(createConditionalJob(store, streamId, invalidEpoch)).rejects.toThrow(
          'Invalid expected generation predecessor',
        );
        await expect(store.getJob(streamId)).resolves.toBeNull();
      } finally {
        await store.destroy();
      }
    },
  );

  test('manager propagates the typed mismatch without ambiguous-create recovery', async () => {
    const store = new InMemoryJobStore();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    const streamId = 'predecessor-fence-manager-propagation';
    try {
      const predecessor = await manager.createJob(streamId, 'owner-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const getJob = jest.spyOn(store, 'getJob');

      await expect(
        manager.createJob(streamId, 'owner-1', streamId, {
          expectedPredecessorCreatedAt: predecessor.createdAt + 1,
          initialMetadata: { generationProtocolVersion: 2 },
        }),
      ).rejects.toBeInstanceOf(JobPredecessorMismatchError);

      // One pre-create observation is expected. A generic create failure would
      // perform another read in recoverCommittedCreate and could misclassify a
      // deliberate no-mutation CAS rejection as an ambiguous committed write.
      expect(getJob).toHaveBeenCalledTimes(1);
      expect(predecessor.abortController.signal.aborted).toBe(false);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        createdAt: predecessor.createdAt,
        abortController: predecessor.abortController,
      });
    } finally {
      await manager.destroy();
    }
  });

  test('manager validates the expected epoch before observing durable state', async () => {
    const store = new InMemoryJobStore();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    const getJob = jest.spyOn(store, 'getJob');
    try {
      await expect(
        manager.createJob('predecessor-fence-manager-invalid', 'owner-1', undefined, {
          expectedPredecessorCreatedAt: -1,
        }),
      ).rejects.toThrow('Invalid expected generation predecessor');
      expect(getJob).not.toHaveBeenCalled();
    } finally {
      await manager.destroy();
    }
  });
});
