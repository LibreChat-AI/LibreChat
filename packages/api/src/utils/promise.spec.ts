import { createConcurrencyLimiter, withTimeout } from './promise';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('withTimeout', () => {
  beforeEach(() => {
    jest.clearAllTimers();
  });

  it('should resolve when promise completes before timeout', async () => {
    const promise = Promise.resolve('success');
    const result = await withTimeout(promise, 1000);
    expect(result).toBe('success');
  });

  it('should reject when promise rejects before timeout', async () => {
    const promise = Promise.reject(new Error('test error'));
    await expect(withTimeout(promise, 1000)).rejects.toThrow('test error');
  });

  it('should timeout when promise takes too long', async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve('late'), 2000));
    await expect(withTimeout(promise, 100, 'Custom timeout message')).rejects.toThrow(
      'Custom timeout message',
    );
  });

  it('should use default error message when none provided', async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve('late'), 2000));
    await expect(withTimeout(promise, 100)).rejects.toThrow('Operation timed out after 100ms');
  });

  it('should clear timeout when promise resolves', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const promise = Promise.resolve('fast');

    await withTimeout(promise, 1000);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('should clear timeout when promise rejects', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const promise = Promise.reject(new Error('fail'));

    await expect(withTimeout(promise, 1000)).rejects.toThrow('fail');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('should handle multiple concurrent timeouts', async () => {
    const promise1 = Promise.resolve('first');
    const promise2 = new Promise((resolve) => setTimeout(() => resolve('second'), 50));
    const promise3 = new Promise((resolve) => setTimeout(() => resolve('third'), 2000));

    const [result1, result2] = await Promise.all([
      withTimeout(promise1, 1000),
      withTimeout(promise2, 1000),
    ]);

    expect(result1).toBe('first');
    expect(result2).toBe('second');

    await expect(withTimeout(promise3, 100)).rejects.toThrow('Operation timed out after 100ms');
  });

  it('should work with async functions', async () => {
    const asyncFunction = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'async result';
    };

    const result = await withTimeout(asyncFunction(), 1000);
    expect(result).toBe('async result');
  });

  it('should work with any return type', async () => {
    const numberPromise = Promise.resolve(42);
    const objectPromise = Promise.resolve({ key: 'value' });
    const arrayPromise = Promise.resolve([1, 2, 3]);

    expect(await withTimeout(numberPromise, 1000)).toBe(42);
    expect(await withTimeout(objectPromise, 1000)).toEqual({ key: 'value' });
    expect(await withTimeout(arrayPromise, 1000)).toEqual([1, 2, 3]);
  });

  it('should call logger when timeout occurs', async () => {
    const loggerMock = jest.fn();
    const promise = new Promise((resolve) => setTimeout(() => resolve('late'), 2000));
    const errorMessage = 'Custom timeout with logger';

    await expect(withTimeout(promise, 100, errorMessage, loggerMock)).rejects.toThrow(errorMessage);

    expect(loggerMock).toHaveBeenCalledTimes(1);
    expect(loggerMock).toHaveBeenCalledWith(errorMessage, expect.any(Error));
  });

  it('should not call logger when promise resolves', async () => {
    const loggerMock = jest.fn();
    const promise = Promise.resolve('success');

    const result = await withTimeout(promise, 1000, 'Should not timeout', loggerMock);

    expect(result).toBe('success');
    expect(loggerMock).not.toHaveBeenCalled();
  });

  it('should work without logger parameter', async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve('late'), 2000));

    await expect(withTimeout(promise, 100, 'No logger provided')).rejects.toThrow(
      'No logger provided',
    );
  });
});

