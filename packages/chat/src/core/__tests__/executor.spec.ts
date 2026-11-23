import { SerialJobExecutor } from '../executor';

describe('SerialJobExecutor', () => {
  it('runs jobs one at a time in the order they were queued', async () => {
    const executor = new SerialJobExecutor();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = executor.run(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = executor.run(() => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    expect(executor.idle).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(executor.idle).toBe(true);
  });

  it('rejects the failing job and keeps running the ones behind it', async () => {
    const executor = new SerialJobExecutor();
    const failure = new Error('write failed');
    const ran: string[] = [];

    const failed = executor.run(() => {
      throw failure;
    });
    const next = executor.run(() => {
      ran.push('next');
    });

    await expect(failed).rejects.toBe(failure);
    await next;
    expect(ran).toEqual(['next']);
  });

  it('runs a job queued from inside a running job after it', async () => {
    const executor = new SerialJobExecutor();
    const order: string[] = [];
    let inner: Promise<void> | undefined;

    await executor.run(() => {
      inner = executor.run(() => {
        order.push('inner');
      });
      order.push('outer');
    });
    await inner;

    expect(order).toEqual(['outer', 'inner']);
  });
});
