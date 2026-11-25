import mongoose, { Types } from 'mongoose';
import { createMethods, logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import {
  noteCodeEnvironmentLifecycleWork,
  revokeUserCodeEnvironmentWorkers,
  startCodeEnvironmentLifecycleReconciler,
  stopCodeEnvironmentLifecycleReconciler,
} from './lifecycle';
import { isLeader } from '~/cluster';

jest.mock('~/cluster', () => ({ isLeader: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createMethods: jest.fn(),
}));

const leader = jest.mocked(isLeader);

describe('code environment lifecycle scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    leader.mockReset();
  });

  afterEach(async () => {
    await stopCodeEnvironmentLifecycleReconciler();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('runs reconciliation only on the elected API replica', async () => {
    leader.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose });
    await jest.advanceTimersByTimeAsync(0);

    expect(leader).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(leader).toHaveBeenCalledTimes(2);
  });

  test('keeps a follower at the base interval and never reconciles for it', async () => {
    leader.mockResolvedValue(false);
    const reconcile = jest.fn().mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(180_000);

    /** A follower reads no Mongo, so backing off would only slow a change of leader. */
    expect(leader).toHaveBeenCalledTimes(4);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('backs off while a pass finds nothing and returns to the base interval on work', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    /** First idle pass: the wait doubles to 120 s. */
    await jest.advanceTimersByTimeAsync(119_999);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);

    /** Second idle pass: the wait reaches the 240 s ceiling. */
    await jest.advanceTimersByTimeAsync(239_999);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(3);

    /** That pass found work, so the next one is due after the base interval, as before. */
    await jest.advanceTimersByTimeAsync(59_999);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });

  test('logs a failed pass and retries at the base interval instead of backing off', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    leader.mockResolvedValue(true);
    const failure = new Error('mongo unavailable');
    const reconcile = jest
      .fn<Promise<boolean>, []>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);

    expect(error).toHaveBeenCalledWith(
      '[code-environments] lifecycle reconciliation failed:',
      failure,
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  test('is a no-op to start twice, and stop leaves no timer behind', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest.fn().mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await stopCodeEnvironmentLifecycleReconciler();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('scans again after one base interval when a producer leaves work behind', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest.fn().mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    /** The loop is now waiting 120 s, but the producer's work is due sooner. */
    noteCodeEnvironmentLifecycleWork();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  test('scans again when a pass defers a retry that falls before the idle wait ends', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest
      .fn<Promise<boolean>, [Parameters<typeof startCodeEnvironmentLifecycleReconciler>[0]]>()
      .mockImplementationOnce(async ({ onRetryAt }) => {
        onRetryAt?.(new Date(Date.now() + 90_000));
        return true;
      })
      .mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    /** An idle pass would wait 120 s; the deferred retry is due at 90 s. */
    await jest.advanceTimersByTimeAsync(89_999);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  test('answers a burst of producer hints with one scan per base interval', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest.fn().mockResolvedValue(true);
    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);

    /** A failed revocation every second for four minutes. */
    for (let second = 0; second < 240; second += 1) {
      noteCodeEnvironmentLifecycleWork();
      await jest.advanceTimersByTimeAsync(1_000);
    }

    /** Scans at 0, 60, 120, 180 and 240 s, not one per hint. */
    expect(reconcile).toHaveBeenCalledTimes(5);
  });

  test('scans at each retry time a pass reports', async () => {
    leader.mockResolvedValue(true);
    const reconcile = jest
      .fn<Promise<boolean>, [Parameters<typeof startCodeEnvironmentLifecycleReconciler>[0]]>()
      .mockImplementationOnce(async ({ onRetryAt }) => {
        onRetryAt?.(new Date(Date.now() + 90_000));
        onRetryAt?.(new Date(Date.now() + 100_000));
        return true;
      })
      .mockResolvedValue(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledTimes(3);

    /** Nothing else is due before the idle ceiling. */
    await jest.advanceTimersByTimeAsync(200_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  describe('worker revocation during account deletion', () => {
    const environment = {
      _id: new Types.ObjectId(),
      environmentId: 'env-1',
      baseURL: 'https://code.example.com',
      workerId: 'worker-1',
      workerPrincipal: { type: 'user', id: 'user-1' },
      revocationTokenEnv: 'CODE_ADMIN_TOKEN',
    };

    async function revokeWith(fetchImpl: jest.Mock) {
      jest.spyOn(logger, 'error').mockImplementation(() => logger);
      jest.mocked(createMethods).mockReturnValue({
        findCodeEnvironmentsByCreator: jest.fn(async () => [environment]),
      } as unknown as ReturnType<typeof createMethods>);
      const CodeEnvironment = { updateMany: jest.fn(), updateOne: jest.fn() };
      return revokeUserCodeEnvironmentWorkers({
        mongoose: { models: { CodeEnvironment } } as unknown as typeof mongoose,
        userId: 'user-1',
        appConfig: {} as AppConfig,
        readSecret: () => 'administrator-token',
        fetchImpl,
      });
    }

    test('keeps a failed revocation inside the base interval of the next scan', async () => {
      leader.mockResolvedValue(true);
      const reconcile = jest.fn().mockResolvedValue(true);
      startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
      await jest.advanceTimersByTimeAsync(0);
      expect(reconcile).toHaveBeenCalledTimes(1);

      await expect(
        revokeWith(jest.fn().mockRejectedValue(new Error('control plane unavailable'))),
      ).resolves.toBe(0);

      await jest.advanceTimersByTimeAsync(59_999);
      expect(reconcile).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    test('leaves the idle back-off alone when every revocation succeeds', async () => {
      leader.mockResolvedValue(true);
      const reconcile = jest.fn().mockResolvedValue(true);
      startCodeEnvironmentLifecycleReconciler({ mongoose }, { reconcile });
      await jest.advanceTimersByTimeAsync(0);

      await expect(
        revokeWith(
          jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ protocolVersion: 1, revoked: true }),
          }),
        ),
      ).resolves.toBe(1);

      await jest.advanceTimersByTimeAsync(119_999);
      expect(reconcile).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });
  });
});
