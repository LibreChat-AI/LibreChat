import { Keyv } from 'keyv';
import { FlowStateManager, FlowStateNotFoundError, PENDING_STALE_MS } from './manager';
import { FlowState } from './types';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/** Mock class without extending Keyv */
class MockKeyv<T = string> {
  private store: Map<string, FlowState<T>>;

  constructor() {
    this.store = new Map();
  }

  async get(key: string): Promise<FlowState<T> | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: FlowState<T>, _ttl?: number): Promise<true> {
    this.store.set(key, value);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

describe('FlowStateManager', () => {
  let flowManager: FlowStateManager<string>;
  let store: MockKeyv;

  beforeEach(() => {
    store = new MockKeyv();
    // Type assertion here since we know our mock implements the necessary methods
    flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 30000, ci: true });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([false, true])(
    'preserves named failures across serialized stores (guarded: %s)',
    async (guarded) => {
      jest.useFakeTimers();
      const keyv = new Keyv({ serialize: JSON.stringify, deserialize: JSON.parse });
      const owner = new FlowStateManager<string>(keyv, { ttl: 30000, ci: true });
      const peer = new FlowStateManager<string>(keyv, { ttl: 30000, ci: true });
      try {
        await owner.initFlow('refresh', 'mcp_get_tokens');
        const flow = await owner.getFlowState('refresh', 'mcp_get_tokens');
        const waiting = peer.createFlowWithHandler(
          'refresh',
          'mcp_get_tokens',
          async () => 'unexpected',
        );
        const result = waiting.catch((error: Error) => error);
        const expected = {
          name: 'MCPTokenRefreshUnavailableError',
          message: 'retry later',
        };
        await Promise.resolve();
        const error = new Error('retry later');
        error.name = 'MCPTokenRefreshUnavailableError';
        if (guarded) {
          await owner.failFlowIfCurrent('refresh', 'mcp_get_tokens', flow!.createdAt, '', error);
        } else {
          await owner.failFlow('refresh', 'mcp_get_tokens', error);
        }
        await jest.advanceTimersByTimeAsync(2000);
        expect(await result).toMatchObject(expected);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  describe('Concurrency Tests', () => {
    it('atomically updates the default in-memory Keyv envelope', async () => {
      const keyv = new Keyv({
        namespace: 'flow-atomic-test',
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      });
      const manager = new FlowStateManager<string>(keyv, { ttl: 30000, ci: true });
      await manager.initFlow('oauth-flow', 'mcp_oauth', { state: 'expected-state' });
      const flow = await manager.getFlowState('oauth-flow', 'mcp_oauth');

      await expect(
        manager.failFlowIfCurrent(
          'oauth-flow',
          'mcp_oauth',
          flow!.createdAt,
          'expected-state',
          'cancelled',
        ),
      ).resolves.toBe('updated');

      expect(await manager.getFlowState('oauth-flow', 'mcp_oauth')).toMatchObject({
        status: 'FAILED',
        error: 'cancelled',
      });
    });

    it('treats an expired in-memory envelope as missing during a guarded mutation', async () => {
      const keyv = new Keyv({
        namespace: 'flow-expiry-test',
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      });
      const manager = new FlowStateManager<string>(keyv, { ttl: 30000, ci: true });
      await manager.initFlow('oauth-flow', 'mcp_oauth', { state: 'expected-state' });
      const flow = await manager.getFlowState('oauth-flow', 'mcp_oauth');
      const memoryStore = keyv.store as Map<string, string>;
      const [storedKey, raw] = [...memoryStore.entries()][0];
      const envelope = JSON.parse(raw);
      envelope.expires = Date.now() - 1;
      memoryStore.set(storedKey, JSON.stringify(envelope));

      await expect(
        manager.completeFlowIfCurrent(
          'oauth-flow',
          'mcp_oauth',
          flow!.createdAt,
          'expected-state',
          'late-result',
        ),
      ).resolves.toBe('missing');
      expect(memoryStore.has(storedKey)).toBe(false);
    });

    it('does not delete a replacement OAuth attempt', async () => {
      await flowManager.initFlow('oauth-flow', 'mcp_oauth', { state: 'new-state' });

      await expect(
        flowManager.deleteFlowIfCurrent('oauth-flow', 'mcp_oauth', 1, 'old-state'),
      ).resolves.toBe('stale');

      expect(await flowManager.getFlowState('oauth-flow', 'mcp_oauth')).toMatchObject({
        status: 'PENDING',
        metadata: { state: 'new-state' },
      });
    });

    it('does not complete a replacement OAuth attempt', async () => {
      await flowManager.initFlow('oauth-flow', 'mcp_oauth', { state: 'new-state' });

      await expect(
        flowManager.completeFlowIfCurrent('oauth-flow', 'mcp_oauth', 1, 'old-state', 'old-result'),
      ).resolves.toBe('stale');

      expect(await flowManager.getFlowState('oauth-flow', 'mcp_oauth')).toMatchObject({
        status: 'PENDING',
        metadata: { state: 'new-state' },
      });
    });

    it('does not overwrite an already completed OAuth attempt', async () => {
      await flowManager.initFlow('oauth-flow', 'mcp_oauth', { state: 'expected-state' });
      const flow = await flowManager.getFlowState('oauth-flow', 'mcp_oauth');
      await flowManager.completeFlow('oauth-flow', 'mcp_oauth', 'first-result');

      await expect(
        flowManager.completeFlowIfCurrent(
          'oauth-flow',
          'mcp_oauth',
          flow!.createdAt,
          'expected-state',
          'second-result',
        ),
      ).resolves.toBe('stale');

      expect(await flowManager.getFlowState('oauth-flow', 'mcp_oauth')).toMatchObject({
        status: 'COMPLETED',
        result: 'first-result',
      });
    });

    it('settles a fresher result over a completion from the same observed attempt', async () => {
      await flowManager.initFlow('token-flow', 'mcp_get_tokens');
      const flow = await flowManager.getFlowState('token-flow', 'mcp_get_tokens');
      await flowManager.completeFlow('token-flow', 'mcp_get_tokens', 'old-token');

      await expect(
        flowManager.settleFlowIfCurrent(
          'token-flow',
          'mcp_get_tokens',
          flow!.createdAt,
          '',
          'fresh-token',
        ),
      ).resolves.toBe('updated');

      expect(await flowManager.getFlowState('token-flow', 'mcp_get_tokens')).toMatchObject({
        status: 'COMPLETED',
        result: 'fresh-token',
      });
    });

    it('settles a fresher result over a failure from the same observed attempt', async () => {
      await flowManager.initFlow('token-flow', 'mcp_get_tokens');
      const flow = await flowManager.getFlowState('token-flow', 'mcp_get_tokens');
      await flowManager.failFlow('token-flow', 'mcp_get_tokens', new Error('stale failure'));

      await expect(
        flowManager.settleFlowIfCurrent(
          'token-flow',
          'mcp_get_tokens',
          flow!.createdAt,
          '',
          'fresh-token',
        ),
      ).resolves.toBe('updated');

      expect(await flowManager.getFlowState('token-flow', 'mcp_get_tokens')).toMatchObject({
        status: 'COMPLETED',
        result: 'fresh-token',
      });
    });

    it('does not settle a replacement token-flow attempt', async () => {
      await flowManager.initFlow('token-flow', 'mcp_get_tokens');

      await expect(
        flowManager.settleFlowIfCurrent('token-flow', 'mcp_get_tokens', 1, '', 'old-token'),
      ).resolves.toBe('stale');

      expect(await flowManager.getFlowState('token-flow', 'mcp_get_tokens')).toMatchObject({
        status: 'PENDING',
      });
    });

    it('fails only the observed OAuth attempt', async () => {
      await flowManager.initFlow('oauth-flow', 'mcp_oauth', { state: 'expected-state' });
      const flow = await flowManager.getFlowState('oauth-flow', 'mcp_oauth');

      await expect(
        flowManager.failFlowIfCurrent(
          'oauth-flow',
          'mcp_oauth',
          flow!.createdAt,
          'expected-state',
          'cancelled',
        ),
      ).resolves.toBe('updated');

      expect(await flowManager.getFlowState('oauth-flow', 'mcp_oauth')).toMatchObject({
        status: 'FAILED',
        error: 'cancelled',
        metadata: { state: 'expected-state' },
      });
    });

    it('should handle concurrent flow creation and return same result', async () => {
      const flowId = 'test-flow';
      const type = 'test-type';

      // Start two concurrent flow creations
      const flow1Promise = flowManager.createFlowWithHandler(flowId, type, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'result';
      });

      const flow2Promise = flowManager.createFlowWithHandler(flowId, type, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'different-result';
      });

      // Both should resolve to the same result from the first handler
      const [result1, result2] = await Promise.all([flow1Promise, flow2Promise]);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
    });

    it('should return the externally completed result when handler loses completion race', async () => {
      const flowId = 'race-flow';
      const type = 'test-type';

      const result = await flowManager.createFlowWithHandler(flowId, type, async () => {
        await flowManager.completeFlow(flowId, type, 'fresh-result');
        return 'stale-result';
      });

      expect(result).toBe('fresh-result');
      await expect(flowManager.getFlowState(flowId, type)).resolves.toEqual(
        expect.objectContaining({
          status: 'COMPLETED',
          result: 'fresh-result',
        }),
      );
    });

    it('should return the externally completed result when handler loses failure race', async () => {
      const flowId = 'failure-race-flow';
      const type = 'test-type';

      const result = await flowManager.createFlowWithHandler(flowId, type, async () => {
        await flowManager.completeFlow(flowId, type, 'fresh-result');
        throw new Error('stale failure');
      });

      expect(result).toBe('fresh-result');
    });

    it('should re-read completion that wins after its guarded failure write', async () => {
      const flowId = 'post-failure-race-flow';
      const type = 'test-type';
      const originalFail = flowManager.failFlowIfCurrent.bind(flowManager);
      jest.spyOn(flowManager, 'failFlowIfCurrent').mockImplementation(async (...args) => {
        const failureResult = await originalFail(...args);
        await flowManager.settleFlowIfCurrent(flowId, type, args[2], args[3], 'fresh-result');
        return failureResult;
      });

      const result = await flowManager.createFlowWithHandler(flowId, type, async () => {
        throw new Error('stale failure');
      });

      expect(result).toBe('fresh-result');
    });

    it('should handle flow timeout correctly', async () => {
      const flowId = 'timeout-flow';
      const type = 'test-type';

      // Create flow with very short TTL
      const shortTtlManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 100,
        ci: true,
      });

      const flowPromise = shortTtlManager.createFlow(flowId, type);

      await expect(flowPromise).rejects.toThrow('test-type flow timed out');
    });

    it('should retain a terminal timeout for the remaining storage TTL', async () => {
      const flowId = 'retained-timeout-flow';
      const type = 'mcp_oauth';
      const shortTimeoutManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 5000,
        monitorTimeout: 100,
        retainedFailureTypes: ['mcp_oauth'],
        ci: true,
      });

      await expect(shortTimeoutManager.createFlow(flowId, type)).rejects.toThrow(
        'mcp_oauth flow timed out',
      );

      await expect(shortTimeoutManager.getFlowState(flowId, type)).resolves.toEqual(
        expect.objectContaining({
          status: 'FAILED',
          error: 'mcp_oauth flow timed out',
          failedAt: expect.any(Number),
        }),
      );
    });

    it('should maintain flow state consistency under high concurrency', async () => {
      const flowId = 'concurrent-flow';
      const type = 'test-type';

      // Create multiple concurrent operations
      const operations = [];
      for (let i = 0; i < 10; i++) {
        operations.push(
          flowManager.createFlowWithHandler(flowId, type, async () => {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
            return `result-${i}`;
          }),
        );
      }

      // All operations should resolve to the same result
      const results = await Promise.all(operations);
      const firstResult = results[0];
      results.forEach((result: string) => {
        expect(result).toBe(firstResult);
      });
    });

    it('should handle race conditions in flow completion', async () => {
      const flowId = 'test-flow';
      const type = 'test-type';

      // Create initial flow
      const flowPromise = flowManager.createFlow(flowId, type);

      // Increase delay to ensure flow is properly created
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Complete the flow
      await flowManager.completeFlow(flowId, type, 'result1');

      const result = await flowPromise;
      expect(result).toBe('result1');
    }, 15000);

    it('should handle concurrent flow monitoring', async () => {
      const flowId = 'test-flow';
      const type = 'test-type';

      // Create initial flow
      const flowPromise = flowManager.createFlow(flowId, type);

      // Increase delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Complete the flow
      await flowManager.completeFlow(flowId, type, 'success');

      const result = await flowPromise;
      expect(result).toBe('success');
    }, 15000);

    it('should handle concurrent success and failure attempts', async () => {
      const flowId = 'race-flow';
      const type = 'test-type';

      const flowPromise = flowManager.createFlow(flowId, type);

      // Increase delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Fail the flow
      await flowManager.failFlow(flowId, type, new Error('failure'));

      await expect(flowPromise).rejects.toThrow('failure');
      await expect(flowManager.getFlowState(flowId, type)).resolves.toBeUndefined();
    }, 15000);

    it('should retain configured failed flow types for status polling', async () => {
      const flowId = 'retained-failure-flow';
      const type = 'mcp_oauth';
      const retainedManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 5000,
        retainedFailureTypes: [type],
        ci: true,
      });
      const flowPromise = retainedManager.createFlow(flowId, type);

      await new Promise((resolve) => setTimeout(resolve, 500));
      await retainedManager.failFlow(flowId, type, new Error('provider rejected request'));

      await expect(flowPromise).rejects.toThrow('provider rejected request');
      await expect(retainedManager.getFlowState(flowId, type)).resolves.toEqual(
        expect.objectContaining({ status: 'FAILED', error: 'provider rejected request' }),
      );
    }, 15000);

    it('should not overwrite a completed flow with a late failure', async () => {
      const flowId = 'completed-race-flow';
      const type = 'test-type';
      const flowKey = `${type}:${flowId}`;

      await flowManager.initFlow(flowId, type);
      await flowManager.completeFlow(flowId, type, 'success');

      const result = await flowManager.failFlow(flowId, type, new Error('late failure'));
      const state = await store.get(flowKey);

      expect(result).toBe(true);
      expect(state).toMatchObject({
        status: 'COMPLETED',
        result: 'success',
      });
      expect(state?.error).toBeUndefined();
    });
  });

  describe('initFlow', () => {
    const flowId = 'init-test-flow';
    const type = 'test-type';
    const flowKey = `${type}:${flowId}`;

    it('stores a PENDING flow state in the cache', async () => {
      await flowManager.initFlow(flowId, type, { serverName: 'test' });

      const state = await store.get(flowKey);
      expect(state).toBeDefined();
      expect(state!.status).toBe('PENDING');
      expect(state!.type).toBe(type);
      expect(state!.metadata).toEqual({ serverName: 'test' });
      expect(state!.createdAt).toBeGreaterThan(0);
    });

    it('overwrites an existing flow state', async () => {
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: { old: true },
        createdAt: Date.now() - 10000,
      });

      await flowManager.initFlow(flowId, type, { new: true });

      const state = await store.get(flowKey);
      expect(state!.status).toBe('PENDING');
      expect(state!.metadata).toEqual({ new: true });
    });

    it('allows createFlow to find and monitor the pre-stored state', async () => {
      // initFlow stores the PENDING state
      await flowManager.initFlow(flowId, type, { preStored: true });

      // createFlow should find the existing state and start monitoring
      const flowPromise = flowManager.createFlow(flowId, type);

      // Complete the flow so the monitor resolves
      await new Promise((resolve) => setTimeout(resolve, 500));
      await flowManager.completeFlow(flowId, type, 'success');

      const result = await flowPromise;
      expect(result).toBe('success');
    }, 15000);

    it('passes the configured TTL to keyv.set', async () => {
      const setSpy = jest.spyOn(store, 'set');

      await flowManager.initFlow(flowId, type, { serverName: 'test' });

      expect(setSpy).toHaveBeenCalledWith(
        flowKey,
        expect.objectContaining({ status: 'PENDING' }),
        30000,
      );
    });

    it('propagates store write failures', async () => {
      jest.spyOn(store, 'set').mockRejectedValueOnce(new Error('Store write failed'));

      await expect(flowManager.initFlow(flowId, type)).rejects.toThrow('Store write failed');
    });
  });

  it('does not recreate a missing flow when monitoring a published attempt', async () => {
    await expect(
      flowManager.createFlow('deleted-oauth-flow', 'mcp_oauth', {}, undefined, false),
    ).rejects.toThrow('mcp_oauth flow not found');
    await expect(
      flowManager.getFlowState('deleted-oauth-flow', 'mcp_oauth'),
    ).resolves.toBeUndefined();
  });

  describe('deleteFlow', () => {
    const flowId = 'test-flow-123';
    const type = 'test-type';
    const flowKey = `${type}:${flowId}`;

    it('deletes an existing flow', async () => {
      await store.set(flowKey, { type, status: 'PENDING', metadata: {}, createdAt: Date.now() });
      expect(await store.get(flowKey)).toBeDefined();

      const result = await flowManager.deleteFlow(flowId, type);

      expect(result).toBe(true);
      expect(await store.get(flowKey)).toBeUndefined();
    });

    it('returns false if the deletion errors', async () => {
      jest.spyOn(store, 'delete').mockRejectedValue(new Error('Deletion failed'));

      const result = await flowManager.deleteFlow(flowId, type);

      expect(result).toBe(false);
    });

    it('does nothing if the flow does not exist', async () => {
      expect(await store.get(flowKey)).toBeUndefined();

      const result = await flowManager.deleteFlow(flowId, type);

      expect(result).toBe(true);
    });
  });

  describe('createFlowWithHandler - token expiration', () => {
    const flowId = 'token-flow';
    const type = 'mcp_get_tokens';
    const flowKey = `${type}:${flowId}`;

    type TokenResult = {
      access_token: string;
      refresh_token: string;
      expires_at?: number;
    };

    let tokenFlowManager: FlowStateManager<TokenResult>;
    let tokenStore: MockKeyv<TokenResult>;

    beforeEach(() => {
      tokenStore = new MockKeyv<TokenResult>();
      tokenFlowManager = new FlowStateManager(tokenStore as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });
    });

    it('serves a completed result without waiting on the monitor interval', async () => {
      const completedResult: TokenResult = {
        access_token: 'cached_token',
        refresh_token: 'refresh_token',
        expires_at: Date.now() + 3600000,
      };
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: completedResult,
      } as FlowState<TokenResult>);
      const handlerSpy = jest.fn();

      const startedAt = Date.now();
      await expect(
        tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy),
      ).resolves.toEqual(completedResult);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(handlerSpy).not.toHaveBeenCalled();
    });

    it('replaces a failure nobody retains instead of waiting on it', async () => {
      await tokenStore.set(flowKey, {
        type,
        status: 'FAILED',
        metadata: {},
        createdAt: Date.now() - 5000,
        failedAt: Date.now() - 4000,
        error: 'earlier attempt failed',
      } as FlowState<TokenResult>);
      const freshResult: TokenResult = { access_token: 'fresh_token', refresh_token: 'refresh' };
      const handlerSpy = jest.fn().mockResolvedValue(freshResult);

      await expect(
        tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy),
      ).resolves.toEqual(freshResult);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      await expect(tokenFlowManager.getFlowState(flowId, type)).resolves.toEqual(
        expect.objectContaining({ status: 'COMPLETED', result: freshResult }),
      );
    });

    it('still reports a retained failure to a later attempt', async () => {
      const retainingManager = new FlowStateManager<TokenResult>(tokenStore as unknown as Keyv, {
        ttl: 30000,
        retainedFailureTypes: [type],
        ci: true,
      });
      await tokenStore.set(flowKey, {
        type,
        status: 'FAILED',
        metadata: {},
        createdAt: Date.now() - 5000,
        failedAt: Date.now() - 4000,
        error: 'earlier attempt failed',
      } as FlowState<TokenResult>);
      const handlerSpy = jest.fn();

      await expect(
        retainingManager.createFlowWithHandler(flowId, type, handlerSpy),
      ).rejects.toThrow('earlier attempt failed');

      expect(handlerSpy).not.toHaveBeenCalled();
    }, 15000);

    it('rejects with FlowStateNotFoundError when the pending flow it joined disappears', async () => {
      await tokenStore.set(flowKey, {
        type,
        status: 'PENDING',
        metadata: {},
        createdAt: Date.now(),
      } as FlowState<TokenResult>);
      const handlerSpy = jest.fn();

      const joined = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tokenFlowManager.deleteFlow(flowId, type);

      await expect(joined).rejects.toBeInstanceOf(FlowStateNotFoundError);
      await expect(joined).rejects.toThrow('mcp_get_tokens Flow state not found');
      expect(handlerSpy).not.toHaveBeenCalled();
    }, 15000);

    it('rejects instead of serving a completed result to an aborted caller', async () => {
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: { access_token: 'cached_token', refresh_token: 'refresh' },
      } as FlowState<TokenResult>);
      const handlerSpy = jest.fn();
      const controller = new AbortController();
      controller.abort();

      await expect(
        tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy, controller.signal),
      ).rejects.toThrow('mcp_get_tokens flow aborted');

      expect(handlerSpy).not.toHaveBeenCalled();
    });

    it('leaves the shared flow in place when a joiner aborts', async () => {
      await tokenStore.set(flowKey, {
        type,
        status: 'PENDING',
        metadata: {},
        createdAt: Date.now(),
      } as FlowState<TokenResult>);
      const controller = new AbortController();
      const joiner = tokenFlowManager.createFlowWithHandler(
        flowId,
        type,
        jest.fn(),
        controller.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();

      await expect(joiner).rejects.toThrow('mcp_get_tokens flow aborted');
      await expect(tokenFlowManager.getFlowState(flowId, type)).resolves.toEqual(
        expect.objectContaining({ status: 'PENDING' }),
      );

      const settled: TokenResult = { access_token: 'settled_token', refresh_token: 'refresh' };
      const otherWaiter = tokenFlowManager.createFlowWithHandler(flowId, type, jest.fn());
      await tokenFlowManager.completeFlow(flowId, type, settled);
      await expect(otherWaiter).resolves.toEqual(settled);
    }, 15000);

    it('should execute handler when existing flow has expired token', async () => {
      const expiredTokenResult: TokenResult = {
        access_token: 'expired_token',
        refresh_token: 'refresh_token',
        expires_at: Date.now() - 1000, // Expired 1 second ago
      };

      // Create flow with expired token
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: expiredTokenResult,
      } as FlowState<TokenResult>);

      const newTokenResult: TokenResult = {
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      };
      const handlerSpy = jest.fn().mockResolvedValue(newTokenResult);

      const result = await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      // Handler should be called because token is expired
      expect(handlerSpy).toHaveBeenCalled();
      expect(result).toEqual(newTokenResult);
    });

    it('should reuse existing flow when token is still valid', async () => {
      const validTokenResult: TokenResult = {
        access_token: 'valid_token',
        refresh_token: 'refresh_token',
        expires_at: Date.now() + 3600000, // Expires in 1 hour
      };

      // Create flow with valid token
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: validTokenResult,
      } as FlowState<TokenResult>);

      const handlerSpy = jest.fn().mockResolvedValue({
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      });

      const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      // Complete the monitored flow
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await resultPromise;

      // Handler should NOT be called because token is still valid
      expect(handlerSpy).not.toHaveBeenCalled();
      expect(result).toEqual(validTokenResult);
    }, 15000);

    it('should reuse existing flow when no expires_at field exists', async () => {
      const tokenResultWithoutExpiry: TokenResult = {
        access_token: 'token_without_expiry',
        refresh_token: 'refresh_token',
        // No expires_at field - handles flows without expiration metadata
      };

      // Create flow without expires_at
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: tokenResultWithoutExpiry,
      } as FlowState<TokenResult>);

      const handlerSpy = jest.fn().mockResolvedValue({
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      });

      const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      // Wait for flow monitoring
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await resultPromise;

      // Handler should NOT be called - flows without expires_at are treated as valid/non-expired
      expect(handlerSpy).not.toHaveBeenCalled();
      expect(result).toEqual(tokenResultWithoutExpiry);
    }, 15000);

    it('should treat NaN expires_at as non-expired and reuse existing flow', async () => {
      const tokenResultWithNaN: TokenResult = {
        access_token: 'token_with_nan',
        refresh_token: 'refresh_token',
        expires_at: NaN,
      };

      // Create flow with NaN expires_at
      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: tokenResultWithNaN,
      } as FlowState<TokenResult>);

      const handlerSpy = jest.fn().mockResolvedValue({
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      });

      const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      // Wait for flow monitoring
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await resultPromise;

      // Handler should NOT be called - NaN is treated as invalid expiration (non-expired)
      expect(handlerSpy).not.toHaveBeenCalled();
      expect(result).toEqual(tokenResultWithNaN);
    }, 15000);

    it('should handle expires_at in seconds format (Unix timestamp)', async () => {
      const expiredSecondsTimestamp = Math.floor(Date.now() / 1000) - 60;
      const expiredTokenResult: TokenResult = {
        access_token: 'expired_token_seconds',
        refresh_token: 'refresh_token',
        expires_at: expiredSecondsTimestamp,
      };

      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: expiredTokenResult,
      } as FlowState<TokenResult>);

      const newTokenResult: TokenResult = {
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      };
      const handlerSpy = jest.fn().mockResolvedValue(newTokenResult);

      const result = await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      // Handler SHOULD be called - token in seconds format is expired
      expect(handlerSpy).toHaveBeenCalled();
      expect(result).toEqual(newTokenResult);
    });

    it('should reuse flow when expires_at in seconds format is still valid', async () => {
      const validSecondsTimestamp = Math.floor(Date.now() / 1000) + 3600;
      const validTokenResult: TokenResult = {
        access_token: 'valid_token_seconds',
        refresh_token: 'refresh_token',
        expires_at: validSecondsTimestamp,
      };

      await tokenStore.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        result: validTokenResult,
      } as FlowState<TokenResult>);

      const handlerSpy = jest.fn().mockResolvedValue({
        access_token: 'new_token',
        refresh_token: 'new_refresh',
        expires_at: Date.now() + 3600000,
      });

      const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await resultPromise;

      // Handler should NOT be called - seconds-format token is still valid
      expect(handlerSpy).not.toHaveBeenCalled();
      expect(result).toEqual(validTokenResult);
    }, 15000);
  });

  describe('Timestamp normalization', () => {
    const SECONDS_THRESHOLD = 1e10;

    const flowId = 'normalization-test';
    const type = 'timestamp_test';
    const flowKey = `${type}:${flowId}`;

    type TokenResult = {
      access_token: string;
      expires_at: number;
    };

    let tokenFlowManager: FlowStateManager<TokenResult>;
    let tokenStore: MockKeyv<TokenResult>;

    beforeEach(() => {
      tokenStore = new MockKeyv<TokenResult>();
      tokenFlowManager = new FlowStateManager(tokenStore as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });
    });

    describe('Seconds format detection (values < 1e10)', () => {
      it('should normalize current Unix timestamp in seconds (Dec 2024: ~1734000000)', async () => {
        const currentSeconds = Math.floor(Date.now() / 1000);
        const expiredSecondsAgo = currentSeconds - 60;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: expiredSecondsAgo },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle Sept 2001 timestamp in seconds (1000000000)', async () => {
        const sept2001Seconds = 1000000000;
        expect(sept2001Seconds).toBeLessThan(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: sept2001Seconds },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle year 2000 timestamp in seconds (946684800)', async () => {
        const year2000Seconds = 946684800;
        expect(year2000Seconds).toBeLessThan(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: year2000Seconds },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle May 2033 timestamp in seconds (2000000000) - future but still seconds format', async () => {
        const may2033Seconds = 2000000000;
        expect(may2033Seconds).toBeLessThan(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: may2033Seconds },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await resultPromise;

        expect(handlerSpy).not.toHaveBeenCalled();
      }, 15000);

      it('should handle edge case: just below threshold (9999999999 - ~Nov 2286 in seconds)', async () => {
        const justBelowThreshold = 9999999999;
        expect(justBelowThreshold).toBeLessThan(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: justBelowThreshold },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await resultPromise;

        expect(handlerSpy).not.toHaveBeenCalled();
      }, 15000);
    });

    describe('Milliseconds format detection (values >= 1e10)', () => {
      it('should recognize current timestamp in milliseconds (Dec 2024: ~1734000000000)', async () => {
        const currentMs = Date.now();
        const expiredMsAgo = currentMs - 60000;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: expiredMsAgo },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle Sept 2001 timestamp in milliseconds (1000000000000)', async () => {
        const sept2001Ms = 1000000000000;
        expect(sept2001Ms).toBeGreaterThanOrEqual(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: sept2001Ms },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle edge case: exactly at threshold (10000000000 - ~April 1970 in ms)', async () => {
        const exactlyAtThreshold = 10000000000;
        expect(exactlyAtThreshold).toEqual(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: exactlyAtThreshold },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle edge case: just above threshold (10000000001)', async () => {
        const justAboveThreshold = 10000000001;
        expect(justAboveThreshold).toBeGreaterThan(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: justAboveThreshold },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle future timestamp in milliseconds (2000000000000 - May 2033)', async () => {
        const may2033Ms = 2000000000000;
        expect(may2033Ms).toBeGreaterThanOrEqual(SECONDS_THRESHOLD);

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: may2033Ms },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await resultPromise;

        expect(handlerSpy).not.toHaveBeenCalled();
      }, 15000);
    });

    describe('Real-world OAuth provider timestamp formats', () => {
      it('should handle Google/MCP OAuth style (milliseconds, current + expires_in * 1000)', async () => {
        const expiresIn = 3600;
        const googleStyleExpiry = Date.now() + expiresIn * 1000;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'google_token', expires_at: googleStyleExpiry },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 7200000 });
        const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await resultPromise;

        expect(handlerSpy).not.toHaveBeenCalled();
      }, 15000);

      it('should handle OIDC style (seconds, Unix epoch)', async () => {
        const oidcStyleExpiry = Math.floor(Date.now() / 1000) + 3600;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'oidc_token', expires_at: oidcStyleExpiry },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 7200000 });
        const resultPromise = tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await resultPromise;

        expect(handlerSpy).not.toHaveBeenCalled();
      }, 15000);

      it('should handle expired Google/MCP OAuth style token', async () => {
        const expiredGoogleStyle = Date.now() - 60000;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 70000,
          result: { access_token: 'expired_google', expires_at: expiredGoogleStyle },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });

      it('should handle expired OIDC style token', async () => {
        const expiredOidcStyle = Math.floor(Date.now() / 1000) - 60;

        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 70000,
          result: { access_token: 'expired_oidc', expires_at: expiredOidcStyle },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });
    });

    describe('Threshold boundary validation', () => {
      /**
       * The threshold (1e10 = 10 billion) was chosen because:
       * - In SECONDS: 10 billion seconds from epoch = ~year 2286
       * - In MILLISECONDS: 10 billion ms from epoch = ~April 1970
       *
       * So any reasonable timestamp:
       * - Less than 10 billion -> must be seconds (we haven't reached year 2286 yet)
       * - Greater than or equal to 10 billion -> must be milliseconds (we're past April 1970)
       */

      it('should correctly identify threshold represents ~April 1970 in milliseconds', () => {
        const thresholdAsDate = new Date(SECONDS_THRESHOLD);
        expect(thresholdAsDate.getFullYear()).toBe(1970);
        expect(thresholdAsDate.getMonth()).toBe(3);
      });

      it('should correctly identify threshold represents ~year 2286 in seconds', () => {
        const thresholdAsSecondsDate = new Date(SECONDS_THRESHOLD * 1000);
        expect(thresholdAsSecondsDate.getFullYear()).toBe(2286);
      });

      it('should handle token expiring exactly at threshold boundary', async () => {
        await tokenStore.set(flowKey, {
          type,
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now() - 5000,
          result: { access_token: 'test', expires_at: SECONDS_THRESHOLD },
        } as FlowState<TokenResult>);

        const handlerSpy = jest
          .fn()
          .mockResolvedValue({ access_token: 'new', expires_at: Date.now() + 3600000 });
        await tokenFlowManager.createFlowWithHandler(flowId, type, handlerSpy);

        expect(handlerSpy).toHaveBeenCalled();
      });
    });
  });

  describe('createFlowWithHandler - atomic attempt claims', () => {
    const type = 'mcp_get_tokens';
    let claimingManager: FlowStateManager<string>;

    beforeEach(() => {
      const keyv = new Keyv({
        namespace: `flow-claim-${Date.now()}`,
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      });
      claimingManager = new FlowStateManager<string>(keyv, { ttl: 30000, ci: true });
    });

    const slowHandler = (result: string) =>
      jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return result;
      });

    it('runs one handler when concurrent attempts replace a failure from the same millisecond', async () => {
      const flowId = 'claimed-after-failure';
      /** A replacement created in the same millisecond as the failure shares its `createdAt`. */
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        await expect(
          claimingManager.createFlowWithHandler(flowId, type, async () => {
            throw new Error('earlier attempt failed');
          }),
        ).rejects.toThrow('earlier attempt failed');
        const first = slowHandler('first');
        const second = slowHandler('second');

        const results = await Promise.all([
          claimingManager.createFlowWithHandler(flowId, type, first),
          claimingManager.createFlowWithHandler(flowId, type, second),
        ]);

        expect(new Set(results).size).toBe(1);
        expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    }, 15000);

    it('runs one handler when concurrent attempts create the same absent flow', async () => {
      const flowId = 'claimed-when-absent';
      const first = slowHandler('first');
      const second = slowHandler('second');

      const results = await Promise.all([
        claimingManager.createFlowWithHandler(flowId, type, first),
        claimingManager.createFlowWithHandler(flowId, type, second),
      ]);

      expect(new Set(results).size).toBe(1);
      expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    }, 15000);
  });

  describe('isFlowStale', () => {
    const flowId = 'test-flow-stale';
    const type = 'test-type';
    const flowKey = `${type}:${flowId}`;

    it('returns not stale for non-existent flow', async () => {
      const result = await flowManager.isFlowStale(flowId, type);

      expect(result).toEqual({
        isStale: false,
        age: 0,
      });
    });

    it('returns not stale for PENDING flow regardless of age', async () => {
      const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      await store.set(flowKey, {
        type,
        status: 'PENDING',
        metadata: {},
        createdAt: oldTimestamp,
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result).toEqual({
        isStale: false,
        age: 0,
        status: 'PENDING',
      });
    });

    it('returns not stale for recently COMPLETED flow', async () => {
      const recentTimestamp = Date.now() - 30 * 1000; // 30 seconds ago
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 60 * 1000,
        completedAt: recentTimestamp,
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(false);
      expect(result.status).toBe('COMPLETED');
      expect(result.age).toBeGreaterThan(0);
      expect(result.age).toBeLessThan(60 * 1000);
    });

    it('returns stale for old COMPLETED flow', async () => {
      const oldTimestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 10 * 60 * 1000,
        completedAt: oldTimestamp,
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(true);
      expect(result.status).toBe('COMPLETED');
      expect(result.age).toBeGreaterThan(2 * 60 * 1000);
    });

    it('returns not stale for recently FAILED flow', async () => {
      const recentTimestamp = Date.now() - 30 * 1000; // 30 seconds ago
      await store.set(flowKey, {
        type,
        status: 'FAILED',
        metadata: {},
        createdAt: Date.now() - 60 * 1000,
        failedAt: recentTimestamp,
        error: 'Test error',
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.age).toBeGreaterThan(0);
      expect(result.age).toBeLessThan(60 * 1000);
    });

    it('returns stale for old FAILED flow', async () => {
      const oldTimestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      await store.set(flowKey, {
        type,
        status: 'FAILED',
        metadata: {},
        createdAt: Date.now() - 10 * 60 * 1000,
        failedAt: oldTimestamp,
        error: 'Test error',
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(true);
      expect(result.status).toBe('FAILED');
      expect(result.age).toBeGreaterThan(2 * 60 * 1000);
    });

    it('uses custom stale threshold', async () => {
      const timestamp = Date.now() - 90 * 1000; // 90 seconds ago
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - 2 * 60 * 1000,
        completedAt: timestamp,
      });

      // 90 seconds old, threshold 60 seconds = stale
      const result1 = await flowManager.isFlowStale(flowId, type, 60 * 1000);
      expect(result1.isStale).toBe(true);

      // 90 seconds old, threshold 120 seconds = not stale
      const result2 = await flowManager.isFlowStale(flowId, type, 120 * 1000);
      expect(result2.isStale).toBe(false);
    });

    it('uses the default PENDING_STALE_MS threshold when not specified', async () => {
      const timestamp = Date.now() - (PENDING_STALE_MS + 60 * 1000); // just past the default
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: Date.now() - (PENDING_STALE_MS + 3 * 60 * 1000),
        completedAt: timestamp,
      });

      // Should use the default PENDING_STALE_MS threshold
      const result = await flowManager.isFlowStale(flowId, type);

      expect(result.isStale).toBe(true);
      expect(result.age).toBeGreaterThan(PENDING_STALE_MS);
    });

    it('falls back to createdAt when completedAt/failedAt are not present', async () => {
      const createdTimestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: createdTimestamp,
        // No completedAt or failedAt
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(true);
      expect(result.status).toBe('COMPLETED');
      expect(result.age).toBeGreaterThan(2 * 60 * 1000);
    });

    it('handles flow with no timestamps', async () => {
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        // No timestamps at all
      } as FlowState<string>);

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      expect(result.isStale).toBe(false);
      expect(result.age).toBe(0);
      expect(result.status).toBe('COMPLETED');
    });

    it('prefers completedAt over createdAt for age calculation', async () => {
      const createdTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const completedTimestamp = Date.now() - 30 * 1000; // 30 seconds ago
      await store.set(flowKey, {
        type,
        status: 'COMPLETED',
        metadata: {},
        createdAt: createdTimestamp,
        completedAt: completedTimestamp,
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      // Should use completedAt (30s) not createdAt (10m)
      expect(result.isStale).toBe(false);
      expect(result.age).toBeLessThan(60 * 1000);
    });

    it('prefers failedAt over createdAt for age calculation', async () => {
      const createdTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const failedTimestamp = Date.now() - 30 * 1000; // 30 seconds ago
      await store.set(flowKey, {
        type,
        status: 'FAILED',
        metadata: {},
        createdAt: createdTimestamp,
        failedAt: failedTimestamp,
        error: 'Test error',
      });

      const result = await flowManager.isFlowStale(flowId, type, 2 * 60 * 1000);

      // Should use failedAt (30s) not createdAt (10m)
      expect(result.isStale).toBe(false);
      expect(result.age).toBeLessThan(60 * 1000);
    });
  });

  describe('cross-replica leases', () => {
    it('rejects stale work after teardown advances the generation', async () => {
      const generation = await flowManager.getLeaseGeneration('user:server');
      if (generation === null) {
        throw new Error('lease unexpectedly active');
      }
      const teardown = await flowManager.acquireLease('user:server', {
        advanceGeneration: true,
      });

      expect(teardown?.generation).toBe(generation + 1);
      await expect(flowManager.getLeaseGeneration('user:server')).resolves.toBeNull();
      await teardown?.release();
      await expect(
        flowManager.acquireLease('user:server', { expectedGeneration: generation }),
      ).resolves.toBeNull();
    });

    it('serializes holders and preserves the generation after release', async () => {
      const first = await flowManager.acquireLease('shared-owner');
      expect(first).not.toBeNull();
      await expect(flowManager.getLeaseGeneration('shared-owner')).resolves.toBe(first?.generation);
      await expect(flowManager.acquireLease('shared-owner', { waitMs: 0 })).resolves.toBeNull();

      await first?.release();
      const second = await flowManager.acquireLease('shared-owner', {
        expectedGeneration: first?.generation,
      });
      expect(second?.generation).toBe(first?.generation);
      await second?.release();
    });

    it('expires released in-memory generations after the stale-work horizon', async () => {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      const teardown = await flowManager.acquireLease('expiring-owner', {
        advanceGeneration: true,
      });
      await teardown?.release();
      expect(await flowManager.getLeaseGeneration('expiring-owner')).toBe(1);

      clock.mockReturnValue(now + 24 * 60 * 60_000 + 1);
      expect(await flowManager.getLeaseGeneration('expiring-owner')).toBe(0);
      clock.mockRestore();
    });

    it('treats an active pre-purpose lease as teardown during rolling upgrades', async () => {
      const leases = (
        FlowStateManager as unknown as {
          inMemoryLeases: Map<string, Record<string, unknown>>;
        }
      ).inMemoryLeases;
      leases.set('lease:legacy-owner', {
        generation: 4,
        owner: 'old-replica',
        leaseUntil: Date.now() + 60_000,
        expiresAt: Date.now() + 60_000,
      });

      await expect(flowManager.getLeaseGeneration('legacy-owner')).resolves.toBeNull();
      leases.delete('lease:legacy-owner');
    });
  });
});
