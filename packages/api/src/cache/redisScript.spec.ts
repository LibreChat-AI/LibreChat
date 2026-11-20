import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { evalScript } from './redisScript';

function createClient() {
  const client = new Redis({ lazyConnect: true });
  const evalsha = jest.spyOn(client, 'evalsha').mockResolvedValue(1);
  const evalCommand = jest.spyOn(client, 'eval').mockResolvedValue(1);
  return { client, evalsha, evalCommand };
}

describe('independent Redis script execution', () => {
  test('uses the exact SHA and arguments without an EVAL on success', async () => {
    const { client, evalsha, evalCommand } = createClient();
    await expect(evalScript(client, 'return ARGV[1]', 1, '{key}', 'value')).resolves.toBe(1);
    expect(evalsha).toHaveBeenCalledWith(
      createHash('sha1').update('return ARGV[1]').digest('hex'),
      1,
      '{key}',
      'value',
    );
    expect(evalCommand).not.toHaveBeenCalled();
  });

  test('falls back once for both cold and previously successful scripts', async () => {
    const { client, evalsha, evalCommand } = createClient();
    evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    await expect(evalScript(client, 'return 1', 0)).resolves.toBe(1);
    await expect(evalScript(client, 'return 1', 0)).resolves.toBe(1);
    evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    await expect(evalScript(client, 'return 1', 0)).resolves.toBe(1);
    expect(evalsha).toHaveBeenCalledTimes(3);
    expect(evalCommand).toHaveBeenCalledTimes(2);
  });

  test.each([
    "NOPERM this user has no permissions to run the 'evalsha' command",
    "ERR unknown command 'evalsha', with args beginning with: 'sha'",
  ])('memoizes command-level EVAL-only compatibility: %s', async (message) => {
    const { client, evalsha, evalCommand } = createClient();
    evalsha.mockRejectedValueOnce(new Error(message));
    await expect(evalScript(client, 'return 1', 0)).resolves.toBe(1);
    await expect(evalScript(client, 'return 2', 0)).resolves.toBe(1);
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(evalCommand).toHaveBeenCalledTimes(2);
  });

  test.each([
    'READONLY replica cannot accept writes',
    'Connection is closed',
    'NOPERM this user has no permissions to access one of the keys used as arguments',
    'ERR Error running script: NOSCRIPT failure inside script',
    'ERR Error running script: NOPERM EVALSHA inside script',
  ])('does not replay an ambiguous or script-runtime failure: %s', async (message) => {
    const { client, evalsha, evalCommand } = createClient();
    evalsha.mockRejectedValueOnce(new Error(message));
    await expect(evalScript(client, 'return 1', 0)).rejects.toThrow(message);
    expect(evalCommand).not.toHaveBeenCalled();
  });

  test('propagates a failed EVAL fallback', async () => {
    const { client, evalsha, evalCommand } = createClient();
    evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    evalCommand.mockRejectedValueOnce(new Error('EVAL failed'));
    await expect(evalScript(client, 'return 1', 0)).rejects.toThrow('EVAL failed');
    expect(evalCommand).toHaveBeenCalledTimes(1);
  });

  test('dispatches concurrent warm calls without waiting for a predecessor', async () => {
    const { client, evalsha } = createClient();
    let release!: () => void;
    evalsha.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(1);
        }),
    );
    const first = evalScript(client, 'return 1', 1, '{same}key');
    await expect(evalScript(client, 'return 1', 1, '{same}key')).resolves.toBe(1);
    expect(evalsha).toHaveBeenCalledTimes(2);
    release();
    await expect(first).resolves.toBe(1);
  });
});
