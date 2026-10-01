import { detachOnAbort } from './promises';

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
