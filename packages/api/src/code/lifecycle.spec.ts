import mongoose from 'mongoose';
import { startCodeEnvironmentLifecycleReconciler } from './lifecycle';
import { isLeader } from '~/cluster';

jest.mock('~/cluster', () => ({ isLeader: jest.fn() }));

describe('code environment lifecycle scheduler', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('runs reconciliation only on the elected API replica', async () => {
    jest.useFakeTimers();
    const leader = jest.mocked(isLeader);
    leader.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    startCodeEnvironmentLifecycleReconciler({ mongoose });
    await jest.advanceTimersByTimeAsync(0);

    expect(leader).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(leader).toHaveBeenCalledTimes(2);
  });
});
