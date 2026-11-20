jest.mock('@librechat/api', () => {
  const api = jest.requireActual('@librechat/api');
  return {
    ...api,
    standardCache: jest.fn(api.standardCache),
    registerShutdownTask: jest.fn(),
    cacheConfig: {
      ...api.cacheConfig,
      USE_REDIS: true,
      CI: false,
      DEBUG_MEMORY_CACHE: false,
      FORCED_IN_MEMORY_CACHE_NAMESPACES: ['ROLES'],
    },
  };
});

const { standardCache, registerShutdownTask } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
jest.useFakeTimers();
const getLogStores = require('./getLogStores');
const index = standardCache.mock.calls.findIndex(([key]) => key === CacheKeys.ROLES);
const base = standardCache.mock.results[index].value;
const shutdown = registerShutdownTask.mock.calls.find(([name]) => name === 'cache cleanup');

it('sweeps expired generations when Redis is enabled but roles are forced into memory', async () => {
  const cache = getLogStores(CacheKeys.ROLES);
  cache.configure(1000);
  await (await cache.snapshot()).set('USER', { permissions: { AGENTS: { CREATE: true } } });
  await cache.invalidate();
  // The old generation is unreachable: only the periodic sweep can reclaim its document.
  expect(base.opts.store.size).toBe(2);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(base.opts.store.size).toBe(1);
  expect(await base.get('__regional_role_generation')).toEqual(expect.any(String));
  const timers = jest.getTimerCount();
  await shutdown[1]();
  expect(jest.getTimerCount()).toBe(timers - 1);
});

afterAll(async () => {
  await shutdown[1]();
  jest.clearAllTimers();
  jest.useRealTimers();
});
