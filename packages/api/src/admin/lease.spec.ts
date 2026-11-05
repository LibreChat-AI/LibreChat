import { inspect } from 'util';
import { logger } from '@librechat/data-schemas';
import { grantLeaseKey, withLease } from './lease';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe('withLease', () => {
  afterEach(() => jest.useRealTimers());

  it('renews the lease while the callback is still running', async () => {
    jest.useFakeTimers();
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(true),
      renewResourceLock: jest.fn().mockResolvedValue(true),
      releaseResourceLock: jest.fn().mockResolvedValue(true),
    };
    const run = withLease(
      lease,
      'k',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 25_000)),
    );

    await jest.advanceTimersByTimeAsync(25_000);

    await expect(run).resolves.toBe('done');
    expect(lease.renewResourceLock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lease.releaseResourceLock).toHaveBeenCalledTimes(1);
  });

  it('does not lose the lease on a transient renewal error', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(true),
      renewResourceLock: jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(true),
      releaseResourceLock: jest.fn().mockResolvedValue(true),
    };
    await expect(
      withLease(lease, 'k', async (fence) => {
        await expect(fence()).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_UNAVAILABLE' });
        await fence();
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });

  it('turns a lock-store failure on acquire into the unavailable error', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockRejectedValue(new Error('mongo secret detail')),
      renewResourceLock: jest.fn(),
      releaseResourceLock: jest.fn(),
    };
    await expect(withLease(lease, 'k', async () => 'x')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.not.stringContaining('secret'),
    });
  });

  it('honors configured wait and TTL limits', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(false),
      renewResourceLock: jest.fn().mockResolvedValue(true),
      releaseResourceLock: jest.fn().mockResolvedValue(true),
    };
    const started = Date.now();
    await expect(withLease(lease, 'k', async () => 'x', { waitMs: 0 })).rejects.toMatchObject({
      code: 'RESOURCE_PERMISSIONS_BUSY',
    });
    expect(Date.now() - started).toBeLessThan(1000);

    lease.acquireResourceLock.mockResolvedValue(true);
    await withLease(lease, 'k', async () => 'x', { ttlMs: 12_345 });
    expect(lease.acquireResourceLock).toHaveBeenLastCalledWith(
      expect.objectContaining({ ttlMs: 12_345 }),
    );
  });

  it('logs a failed release with safe metadata and still returns the result', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(true),
      renewResourceLock: jest.fn().mockResolvedValue(true),
      releaseResourceLock: jest.fn().mockRejectedValue(new Error('mongo secret detail')),
    };
    (logger.error as jest.Mock).mockClear();

    await expect(withLease(lease, 'k', async () => 'ok')).resolves.toBe('ok');

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(inspect((logger.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('keys one grant the same for a user ObjectId in either case', () => {
    const hex = 'abcdef0123456789abcdef01';
    expect(grantLeaseKey('user', hex, 'cap')).toBe(grantLeaseKey('USER', hex.toUpperCase(), 'cap'));
  });

  it('keeps role names case-sensitive', () => {
    const hex = 'abcdef0123456789abcdef01';
    expect(grantLeaseKey('role', hex, 'cap')).not.toBe(
      grantLeaseKey('role', hex.toUpperCase(), 'cap'),
    );
  });
});
