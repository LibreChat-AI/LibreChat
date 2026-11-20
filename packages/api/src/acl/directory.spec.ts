import { createDirectoryTokenRunner, runDirectoryOperation } from './directory';

describe('directory transport cancellation', () => {
  it('settles abort for an uncooperative dependency and ignores its late result', async () => {
    const controller = new AbortController();
    let complete: (value: string) => void = () => undefined;
    const work = runDirectoryOperation(
      controller.signal,
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const rejected = work.catch((error) => error);
    await Promise.resolve();
    controller.abort(new Error('Directory cancelled'));
    expect(await rejected).toMatchObject({ message: 'Directory cancelled' });
    complete('late');
    await Promise.resolve();
  });

  it('keeps concurrent token budgets separate and preserves the configured fetch transport', async () => {
    const key = Symbol('customFetch');
    const observed: AbortSignal[] = [];
    const transport = jest.fn(async (_url: string, options: RequestInit) => {
      observed.push(options.signal!);
      return new Response('{}');
    });
    const config = { [key]: transport };
    const run = createDirectoryTokenRunner(key);
    const first = new AbortController();
    const second = new AbortController();
    const sdk = new AbortController();
    await Promise.all([
      run(config, first.signal, () =>
        config[key]('https://issuer.example/token', { signal: sdk.signal, method: 'POST' }),
      ),
      run(config, second.signal, () =>
        config[key]('https://issuer.example/token', { method: 'POST' }),
      ),
    ]);
    first.abort();
    expect(observed[0].aborted).toBe(true);
    expect(observed[1].aborted).toBe(false);
    await config[key]('https://issuer.example/unscoped', {});
    expect(transport).toHaveBeenLastCalledWith('https://issuer.example/unscoped', {});
    second.abort();
    expect(observed[1].aborted).toBe(true);
  });

  it('does not send a token request after a cancelled cache lookup resumes', async () => {
    const key = Symbol('customFetch');
    const transport = jest.fn(async (_url: string, _options: RequestInit) => new Response('{}'));
    const config = { [key]: transport };
    const run = createDirectoryTokenRunner(key);
    const controller = new AbortController();
    let complete: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const work = run(config, controller.signal, async () => {
      await blocked;
      return config[key]('https://issuer.example/token', {});
    });
    const rejected = work.catch((error) => error);
    controller.abort(new Error('cancelled'));
    expect(await rejected).toMatchObject({ message: 'cancelled' });
    complete();
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });
});
