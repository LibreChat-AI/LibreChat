import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as timers from 'node:timers/promises';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { AddressInfo } from 'node:net';
import type { DiscordGatewayDriverOptions } from './socket';
import { createDiscordGatewayDriver, createOwnedIdentifyThrottler } from './socket';
import { DiscordIdentifyRefusal } from './recovery';
import { DiscordRateCoordinator } from './rates';

function options(): DiscordGatewayDriverOptions {
  return {
    token: 'private-token',
    policy: discordChannelConfigSchema.shape.gateway.parse({ enabled: true }),
    maxResponseBytes: 1024,
    signal: new AbortController().signal,
    assertOwned: jest.fn(),
    retrieveSessionInfo: () => null,
    updateSessionInfo: async () => {},
    dispatch() {},
    ready() {},
    resumed() {},
    closed() {},
    error() {},
  };
}

describe('published Discord SDK binding', () => {
  test('uses the real SDK REST discovery with bounded authenticated GET and no retries', async () => {
    const config = options();
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ code: 50014, message: 'Authentication rejected' }, { status: 401 }),
    );
    const driver = createDiscordGatewayDriver(config, transport);
    await expect(driver.connect()).rejects.toMatchObject({ reason: 'credentials', fatal: true });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe('https://discord.com/api/v10/gateway/bot');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bot private-token');
    expect(config.assertOwned).toHaveBeenCalled();
    await driver.destroy();
  });
  test('shares global bot limits with channel delivery and aborts queued discovery', async () => {
    const config = options();
    const controller = new AbortController();
    config.signal = controller.signal;
    const rates = new DiscordRateCoordinator();
    const permit = await rates.acquire({
      route: 'POST /channels/:id/messages',
      major: 'channels:123',
    });
    permit.observe(
      new Response(null, {
        status: 429,
        headers: { 'retry-after': '10', 'x-ratelimit-global': 'true' },
      }),
    );
    permit.release();
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const driver = createDiscordGatewayDriver(config, transport, rates);
    const connecting = driver.connect().catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
    controller.abort();
    await expect(connecting).resolves.toMatchObject({ code: 'aborted' });
    await driver.destroy();
  });
  test('rejects oversized gateway metadata before opening a WebSocket', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response('x'.repeat(1025)),
    );
    const driver = createDiscordGatewayDriver(options(), transport);
    await expect(driver.connect()).rejects.toThrow('Remote response exceeds size limit');
    expect(transport).toHaveBeenCalledTimes(1);
    await driver.destroy();
  });
  test('shares one SDK identify budget across concurrent shard initialization', async () => {
    const config = options();
    const controller = new AbortController();
    config.signal = controller.signal;
    const fetchGatewayInformation = jest.fn(async () => ({
      url: 'wss://gateway.discord.gg',
      shards: 2,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 60000, max_concurrency: 1 },
    }));
    const build = createOwnedIdentifyThrottler(config);
    const [first, second] = await Promise.all([
      build({ fetchGatewayInformation }),
      build({ fetchGatewayInformation }),
    ]);
    expect(first).toBe(second);
    expect(fetchGatewayInformation).toHaveBeenCalledTimes(1);
    await first.waitForIdentify(0, controller.signal);
    let identified = false;
    const waiting = second
      .waitForIdentify(1, controller.signal)
      .then(() => {
        identified = true;
      })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(identified).toBe(false);
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ name: 'AbortError' });
    await timers.setTimeout(6500);
  });
  test('binds the acknowledged heartbeat of any shard to the optional driver hook', async () => {
    const on = jest.spyOn(WebSocketManager.prototype, 'on');
    try {
      const heartbeat = jest.fn();
      const driver = createDiscordGatewayDriver({ ...options(), heartbeat }, jest.fn());
      const listener = on.mock.calls.find(
        ([event]) => event === WebSocketShardEvents.HeartbeatComplete,
      )?.[1];
      expect(listener).toBeDefined();
      await listener?.({ shardId: 3, latency: 41, ackAt: 2000, heartbeatAt: 1959 });
      expect(heartbeat).toHaveBeenCalledWith(3, 41);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await driver.destroy();
      const silent = createDiscordGatewayDriver(options(), jest.fn());
      const [, second] = on.mock.calls.filter(
        ([event]) => event === WebSocketShardEvents.HeartbeatComplete,
      );
      await expect(
        Promise.resolve(second?.[1]({ shardId: 0, latency: 1, ackAt: 2, heartbeatAt: 1 })),
      ).resolves.toBeUndefined();
      await silent.destroy();
    } finally {
      on.mockRestore();
    }
  });
  test('READY and RESUMED let a shard IDENTIFY again', async () => {
    const on = jest.spyOn(WebSocketManager.prototype, 'on');
    try {
      const budget = { reserve: jest.fn(), release: jest.fn(), reached: jest.fn() };
      const ready = jest.fn();
      const resumed = jest.fn();
      const driver = createDiscordGatewayDriver(
        { ...options(), ready, resumed },
        jest.fn(),
        undefined,
        budget,
      );
      const listener = (name: WebSocketShardEvents) =>
        on.mock.calls.find(([event]) => event === name)?.[1];
      await listener(WebSocketShardEvents.Ready)?.({ shardId: 2, data: {} } as never);
      await listener(WebSocketShardEvents.Resumed)?.({ shardId: 3 } as never);
      expect(budget.reached.mock.calls).toEqual([[2], [3]]);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveBeenCalledWith(3);
      await driver.destroy();
    } finally {
      on.mockRestore();
    }
  });
  test('refuses REST discovery after ownership loss', async () => {
    const config = options();
    config.assertOwned = () => {
      throw new Error('Ownership lost');
    };
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const driver = createDiscordGatewayDriver(config, transport);
    await expect(driver.connect()).rejects.toThrow('Ownership lost');
    expect(transport).not.toHaveBeenCalled();
    await driver.destroy();
  });
});

