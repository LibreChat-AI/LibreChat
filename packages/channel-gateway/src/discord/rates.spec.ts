import type { DiscordRateObservation } from './rates';
import { DEFAULT_DISCORD_RATE_POLICY, DiscordRateCoordinator } from './rates';

const route = (major = 'channels:123', method = 'POST') => ({
  route: `${method} /channels/:id/messages`,
  major,
});
const limited = (headers: Record<string, string>, status = 200) =>
  new Response(null, { status, headers });
const policy = { ...DEFAULT_DISCORD_RATE_POLICY, maxQueueWaitMs: 10_000 };

describe('Discord per-bot REST coordination', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());

  test('coordinates learned shared buckets while keeping major resources independent', async () => {
    const rates = new DiscordRateCoordinator(policy);
    const create = await rates.acquire(route());
    create.observe(
      limited({
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '2',
        'x-ratelimit-reset-after': '1',
      }),
    );
    create.release();
    const edit = await rates.acquire(route('channels:123', 'PATCH'));
    edit.observe(
      limited({
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset-after': '1.25',
      }),
    );
    edit.release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    const independent = await rates.acquire(route('channels:456'));
    independent.release();
    await jest.advanceTimersByTimeAsync(1249);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  test('serializes in-flight operations within a learned bucket without blocking other routes', async () => {
    const rates = new DiscordRateCoordinator(policy);
    for (const method of ['POST', 'PATCH']) {
      const seed = await rates.acquire(route('channels:123', method));
      seed.observe(
        limited({
          'x-ratelimit-bucket': 'messages',
          'x-ratelimit-remaining': '5',
          'x-ratelimit-reset-after': '1',
        }),
      );
      seed.release();
    }
    const active = await rates.acquire(route());
    const admitted = jest.fn();
    const waiting = rates.acquire(route('channels:123', 'PATCH')).then((permit) => {
      admitted();
      return permit;
    });
    const independent = await rates.acquire(route('channels:456'));
    independent.release();
    expect(admitted).not.toHaveBeenCalled();
    active.release();
    (await waiting).release();
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  test('caps the sliding per-bot global request window across routes', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, globalRequestsPerSecond: 2 });
    (await rates.acquire(route('channels:1'))).release();
    (await rates.acquire(route('channels:2'))).release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route('channels:3')).then((permit) => {
      admitted();
      return permit;
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  test.each(['header', 'scope', 'body'])(
    'honors a global 429 identified by %s across channels',
    async (source) => {
      const rates = new DiscordRateCoordinator(policy);
      const first = await rates.acquire(route());
      const headers: Record<string, string> = {
        'retry-after': '2',
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '9',
        'x-ratelimit-reset-after': '1',
      };
      if (source === 'header') headers['x-ratelimit-global'] = 'true';
      if (source === 'scope') headers['x-ratelimit-scope'] = 'global';
      first.observe(limited(headers, 429), source === 'body' ? { global: true } : undefined);
      first.release();
      const admitted = jest.fn();
      const waiting = rates.acquire(route('channels:456')).then((permit) => {
        admitted();
        return permit;
      });
      await jest.advanceTimersByTimeAsync(1999);
      expect(admitted).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      (await waiting).release();
      expect(admitted).toHaveBeenCalledTimes(1);
    },
  );

  test('shared resource 429s preserve the retry delay despite a positive remaining header', async () => {
    const rates = new DiscordRateCoordinator(policy);
    const first = await rates.acquire(route());
    first.observe(
      limited(
        {
          'retry-after': '2',
          'x-ratelimit-bucket': 'messages',
          'x-ratelimit-scope': 'shared',
          'x-ratelimit-remaining': '9',
          'x-ratelimit-reset-after': '1',
        },
        429,
      ),
    );
    first.release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    const independent = await rates.acquire(route('channels:456'));
    independent.release();
    await jest.advanceTimersByTimeAsync(1999);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
  });

  test('a longer decoded global delay extends the header restriction', async () => {
    const rates = new DiscordRateCoordinator(policy);
    const first = await rates.acquire(route());
    const response = limited({ 'retry-after': '1', 'x-ratelimit-global': 'true' }, 429);
    first.observe(response);
    const admitted = jest.fn();
    const waiting = rates.acquire(route('channels:456')).then((permit) => {
      admitted();
      return permit;
    });
    await jest.advanceTimersByTimeAsync(500);
    first.observe(response, { retry_after: 3, global: true });
    first.release();
    await jest.advanceTimersByTimeAsync(2499);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
  });

  test('out-of-order discovery cannot overwrite an exhausted shared bucket with a stale remainder', async () => {
    const rates = new DiscordRateCoordinator(policy);
    const first = await rates.acquire(route());
    const second = await rates.acquire(route('channels:123', 'PATCH'));
    first.observe(
      limited({
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset-after': '2',
      }),
    );
    second.observe(
      limited({
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '4',
        'x-ratelimit-reset-after': '2',
      }),
    );
    first.release();
    second.release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    await jest.advanceTimersByTimeAsync(1999);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
  });

  test('aborting queued work removes it immediately and frees queue capacity', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, maxQueued: 1 });
    const active = await rates.acquire(route());
    const controller = new AbortController();
    const waiting = rates.acquire(route(), controller.signal).catch((error: unknown) => error);
    await expect(rates.acquire(route())).rejects.toMatchObject({ code: 'queue_full' });
    controller.abort(new Error('sensitive caller reason'));
    await expect(waiting).resolves.toMatchObject({ code: 'aborted' });
    const replacement = rates.acquire(route());
    active.release();
    (await replacement).release();
    expect(jest.getTimerCount()).toBe(0);
    await expect(rates.acquire(route(), controller.signal)).rejects.toThrow(
      'Discord request was not started',
    );
  });

  test('queue deadlines expire without waiting for an in-flight request to finish', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, maxQueueWaitMs: 100 });
    const active = await rates.acquire(route());
    const waiting = rates.acquire(route()).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toMatchObject({ code: 'queue_timeout', retryAfterMs: 1000 });
    active.release();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('bounds tracked routes and reclaims idle metadata without discarding an active limit', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, maxTrackedRoutes: 1, idleTtlMs: 100 });
    const first = await rates.acquire(route());
    first.observe(
      limited({
        'x-ratelimit-bucket': 'messages',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset-after': '1',
      }),
    );
    first.release();
    await jest.advanceTimersByTimeAsync(100);
    await expect(rates.acquire(route('channels:456'))).rejects.toMatchObject({ code: 'capacity' });
    await jest.advanceTimersByTimeAsync(900);
    (await rates.acquire(route('channels:456'))).release();
  });

  test('uses injected fallback delay for malformed rate-limit metadata', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, fallbackRetryMs: 250 });
    const first = await rates.acquire(route());
    first.observe(limited({ 'retry-after': 'invalid', 'x-ratelimit-reset-after': '-1' }, 429));
    first.release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    await jest.advanceTimersByTimeAsync(249);
    expect(admitted).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    (await waiting).release();
  });

  test('release is idempotent and cannot free another in-flight operation', async () => {
    const rates = new DiscordRateCoordinator(policy);
    const first = await rates.acquire(route());
    first.release();
    const second = await rates.acquire(route());
    first.release();
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    second.release();
    (await waiting).release();
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  test.each([0, -1, Infinity, 1.5])('rejects invalid policy values %s', (maxQueued) => {
    expect(() => new DiscordRateCoordinator({ ...policy, maxQueued })).toThrow(
      'Invalid Discord rate policy',
    );
  });
});

