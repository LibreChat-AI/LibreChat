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
    expect(lease.renewResourceLock).toHaveBeenCalledTimes(2);
  });

  it.each(['fence', 'heartbeat'] as const)(
    'does not renew again after definitive ownership loss from a %s',
    async (trigger) => {
      jest.useFakeTimers();
      const lease = {
        acquireResourceLock: jest.fn().mockResolvedValue(true),
        renewResourceLock: jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
        releaseResourceLock: jest.fn().mockResolvedValue(true),
      };

      await expect(
        withLease(lease, 'k', async (fence) => {
          if (trigger === 'heartbeat') {
            await jest.advanceTimersByTimeAsync(10_000);
          } else {
            await expect(fence()).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' });
          }
          await expect(fence()).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' });
          await jest.advanceTimersByTimeAsync(10_000);
          await fence();
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' });

      expect(lease.renewResourceLock).toHaveBeenCalledTimes(1);
      expect(lease.releaseResourceLock).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('turns a lock-store failure on acquire into the unavailable error', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockRejectedValue(new Error('mongo secret detail')),
      renewResourceLock: jest.fn(),
      releaseResourceLock: jest.fn(),
    };
    const callback = jest.fn(async () => 'x');

    await expect(withLease(lease, 'k', callback)).rejects.toMatchObject({
      statusCode: 503,
      code: 'RESOURCE_PERMISSIONS_UNAVAILABLE',
      message: expect.not.stringContaining('secret'),
    });

    expect(callback).not.toHaveBeenCalled();
    expect(lease.renewResourceLock).not.toHaveBeenCalled();
    expect(lease.releaseResourceLock).not.toHaveBeenCalled();
  });

  it('honors configured wait and TTL limits', async () => {
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(false),
      renewResourceLock: jest.fn().mockResolvedValue(true),
      releaseResourceLock: jest.fn().mockResolvedValue(true),
    };
    const callback = jest.fn(async () => 'x');
    const started = Date.now();
    await expect(withLease(lease, 'k', callback, { waitMs: 0 })).rejects.toMatchObject({
      code: 'RESOURCE_PERMISSIONS_BUSY',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(lease.renewResourceLock).not.toHaveBeenCalled();
    expect(lease.releaseResourceLock).not.toHaveBeenCalled();

    lease.acquireResourceLock.mockResolvedValue(true);
    await withLease(lease, 'k', async () => 'x', { ttlMs: 12_345 });
    expect(lease.acquireResourceLock).toHaveBeenLastCalledWith(
      expect.objectContaining({ ttlMs: 12_345 }),
    );
  });

  it('never invokes the callback when acquisition remains denied through the wait limit', async () => {
    jest.useFakeTimers();
    const lease = {
      acquireResourceLock: jest.fn().mockResolvedValue(false),
      renewResourceLock: jest.fn(),
      releaseResourceLock: jest.fn(),
    };
    const callback = jest.fn(async () => 'x');
    const denied = withLease(lease, 'k', callback, { waitMs: 100 });

    await Promise.all([
      expect(denied).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' }),
      jest.advanceTimersByTimeAsync(100),
    ]);

    expect(lease.acquireResourceLock).toHaveBeenCalledTimes(3);
    expect(callback).not.toHaveBeenCalled();
    expect(lease.renewResourceLock).not.toHaveBeenCalled();
    expect(lease.releaseResourceLock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'preserves a callback error and stops renewal when release fails: %s',
    async (releaseFails) => {
      jest.useFakeTimers();
      const error = new Error('callback failed');
      const lease = {
        acquireResourceLock: jest.fn().mockResolvedValue(true),
        renewResourceLock: jest.fn().mockResolvedValue(true),
        releaseResourceLock: jest.fn().mockResolvedValue(true),
      };
      if (releaseFails) {
        lease.releaseResourceLock.mockRejectedValue(new Error('mongo secret detail'));
      }
      (logger.error as jest.Mock).mockClear();

      await expect(
        withLease(lease, 'k', async (fence) => {
          await fence();
          throw error;
        }),
      ).rejects.toBe(error);
      await jest.advanceTimersByTimeAsync(60_000);

      const { ownerId } = lease.acquireResourceLock.mock.calls[0][0];
      expect(lease.releaseResourceLock).toHaveBeenCalledTimes(1);
      expect(lease.releaseResourceLock).toHaveBeenCalledWith({ key: 'k', ownerId });
      expect(lease.renewResourceLock).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(releaseFails ? 1 : 0);
      expect(inspect((logger.error as jest.Mock).mock.calls)).not.toContain('secret');
    },
  );

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
