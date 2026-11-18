import { createProductSession } from '../productSession';

const first = 'd79706cc-4ddf-4cf7-b99a-333755af9be8';
const second = '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21';
function setup() {
  let time = 1000;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const createId = jest.fn().mockReturnValueOnce(first).mockReturnValue(second);
  const options = { key: 'user:org', storage, idleTimeoutMs: 100, now: () => time, createId };
  return {
    options,
    values,
    setTime: (value: number) => {
      time = value;
    },
  };
}

it('shares user activity across tabs and expires without counting idle time', async () => {
  const { options, setTime } = setup();
  const one = createProductSession(options);
  const two = createProductSession(options);
  expect(await one.activity()).toEqual({ sessionId: first });
  setTime(1050);
  expect(await two.activity()).toEqual({ sessionId: first });
  setTime(1149);
  expect(one.peek()).toEqual({ sessionId: first });
  expect(one.snapshot()).toEqual({ sessionId: first, startedAt: 1000, lastActivityAt: 1050 });
  setTime(1150);
  expect(one.peek()).toBeUndefined();
  expect(one.snapshot()?.lastActivityAt).toBe(1050);
  expect(await one.activity()).toEqual({ sessionId: second });
});

it('isolates identity keys and tab-local storage', async () => {
  const { options } = setup();
  const one = createProductSession(options);
  const other = createProductSession({ ...options, key: 'other:org' });
  await one.activity();
  expect(other.peek()).toBeUndefined();
  expect(await other.activity()).toEqual({ sessionId: second });
  expect(one.peek()).toEqual({ sessionId: first });
});

it('survives corrupt or unavailable storage', async () => {
  const { options, values } = setup();
  values.set(options.key, 'broken');
  const session = createProductSession({
    ...options,
    storage: {
      getItem: options.storage.getItem,
      setItem: () => {
        throw new Error('blocked');
      },
    },
  });
  expect(await session.activity()).toEqual({ sessionId: first });
  expect(session.peek()).toEqual({ sessionId: first });
});

it('rotates future timestamps and stops pending activity after unmount', async () => {
  const { options, setTime } = setup();
  const session = createProductSession(options);
  await session.activity();
  setTime(999);
  expect(session.peek()).toBeUndefined();
  expect(await session.activity()).toEqual({ sessionId: second });
  const pending = session.activity();
  session.stop();
  expect(await pending).toBeUndefined();
});

it('serializes creation across tabs with the supplied lock', async () => {
  const { options } = setup();
  let tail = Promise.resolve();
  const exclusive = <T>(work: () => T): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(() => {});
    return next;
  };
  const one = createProductSession({ ...options, exclusive });
  const two = createProductSession({ ...options, exclusive });
  expect(await Promise.all([one.activity(), two.activity()])).toEqual([
    { sessionId: first },
    { sessionId: first },
  ]);
  expect(options.createId).toHaveBeenCalledTimes(1);
});

it('captures an explicit send while a cross-tab lock never resolves', async () => {
  const { options, setTime } = setup();
  const session = createProductSession({ ...options, exclusive: () => new Promise(() => {}) });
  void session.activity();
  expect(session.activityNow()).toEqual({ sessionId: first });
  setTime(1100);
  expect(session.activityNow()).toEqual({ sessionId: second });
  expect(session.peek()).toEqual({ sessionId: second });
});
