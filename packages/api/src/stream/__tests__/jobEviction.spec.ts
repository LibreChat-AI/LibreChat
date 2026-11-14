import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';

jest.spyOn(console, 'log').mockImplementation();

describe('InMemoryJobStore eviction at capacity', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 60000, maxJobs: 2 });
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('evicts a finished job before an older running one', async () => {
    await store.createJob('older-running', 'owner', 'older-running');
    const finished = await store.createJob('newer-finished', 'owner', 'newer-finished');
    await store.updateJob(
      'newer-finished',
      { status: 'complete', completedAt: Date.now() },
      finished.createdAt,
    );

    await store.createJob('incoming', 'owner', 'incoming');

    expect(await store.hasJob('older-running')).toBe(true);
    expect(await store.hasJob('newer-finished')).toBe(false);
    expect(await store.hasJob('incoming')).toBe(true);
  });

  it('still evicts the oldest job when every job is live', async () => {
    await store.createJob('oldest', 'owner', 'oldest');
    await store.createJob('newer', 'owner', 'newer');

    await store.createJob('incoming', 'owner', 'incoming');

    expect(await store.hasJob('oldest')).toBe(false);
    expect(await store.hasJob('newer')).toBe(true);
    expect(await store.hasJob('incoming')).toBe(true);
  });
});
