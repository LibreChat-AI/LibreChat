import type { DiscordApplicationObservation } from './observe';
import { DiscordCredentialReporter } from './credentials';
import { discordCredentialObservation } from './observe';

const owner = {
  applicationId: '123456789012345678',
  applicationRevision: 'revision',
  ownerId: 'a'.repeat(32),
};
const valid: DiscordApplicationObservation = { type: 'session', event: 'ready', shardId: 0 };
const invalid: DiscordApplicationObservation = { type: 'stop', reason: 'credentials' };
const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe('credential evidence', () => {
  it.each([200, 204, 299, 401])('accepts bot REST status %s', (status) => {
    expect(discordCredentialObservation({ type: 'rest', route: 'GET /gateway/bot', status })).toBe(
      status === 401 ? 'invalid' : 'valid',
    );
  });

  it.each([undefined, 199, 302, 403, 404, 429, 500, 503, 600, 200.5, NaN])(
    'ignores ambiguous bot REST status %s',
    (status) => {
      expect(
        discordCredentialObservation({ type: 'rest', route: 'GET /gateway/bot', status }),
      ).toBeUndefined();
    },
  );

  it.each(['PATCH /webhooks/:id/:token/messages/@original', 'GET /unknown', 'GET /channels/123'])(
    'does not infer bot validity from %s',
    (route) => {
      for (const status of [200, 401])
        expect(discordCredentialObservation({ type: 'rest', route, status })).toBeUndefined();
    },
  );

  it.each<DiscordApplicationObservation>([
    { type: 'permission', outcome: 'denied' },
    { type: 'stop', reason: 'configuration' },
    { type: 'stop', reason: 'identity' },
    { type: 'session', event: 'closed_fatal', shardId: 0 },
    { type: 'session', event: 'closed_transient', shardId: 0 },
    { type: 'heartbeat', shardId: 0, latencyMs: 20 },
  ])('ignores non-credential evidence %j', (observation) => {
    expect(discordCredentialObservation(observation)).toBeUndefined();
  });

  it('recognizes authenticated sessions and an explicit credential stop', () => {
    expect(discordCredentialObservation(valid)).toBe('valid');
    expect(discordCredentialObservation({ type: 'session', event: 'resumed', shardId: 0 })).toBe(
      'valid',
    );
    expect(discordCredentialObservation(invalid)).toBe('invalid');
  });
});

