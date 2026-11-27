export interface MockPublisher {
  publish: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  ttl: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
}

/** Mock publisher with Redis command simulation for atomic sequence counters */
export function createMockPublisher(): MockPublisher {
  const counters = new Map<string, number>();
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const publisher: MockPublisher = {
    publish: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockImplementation((key: string) => {
      const current = (counters.get(key) ?? 0) + 1;
      counters.set(key, current);
      return Promise.resolve(current);
    }),
    expire: jest.fn().mockImplementation((key: string, ttl: number) => {
      if (!counters.has(key)) {
        return Promise.resolve(0);
      }
      ttls.set(key, ttl);
      return Promise.resolve(1);
    }),
    ttl: jest.fn().mockImplementation((key: string) => {
      if (!counters.has(key)) {
        return Promise.resolve(-2);
      }
      return Promise.resolve(ttls.get(key) ?? -1);
    }),
    get: jest.fn().mockImplementation((key: string) => {
      const stored = values.get(key);
      if (stored != null) {
        return Promise.resolve(stored);
      }
      const val = counters.get(key);
      return Promise.resolve(val != null ? String(val) : null);
    }),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn().mockImplementation((...keys: string[]) => {
      for (const key of keys) {
        counters.delete(key);
        values.delete(key);
        ttls.delete(key);
      }
      return Promise.resolve(keys.length);
    }),
    eval: jest.fn(),
  };

  /**
   * Stands in for PUBLISH_SEQ_LUA, which allocates the sequence and publishes in one server-side
   * round trip. Delegates to the incr/publish mocks rather than reimplementing them, so a test
   * can still fail either half independently and observe the ordering between them.
   */
  publisher.eval.mockImplementation(
    async (
      _script: string,
      _numKeys: number,
      seqKey: string,
      jobKey: string,
      _generationEpochKey: string,
      channel: string,
      prefix: string,
      suffix: string,
      ttlSeconds: string,
      _expectedGenerationId: string,
      _allowRetainedEpoch: string,
      _generationEpochGraceTtl: string,
      _requireActiveJob: string,
      sequenceCount = '1',
      ...chunkSuffixes: string[]
    ) => {
      if (_numKeys === 1) {
        const frontier = await publisher.get(seqKey);
        await publisher.publish(jobKey, _generationEpochKey);
        return frontier ?? '0';
      }
      const count = Number(sequenceCount);
      const val = (await publisher.incr(seqKey)) as number;
      for (let i = 1; i < count; i++) {
        await publisher.incr(seqKey);
      }
      let ttl = Number(ttlSeconds);
      const seqTtl = (await publisher.ttl(seqKey)) as number;
      if (seqTtl < Math.floor(ttl / 2)) {
        const jobTtl = (await publisher.ttl(jobKey)) as number;
        if (jobTtl > ttl) {
          ttl = jobTtl;
        }
        await publisher.expire(seqKey, ttl);
      }
      const seq = val - 1;
      if (chunkSuffixes.length > 0) {
        for (let i = 0; i < count; i++) {
          await publisher.publish(channel, `${prefix}${seq + i}${chunkSuffixes[i]}`);
        }
      } else {
        await publisher.publish(channel, `${prefix}${seq}${suffix}`);
      }
      return seq;
    },
  );

  return publisher;
}
