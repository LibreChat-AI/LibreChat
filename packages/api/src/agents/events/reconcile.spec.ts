import { cadence, createSubscriptionReconciler } from './reconcile';

function setup(jobs: Record<string, string> = {}, staleMs = 30 * 60_000) {
  const states: unknown[] = [];
  const reconcile = jest.fn(
    async (job: (run: { conversationId?: string }) => Promise<string | null>) => {
      for (const conversationId of ['live', 'paused', 'done', 'gone', undefined]) {
        states.push(await job({ conversationId }));
      }
      return states.length;
    },
  );
  const host = { reconcile, bounds: jest.fn(async () => ({ staleMs }) as never) };
  const store = {
    getJob: jest.fn(async (id: string) => (id in jobs ? { status: jobs[id] } : null)),
  };
  const reconciler = createSubscriptionReconciler(host, { getJobStore: () => store });
  return { reconciler, reconcile, host, states };
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
  it("asks the generation job store what became of each run's generation", async () => {
    const { reconciler, states } = setup({
      live: 'running',
      paused: 'requires_action',
      done: 'complete',
    });
    await reconciler.pass();
    // A run with no conversation, or whose job is gone, has no generation to ask about.
    expect(states).toEqual(['running', 'requires_action', 'complete', null, null]);
  });

  it('starts no timer until it is initialized, then passes on its cadence', async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup({}, 6 * 60_000);
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
    const { reconciler, reconcile } = setup({}, 6 * 60_000);
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(120_000);
    await reconciler.stop();
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(1_200_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('keeps passing after a pass fails', async () => {
    jest.useFakeTimers();
    const { reconciler, reconcile } = setup({}, 6 * 60_000);
    reconcile.mockRejectedValueOnce(new Error('store down'));
    reconciler.initialize();
    await jest.advanceTimersByTimeAsync(240_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });
});
