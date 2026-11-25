import type { SteerQueueItem } from '../interfaces/IJobStore';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

type ParkedMap = Map<string, { payload: string; expiresAt: number }>;

function parkedMap(store: InMemoryJobStore): ParkedMap {
  return (store as unknown as { parkedSteers: ParkedMap }).parkedSteers;
}

describe('InMemoryJobStore createJob ownership integrity', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore();
  });

  afterEach(async () => {
    await store.destroy();
  });

  test('refuses a cross-user replacement without disturbing the live generation', async () => {
    const streamId = 'create-owner-cross-user';
    const original = await store.createJob(streamId, 'owner-a', streamId, 'tenant-a');
    const steer: SteerQueueItem = {
      steerId: 'keep-me',
      text: 'must remain queued',
      userId: 'owner-a',
      createdAt: Date.now(),
    };
    await expect(store.enqueueSteer(streamId, steer, original.createdAt)).resolves.toBe(1);

    await expect(store.createJob(streamId, 'owner-b', streamId, 'tenant-a')).rejects.toThrow(
      /owner|ownership/i,
    );

    await expect(store.getJob(streamId)).resolves.toMatchObject({
      userId: 'owner-a',
      tenantId: 'tenant-a',
      createdAt: original.createdAt,
      status: 'running',
    });
    await expect(store.peekSteers(streamId, original.createdAt)).resolves.toEqual([steer]);
  });

  test('refuses a cross-tenant replacement for the same user', async () => {
    const streamId = 'create-owner-cross-tenant';
    const original = await store.createJob(streamId, 'owner', streamId, 'tenant-a');

    await expect(store.createJob(streamId, 'owner', streamId, 'tenant-b')).rejects.toThrow(
      /owner|tenant|ownership/i,
    );

    await expect(store.getJob(streamId)).resolves.toMatchObject({
      userId: 'owner',
      tenantId: 'tenant-a',
      createdAt: original.createdAt,
    });
  });

  test('allows a same-user legacy job to enter a tenant without leaking its membership', async () => {
    const streamId = 'create-owner-legacy-tenant';
    const legacy = await store.createJob(streamId, 'owner', streamId);
    const replacement = await store.createJob(streamId, 'owner', streamId, 'tenant-a');

    expect(replacement.createdAt).toBeGreaterThan(legacy.createdAt);
    await expect(store.getActiveJobIdsByUser('owner')).resolves.not.toContain(streamId);
    await expect(store.getActiveJobIdsByUser('owner', 'tenant-a')).resolves.toContain(streamId);
  });

  test.each([
    ['malformed JSON', '{not-json'],
    ['a scalar entry', JSON.stringify({ userId: 'owner', steers: [42] })],
    ['an item without steerId', JSON.stringify({ userId: 'owner', steers: [{ text: 'lost' }] })],
  ])('preserves parked recovery state containing %s', async (_name, payload) => {
    const streamId = `create-corrupt-parked-${String(_name).replaceAll(' ', '-')}`;
    parkedMap(store).set(streamId, { payload, expiresAt: Date.now() + 60_000 });

    await expect(store.createJob(streamId, 'owner', streamId)).rejects.toThrow(
      /recovery|parked|corrupt/i,
    );

    expect(parkedMap(store).get(streamId)?.payload).toBe(payload);
    await expect(store.getJob(streamId)).resolves.toBeNull();
  });

  test('preserves and refuses recovery state owned by another user', async () => {
    const streamId = 'create-foreign-parked';
    const payload = JSON.stringify({
      userId: 'owner-a',
      tenantId: 'tenant-a',
      steers: [{ steerId: 'recover-me', text: 'keep me', createdAt: Date.now() }],
    });
    parkedMap(store).set(streamId, { payload, expiresAt: Date.now() + 60_000 });

    await expect(store.createJob(streamId, 'owner-b', streamId, 'tenant-a')).rejects.toThrow(
      /owner|ownership/i,
    );

    expect(parkedMap(store).get(streamId)?.payload).toBe(payload);
    await expect(store.getJob(streamId)).resolves.toBeNull();
  });

  test('refuses to create an ownerless generation', async () => {
    await expect(store.createJob('create-ownerless', '', 'create-ownerless')).rejects.toThrow(
      /owner|user/i,
    );
    await expect(store.getJob('create-ownerless')).resolves.toBeNull();
  });

  test('keeps the generation epoch monotonic after delete under a frozen clock', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const streamId = 'create-monotonic-after-delete';
      const first = await store.createJob(streamId, 'owner', streamId);
      await expect(store.deleteJob(streamId, first.createdAt)).resolves.toBe(true);
      const second = await store.createJob(streamId, 'owner', streamId);

      expect(second.createdAt).toBeGreaterThan(first.createdAt);
      expect(second.checkpointNamespace).not.toBe(first.checkpointNamespace);
      expect(second.checkpointNamespace).not.toBe(String(second.createdAt));
    } finally {
      now.mockRestore();
    }
  });
});