describe('createConcurrencyLimiter', () => {
  it('runs tasks immediately while under the cap', async () => {
    const limit = createConcurrencyLimiter(2);
    const a = deferred<string>();
    const b = deferred<string>();
    let aStarted = false;
    let bStarted = false;

    const pa = limit(() => {
      aStarted = true;
      return a.promise;
    });
    const pb = limit(() => {
      bStarted = true;
      return b.promise;
    });

    await tick();
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);

    a.resolve('a');
    b.resolve('b');
    expect(await pa).toBe('a');
    expect(await pb).toBe('b');
  });

  it('queues tasks beyond the cap and starts them as slots free', async () => {
    const limit = createConcurrencyLimiter(2);
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();
    let cStarted = false;

    const pa = limit(() => a.promise);
    const pb = limit(() => b.promise);
    const pc = limit(() => {
      cStarted = true;
      return c.promise;
    });

    await tick();
    expect(cStarted).toBe(false);

    a.resolve('a');
    expect(await pa).toBe('a');
    await tick();
    expect(cStarted).toBe(true);

    b.resolve('b');
    c.resolve('c');
    expect(await pb).toBe('b');
    expect(await pc).toBe('c');
  });

  it('dequeues in FIFO order', async () => {
    const limit = createConcurrencyLimiter(1);
    const order: string[] = [];
    const head = deferred<void>();

    const pHead = limit(async () => {
      order.push('head:start');
      await head.promise;
      order.push('head:end');
    });
    const p1 = limit(async () => {
      order.push('1');
    });
    const p2 = limit(async () => {
      order.push('2');
    });
    const p3 = limit(async () => {
      order.push('3');
    });

    await tick();
    expect(order).toEqual(['head:start']);

    head.resolve();
    await Promise.all([pHead, p1, p2, p3]);
    expect(order).toEqual(['head:start', 'head:end', '1', '2', '3']);
  });

  it('releases the slot when a task rejects, allowing queued work to proceed', async () => {
    const limit = createConcurrencyLimiter(1);
    const failing = deferred<never>();
    let nextStarted = false;

    const pFail = limit(() => failing.promise);
    const pNext = limit(async () => {
      nextStarted = true;
      return 'ok';
    });

    await tick();
    expect(nextStarted).toBe(false);

    failing.reject(new Error('boom'));
    await expect(pFail).rejects.toThrow('boom');
    expect(await pNext).toBe('ok');
    expect(nextStarted).toBe(true);
  });

  it('isolates rejections — one failing task does not reject sibling tasks', async () => {
    const limit = createConcurrencyLimiter(2);
    const ok = limit(async () => 'ok');
    const bad = limit(async () => {
      throw new Error('nope');
    });

    expect(await ok).toBe('ok');
    await expect(bad).rejects.toThrow('nope');
  });

  it('does not exceed the configured cap under heavy load', async () => {
    const concurrency = 3;
    const limit = createConcurrencyLimiter(concurrency);
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 20 }, (_, i) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(5);
        active--;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(concurrency);
    expect(peak).toBe(concurrency);
  });

  it('serializes when concurrency is 1', async () => {
    const limit = createConcurrencyLimiter(1);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(2);
          active--;
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it('throws when concurrency is not a positive integer', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/positive integer/);
    expect(() => createConcurrencyLimiter(-1)).toThrow(/positive integer/);
    expect(() => createConcurrencyLimiter(1.5)).toThrow(/positive integer/);
    expect(() => createConcurrencyLimiter(Infinity)).toThrow(/positive integer/);
    expect(() => createConcurrencyLimiter(NaN)).toThrow(/positive integer/);
  });

  it('does not invoke the task until a slot is available', async () => {
    const limit = createConcurrencyLimiter(1);
    const block = deferred<void>();
    let queuedTaskCalled = false;

    const pHead = limit(() => block.promise);
    const pQueued = limit(async () => {
      queuedTaskCalled = true;
    });

    await tick();
    await tick();
    expect(queuedTaskCalled).toBe(false);

    block.resolve();
    await Promise.all([pHead, pQueued]);
    expect(queuedTaskCalled).toBe(true);
  });
});