describe('Discord REST observation', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());
  const observed = () => {
    const events: DiscordRateObservation[] = [];
    return { events, observer: (event: DiscordRateObservation) => events.push(event) };
  };

  test('reports each request once on release with its first observed status', async () => {
    const { events, observer } = observed();
    const rates = new DiscordRateCoordinator(policy, observer);
    const permit = await rates.acquire(route());
    permit.observe(limited({}, 200));
    permit.observe(limited({}, 200), { id: '1' });
    expect(events).toEqual([]);
    permit.release();
    permit.release();
    expect(events).toEqual([{ type: 'rest', route: 'POST /channels/:id/messages', status: 200 }]);
  });

  test('reports a request that never received a response with no status', async () => {
    const { events, observer } = observed();
    const permit = await new DiscordRateCoordinator(policy, observer).acquire(route());
    permit.release();
    expect(events).toEqual([
      { type: 'rest', route: 'POST /channels/:id/messages', status: undefined },
    ]);
  });

  test('ignores a response observed after release', async () => {
    const { events, observer } = observed();
    const permit = await new DiscordRateCoordinator(policy, observer).acquire(route());
    permit.release();
    permit.observe(limited({}, 500));
    expect(events).toEqual([
      { type: 'rest', route: 'POST /channels/:id/messages', status: undefined },
    ]);
  });

  test('never reports the major key, which can derive from an interaction token', async () => {
    const { events, observer } = observed();
    const rates = new DiscordRateCoordinator(policy, observer);
    const permit = await rates.acquire({
      route: 'PATCH /webhooks/:id/:token/messages/@original',
      major: '123:interaction-token-sentinel',
    });
    permit.observe(limited({}, 401));
    permit.release();
    expect(JSON.stringify(events)).not.toContain('interaction-token-sentinel');
    expect(events).toEqual([
      { type: 'rest', route: 'PATCH /webhooks/:id/:token/messages/@original', status: 401 },
    ]);
  });

  test('reports a rate limited response as the status Discord returned', async () => {
    const { events, observer } = observed();
    const permit = await new DiscordRateCoordinator(policy, observer).acquire(route());
    permit.observe(limited({ 'retry-after': '1' }, 429), { retry_after: 1 });
    permit.release();
    expect(events).toEqual([{ type: 'rest', route: 'POST /channels/:id/messages', status: 429 }]);
  });

  test('reports each local refusal once and never a caller abort', async () => {
    const { events, observer } = observed();
    const rates = new DiscordRateCoordinator(
      { ...policy, maxQueued: 1, maxQueueWaitMs: 100 },
      observer,
    );
    const active = await rates.acquire(route());
    const waiting = rates.acquire(route()).catch((error: unknown) => error);
    await expect(rates.acquire(route())).rejects.toMatchObject({ code: 'queue_full' });
    await jest.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toMatchObject({ code: 'queue_timeout' });
    const controller = new AbortController();
    controller.abort();
    await expect(rates.acquire(route(), controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    active.release();
    const capped = new DiscordRateCoordinator({ ...policy, maxTrackedRoutes: 1 }, observer);
    const held = await capped.acquire(route());
    await expect(capped.acquire(route('channels:456'))).rejects.toMatchObject({ code: 'capacity' });
    held.release();
    expect(events.filter((event) => event.type === 'rejected')).toEqual([
      { type: 'rejected', reason: 'queue_full' },
      { type: 'rejected', reason: 'queue_timeout' },
      { type: 'rejected', reason: 'capacity' },
    ]);
    expect(events.filter((event) => event.type === 'rest')).toHaveLength(2);
  });

  test('an invalid route is not a refusal and is not reported', async () => {
    const { events, observer } = observed();
    await expect(
      new DiscordRateCoordinator(policy, observer).acquire({ route: '', major: 'x' }),
    ).rejects.toThrow('Invalid Discord rate route');
    expect(events).toEqual([]);
  });

  test('a throwing observer cannot disturb permits, queueing or rate limits', async () => {
    const rates = new DiscordRateCoordinator({ ...policy, maxQueued: 1 }, () => {
      throw new Error('observer unavailable');
    });
    const first = await rates.acquire(route());
    first.observe(limited({ 'x-ratelimit-bucket': 'b', 'x-ratelimit-remaining': '5' }, 200));
    const admitted = jest.fn();
    const waiting = rates.acquire(route()).then((permit) => {
      admitted();
      return permit;
    });
    await expect(rates.acquire(route())).rejects.toMatchObject({ code: 'queue_full' });
    expect(admitted).not.toHaveBeenCalled();
    expect(() => first.release()).not.toThrow();
    (await waiting).release();
    expect(admitted).toHaveBeenCalledTimes(1);
    (await rates.acquire(route())).release();
  });

  test('behaves exactly as before when no observer is supplied', async () => {
    const permit = await new DiscordRateCoordinator(policy).acquire(route());
    permit.observe(limited({}, 200));
    expect(() => permit.release()).not.toThrow();
  });
});
