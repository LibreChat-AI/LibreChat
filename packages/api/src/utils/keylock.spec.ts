import { withKeyLock, createSingleFlight } from './keylock';

describe('withKeyLock', () => {
  it('serializes read-modify-write cycles on one key without losing updates', async () => {
    let value = 0;
    const bump = () =>
      withKeyLock('k', async () => {
        const read = value;
        await new Promise((resolve) => setTimeout(resolve, 1));
        value = read + 1;
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(value).toBe(20);
  });

  it('keeps running later tasks after one rejects', async () => {
    await expect(withKeyLock('r', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(withKeyLock('r', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('createSingleFlight', () => {
  it('skips overlapping runs and reports rejections', async () => {
    let release: () => void = () => undefined;
    const task = jest.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          release = () => reject(new Error('fail'));
          void resolve;
        }),
    );
    const onError = jest.fn();
    const tick = createSingleFlight(task, { error: onError }, '[Test] sweep');
    tick();
    tick();
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('[Test] sweep failed', expect.any(Error));
    tick();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
