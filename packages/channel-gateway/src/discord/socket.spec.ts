import * as timers from 'node:timers/promises';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { DiscordGatewayDriverOptions } from './socket';
import { createDiscordGatewayDriver, createOwnedIdentifyThrottler } from './socket';
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
