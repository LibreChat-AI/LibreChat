import {
  withMCPRequestSignal,
  holdMCPRequestFailure,
  getMCPDispatchSignal,
  captureMCPRequestScope,
  outsideMCPRequestScope,
} from './signal';

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

describe('exact SDK admission scope', () => {
  it('keeps a known denial ahead of a timeout, without delaying another request', async () => {
    const denial = new Error('Known denial');
    const timeout = new Error('SDK deadline');
    let admit!: () => void;
    let returned = false;
    const admission = new Promise<never>((_resolve, reject) => {
      admit = () => reject(denial);
    });
    const first = withMCPRequestSignal(
      undefined,
      async () => {
        holdMCPRequestFailure(admission);
        throw timeout;
      },
      true,
    ).catch((error) => {
      returned = true;
      return error;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
      await expect(
        withMCPRequestSignal(
          undefined,
          async () => {
            throw timeout;
          },
          true,
        ),
      ).rejects.toBe(timeout);
      admit();
      await expect(first).resolves.toBe(denial);
    } finally {
      admit();
      await first;
    }
  });

  it('closes pre-dispatch work at the SDK deadline but does not change the SDK result without a denial', async () => {
    const timeout = new Error('SDK deadline');
    let dispatchSignal: AbortSignal | undefined;
    await expect(
      withMCPRequestSignal(
        undefined,
        async () => {
          dispatchSignal = getMCPDispatchSignal();
          expect(dispatchSignal?.aborted).toBe(false);
          throw timeout;
        },
        true,
      ),
    ).rejects.toBe(timeout);
    expect(dispatchSignal?.aborted).toBe(true);
    expect(getMCPDispatchSignal()).toBeUndefined();
  });

  it('isolates concurrent caller cutoffs and detaches autonomous SDK notifications', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let firstSignal: AbortSignal | undefined, secondSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withMCPRequestSignal(
      firstController.signal,
      async () => {
        firstSignal = getMCPDispatchSignal();
        await gate;
        expect(outsideMCPRequestScope(getMCPDispatchSignal)).toBeUndefined();
      },
      true,
    );
    const second = withMCPRequestSignal(
      secondController.signal,
      async () => {
        secondSignal = getMCPDispatchSignal();
        await gate;
      },
      true,
    );
    try {
      firstController.abort();
      expect(firstSignal?.aborted).toBe(true);
      expect(secondSignal?.aborted).toBe(false);
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });
});

it('restores the originating scope for a cancellation emitted outside its async context', async () => {
  const controller = new AbortController();
  let released!: () => void;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let run: ReturnType<typeof captureMCPRequestScope>;
  const settled = jest.fn();
  const pending = withMCPRequestSignal(
    controller.signal,
    async () => {
      run = captureMCPRequestScope(settled);
      await gate;
    },
    true,
  );
  try {
    controller.abort();
    expect(getMCPDispatchSignal()).toBeUndefined();
    await run?.(async () => {
      expect(getMCPDispatchSignal()?.aborted).toBe(true);
    });
  } finally {
    released();
    await pending;
  }
  expect(settled).toHaveBeenCalledTimes(1);
});
