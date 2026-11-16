import type { IIdentifyThrottler } from '@discordjs/ws';
import type { DiscordIdentifyBudget } from './budget';
import { createDiscordIdentifyBudget, readDiscordGatewayInformation } from './budget';
import { DiscordGatewayFailure, DiscordIdentifyRefusal } from './recovery';
import { createOwnedIdentifyThrottler } from './socket';

const limit = (overrides: object = {}) => ({
  total: 1000,
  remaining: 5,
  reset_after: 86_400_000,
  max_concurrency: 16,
  ...overrides,
});
const information = (overrides: object = {}) => ({
  url: 'wss://gateway.discord.gg',
  shards: 1,
  session_start_limit: limit(overrides),
});
/** Like the SDK, it hands out the same object until its cache expires, and a new one after. */
function remote(initial: unknown = information()) {
  const state = { current: initial as unknown };
  const manager = { fetchGatewayInformation: jest.fn(async () => state.current as never) };
  return { state, manager };
}
const reasonOf = async (work: Promise<unknown>) =>
  work.then(
    () => 'allowed',
    (error: unknown) => (error instanceof DiscordIdentifyRefusal ? error.reason : error),
  );
const settles = async (work: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

describe('Discord gateway metadata', () => {
  test('accepts exactly what Discord reports', () => {
    expect(readDiscordGatewayInformation(information()).session_start_limit.remaining).toBe(5);
    expect(readDiscordGatewayInformation(information({ remaining: 0 }))).toBeDefined();
    expect(readDiscordGatewayInformation(information({ remaining: 1000 }))).toBeDefined();
    expect(readDiscordGatewayInformation(information({ reset_after: 0 }))).toBeDefined();
  });

  test.each([
    ['null', null],
    ['no limit', { url: 'wss://gateway.discord.gg', shards: 1 }],
    ['a negative remaining', information({ remaining: -1 })],
    ['a fractional remaining', information({ remaining: 1.5 })],
    ['a remaining that is text', information({ remaining: '5' })],
    ['a remaining that is not finite', information({ remaining: Number.POSITIVE_INFINITY })],
    ['a remaining above the total', information({ total: 10, remaining: 11 })],
    ['no total', information({ total: undefined })],
    ['no concurrency', information({ max_concurrency: 0 })],
    ['a negative reset', information({ reset_after: -1 })],
    ['no url', { ...information(), url: '' }],
    ['no shards', { ...information(), shards: 0 }],
  ])('refuses %s', (_name, value) => {
    expect(() => readDiscordGatewayInformation(value)).toThrow(DiscordIdentifyRefusal);
    try {
      readDiscordGatewayInformation(value);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'invalid' });
    }
  });
});

