import { startIndexSyncScheduler } from './scheduler';

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('startIndexSyncScheduler', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('runs startup and periodic checks without overlap', async () => {
    jest.useFakeTimers();
    const startup = createDeferred();
    const run = jest.fn((reason: 'startup' | 'periodic') =>
      reason === 'startup' ? startup.promise : Promise.resolve(),
    );
    const onError = jest.fn();

    const scheduler = startIndexSyncScheduler({ run, onError, intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith('startup', expect.any(AbortSignal));

    await jest.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);

    startup.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith('periodic', expect.any(AbortSignal));
    expect(onError).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  test('reports failures and continues scheduling', async () => {
    jest.useFakeTimers();
    const error = new Error('sync failed');
    const run = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = jest.fn();

    const scheduler = startIndexSyncScheduler({ run, onError, intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);

    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  test('stops future scheduling and awaits cancellation of the active run', async () => {
    jest.useFakeTimers();
    const cancelled = createDeferred();
    const run = jest.fn((_reason: 'startup' | 'periodic', signal: AbortSignal) => {
      signal.addEventListener('abort', cancelled.resolve, { once: true });
      return cancelled.promise;
    });
    const onError = jest.fn();

    const scheduler = startIndexSyncScheduler({ run, onError, intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(0);

    await scheduler.stop();
    await jest.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  test('does not start a queued invocation after stop begins', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const scheduler = startIndexSyncScheduler({ run, onError: jest.fn(), intervalMs: 1000 });

    await scheduler.stop();

    expect(run).not.toHaveBeenCalled();
  });

  test('does not report stopped until non-cooperative work settles', async () => {
    const work = createDeferred();
    const run = jest.fn(() => work.promise);
    const scheduler = startIndexSyncScheduler({ run, onError: jest.fn(), intervalMs: 1000 });
    await Promise.resolve();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    work.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });
});
