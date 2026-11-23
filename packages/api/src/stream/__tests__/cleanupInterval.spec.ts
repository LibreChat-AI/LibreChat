import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

describe('InMemoryJobStore cleanup interval', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a failed cleanup pass instead of leaving an unhandled rejection', async () => {
    const store = new InMemoryJobStore();
    const cleanup = jest.spyOn(store, 'cleanup').mockRejectedValue(new Error('cleanup failed'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    await store.initialize();
    await jest.advanceTimersByTimeAsync(60000);
    await jest.advanceTimersByTimeAsync(60000);
    await store.destroy();
    process.off('unhandledRejection', unhandled);

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('does not start a pass while the previous one is still running', async () => {
    const store = new InMemoryJobStore();
    let finish: (n: number) => void = () => undefined;
    const cleanup = jest.spyOn(store, 'cleanup').mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );

    await store.initialize();
    await jest.advanceTimersByTimeAsync(180000);
    expect(cleanup).toHaveBeenCalledTimes(1);

    finish(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    finish(0);
    await store.destroy();
  });
});