describe('Discord IDENTIFY budget', () => {
  test('spends exactly the remaining across concurrent shards, never one more', async () => {
    const { manager } = remote(information({ remaining: 4 }));
    const budget = createDiscordIdentifyBudget();
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((shard) => reasonOf(budget.reserve(manager, shard))),
    );
    expect(results.filter((result) => result === 'allowed')).toHaveLength(4);
    expect(results.filter((result) => result === 'exhausted')).toHaveLength(2);
  });

  test('a shard cannot IDENTIFY again before it reached READY or RESUMED', async () => {
    const { manager } = remote(information({ remaining: 10 }));
    const budget = createDiscordIdentifyBudget();
    await budget.reserve(manager, 0);
    expect(await reasonOf(budget.reserve(manager, 0))).toBe('retry');
    await budget.reserve(manager, 1);
    budget.reached(0);
    expect(await reasonOf(budget.reserve(manager, 0))).toBe('allowed');
  });

  test('a reservation that was never used is given back, and only once', async () => {
    const { manager } = remote(information({ remaining: 1 }));
    const budget = createDiscordIdentifyBudget();
    await budget.reserve(manager, 0);
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('exhausted');
    budget.release(7);
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('exhausted');
    budget.release(0);
    budget.release(0);
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('allowed');
    expect(await reasonOf(budget.reserve(manager, 2))).toBe('exhausted');
  });

  test('a reservation from an earlier window cannot give a start back to the current one', async () => {
    const { manager, state } = remote(information({ remaining: 2 }));
    const budget = createDiscordIdentifyBudget();
    await budget.reserve(manager, 0);
    state.current = information({ remaining: 1 });
    await budget.reserve(manager, 1);
    expect(await reasonOf(budget.reserve(manager, 2))).toBe('exhausted');
    budget.release(0);
    expect(await reasonOf(budget.reserve(manager, 2))).toBe('exhausted');
    budget.release(1);
    expect(await reasonOf(budget.reserve(manager, 2))).toBe('allowed');
  });

  test('a new authoritative read starts a new window, and the same read keeps its count', async () => {
    const { manager, state } = remote(information({ remaining: 1 }));
    const budget = createDiscordIdentifyBudget();
    await budget.reserve(manager, 0);
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('exhausted');
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('exhausted');
    state.current = information({ remaining: 1 });
    expect(await reasonOf(budget.reserve(manager, 1))).toBe('allowed');
    expect(await reasonOf(budget.reserve(manager, 2))).toBe('exhausted');
  });

  test('a budget that cannot be read exactly is refused and spends nothing', async () => {
    const { manager, state } = remote({ url: 'wss://gateway.discord.gg', shards: 1 });
    const budget = createDiscordIdentifyBudget();
    expect(await reasonOf(budget.reserve(manager, 0))).toBe('invalid');
    state.current = information({ remaining: 1 });
    expect(await reasonOf(budget.reserve(manager, 0))).toBe('allowed');
  });

  test('a failed read reaches the caller unchanged and spends nothing', async () => {
    const { manager } = remote(information({ remaining: 1 }));
    const failure = new DiscordGatewayFailure('credentials');
    manager.fetchGatewayInformation.mockRejectedValueOnce(failure);
    const budget = createDiscordIdentifyBudget();
    expect(await reasonOf(budget.reserve(manager, 0))).toBe(failure);
    expect(await reasonOf(budget.reserve(manager, 0))).toBe('allowed');
  });
});

