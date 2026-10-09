import { expect } from '@playwright/test';
import { ParsedServerConfig } from '~/mcp/types';
const FIXED_TIME = 1699564800000;
const originalDateNow = Date.now;
Date.now = jest.fn(() => FIXED_TIME);

describe('ServerConfigsCacheInMemory Integration Tests', () => {
  let ServerConfigsCacheInMemory: typeof import('../ServerConfigsCacheInMemory').ServerConfigsCacheInMemory;
  let cache: InstanceType<
    typeof import('../ServerConfigsCacheInMemory').ServerConfigsCacheInMemory
  >;

  // Test data
  const mockConfig1: ParsedServerConfig = {
    type: 'stdio',
    command: 'node',
    args: ['server1.js'],
    env: { TEST: 'value1' },
    updatedAt: FIXED_TIME,
  };

  const mockConfig2: ParsedServerConfig = {
    type: 'stdio',
    command: 'python',
    args: ['server2.py'],
    env: { TEST: 'value2' },
    updatedAt: FIXED_TIME,
  };

  const mockConfig3: ParsedServerConfig = {
    type: 'stdio',
    command: 'node',
    args: ['server3.js'],
    url: 'http://localhost:3000',
    requiresOAuth: true,
    updatedAt: FIXED_TIME,
  };

  beforeAll(async () => {
    // Import modules
    const cacheModule = await import('../ServerConfigsCacheInMemory');
    ServerConfigsCacheInMemory = cacheModule.ServerConfigsCacheInMemory;
  });

  afterAll(() => {
    Date.now = originalDateNow;
  });

  beforeEach(() => {
    // Create a fresh instance for each test
    cache = new ServerConfigsCacheInMemory();
  });

  describe('add and get operations', () => {
    it('should add and retrieve a server config', async () => {
      await cache.add('server1', mockConfig1);
      const result = await cache.get('server1');
      expect(result).toEqual(mockConfig1);
    });

    it('should return undefined for non-existent server', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should throw error when adding duplicate server', async () => {
      await cache.add('server1', mockConfig1);
      await expect(cache.add('server1', mockConfig2)).rejects.toThrow(
        'Server "server1" already exists in cache. Use update() to modify existing configs.',
      );
    });

    it('should handle multiple server configs', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);
      await cache.add('server3', mockConfig3);

      const result1 = await cache.get('server1');
      const result2 = await cache.get('server2');
      const result3 = await cache.get('server3');

      expect(result1).toEqual(mockConfig1);
      expect(result2).toEqual(mockConfig2);
      expect(result3).toEqual(mockConfig3);
    });
  });

  describe('getAll operation', () => {
    it('should return empty object when no servers exist', async () => {
      const result = await cache.getAll();
      expect(result).toEqual({});
    });

    it('should return all server configs', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);
      await cache.add('server3', mockConfig3);

      const result = await cache.getAll();
      expect(result).toEqual({
        server1: mockConfig1,
        server2: mockConfig2,
        server3: mockConfig3,
      });
    });

    it('should reflect updates in getAll', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      let result = await cache.getAll();
      expect(Object.keys(result).length).toBe(2);

      await cache.add('server3', mockConfig3);
      result = await cache.getAll();
      expect(Object.keys(result).length).toBe(3);
      expect(result.server3).toEqual(mockConfig3);
    });
  });

  describe('update operation', () => {
    it('should update an existing server config', async () => {
      await cache.add('server1', mockConfig1);
      expect(await cache.get('server1')).toEqual(mockConfig1);

      await cache.update('server1', mockConfig2);
      const result = await cache.get('server1');
      expect(result).toEqual(mockConfig2);
    });

    it('should throw error when updating non-existent server', async () => {
      await expect(cache.update('non-existent', mockConfig1)).rejects.toThrow(
        'Server "non-existent" does not exist in cache. Use add() to create new configs.',
      );
    });

    it('should reflect updates in getAll', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      await cache.update('server1', mockConfig3);
      const result = await cache.getAll();
      expect(result.server1).toEqual(mockConfig3);
      expect(result.server2).toEqual(mockConfig2);
    });
  });

  describe('remove operation', () => {
    it('should remove an existing server config', async () => {
      await cache.add('server1', mockConfig1);
      expect(await cache.get('server1')).toEqual(mockConfig1);

      await cache.remove('server1');
      expect(await cache.get('server1')).toBeUndefined();
    });

    it('should throw error when removing non-existent server', async () => {
      await expect(cache.remove('non-existent')).rejects.toThrow(
        'Failed to remove server "non-existent" in cache.',
      );
    });

    it('should remove server from getAll results', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      let result = await cache.getAll();
      expect(Object.keys(result).length).toBe(2);

      await cache.remove('server1');
      result = await cache.getAll();
      expect(Object.keys(result).length).toBe(1);
      expect(result.server1).toBeUndefined();
      expect(result.server2).toEqual(mockConfig2);
    });

    it('should allow re-adding a removed server', async () => {
      await cache.add('server1', mockConfig1);
      await cache.remove('server1');
      await cache.add('server1', mockConfig3);

      const result = await cache.get('server1');
      expect(result).toEqual(mockConfig3);
    });
  });

  describe('replaceStub operation', () => {
    const stub: ParsedServerConfig = { ...mockConfig1, inspectionFailed: true };

    it('replaces the failed stub it was inspected from', async () => {
      await cache.add('server1', stub);

      await expect(cache.replaceStub('server1', mockConfig2, FIXED_TIME)).resolves.toEqual(
        mockConfig2,
      );
      expect(await cache.get('server1')).toEqual(mockConfig2);
    });

    it('leaves an entry another writer already recovered, even within the same millisecond', async () => {
      await cache.add('server1', stub);
      await cache.update('server1', mockConfig3);

      await expect(cache.replaceStub('server1', mockConfig2, FIXED_TIME)).resolves.toBeUndefined();
      expect(await cache.get('server1')).toEqual(mockConfig3);
    });

    it('leaves a newer stub written after the inspected one', async () => {
      await cache.add('server1', stub);
      (Date.now as jest.Mock).mockReturnValueOnce(FIXED_TIME + 1);
      await cache.update('server1', stub);

      await expect(cache.replaceStub('server1', mockConfig2, FIXED_TIME)).resolves.toBeUndefined();
      expect(await cache.get('server1')).toEqual({ ...stub, updatedAt: FIXED_TIME + 1 });
    });

    it('does not create a missing entry', async () => {
      await expect(cache.replaceStub('server1', mockConfig2, FIXED_TIME)).resolves.toBeUndefined();
      expect(await cache.get('server1')).toBeUndefined();
    });
  });

  describe('credential placeholders in YAML configs', () => {
    it('should preserve LIBRECHAT_OPENID placeholders (admin configs are trusted)', async () => {
      const adminConfig: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://internal-service.example.com/mcp',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-User-Id': '{{LIBRECHAT_OPENID_USER_ID}}',
        },
        updatedAt: FIXED_TIME,
      };

      await cache.add('internal-service', adminConfig as ParsedServerConfig);
      const retrieved = await cache.get('internal-service');

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.Authorization).toBe(
        'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      );
      expect(retrievedWithHeaders?.headers?.['X-User-Id']).toBe('{{LIBRECHAT_OPENID_USER_ID}}');
    });

    it('should preserve LIBRECHAT_USER placeholders (admin configs are trusted)', async () => {
      const adminConfig: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://internal-api.example.com/mcp',
        headers: {
          'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'X-User-Name': '{{LIBRECHAT_USER_NAME}}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
        updatedAt: FIXED_TIME,
      };

      await cache.add('internal-api', adminConfig as ParsedServerConfig);
      const retrieved = await cache.get('internal-api');

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-User-Email']).toBe('{{LIBRECHAT_USER_EMAIL}}');
      expect(retrievedWithHeaders?.headers?.['X-User-Name']).toBe('{{LIBRECHAT_USER_NAME}}');
      expect(retrievedWithHeaders?.headers?.['X-User-Id']).toBe('{{LIBRECHAT_USER_ID}}');
    });
  });
});
