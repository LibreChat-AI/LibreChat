const mockLock = { acquire: jest.fn(), extend: jest.fn(), release: jest.fn() };
const mockCreateDistributedLock = jest.fn(() => mockLock);
const sentinelRedisClient = {};

jest.mock('@librechat/api', () => ({
  createDistributedLock: mockCreateDistributedLock,
  ioredisClient: sentinelRedisClient,
}));

describe('distributedLock', () => {
  it('builds the process-wide lock once with the shared Redis client', () => {
    const { distributedLock } = require('./distributedLock');

    expect(mockCreateDistributedLock).toHaveBeenCalledTimes(1);
    expect(mockCreateDistributedLock).toHaveBeenCalledWith({ redisClient: sentinelRedisClient });
    expect(distributedLock).toBe(mockLock);
  });
});
