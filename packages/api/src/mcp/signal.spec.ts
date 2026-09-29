import { withMCPRequestSignal } from './signal';

describe('withMCPRequestSignal', () => {
  it('relays cancellation to an in-flight request and detaches on rejection', async () => {
    const parent = new AbortController();
    const reason = new Error('Stop');
    const remove = jest.spyOn(parent.signal, 'removeEventListener');
    const request = jest.fn(
      (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = withMCPRequestSignal(parent.signal, request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).not.toBe(parent.signal);
    parent.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not abort a completed request when its parent is aborted later', async () => {
    const parent = new AbortController();
    const request = jest.fn(async (signal?: AbortSignal) => signal);
    const child = await withMCPRequestSignal(parent.signal, request);

    expect(child).toBeDefined();
    parent.abort();
    expect(child?.aborted).toBe(false);
  });

  it('does not start a request whose parent is already aborted', async () => {
    const parent = new AbortController();
    const reason = new Error('Stop');
    parent.abort(reason);
    const request = jest.fn(async () => undefined);

    await expect(withMCPRequestSignal(parent.signal, request)).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it('passes through requests without a parent signal', async () => {
    const request = jest.fn(async (signal?: AbortSignal) => signal);

    await expect(withMCPRequestSignal(undefined, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(undefined);
  });
});
