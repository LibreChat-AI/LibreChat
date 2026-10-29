import { ServerConfigsCacheFactory, APP_CACHE_NAMESPACE } from '../ServerConfigsCacheFactory';
import { ServerConfigsCacheRedisAggregateKey } from '../ServerConfigsCacheRedisAggregateKey';
import { ServerConfigsCacheInMemory } from '../ServerConfigsCacheInMemory';
import { cacheConfig } from '~/cache';

// Mock the cache implementations
jest.mock('../ServerConfigsCacheRedisAggregateKey');
jest.mock('../ServerConfigsCacheInMemory');

// Mock the cache config module
jest.mock('~/cache', () => ({
  cacheConfig: {
    USE_REDIS: false,
  },
}));

describe('ServerConfigsCacheFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheConfig.USE_REDIS = false;
  });

  describe('create()', () => {
    it('should return ServerConfigsCacheRedisAggregateKey for App namespace when USE_REDIS is true', () => {
      cacheConfig.USE_REDIS = true;

      const cache = ServerConfigsCacheFactory.create(APP_CACHE_NAMESPACE, false);

      expect(cache).toBeInstanceOf(ServerConfigsCacheRedisAggregateKey);
      expect(ServerConfigsCacheRedisAggregateKey).toHaveBeenCalledWith(APP_CACHE_NAMESPACE, false);
      expect(ServerConfigsCacheInMemory).not.toHaveBeenCalled();
    });

    it('should return ServerConfigsCacheInMemory for App namespace when USE_REDIS is false', () => {
      cacheConfig.USE_REDIS = false;

      const cache = ServerConfigsCacheFactory.create(APP_CACHE_NAMESPACE, false);

      expect(cache).toBeInstanceOf(ServerConfigsCacheInMemory);
      expect(ServerConfigsCacheInMemory).toHaveBeenCalledWith();
      expect(ServerConfigsCacheRedisAggregateKey).not.toHaveBeenCalled();
    });

    it('should return ServerConfigsCacheInMemory for non-App namespaces when USE_REDIS is false', () => {
      cacheConfig.USE_REDIS = false;

      const cache = ServerConfigsCacheFactory.create('CustomNamespace', false);

      expect(cache).toBeInstanceOf(ServerConfigsCacheInMemory);
      expect(ServerConfigsCacheInMemory).toHaveBeenCalledWith();
    });
  });
});