describe('lease-scoped credential reporter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function setup(options: { intervalMs?: number; retryMs?: number } = {}) {
    let now = 100;
    const write = jest.fn(async () => true);
    const reporter = new DiscordCredentialReporter({
      owner,
      write,
      intervalMs: options.intervalMs ?? 1000,
      retryMs: options.retryMs ?? 200,
      now: () => now,
    });
    return { reporter, write, clock: (value: number) => (now = value) };
  }
  const sequences = (write: jest.Mock) => (write.mock.calls as unknown[][]).map((call) => call[2]);

  it('coalesces bursts, records changes immediately and refreshes only with fresh evidence', async () => {
    const { reporter, write, clock } = setup();
    for (let index = 0; index < 1000; index++) reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(owner, 'valid', 1);
    clock(1099);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    clock(1100);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(2);
    reporter.observe(invalid);
    await settle();
    expect(write).toHaveBeenLastCalledWith(owner, 'invalid', 3);
    clock(100000);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(3);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('serializes writes and flushes the latest pending state before lease release', async () => {
    const { reporter, write } = setup();
    let finish: (value: boolean) => void = () => undefined;
    write.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    reporter.observe(valid);
    await settle();
    reporter.observe(invalid);
    reporter.observe(valid);
    reporter.observe(invalid);
    let closed = false;
    const closing = reporter.close().then(() => (closed = true));
    reporter.observe(valid);
    await settle();
    expect(closed).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    finish(true);
    await closing;
    expect(write.mock.calls).toEqual([
      [owner, 'valid', 1],
      [owner, 'invalid', 2],
    ]);
  });

  it('discards pending and future observations after loss of ownership', async () => {
    const { reporter, write } = setup();
    let finish: (value: boolean) => void = () => undefined;
    write.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    reporter.observe(valid);
    await settle();
    reporter.observe(invalid);
    finish(false);
    await settle();
    reporter.observe(invalid);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not repeat identical evidence inside the retry delay or read a failure as invalid credentials', async () => {
    const { reporter, write, clock } = setup();
    write.mockRejectedValueOnce(new Error('private-provider-content'));
    reporter.observe(valid);
    await settle();
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    clock(300);
    reporter.observe(valid);
    await reporter.close();
    expect(write.mock.calls).toEqual([
      [owner, 'valid', 1],
      [owner, 'valid', 2],
    ]);
  });

  it('does not retry identical evidence when the clock steps backwards', async () => {
    const { reporter, write, clock } = setup();
    reporter.observe(valid);
    await settle();
    clock(1);
    reporter.observe(valid);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(1);
  });

  describe('after a failed write', () => {
    it('repeats it after the retry delay with no new evidence and no help from the clock', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('private-provider-content'));
      reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(199);
      expect(write).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(write.mock.calls).toEqual([
        [owner, 'valid', 1],
        [owner, 'valid', 2],
      ]);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('keeps repeating at the retry delay, one write at a time, until a write lands', async () => {
      const { reporter, write } = setup();
      for (let index = 0; index < 3; index++) write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(invalid);
      await settle();
      for (const calls of [2, 3, 4]) {
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(200);
        expect(write).toHaveBeenCalledTimes(calls);
      }
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(4);
      expect(sequences(write)).toEqual([1, 2, 3, 4]);
      expect(write.mock.calls.every((call) => (call as unknown[])[1] === 'invalid')).toBe(true);
    });

    it('does not stack timers or writes while identical evidence keeps arriving', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      for (let index = 0; index < 1000; index++) reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
    });

    it('repeats on fresh identical evidence once the delay has passed, without waiting for the timer', async () => {
      const { reporter, write, clock } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      clock(299);
      reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      clock(300);
      reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('returns to the full reporting interval once a repeat succeeds', async () => {
      const { reporter, write, clock } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      clock(300);
      await jest.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      clock(1299);
      reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(2);
      clock(1300);
      reporter.observe(valid);
      await settle();
      expect(write).toHaveBeenCalledTimes(3);
    });

    it('reports a changed state at once and drops the superseded retry', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      await jest.advanceTimersByTimeAsync(50);
      reporter.observe(invalid);
      await settle();
      expect(write.mock.calls).toEqual([
        [owner, 'valid', 1],
        [owner, 'invalid', 2],
      ]);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('repeats only the latest evidence when a newer write failed too', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
      reporter.observe(valid);
      await settle();
      reporter.observe(invalid);
      await settle();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(200);
      expect(write.mock.calls).toEqual([
        [owner, 'valid', 1],
        [owner, 'invalid', 2],
        [owner, 'invalid', 3],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never waits longer than the reporting interval', async () => {
      const { reporter, write } = setup({ intervalMs: 1000, retryMs: 600_000 });
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      await jest.advanceTimersByTimeAsync(999);
      expect(write).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('uses a timer that does not keep the process alive', async () => {
      const spy = jest.spyOn(global, 'setTimeout');
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      const timers = spy.mock.results.map((result) => result.value as { hasRef(): boolean });
      expect(timers).toHaveLength(1);
      expect(timers[0].hasRef()).toBe(false);
      spy.mockRestore();
    });

    it('clears the timer on close and does not repeat the failed write', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('unavailable'));
      reporter.observe(valid);
      await settle();
      expect(jest.getTimerCount()).toBe(1);
      await reporter.close();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('flushes at most the write in flight and one pending state at close, and arms no repeat', async () => {
      const { reporter, write } = setup();
      let fail: (error: Error) => void = () => undefined;
      write.mockImplementationOnce(
        () => new Promise<boolean>((_resolve, reject) => (fail = reject)),
      );
      write.mockRejectedValueOnce(new Error('second'));
      reporter.observe(valid);
      await settle();
      reporter.observe(invalid);
      reporter.observe(valid);
      reporter.observe(invalid);
      const closing = reporter.close();
      fail(new Error('first'));
      await closing;
      expect(write.mock.calls).toEqual([
        [owner, 'valid', 1],
        [owner, 'invalid', 2],
      ]);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('stops repeating when a repeat finds the lease lost', async () => {
      const { reporter, write } = setup();
      write.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(false);
      reporter.observe(valid);
      await settle();
      await jest.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
      reporter.observe(invalid);
      await reporter.close();
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('does not repeat while a repeat is still in flight, and then writes the newest evidence', async () => {
      const { reporter, write } = setup();
      let finish: (value: boolean) => void = () => undefined;
      write.mockRejectedValueOnce(new Error('unavailable'));
      write.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
      reporter.observe(valid);
      await settle();
      await jest.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      reporter.observe(invalid);
      await jest.advanceTimersByTimeAsync(100_000);
      expect(write).toHaveBeenCalledTimes(2);
      finish(true);
      await settle();
      expect(write.mock.calls).toEqual([
        [owner, 'valid', 1],
        [owner, 'valid', 2],
        [owner, 'invalid', 3],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects the reporting interval or retry delay %p',
    (value) => {
      const write = jest.fn(async () => true);
      expect(
        () => new DiscordCredentialReporter({ owner, write, intervalMs: value, retryMs: 200 }),
      ).toThrow(TypeError);
      expect(
        () => new DiscordCredentialReporter({ owner, write, intervalMs: 1000, retryMs: value }),
      ).toThrow(TypeError);
    },
  );
});
