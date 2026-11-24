import type { RedisFinalizationRecovery } from './redisOutage';
import { retryRedisFinalization } from './redisOutage';

const outage = new Error('Connection is closed.');

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => jest.useRealTimers());

it('starts the clock on the first transient failure and shares it across settlement phases', async () => {
  const recovery: RedisFinalizationRecovery = { timeoutMs: 350 };
  await jest.advanceTimersByTimeAsync(120_000);
  const claim = jest.fn().mockRejectedValueOnce(outage).mockResolvedValue('claimed');
  const claimed = retryRedisFinalization(recovery, claim);
  await jest.advanceTimersByTimeAsync(100);
  await expect(claimed).resolves.toBe('claimed');
  expect(recovery.deadline).toBe(120_350);

  // Mongo persistence is not retried; its elapsed time also does not reset the budget.
  await jest.advanceTimersByTimeAsync(150);
  const publish = jest.fn().mockRejectedValue(outage);
  await expect(retryRedisFinalization(recovery, publish)).rejects.toBe(outage);
  expect(publish).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(100);
  const drain = jest.fn().mockResolvedValue(true);
  await expect(retryRedisFinalization(recovery, drain)).resolves.toBe(true);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(recovery.deadline).toBe(120_350);
});

it('does not arm the window for successful or non-transient operations and honors zero', async () => {
  const recovery: RedisFinalizationRecovery = { timeoutMs: 350 };
  await expect(retryRedisFinalization(recovery, async () => true)).resolves.toBe(true);
  const corruption = new Error('WRONGTYPE');
  await expect(
    retryRedisFinalization(recovery, async () => {
      throw corruption;
    }),
  ).rejects.toBe(corruption);
  expect(recovery.deadline).toBeUndefined();
  const write = jest.fn().mockRejectedValue(outage);
  await expect(retryRedisFinalization({ timeoutMs: 0 }, write)).rejects.toBe(outage);
  expect(write).toHaveBeenCalledTimes(1);
});