describe('published Discord SDK binding before READY', () => {
  /**
   * A Gateway that says HELLO (unless `hello` is false), hears IDENTIFY and then closes with `closeWith`,
   * sends READY (and `invalidate`s the session) or stays silent. `limit` is the session budget it reports ('absent' omits it).
   */
  async function gateway(
    behavior: { closeWith?: number; ready?: boolean; invalidate?: boolean; hello?: boolean } = {},
    limit: unknown = {
      total: 1000,
      remaining: 999,
      reset_after: 86_400_000,
      max_concurrency: 1,
    },
  ) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const seen = { connections: 0, identifies: 0 };
    let identified!: () => void;
    const firstIdentify = new Promise<void>((resolve) => {
      identified = resolve;
    });
    server.on('connection', (socket) => {
      seen.connections++;
      if (behavior.hello !== false)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).op !== 2) return;
        seen.identifies++;
        identified();
        if (behavior.closeWith !== undefined) socket.close(behavior.closeWith);
        if (behavior.ready)
          socket.send(
            JSON.stringify({
              op: 0,
              t: 'READY',
              s: 1,
              d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' },
            }),
          );
        if (behavior.invalidate)
          setTimeout(() => socket.send(JSON.stringify({ op: 9, d: false })), 50);
      });
    });
    let reported = limit;
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        ...(reported === 'absent' ? {} : { session_start_limit: reported }),
      }),
    );
    return {
      seen,
      transport,
      /** What the next session reads, such as the budget Discord restores when its window resets. */
      report: (next: unknown) => {
        reported = next;
      },
      firstIdentify,
      close: async () => {
        for (const client of server.clients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }
  const bounded = () => ({
    ...options(),
    policy: discordChannelConfigSchema.shape.gateway.parse({
      enabled: true,
      handshakeTimeoutMs: 1000,
    }),
  });

  test('shutdown while a shard waits for READY settles within the handshake bound', async () => {
    const remote = await gateway();
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      let owned = true;
      const config = bounded();
      config.retrieveSessionInfo = () => {
        if (!owned) throw new Error('Discord Gateway ownership unavailable');
        return null;
      };
      const driver = createDiscordGatewayDriver(config, remote.transport);
      void driver.connect().catch(() => undefined);
      await remote.firstIdentify;
      // A session marks itself stopped before it closes the driver.
      owned = false;
      const startedAt = Date.now();
      await expect(driver.destroy()).rejects.toThrow('Discord Gateway destroy timed out');
      expect(Date.now() - startedAt).toBeLessThan(2500);
      // The SDK retries the close after 500 ms and asks for the session again, which is frozen.
      await timers.setTimeout(800);
      expect(rejections).toEqual([]);
      expect(remote.seen.connections).toBe(1);
    } finally {
      process.off('unhandledRejection', record);
      await remote.close();
    }
  });

  test('losing ownership while the SDK reconnects freezes it without an unhandled rejection', async () => {
    const remote = await gateway({ closeWith: 4000 });
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      let owned = true;
      const config = bounded();
      config.retrieveSessionInfo = () => {
        if (!owned) throw new Error('Discord Gateway ownership unavailable');
        return null;
      };
      const driver = createDiscordGatewayDriver(config, remote.transport);
      void driver.connect().catch(() => undefined);
      await remote.firstIdentify;
      owned = false;
      // The SDK waits 500 ms before it reconnects after an unknown close, then asks for the session.
      await timers.setTimeout(1500);
      expect(rejections).toEqual([]);
      expect(remote.seen).toEqual({ connections: 1, identifies: 1 });
      await driver.destroy();
      await timers.setTimeout(700);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
      await remote.close();
    }
  });

  test('a Gateway that never answers an IDENTIFY costs one IDENTIFY and then parks the SDK', async () => {
    const remote = await gateway({ closeWith: 4000 });
    const refusals: unknown[] = [];
    const driver = createDiscordGatewayDriver(
      { ...bounded(), identifyRefused: (error) => refusals.push(error) },
      remote.transport,
    );
    void driver.connect().catch(() => undefined);
    await remote.firstIdentify;
    // The SDK reconnects after 500 ms and asks to IDENTIFY again before the shard ever got READY.
    await timers.setTimeout(1500);
    const settled = { ...remote.seen };
    await timers.setTimeout(1500);
    expect(remote.seen).toEqual(settled);
    expect(remote.seen).toEqual({ connections: 2, identifies: 1 });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ reason: 'retry' });
    await driver.destroy().catch(() => undefined);
    await remote.close();
  });

  test('the SDK cannot spend beyond the authoritative remaining while it keeps reconnecting', async () => {
    // READY resets the per shard rule, so only the authoritative budget can stop this loop.
    const remote = await gateway(
      { ready: true, invalidate: true },
      { total: 1000, remaining: 2, reset_after: 86_400_000, max_concurrency: 1 },
    );
    const refusals: unknown[] = [];
    const driver = createDiscordGatewayDriver(
      { ...bounded(), identifyRefused: (error) => refusals.push(error) },
      remote.transport,
    );
    void driver.connect().catch(() => undefined);
    for (let waited = 0; refusals.length === 0 && waited < 14_000; waited += 100)
      await timers.setTimeout(100);
    await timers.setTimeout(1500);
    expect(remote.seen.identifies).toBe(2);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ reason: 'exhausted' });
    await driver.destroy().catch(() => undefined);
    await remote.close();
  });

  test.each([
    ['a negative remaining', { total: 1000, remaining: -1, reset_after: 1000, max_concurrency: 1 }],
    [
      'a remaining that is not a number',
      { total: 1000, remaining: '999', reset_after: 1000, max_concurrency: 1 },
    ],
    [
      'a remaining above the total',
      { total: 10, remaining: 11, reset_after: 1000, max_concurrency: 1 },
    ],
    ['no concurrency', { total: 1000, remaining: 999, reset_after: 1000, max_concurrency: 0 }],
    ['a fractional reset', { total: 1000, remaining: 999, reset_after: 1.5, max_concurrency: 1 }],
    ['no reset', { total: 1000, remaining: 999, max_concurrency: 1 }],
    ['no limit at all', 'absent'],
  ])('refuses %s before any socket opens', async (_name, limit) => {
    const remote = await gateway({}, limit);
    const driver = createDiscordGatewayDriver(bounded(), remote.transport);
    const refusal = await driver.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    // A typed refusal, so the owner can hold the next session instead of retrying at once.
    expect(refusal).toBeInstanceOf(DiscordIdentifyRefusal);
    expect(refusal).toMatchObject({ reason: 'invalid' });
    expect(remote.seen).toEqual({ connections: 0, identifies: 0 });
    await driver.destroy().catch(() => undefined);
    await remote.close();
  });

  test('a budget below the shard count is refused at connect without opening a socket', async () => {
    const remote = await gateway(
      {},
      { total: 1000, remaining: 0, reset_after: 3_600_000, max_concurrency: 1 },
    );
    const driver = createDiscordGatewayDriver(bounded(), remote.transport);
    const refusal = await driver.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DiscordIdentifyRefusal);
    expect(refusal).toMatchObject({ reason: 'exhausted' });
    expect(remote.seen).toEqual({ connections: 0, identifies: 0 });
    await driver.destroy().catch(() => undefined);
    await remote.close();
  });

  test('a spent budget costs one REST read per session and no socket or IDENTIFY, until the window resets', async () => {
    const remote = await gateway(
      { ready: true },
      { total: 1000, remaining: 0, reset_after: 3_600_000, max_concurrency: 1 },
    );
    const outcomes: unknown[] = [];
    for (let session = 0; session < 4; session++) {
      const driver = createDiscordGatewayDriver(bounded(), remote.transport);
      outcomes.push(
        await driver.connect().then(
          () => 'connected',
          (error: unknown) => error,
        ),
      );
      await driver.destroy().catch(() => undefined);
    }
    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ reason: 'exhausted' });
    expect(remote.transport).toHaveBeenCalledTimes(4);
    expect(remote.seen).toEqual({ connections: 0, identifies: 0 });
    // Discord restores the budget. One remaining is enough for the one shard: exactly one IDENTIFY.
    remote.report({ total: 1000, remaining: 1, reset_after: 86_400_000, max_concurrency: 1 });
    const driver = createDiscordGatewayDriver(bounded(), remote.transport);
    await expect(driver.connect()).resolves.toBeUndefined();
    expect(remote.seen).toEqual({ connections: 1, identifies: 1 });
    await driver.destroy().catch(() => undefined);
    await remote.close();
  });

  test('a session update that fails after ownership ended is not an unhandled rejection', async () => {
    const remote = await gateway({ ready: true });
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);
    try {
      const config = bounded();
      config.updateSessionInfo = async () => {
        throw new Error('Discord checkpoint ownership changed');
      };
      const driver = createDiscordGatewayDriver(config, remote.transport);
      await driver.connect();
      await timers.setTimeout(100);
      expect(rejections).toEqual([]);
      await driver.destroy();
    } finally {
      process.off('unhandledRejection', record);
      await remote.close();
    }
  });
});
