import type { Redis, Cluster } from 'ioredis';
import type { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import type { RedisClientsModule } from './redisClients.helper';
import { startRedis, sleep, waitUntil } from './outage.helper';
import { isRedisReady } from '~/app/readiness';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/math'),
  ...jest.requireActual('~/utils/common'),
}));

describe.each([false, true])('Redis outage recovery (cluster=%s)', (cluster) => {
  let server: Awaited<ReturnType<typeof startRedis>>;
  let clients: RedisClientsModule | undefined;
  let subscriber: Redis | Cluster | undefined;
  let env: NodeJS.ProcessEnv;
  const transports: RedisEventTransport[] = [];
  const extraClients: (Redis | Cluster)[] = [];

  const ready = (): boolean =>
    isRedisReady({
      useRedis: true,
      ioredis: clients?.ioredisClient ?? null,
      keyv: clients?.keyvRedisClient ?? null,
    });

  const connect = async (): Promise<void> => {
    clients = await import('../redisClients');
    await clients.waitForKeyvRedisClient();
    await waitUntil(ready);
  };

  beforeEach(async () => {
    env = { ...process.env };
    server = await startRedis(cluster);
    Object.assign(process.env, {
      USE_REDIS: 'true',
      USE_REDIS_CLUSTER: String(cluster),
      REDIS_URI: server.url,
      REDIS_RETRY_MAX_DELAY: '100',
      REDIS_PING_INTERVAL: '0',
      REDIS_SUBSCRIBER_PING_INTERVAL: '0',
      REDIS_KEY_PREFIX: '',
      REDIS_KEY_PREFIX_VAR: '',
      REDIS_USERNAME: '',
      REDIS_PASSWORD: '',
      REDIS_CA: '',
      REDIS_ENABLE_OFFLINE_QUEUE: 'true',
    });
    delete process.env.REDIS_RETRY_MAX_ATTEMPTS;
    jest.resetModules();
  });

  afterEach(async () => {
    for (const transport of transports.splice(0)) {
      transport.destroy();
    }
    for (const client of extraClients.splice(0)) {
      client.disconnect();
    }
    subscriber?.disconnect();
    subscriber = undefined;
    clients?.ioredisClient?.disconnect();
    const keyv = clients?.keyvRedisClient;
    try {
      if (keyv?.isOpen) {
        keyv.destroy();
      }
    } catch (error) {
      // Cluster teardown can encounter a master that exhausted its finite budget.
      if (!(error instanceof Error) || error.message !== 'The client is closed') {
        throw error;
      }
    } finally {
      clients = undefined;
      await server.close();
      process.env = env;
    }
  });

  it('recovers both clients and subscriptions after 20 seconds without replaying an uncertain write', async () => {
    await connect();
    const io = clients!.ioredisClient!;
    const keyv = clients!.keyvRedisClient!;
    const { createIoRedisSubscriber } = await import('../redisUtils');
    subscriber = createIoRedisSubscriber(io, 'outage-subscriber');
    const messages: string[] = [];
    subscriber.on('message', (_channel: string, value: string) => messages.push(value));
    await waitUntil(() => subscriber?.status === 'ready');
    await subscriber.subscribe('outage-events');
    await io.publish('outage-events', 'before');
    await waitUntil(() => messages.includes('before'));

    server.dropReplies();
    const pendingWrite = io.incr('outage-counter').then(
      () => 'resolved',
      () => 'rejected',
    );
    const pendingKeyvWrite = keyv.incr('keyv-outage-counter').then(
      () => 'resolved',
      () => 'rejected',
    );
    let applied = false;
    const deadline = Date.now() + 5000;
    while (!applied && Date.now() < deadline) {
      applied =
        (await server.admin.get('::outage-counter')) === '1' &&
        (await server.admin.get('keyv-outage-counter')) === '1';
      if (!applied) await sleep(20);
    }
    expect(applied).toBe(true);
    server.block();
    await waitUntil(() => !ready());
    await sleep(20_000);
    expect(ready()).toBe(false);
    await expect(pendingWrite).resolves.toBe('rejected');
    await expect(pendingKeyvWrite).resolves.toBe('rejected');

    server.restore();
    await waitUntil(ready);
    await waitUntil(() => subscriber?.status === 'ready');
    await expect(io.set('after-outage', 'ioredis')).resolves.toBe('OK');
    await expect(io.get('after-outage')).resolves.toBe('ioredis');
    await expect(keyv.set('keyv-after-outage', 'keyv')).resolves.toBe('OK');
    await expect(keyv.get('keyv-after-outage')).resolves.toBe('keyv');
    await expect(server.admin.get('::outage-counter')).resolves.toBe('1');
    await expect(server.admin.get('keyv-outage-counter')).resolves.toBe('1');
    await io.publish('outage-events', 'after');
    await waitUntil(() => messages.includes('after'));
    expect(messages).toEqual(['before', 'after']);
  }, 40_000);

  it('keeps stream and abort subscriptions after an interrupted resubscribe acknowledgement', async () => {
    await connect();
    const { createIoRedisSubscriber, duplicateIoRedisClient } = await import('../redisUtils');
    const { RedisEventTransport } = await import('~/stream/implementations/RedisEventTransport');
    const io = clients!.ioredisClient!;
    subscriber = createIoRedisSubscriber(io, 'outage-owner');
    let readyEvents = 0;
    subscriber.on('ready', () => readyEvents++);
    const publisher = duplicateIoRedisClient(io);
    extraClients.push(publisher);
    const owner = new RedisEventTransport(io, subscriber);
    const peer = new RedisEventTransport(publisher, createIoRedisSubscriber(io, 'outage-peer'));
    transports.push(owner, peer);
    const streamId = 'interrupted-subscription';
    const channel = `stream:{${streamId}}:events`;
    const chunks: unknown[] = [];
    let abortedGeneration: number | undefined;
    const attachment = owner.subscribe(streamId, { onChunk: (event) => chunks.push(event) });
    await attachment.ready;
    const unsubscribeAbort = await owner.onAbort(streamId, (generation) => {
      abortedGeneration = generation;
    });
    await waitUntil(() => publisher.status === 'ready');
    await peer.emitChunk(streamId, { value: 'before' });
    await waitUntil(() => chunks.length === 1);

    server.block();
    await waitUntil(() => !ready());
    server.interruptNextSubscription();
    server.restore();
    await waitUntil(() => server.interruptedSubscriptions === 1);
    await waitUntil(
      () => ready() && subscriber?.status === 'ready' && readyEvents >= (cluster ? 2 : 3),
    );

    const isSubscribed = async (): Promise<boolean> => {
      const counts = await server.admin.pubsub('NUMSUB', channel);
      return Array.isArray(counts) && counts[1] === 1;
    };
    let subscribed = await isSubscribed();
    const deadline = Date.now() + 2000;
    while (!subscribed && Date.now() < deadline) {
      await sleep(20);
      subscribed = await isSubscribed();
    }
    expect(subscribed).toBe(true);
    await peer.emitChunk(streamId, { value: 'after' });
    peer.emitAbort(streamId, 7);
    await waitUntil(() => chunks.length === 2 && abortedGeneration === 7);
    expect(chunks).toEqual([{ value: 'before' }, { value: 'after' }]);
    unsubscribeAbort();
    attachment.unsubscribe();
  }, 15_000);

  it('honors an explicit finite reconnect budget and remains not ready', async () => {
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '2';
    await connect();
    const { createIoRedisSubscriber } = await import('../redisUtils');
    subscriber = createIoRedisSubscriber(clients!.ioredisClient!, 'finite-subscriber');
    await waitUntil(() => subscriber?.status === 'ready');
    await subscriber.subscribe('finite-events');
    server.block();
    await waitUntil(() => !ready());
    await sleep(2000);
    server.restore();
    await sleep(500);
    expect(ready()).toBe(false);
    expect(clients!.ioredisClient!.status).not.toBe('ready');
    expect(subscriber.status).not.toBe('ready');
    expect(
      isRedisReady({
        useRedis: true,
        ioredis: { status: 'ready' },
        keyv: clients!.keyvRedisClient,
      }),
    ).toBe(false);
  }, 15_000);
});
