import { randomUUID } from 'crypto';
import type { RecoveredSteerPayload } from '../SteerRecovery';
import type { RedisTestClient } from './helpers/redis';
import { clearRedisTestPrefix, createRedisTestClient } from './helpers/redis';
import { RedisJobStore } from '../implementations/RedisJobStore';

const proof: RecoveredSteerPayload = { text: 'original words', fileIds: [], quotes: [] };
const source = { steerId: 'source', text: proof.text, createdAt: 1 };

describe('Redis recovery rejection reasons', () => {
  const prefix = `recovery-test:${randomUUID()}:`;
  let redis: RedisTestClient;
  let store: RedisJobStore;

  beforeAll(async () => {
    redis = createRedisTestClient(prefix);
    await redis.ping();
  });
  beforeEach(() => {
    store = new RedisJobStore(redis);
  });
  afterEach(async () => {
    await store.destroy();
    await clearRedisTestPrefix(redis, prefix);
  });
  afterAll(async () => {
    await redis.quit();
  });

  const recover = (payload = proof, generationProtocolVersion: 1 | 2 = 2, userId = 'owner') =>
    store.createJob(
      'conversation',
      userId,
      'conversation',
      undefined,
      { generationProtocolVersion },
      'source',
      undefined,
      undefined,
      undefined,
      payload,
    );

  const park = async (generationProtocolVersion: 1 | 2 = 2) => {
    const job = await store.createJob('conversation', 'owner', 'conversation', undefined, {
      generationProtocolVersion,
    });
    await store.parkSteers(
      'conversation',
      JSON.stringify({ userId: 'owner', steers: [source] }),
      job.createdAt,
    );
    return job;
  };

  test('missing source is a specific failure with no job creation', async () => {
    await expect(recover()).rejects.toMatchObject({
      code: 'RECOVERY_PAYLOAD_MISMATCH',
      reason: 'source_missing',
    });
    expect(await store.getJob('conversation')).toBeNull();
  });

  test('expired source does not become a genuine payload mismatch', async () => {
    await park();
    await redis.pexpire('stream:{conversation}:parked', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(recover()).rejects.toMatchObject({ reason: 'source_missing' });
  });

  test('consumed source cannot start a second generation', async () => {
    await park();
    const job = await recover();
    expect(
      await store.consumeParkedSteer('conversation', 'source', 'owner', undefined, job.createdAt),
    ).toBe(true);
    await expect(recover()).rejects.toMatchObject({ reason: 'source_missing' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
  });

  test.each([
    [1, 2],
    [2, 1],
  ] as const)(
    'source v%s with requester v%s reports protocol_mismatch',
    async (sourceVersion, requestVersion) => {
      const job = await park(sourceVersion);
      await expect(recover(proof, requestVersion)).rejects.toMatchObject({
        reason: 'protocol_mismatch',
      });
      expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
      expect(await redis.exists('stream:{conversation}:parked')).toBe(1);
    },
  );

  test('foreign recovery owner cannot mutate the source', async () => {
    const job = await park();
    await expect(recover(proof, 2, 'another-owner')).rejects.toMatchObject({
      reason: 'owner_mismatch',
    });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    expect(await redis.exists('stream:{conversation}:parked')).toBe(1);
  });

  test.each([
    { ...proof, text: 'changed words' },
    { ...proof, quotes: ['local excerpt never accepted'] },
    { ...proof, fileIds: ['another-file'] },
  ])('actual payload mismatch leaves the source recoverable', async (payload) => {
    const job = await park();
    await expect(recover(payload)).rejects.toMatchObject({ reason: 'payload_mismatch' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    expect(
      JSON.parse(
        (await store.claimParkedSteersDetailed('conversation', 'owner', undefined, 2))!.payload,
      ).steers,
    ).toEqual([source]);
  });

  test('invalid proof reports invalid_payload before changing state', async () => {
    await expect(
      store.createJob(
        'conversation',
        'owner',
        'conversation',
        undefined,
        { generationProtocolVersion: 2 },
        'source',
      ),
    ).rejects.toMatchObject({ reason: 'invalid_payload' });
    expect(await store.getJob('conversation')).toBeNull();
  });
});
