import { cadence, createSubscriptionReconciler } from './reconcile';

function setup(staleMs = 30 * 60_000, canArm = () => true) {
  const reconcile = jest.fn(async () => 0);
  const host = { reconcile, bounds: jest.fn(async () => ({ staleMs }) as never) };
  const reconciler = createSubscriptionReconciler(host, canArm);
  return { reconciler, reconcile, host };
}

afterEach(() => jest.useRealTimers());

describe('cadence', () => {
  it('runs a pass every third of the stale age, between one and ten minutes', () => {
    expect(cadence({ staleMs: 30 * 60_000 })).toBe(600_000);
    expect(cadence({ staleMs: 6 * 60_000 })).toBe(120_000);
    expect(cadence({ staleMs: 60_000 })).toBe(60_000);
    expect(cadence({ staleMs: 24 * 60 * 60_000 })).toBe(600_000);
  });
});

describe('createSubscriptionReconciler', () => {
  it("answers one pass on demand with what the host's pass finished", async () => {
    const { reconciler, reconcile } = setup();
    reconcile.mockResolvedValueOnce(3);
    await expect(reconciler.pass()).resolves.toBe(3);
  });

  it('starts no timer until it is initialized, then passes on its cadence', async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup(6 * 60_000);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(reconcile).not.toHaveBeenCalled();
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });

  it("never starts in a process that cannot see every replica's generations", async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup(6 * 60_000, () => false);
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(1_200_000);
    expect(reconcile).not.toHaveBeenCalled();
    await reconciler.stop();
  });

  it('is armed by default only where the scheduler would be', async () => {
    jest.useFakeTimers();
    const before = process.env.SCHEDULES_SINGLE_PROCESS;
    const reconcile = jest.fn(async () => 0);
    const host = { reconcile, bounds: jest.fn(async () => ({ staleMs: 360_000 }) as never) };
    try {
      delete process.env.SCHEDULES_SINGLE_PROCESS;
      const unsafe = createSubscriptionReconciler(host);
      unsafe.initialize();
      await jest.advanceTimersByTimeAsync(240_000);
      expect(reconcile).not.toHaveBeenCalled();
      process.env.SCHEDULES_SINGLE_PROCESS = 'true';
      const single = createSubscriptionReconciler(host);
      single.initialize();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      await single.stop();
    } finally {
      if (before == null) delete process.env.SCHEDULES_SINGLE_PROCESS;
      else process.env.SCHEDULES_SINGLE_PROCESS = before;
    }
  });

  it('passes no more once stopped, and is not started again', async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup(6 * 60_000);
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(120_000);
    await reconciler.stop();
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(1_200_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('keeps passing after a pass fails', async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup(6 * 60_000);
    reconcile.mockRejectedValueOnce(new Error('store down'));
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(240_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });
});
