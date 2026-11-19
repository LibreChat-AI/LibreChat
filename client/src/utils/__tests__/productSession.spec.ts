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

it('keeps advancing in memory after a write to a valid stored record fails', async () => {
  const { options, values, setTime } = setup();
  values.set(
    options.key,
    JSON.stringify({ sessionId: first, startedAt: 1000, lastActivityAt: 1000 }),
  );
  const setItem = jest.fn(() => {
    throw new Error('quota');
  });
  const session = createProductSession({
    ...options,
    storage: { getItem: options.storage.getItem, setItem },
  });
  setTime(1050);
  expect(await session.activity()).toEqual({ sessionId: first });
  setTime(1120);
  expect(await session.activity()).toEqual({ sessionId: first });
  setTime(1200);
  expect(session.peek()).toEqual({ sessionId: first });
  expect(session.snapshot()?.lastActivityAt).toBe(1120);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(options.createId).not.toHaveBeenCalled();
});

it('reports each activity marker from one tab only', async () => {
  const { options, setTime } = setup();
  let tail = Promise.resolve();
  const exclusive = <T>(work: () => T): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(() => {});
    return next;
  };
  const one = createProductSession({ ...options, exclusive });
  const two = createProductSession({ ...options, exclusive });
  await one.activity();
  const reported: unknown[] = [];
  const emit = (record: unknown) => reported.push(record);
  await Promise.all([one.report(emit), two.report(emit)]);
  expect(reported).toEqual([{ sessionId: first, startedAt: 1000, lastActivityAt: 1000 }]);
  await two.report(emit);
  expect(reported).toHaveLength(1);
  setTime(1050);
  await two.activity();
  await Promise.all([two.report(emit), one.report(emit)]);
  expect(reported).toEqual([
    { sessionId: first, startedAt: 1000, lastActivityAt: 1000 },
    { sessionId: first, startedAt: 1000, lastActivityAt: 1050, lastReportedActivityAt: 1000 },
  ]);
});

it('reports without waiting for the lock and marks the marker for locked reports', async () => {
  const { options } = setup();
  let release = () => {};
  const exclusive = <T>(work: () => T): Promise<T> =>
    new Promise((resolve) => {
      release = () => resolve(work());
    });
  const session = createProductSession({ ...options, exclusive });
  session.activityNow();
  const reported: unknown[] = [];
  const emit = (record: unknown) => reported.push(record);
  const locked = session.report(emit);
  session.reportNow(emit);
  expect(reported).toEqual([{ sessionId: first, startedAt: 1000, lastActivityAt: 1000 }]);
  await Promise.resolve();
  release();
  await locked;
  expect(reported).toHaveLength(1);
});

it('does not write back a record that logout removed from storage', async () => {
  const { options, values, setTime } = setup();
  const session = createProductSession(options);
  await session.activity();
  setTime(1010);
  session.activityNow();
  values.delete('user:org');
  const emit = jest.fn();

  session.reportNow(emit);
  await session.report(emit);

  expect(emit).not.toHaveBeenCalled();
  expect(values.has('user:org')).toBe(false);
});
