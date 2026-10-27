import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';
import type { ConfigInvalidationPublisher, ConfigInvalidationSubscriber } from './invalidation';
import { CONFIG_INVALIDATION_CHANNEL, createConfigCacheInvalidation } from './invalidation';

/**
 * An in-process stand-in for Redis pub/sub: every subscribed connection receives every message
 * published on a channel it subscribed to, including the publisher's own instance.
 */
function createBroker() {
  const subscribers = new Set<{ channels: Set<string>; events: EventEmitter }>();
  return {
    publisher(): ConfigInvalidationPublisher & { publish: jest.Mock } {
      return {
        publish: jest.fn(async (channel: string, message: string) => {
          let delivered = 0;
          for (const subscriber of subscribers) {
            if (subscriber.channels.has(channel)) {
              delivered += 1;
              subscriber.events.emit('message', channel, message);
            }
          }
          return delivered;
        }),
      };
    },
    /** `failSubscribes` rejects that many SUBSCRIBE calls first, as Redis being down would. */
    subscriber(
      failSubscribes = 0,
    ): ConfigInvalidationSubscriber & { events: EventEmitter; subscribe: jest.Mock } {
      const state = { channels: new Set<string>(), events: new EventEmitter() };
      subscribers.add(state);
      let failures = failSubscribes;
      return {
        events: state.events,
        subscribe: jest.fn(async (channel: string) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('Reached the max retries per request limit');
          }
          return state.channels.add(channel);
        }),
        unsubscribe: async (channel: string) => state.channels.delete(channel),
        on: (event: string, listener: (...args: string[]) => void) =>
          state.events.on(event, listener),
        off: (event: string, listener: (...args: string[]) => void) =>
          state.events.off(event, listener),
      };
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createInstance(
  broker: ReturnType<typeof createBroker>,
  instanceId: string,
  failSubscribes = 0,
) {
  const clearOverrides = jest.fn(async (_tenantId?: string) => undefined);
  const clearMcp = jest.fn(async () => undefined);
  const publisher = broker.publisher();
  const subscriber = broker.subscriber(failSubscribes);
  const invalidation = createConfigCacheInvalidation({
    clears: [
      { label: 'clearOverrideCache', clear: clearOverrides },
      { label: 'clearMcpConfigCache', clear: clearMcp },
    ],
    pubsub: { publisher, subscriber },
    instanceId,
  });
  return { invalidation, clearOverrides, clearMcp, publisher, subscriber };
}

describe('createConfigCacheInvalidation', () => {
  it('runs every clear concurrently and passes the tenant through', async () => {
    const events: string[] = [];
    const tracked = (label: string) =>
      jest.fn(async () => {
        events.push(`start:${label}`);
        await flush();
        events.push(`end:${label}`);
      });
    const overrides = tracked('override');
    const mcp = tracked('mcp');
    const invalidation = createConfigCacheInvalidation({
      clears: [
        { label: 'override', clear: overrides },
        { label: 'mcp', clear: mcp },
      ],
    });

    await invalidation.invalidate('tenant-a');

    expect(events.slice(0, 2).sort()).toEqual(['start:mcp', 'start:override']);
    expect(events).toHaveLength(4);
    expect(overrides).toHaveBeenCalledWith('tenant-a');
  });

  it('resolves when a clear fails, logging which one without its message', async () => {
    const error = jest.spyOn(logger, 'error').mockReturnValue(logger);
    const other = jest.fn().mockResolvedValue(undefined);
    const invalidation = createConfigCacheInvalidation({
      clears: [
        {
          label: 'clearOverrideCache',
          clear: jest.fn().mockRejectedValue(new Error('secret-ish')),
        },
        { label: 'clearMcpConfigCache', clear: other },
      ],
    });

    await expect(invalidation.invalidate()).resolves.toBeUndefined();

    expect(other).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[invalidateConfigCaches] clearOverrideCache failed:',
      expect.not.objectContaining({ message: 'secret-ish' }),
    );
  });

  it('clears another instance when one invalidates, scoped to the same tenant', async () => {
    const broker = createBroker();
    const first = createInstance(broker, 'first');
    const second = createInstance(broker, 'second');
    await flush();

    await first.invalidation.invalidate('tenant-a');
    await flush();

    expect(first.clearOverrides).toHaveBeenCalledTimes(1);
    expect(second.clearOverrides).toHaveBeenCalledWith('tenant-a');
    expect(second.clearMcp).toHaveBeenCalledTimes(1);
    expect(first.publisher.publish).toHaveBeenCalledWith(
      CONFIG_INVALIDATION_CHANNEL,
      JSON.stringify({ origin: 'first', tenantId: 'tenant-a' }),
    );
  });

  it('broadcasts a clear of every tenant without a tenant id', async () => {
    const broker = createBroker();
    const first = createInstance(broker, 'first');
    const second = createInstance(broker, 'second');
    await flush();

    await first.invalidation.invalidate();
    await flush();

    expect(second.clearOverrides).toHaveBeenCalledWith(undefined);
  });

  it('ignores its own broadcast, malformed messages and other channels', async () => {
    const broker = createBroker();
    const only = createInstance(broker, 'only');
    const listener = broker.subscriber();
    await flush();
    const publisher = broker.publisher();

    await only.invalidation.invalidate();
    await publisher.publish(CONFIG_INVALIDATION_CHANNEL, 'not json');
    await publisher.publish(CONFIG_INVALIDATION_CHANNEL, JSON.stringify({ origin: 1 }));
    await publisher.publish(
      CONFIG_INVALIDATION_CHANNEL,
      JSON.stringify({ origin: 'x', tenantId: { $ne: '' } }),
    );
    await listener.subscribe('another-channel');
    await publisher.publish('another-channel', JSON.stringify({ origin: 'x' }));
    await flush();

    expect(only.clearOverrides).toHaveBeenCalledTimes(1);
  });

  it('stops listening once closed', async () => {
    const broker = createBroker();
    const first = createInstance(broker, 'first');
    const second = createInstance(broker, 'second');
    await flush();

    await second.invalidation.close();
    await first.invalidation.invalidate();
    await flush();

    expect(second.clearOverrides).not.toHaveBeenCalled();
  });

  it('subscribes again when the subscriber becomes ready after a failed SUBSCRIBE', async () => {
    const error = jest.spyOn(logger, 'error').mockReturnValue(logger);
    const broker = createBroker();
    const first = createInstance(broker, 'first');
    const second = createInstance(broker, 'second', 1);
    await flush();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Subscribing to cross-instance invalidations failed'),
      expect.anything(),
    );
    await first.invalidation.invalidate('tenant-a');
    await flush();
    expect(second.clearOverrides).not.toHaveBeenCalled();

    second.subscriber.events.emit('ready');
    await flush();
    await first.invalidation.invalidate('tenant-a');
    await flush();

    expect(second.subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(second.clearOverrides).toHaveBeenCalledWith('tenant-a');
  });

  it('leaves resubscribing to the client once subscribed, and stops retrying once closed', async () => {
    const broker = createBroker();
    const subscribed = createInstance(broker, 'subscribed');
    const closed = createInstance(broker, 'closed', 1);
    await flush();

    subscribed.subscriber.events.emit('ready');
    await closed.invalidation.close();
    closed.subscriber.events.emit('ready');
    await flush();

    expect(subscribed.subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(closed.subscriber.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the local clear when publishing fails', async () => {
    const error = jest.spyOn(logger, 'error').mockReturnValue(logger);
    const clear = jest.fn().mockResolvedValue(undefined);
    const broker = createBroker();
    const invalidation = createConfigCacheInvalidation({
      clears: [{ label: 'clearOverrideCache', clear }],
      pubsub: {
        publisher: { publish: jest.fn().mockRejectedValue(new Error('redis down')) },
        subscriber: broker.subscriber(),
      },
    });

    await expect(invalidation.invalidate()).resolves.toBeUndefined();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Publishing to other instances failed'),
      expect.anything(),
    );
  });

  describe('reload', () => {
    it('reports a clear here and a broadcast the other instance acts on', async () => {
      const broker = createBroker();
      const first = createInstance(broker, 'first');
      const second = createInstance(broker, 'second');
      await flush();

      await expect(first.invalidation.reload('tenant-a')).resolves.toEqual({
        cleared: true,
        broadcast: 'sent',
      });
      await flush();

      expect(first.clearOverrides).toHaveBeenCalledWith('tenant-a');
      expect(second.clearOverrides).toHaveBeenCalledWith('tenant-a');
    });

    it('reports a failed publish, keeping the local clear, instead of only logging it', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const clear = jest.fn().mockResolvedValue(undefined);
      const invalidation = createConfigCacheInvalidation({
        clears: [{ label: 'clearAppConfigCache', clear }],
        pubsub: {
          publisher: { publish: jest.fn().mockRejectedValue(new Error('redis down')) },
          subscriber: createBroker().subscriber(),
        },
      });

      await expect(invalidation.reload()).resolves.toEqual({ cleared: true, broadcast: 'failed' });
      expect(clear).toHaveBeenCalledTimes(1);
    });

    it('reports a failed local clear, still publishing it to the other instances', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const broker = createBroker();
      const second = createInstance(broker, 'second');
      const invalidation = createConfigCacheInvalidation({
        clears: [
          { label: 'clearAppConfigCache', clear: jest.fn().mockRejectedValue(new Error('x')) },
          { label: 'clearOverrideCache', clear: jest.fn().mockResolvedValue(undefined) },
        ],
        pubsub: { publisher: broker.publisher(), subscriber: broker.subscriber() },
        instanceId: 'first',
      });
      await flush();

      await expect(invalidation.reload()).resolves.toEqual({ cleared: false, broadcast: 'sent' });
      await flush();
      expect(second.clearOverrides).toHaveBeenCalledTimes(1);
    });

    it('loads the config here after the clear and before the broadcast, reporting the load', async () => {
      const broker = createBroker();
      const second = createInstance(broker, 'second');
      const publisher = broker.publisher();
      const clear = jest.fn().mockResolvedValue(undefined);
      const load = jest.fn(async () => ({ ok: true as const }));
      const invalidation = createConfigCacheInvalidation({
        clears: [{ label: 'clearAppConfigCache', clear }],
        load,
        pubsub: { publisher, subscriber: broker.subscriber() },
        instanceId: 'first',
      });
      await flush();

      await expect(invalidation.reload()).resolves.toEqual({
        cleared: true,
        loaded: { ok: true },
        broadcast: 'sent',
      });
      await flush();

      const [cleared] = clear.mock.invocationCallOrder;
      const [loaded] = load.mock.invocationCallOrder;
      const [published] = publisher.publish.mock.invocationCallOrder;
      expect(cleared).toBeLessThan(loaded);
      expect(loaded).toBeLessThan(published);
      expect(second.clearOverrides).toHaveBeenCalledTimes(1);
    });

    it('reports a failed load and does not tell the other instances, which keep their config', async () => {
      const broker = createBroker();
      const second = createInstance(broker, 'second');
      const publisher = broker.publisher();
      const clear = jest.fn().mockResolvedValue(undefined);
      const failure = {
        code: 'CONFIG_INVALID' as const,
        issues: [{ path: 'bogus', segments: ['bogus'], code: 'unrecognized_keys' }],
      };
      const invalidation = createConfigCacheInvalidation({
        clears: [{ label: 'clearAppConfigCache', clear }],
        load: async () => ({ ok: false, error: failure }),
        pubsub: { publisher, subscriber: broker.subscriber() },
        instanceId: 'first',
      });
      await flush();

      await expect(invalidation.reload()).resolves.toEqual({
        cleared: true,
        loaded: { ok: false, error: failure },
        broadcast: 'skipped',
      });
      await flush();

      expect(clear).toHaveBeenCalledTimes(1);
      expect(publisher.publish).not.toHaveBeenCalled();
      expect(second.clearOverrides).not.toHaveBeenCalled();
    });

    it('leaves the load to the next read for a write invalidation', async () => {
      const load = jest.fn(async () => ({ ok: true as const }));
      const clear = jest.fn().mockResolvedValue(undefined);
      const invalidation = createConfigCacheInvalidation({
        clears: [{ label: 'clearAppConfigCache', clear }],
        load,
      });

      await invalidation.invalidate();

      expect(clear).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    });

    it('reports no broadcast without a pub/sub', async () => {
      const clear = jest.fn().mockResolvedValue(undefined);
      const invalidation = createConfigCacheInvalidation({
        clears: [{ label: 'clearAppConfigCache', clear }],
      });

      await expect(invalidation.reload('tenant-a')).resolves.toEqual({
        cleared: true,
        broadcast: 'none',
      });
      expect(clear).toHaveBeenCalledWith('tenant-a');
    });
  });
});
