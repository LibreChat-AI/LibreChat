import { cadence, createSubscriptionReconciler } from './reconcile';

function setup(staleMs = 30 * 60_000) {
  const reconcile = jest.fn(async () => 0);
  const host = { reconcile, bounds: jest.fn(async () => ({ staleMs }) as never) };
  const reconciler = createSubscriptionReconciler(host);
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
