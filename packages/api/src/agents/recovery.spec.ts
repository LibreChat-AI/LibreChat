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
});
