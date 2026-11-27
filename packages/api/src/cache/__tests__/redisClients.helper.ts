export type RedisClientsModule = typeof import('~/cache/redisClients');

/**
 * Closes the Redis clients owned by a `redisClients` module instance so the jest process can
 * exit once the suite finishes. Importing `redisClients` constructs and connects both
 * `ioredisClient` and `keyvRedisClient` as module side effects, so every instance created
 * through `jest.resetModules()` + re-import must be closed or its sockets and timers keep the
 * (in-band) test process alive after all tests pass.
 *
 * Pass the captured module object when `jest.resetModules()` already dropped the instance from
 * the registry (e.g. closing a `beforeAll` instance from `afterAll`); otherwise the current
 * registry instance is used.
 */
export async function closeRedisClients(clients?: RedisClientsModule): Promise<void> {
  const { ioredisClient, keyvRedisClient, keyvRedisClientReady } =
    clients ?? (await import('~/cache/redisClients'));

  if (keyvRedisClientReady) {
    await keyvRedisClientReady.catch(() => undefined);
  }
  if (keyvRedisClient?.isOpen) {
    await keyvRedisClient.disconnect().catch(() => undefined);
  }
  ioredisClient?.disconnect();
}
