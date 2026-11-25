jest.mock('~/cache/cacheConfig', () => ({ cacheConfig: { USE_REDIS: true } }));
jest.mock('~/cache/redisClients', () => ({
  ioredisClient: { get: jest.fn(), set: jest.fn(), eval: jest.fn() },
}));
jest.mock('~/cache/redisTelemetry', () => ({
  instrumentIORedisClient: (client: unknown) => client,
  RedisUseCases: { LEADER_ELECTION: 'leader' },
}));

import { ioredisClient } from '~/cache/redisClients';
import { LeaderElection } from './LeaderElection';

describe('concurrent leader ownership checks', () => {
  const election = new LeaderElection();
  const redis = ioredisClient as jest.Mocked<NonNullable<typeof ioredisClient>>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    election.clearRefreshTimer();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reports leadership to both startup callers after one wins SET NX', async () => {
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(election.UUID);
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const result = Promise.all([election.isLeader(), election.isLeader()]);
    await jest.advanceTimersByTimeAsync(0);
    expect(await result).toEqual([true, true]);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it.each(['another-process', null])(
    'does not claim another or missing lease: %s',
    async (owner) => {
      redis.get.mockResolvedValueOnce(null).mockResolvedValue(owner);
      redis.set.mockResolvedValue(null);
      const result = election.isLeader();
      await jest.advanceTimersByTimeAsync(0);
      expect(await result).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does not revive ownership without a renewal timer', async () => {
    redis.get.mockResolvedValueOnce(null).mockResolvedValue(election.UUID);
    redis.set.mockResolvedValue(null);
    const result = election.isLeader();
    await jest.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
  });
});
