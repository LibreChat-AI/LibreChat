import type { SendCommandFn } from 'rate-limit-redis';
import { createClusterSafeSendCommand } from '../limiterSendCommand';

describe('createClusterSafeSendCommand', () => {
  it('falls back to EVAL with the cached script when a cluster node returns NOSCRIPT', async () => {
    const execute = jest.fn<ReturnType<SendCommandFn>, Parameters<SendCommandFn>>();
    execute
      .mockResolvedValueOnce('script-sha')
      .mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'))
      .mockResolvedValueOnce([1, 60_000]);
    const sendCommand = createClusterSafeSendCommand(execute);
    const script = 'return redis.call("INCR", KEYS[1])';

    await expect(sendCommand('SCRIPT', 'LOAD', script)).resolves.toBe('script-sha');
    await expect(sendCommand('EVALSHA', 'script-sha', '1', 'limiter:key')).resolves.toEqual([
      1, 60_000,
    ]);

    expect(execute).toHaveBeenNthCalledWith(2, 'EVALSHA', 'script-sha', '1', 'limiter:key');
    expect(execute).toHaveBeenNthCalledWith(3, 'EVAL', script, '1', 'limiter:key');
  });
});
