import {
  incrementViolationCount,
  appendViolationLog,
  MAX_VIOLATION_LOG_ENTRIES,
} from './violation';

const makeStore = <T>() => {
  const map = new Map<string, T>();
  return {
    get: async (key: string) => {
      const value = map.get(key);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value;
    },
    set: async (key: string, value: T) => {
      map.set(key, value);
    },
  };
};

describe('violation helpers', () => {
  it('counts concurrent violations without undercounting', async () => {
    const store = makeStore<number | string>();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => incrementViolationCount(store, 'u', 2)),
    );
    expect(Math.max(...results.map((r) => r.count))).toBe(20);
    expect(results[0].prevCount).toBe(0);
  });

  it('keeps only the newest log entries', async () => {
    const store = makeStore<number[]>();
    for (let i = 0; i < MAX_VIOLATION_LOG_ENTRIES + 5; i++) {
      await appendViolationLog(store, 'u', i);
    }
    const entries = (await store.get('u')) ?? [];
    expect(entries).toHaveLength(MAX_VIOLATION_LOG_ENTRIES);
    expect(entries[entries.length - 1]).toBe(MAX_VIOLATION_LOG_ENTRIES + 4);
  });

  it('honors a configured retention', async () => {
    const store = makeStore<number[]>();
    for (let i = 0; i < 10; i++) {
      await appendViolationLog(store, 'u', i, 3);
    }
    expect(await store.get('u')).toEqual([7, 8, 9]);
  });
});
