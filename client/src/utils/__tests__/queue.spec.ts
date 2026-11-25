import { enqueue } from '../queue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** The queue is module state keyed by string, so every test uses its own key
 *  rather than leaking a pending chain into the next one. */
let keySeq = 0;
const freshKey = () => `key-${++keySeq}`;

/** Tasks start on a microtask, never synchronously inside `enqueue`. */
const flush = () => Promise.resolve();

describe('enqueue', () => {
  it('runs tasks on one key strictly in order', async () => {
    const key = freshKey();
    const started: string[] = [];
    const first = deferred<void>();

    const a = enqueue(key, () => {
      started.push('a');
      return first.promise;
    });
    const b = enqueue(key, async () => {
      started.push('b');
    });

    await flush();
    expect(started).toEqual(['a']);

    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']);
  });

  it('keeps different keys independent', async () => {
    const started: string[] = [];
    const held = deferred<void>();

    const a = enqueue(freshKey(), () => {
      started.push('one');
      return held.promise;
    });
    await enqueue(freshKey(), async () => {
      started.push('two');
    });

    /* `two` must not wait behind an unrelated key's in-flight task. */
    expect(started).toEqual(['one', 'two']);
    held.resolve();
    await a;
  });

  it('does not let a failed task block the queue behind it', async () => {
    const ran: string[] = [];

    const key = freshKey();
    const failing = enqueue(key, async () => {
      ran.push('failing');
      throw new Error('nope');
    });
    const after = enqueue(key, async () => {
      ran.push('after');
    });

    await expect(failing).rejects.toThrow('nope');
    await after;
    expect(ran).toEqual(['failing', 'after']);
  });

  it('rejects only for the caller whose task failed', async () => {
    const key = freshKey();
    const failing = enqueue(key, async () => {
      throw new Error('mine');
    });
    const ok = enqueue(key, async () => 'value');

    await expect(failing).rejects.toThrow('mine');
    await expect(ok).resolves.toBe('value');
  });

  it('releases a key once its queue drains', async () => {
    const key = freshKey();
    await enqueue(key, async () => undefined);
    const started: string[] = [];

    /* A retained tail would leak one map entry per key ever used. */
    await enqueue(key, async () => {
      started.push('fresh');
    });
    expect(started).toEqual(['fresh']);
  });
});
