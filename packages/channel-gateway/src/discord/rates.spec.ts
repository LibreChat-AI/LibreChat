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
