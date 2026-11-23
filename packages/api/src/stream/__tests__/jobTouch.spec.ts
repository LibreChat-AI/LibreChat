import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

describe('GenerationJobManager.touchJob', () => {
  const streamId = 'silent-run';
  let manager: GenerationJobManagerClass;
  let jobStore: InMemoryJobStore;

  beforeEach(() => {
    jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000, staleJobTimeout: 1000 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  /** Moves the clock past the stale cutoff, the way a long silent tool call would. */
  const elapse = (ms: number) => {
    const base = Date.now();
    return jest.spyOn(Date, 'now').mockImplementation(() => base + ms);
  };

  it('reaps a silent running job that nobody touches', async () => {
    await manager.createJob(streamId, 'owner', streamId);
    const clock = elapse(5000);
    try {
      await jobStore.cleanup();
    } finally {
      clock.mockRestore();
    }

    expect(await jobStore.hasJob(streamId)).toBe(false);
  });

  it('keeps a silent running job alive once its owner touches it', async () => {
    const job = await manager.createJob(streamId, 'owner', streamId);
    const clock = elapse(5000);
    try {
      await expect(manager.touchJob(streamId, job.createdAt)).resolves.toBe(true);
      await jobStore.cleanup();
    } finally {
      clock.mockRestore();
    }

    expect(await jobStore.hasJob(streamId)).toBe(true);
  });

  it('refuses a touch for another generation of the same stream', async () => {
    const job = await manager.createJob(streamId, 'owner', streamId);

    await expect(manager.touchJob(streamId, job.createdAt - 1)).resolves.toBe(false);
  });

  it('refuses a touch once the job has finished', async () => {
    const job = await manager.createJob(streamId, 'owner', streamId);
    await manager.completeJob(streamId);

    await expect(manager.touchJob(streamId, job.createdAt)).resolves.toBe(false);
    await expect(jobStore.touchJob(streamId, job.createdAt)).resolves.toBe(false);
  });

  it('refuses a touch for a stream this manager does not own', async () => {
    await expect(manager.touchJob('unknown', Date.now())).resolves.toBe(false);
  });
});
