import { createIdleRecoveryLoop } from './recovery';

describe('durable agent idle recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T00:00:00Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('backs off only after empty passes and wakes without waiting for the idle ceiling', async () => {
    const scan = jest.fn(async () => true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(scan).toHaveBeenCalledTimes(3);
    loop.wake();
    await jest.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(scan).toHaveBeenCalledTimes(4);
    await loop.stop();
  });

  it('never lets an in-flight empty result discard a wake or start overlapping scans', async () => {
    let release!: (idle: boolean) => void;
    const scan = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    const first = loop.start();
    await jest.advanceTimersByTimeAsync(0);
    loop.wake();
    loop.wake();
    expect(scan).toHaveBeenCalledTimes(1);
    release(true);
    await first;
    await jest.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(2);
    release(true);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(3);
    release(false);
    await loop.stop();
  });

  it('scans at the base cadence after a failed or nonempty pass', async () => {
    const onError = jest.fn();
    const scan = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError,
    });
    await loop.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(4);
    await loop.stop();
  });

  it('scans at known eligibility times rather than sleeping past deferred work', async () => {
    const scan = jest.fn(async () => true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    const now = Date.now();
    loop.noteEligibleAt(new Date(now + 14_000));
    loop.noteEligibleAt(new Date(now + 5_000));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(9_000);
    expect(scan).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it('discovers work written by another replica without a process-local wake', async () => {
    let hasWork = false;
    const scan = jest.fn(async () => !hasWork);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);
    hasWork = true;
    await jest.advanceTimersByTimeAsync(119_999);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(4);
    await loop.stop();
  });

  it('never postpones the bounded fallback scan when a later deadline is learned', async () => {
    const scan = jest.fn(async () => true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    await jest.advanceTimersByTimeAsync(59_000);
    loop.noteEligibleAt(new Date(Date.now() + 120_000));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it.each([false, true])(
    'rescans for a deadline that expires in-flight (stop: %s)',
    async (stop) => {
      let release!: (idle: boolean) => void;
      const scan = jest
        .fn<Promise<boolean>, []>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(true);
      const loop = createIdleRecoveryLoop({
        intervalMs: 30_000,
        maxIdleIntervalMs: 120_000,
        scan,
        onError: jest.fn(),
      });
      const starting = loop.start();
      await jest.advanceTimersByTimeAsync(0);
      loop.noteEligibleAt(new Date(Date.now() + 5_000));
      loop.noteEligibleAt(new Date(Date.now() + 20_000));
      await jest.advanceTimersByTimeAsync(6_000);
      expect(scan).toHaveBeenCalledTimes(1);
      const stopping = stop ? loop.stop() : undefined;
      release(false);
      await starting;
      await stopping;
      await jest.advanceTimersByTimeAsync(0);
      expect(scan).toHaveBeenCalledTimes(stop ? 1 : 2);
      await jest.advanceTimersByTimeAsync(14_000);
      expect(scan).toHaveBeenCalledTimes(stop ? 1 : 3);
      await loop.stop();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does not rescan or reset its idle timer when start is called twice', async () => {
    const scan = jest.fn(async () => true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    await jest.advanceTimersByTimeAsync(59_000);
    await loop.start();
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it('waits for its active scan on shutdown and never rearms a timer', async () => {
    let release!: (value: boolean) => void;
    const scan = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      scan,
      onError: jest.fn(),
    });
    const started = loop.start();
    await jest.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    loop.wake();
    expect(stopped).toBe(false);
    release(true);
    await Promise.all([started, stopping]);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(stopped).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('delays its first scan by the initial delay, and a wake still runs it at once', async () => {
    const scan = jest.fn(async () => true);
    const delayed = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      initialDelayMs: 300_000,
      scan,
      onError: jest.fn(),
    });
    await delayed.start();
    expect(scan).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(299_999);
    expect(scan).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(1);
    /** The delay applies once: an idle first scan then backs off from the base interval. */
    await jest.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await delayed.stop();

    const woken = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      initialDelayMs: 300_000,
      scan,
      onError: jest.fn(),
    });
    await woken.start();
    woken.wake();
    await jest.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(3);
    await woken.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('spreads every wait, the first one included, by less than the jitter', async () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const scan = jest.fn(async () => true);
    const loop = createIdleRecoveryLoop({
      intervalMs: 30_000,
      maxIdleIntervalMs: 120_000,
      jitterMs: 10_000,
      initialDelayMs: 10_000,
      scan,
      onError: jest.fn(),
    });
    await loop.start();
    await jest.advanceTimersByTimeAsync(14_999);
    expect(scan).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(1);
    /** The idle wait doubles to 60 s, plus the 5 s jitter. */
    await jest.advanceTimersByTimeAsync(64_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
    /** The ceiling bounds the wait before the jitter is added. */
    await jest.advanceTimersByTimeAsync(124_999);
    expect(scan).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
    await loop.stop();
    random.mockRestore();
  });

  it.each([-1, 1.5, Number.NaN])('rejects an invalid jitter or initial delay (%s)', (value) => {
    const options = {
      intervalMs: 1_000,
      maxIdleIntervalMs: 2_000,
      scan: jest.fn(async () => true),
      onError: jest.fn(),
    };
    expect(() => createIdleRecoveryLoop({ ...options, jitterMs: value })).toThrow(TypeError);
    expect(() => createIdleRecoveryLoop({ ...options, initialDelayMs: value })).toThrow(TypeError);
  });

  describe('hint', () => {
    const start = async (scan = jest.fn(async () => true)) => {
      const loop = createIdleRecoveryLoop({
        intervalMs: 30_000,
        maxIdleIntervalMs: 120_000,
        scan,
        onError: jest.fn(),
      });
      await loop.start();
      return { loop, scan };
    };

    it('costs one scan per interval however often it is called', async () => {
      const { loop, scan } = await start();

      /** A hint every second for 90 s, each asking for a look one interval later. */
      for (let second = 0; second < 90; second += 1) {
        loop.hint(new Date(Date.now() + 30_000));
        await jest.advanceTimersByTimeAsync(1_000);
      }

      /** Scans at 0, 30, 60 and 90 s, where `noteEligibleAt` would have kept every deadline. */
      expect(scan).toHaveBeenCalledTimes(4);
      await loop.stop();
    });

    it('drops a time at or after a waiting deadline however far, and keeps an earlier one', async () => {
      const { loop, scan } = await start();
      loop.hint(new Date(Date.now() + 10_000));
      /** The scan at 10 s sees the same pending work, so a later time adds nothing. */
      loop.hint(new Date(Date.now() + 41_000));
      /** An earlier time is kept. */
      loop.hint(new Date(Date.now() + 5_000));

      await jest.advanceTimersByTimeAsync(4_999);
      expect(scan).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(scan).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(31_000);
      expect(scan).toHaveBeenCalledTimes(3);
      await loop.stop();
    });

    it('is not what work that becomes due later should use: noteEligibleAt keeps every time', async () => {
      const { loop, scan } = await start();
      loop.noteEligibleAt(new Date(Date.now() + 10_000));
      loop.noteEligibleAt(new Date(Date.now() + 41_000));

      await jest.advanceTimersByTimeAsync(10_000);
      expect(scan).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(31_000);
      expect(scan).toHaveBeenCalledTimes(3);
      await loop.stop();
    });

    it('runs a scan at once for a time that has passed, like noteEligibleAt', async () => {
      const { loop, scan } = await start();
      loop.hint(new Date(Date.now() - 1));
      await jest.advanceTimersByTimeAsync(0);
      expect(scan).toHaveBeenCalledTimes(2);
      await loop.stop();
    });

    it('ignores an invalid time and a hint after stop', async () => {
      const { loop, scan } = await start();
      loop.hint(new Date(Number.NaN));
      await loop.stop();
      loop.hint(new Date(Date.now() + 1_000));
      await jest.advanceTimersByTimeAsync(600_000);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