describe('Discord owned identify throttler with a budget', () => {
  const setup = (
    initial: unknown = information({ remaining: 1 }),
    overrides: { assertOwned?: () => void; identifyRefused?: (error: unknown) => void } = {},
  ) => {
    const refusals: unknown[] = [];
    const base: IIdentifyThrottler = { waitForIdentify: jest.fn(async () => undefined) };
    const world = remote(initial);
    const controller = new AbortController();
    const build = createOwnedIdentifyThrottler(
      {
        assertOwned: overrides.assertOwned ?? (() => undefined),
        signal: controller.signal,
        identifyRefused: overrides.identifyRefused ?? ((error) => refusals.push(error)),
      },
      undefined,
      () => base,
    );
    return { refusals, base, controller, ...world, build: () => build(world.manager) };
  };

  test('lets an IDENTIFY through while the budget allows it, spaced by the SDK throttle', async () => {
    const f = setup(information({ remaining: 2 }));
    const throttler = await f.build();
    await throttler.waitForIdentify(0, new AbortController().signal);
    expect(f.base.waitForIdentify).toHaveBeenCalledTimes(1);
    expect(f.refusals).toEqual([]);
  });

  test('refuses beyond the budget: the owner is told, the SDK throttle is not reached, the shard parks', async () => {
    const f = setup(information({ remaining: 1 }));
    const throttler = await f.build();
    await throttler.waitForIdentify(0, new AbortController().signal);
    const second = throttler.waitForIdentify(1, new AbortController().signal);
    expect(await settles(second)).toBe(false);
    expect(f.refusals).toHaveLength(1);
    expect(f.refusals[0]).toMatchObject({ reason: 'exhausted' });
    expect(f.base.waitForIdentify).toHaveBeenCalledTimes(1);
  });

  test('a refusal parks even when the owner hook throws, and never throws into the SDK', async () => {
    const f = setup(information({ remaining: 0 }), {
      identifyRefused: () => {
        throw new Error('hook unavailable');
      },
    });
    const throttler = await f.build();
    expect(await settles(throttler.waitForIdentify(0, new AbortController().signal))).toBe(false);
    expect(f.base.waitForIdentify).not.toHaveBeenCalled();
  });

  test('checks ownership before it reserves anything', async () => {
    const f = setup(information({ remaining: 1 }), {
      assertOwned: () => {
        throw new Error('Ownership lost');
      },
    });
    const throttler = await f.build();
    await expect(throttler.waitForIdentify(0, new AbortController().signal)).rejects.toThrow(
      'Ownership lost',
    );
    expect(f.refusals).toEqual([]);
  });

  test('a wait that is aborted before its IDENTIFY gives the reservation back', async () => {
    const f = setup(information({ remaining: 1 }));
    f.base.waitForIdentify = jest.fn(
      (_shard: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('closed', 'AbortError'))),
        ),
    );
    const throttler = await f.build();
    const shard = new AbortController();
    const waiting = throttler.waitForIdentify(0, shard.signal);
    shard.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    f.base.waitForIdentify = jest.fn(async () => undefined);
    await throttler.waitForIdentify(0, new AbortController().signal);
    expect(f.refusals).toEqual([]);
  });

  test('a budget that cannot be read exactly refuses every IDENTIFY', async () => {
    const f = setup({ url: 'wss://gateway.discord.gg', shards: 1 });
    const throttler = await f.build();
    expect(await settles(throttler.waitForIdentify(0, new AbortController().signal))).toBe(false);
    expect(await settles(throttler.waitForIdentify(1, new AbortController().signal))).toBe(false);
    expect(f.refusals.map((error) => (error as DiscordIdentifyRefusal).reason)).toEqual([
      'invalid',
      'invalid',
    ]);
    expect(f.base.waitForIdentify).not.toHaveBeenCalled();
  });

  test('a failed first read refuses every IDENTIFY with the original failure', async () => {
    const f = setup();
    const failure = new DiscordGatewayFailure('credentials');
    f.manager.fetchGatewayInformation.mockRejectedValue(failure);
    const throttler = await f.build();
    expect(await settles(throttler.waitForIdentify(0, new AbortController().signal))).toBe(false);
    expect(f.refusals).toEqual([failure]);
    expect(f.base.waitForIdentify).not.toHaveBeenCalled();
  });

  test('a rejected token found while reading the budget for an IDENTIFY reaches the owner unchanged', async () => {
    const f = setup(information({ remaining: 5 }));
    const throttler = await f.build();
    const failure = new DiscordGatewayFailure('credentials');
    f.manager.fetchGatewayInformation.mockRejectedValueOnce(failure);
    expect(await settles(throttler.waitForIdentify(0, new AbortController().signal))).toBe(false);
    expect(f.refusals).toEqual([failure]);
  });

  test('reserves before the SDK spaces the IDENTIFY, so a refusal does not wait for a turn', async () => {
    const order: string[] = [];
    const budget: DiscordIdentifyBudget = {
      reserve: jest.fn(async () => {
        order.push('reserve');
      }),
      release: jest.fn(),
      reached: jest.fn(),
    };
    const base: IIdentifyThrottler = {
      waitForIdentify: jest.fn(async () => {
        order.push('space');
      }),
    };
    const world = remote(information());
    const build = createOwnedIdentifyThrottler(
      { assertOwned: () => undefined, signal: new AbortController().signal },
      budget,
      () => base,
    );
    await (await build(world.manager)).waitForIdentify(0, new AbortController().signal);
    expect(order).toEqual(['reserve', 'space']);
  });
});
