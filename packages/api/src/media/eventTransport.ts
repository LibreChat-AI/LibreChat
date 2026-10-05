import type { Cluster, Redis } from 'ioredis';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createIoRedisSubscriber, duplicateIoRedisClient } from '~/cache/redisUtils';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';

export type MediaActivityTransportOptions = {
  useRedis: boolean;
  redisClient?: Redis | Cluster | null;
};

/** A dedicated channel owner: GJM is allowed to retire every stream in its own transport. */
export function createMediaActivityTransport(options: MediaActivityTransportOptions): {
  transport: IEventTransport;
  destroy(): void;
} {
  if (!options.useRedis || !options.redisClient) {
    const transport = new InMemoryEventTransport();
    return { transport, destroy: () => transport.destroy() };
  }
  const publisher = duplicateIoRedisClient(options.redisClient, { enableOfflineQueue: false });
  let subscriber: Redis | Cluster | undefined;
  try {
    subscriber = createIoRedisSubscriber(options.redisClient, '[MediaActivity] subscriber');
    const transport = new RedisEventTransport(publisher, subscriber);
    return {
      transport,
      destroy: () => {
        transport.destroy();
        publisher.disconnect();
        subscriber?.disconnect();
      },
    };
  } catch (error) {
    publisher.disconnect();
    subscriber?.disconnect();
    throw error;
  }
}
