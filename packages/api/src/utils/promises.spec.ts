import { settleAll, detachOnAbort, settleStarted } from './promises';

describe('detachOnAbort', () => {
  it('passes the promise through when no signal is given', async () => {
    await expect(detachOnAbort(Promise.resolve('value'))).resolves.toBe('value');
  });

  it('accepts an already-resolved operation value', async () => {
    await expect(detachOnAbort('value', new AbortController().signal)).resolves.toBe('value');
  });

  it('resolves normally when the signal never aborts', async () => {
    const controller = new AbortController();
    await expect(detachOnAbort(Promise.resolve('value'), controller.signal)).resolves.toBe('value');
  });

  it('propagates the underlying rejection when the signal never aborts', async () => {
    const controller = new AbortController();
    await expect(
      detachOnAbort(Promise.reject(new Error('upstream failed')), controller.signal),
    ).rejects.toThrow('upstream failed');
  });

  it('rejects with the abort reason and leaves the work running', async () => {
    const controller = new AbortController();
    let settle!: (value: string) => void;
    const shared = new Promise<string>((resolve) => (settle = resolve));
    let sharedSettled = false;
    shared.then(() => (sharedSettled = true));

    const detached = detachOnAbort(shared, controller.signal);
    controller.abort();

    await expect(detached).rejects.toBe(controller.signal.reason);
    expect(sharedSettled).toBe(false);

    /** The shared work still completes for whoever else is waiting on it. */
    settle('completed after the abort');
    await shared;
    expect(sharedSettled).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(detachOnAbort(Promise.resolve('value'), controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });

  it('does not surface a late rejection of detached work', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      let fail!: (error: Error) => void;
      const shared = new Promise<string>((_resolve, reject) => (fail = reject));

      const detached = detachOnAbort(shared, controller.signal);
      controller.abort();
      await expect(detached).rejects.toBe(controller.signal.reason);

      fail(new Error('shared work failed later'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

/** A promise and the means to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('settleAll', () => {
  it('resolves with every value in input order', async () => {
    await expect(settleAll([Promise.resolve(1), 2, Promise.resolve(3)])).resolves.toEqual([
      1, 2, 3,
    ]);
  });

  it('waits for pending work before rejecting with a failure', async () => {
    const pending = deferred<string>();
    const failure = new Error('update failed');
    let settled = false;
    const all = settleAll([Promise.reject(failure), pending.promise]).finally(
      () => (settled = true),
    );
    all.catch(() => undefined);

    await flush();
    expect(settled).toBe(false);

    pending.resolve('saved');
    await expect(all).rejects.toBe(failure);
  });

  it('rejects with the first failure in input order, not the first to fail', async () => {
    const later = deferred<never>();
    const first = new Error('first');
    const all = settleAll([later.promise, Promise.reject(new Error('second'))]);
    later.reject(first);
    await expect(all).rejects.toBe(first);
  });
});

describe('settleStarted', () => {
  it('returns the body result once the started work has settled', async () => {
    const started: Promise<unknown>[] = [];
    const work = deferred<string>();
    let settled = false;
    const run = settleStarted(
      () => {
        started.push(work.promise);
        return 'done';
      },
      () => started,
    ).finally(() => (settled = true));

    await flush();
    expect(settled).toBe(false);

    work.resolve('saved');
    await expect(run).resolves.toBe('done');
  });

  it('waits for started work before rethrowing a body failure', async () => {
    const started: Promise<unknown>[] = [];
    const work = deferred<string>();
    const failure = new Error('loop threw');
    let settled = false;
    const run = settleStarted(
      () => {
        started.push(work.promise);
        throw failure;
      },
      () => started,
    ).finally(() => (settled = true));
    run.catch(() => undefined);

    await flush();
    expect(settled).toBe(false);

    work.resolve('saved');
    await expect(run).rejects.toBe(failure);
  });

  it('keeps the body failure when started work also fails', async () => {
    const started: Promise<unknown>[] = [];
    const failure = new Error('loop threw');
    const run = settleStarted(
      async () => {
        started.push(Promise.reject(new Error('save failed')));
        throw failure;
      },
      () => started,
    );
    await expect(run).rejects.toBe(failure);
  });

  it('rejects with the first started failure when the body succeeds', async () => {
    const started: Promise<unknown>[] = [];
    const failure = new Error('update failed');
    const run = settleStarted(
      () => {
        started.push(Promise.reject(failure), Promise.resolve('saved'));
      },
      () => started,
    );
    await expect(run).rejects.toBe(failure);
  });
});
