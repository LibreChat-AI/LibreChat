import { randomUUID } from 'crypto';
import type { Keyv } from 'keyv';
import { keyvRedisClient, keyvRedisClientReady } from '~/cache/redisClients';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';
import { standardCache } from '~/cache/cacheFactory';
import { FlowStateManager } from '~/flow/manager';

const FLOW_TYPE = 'mcp_oauth';
const FLOW_TTL = 30_000;

describe('MCP OAuth flow state across Redis-backed instances', () => {
  let podAStore: Keyv;
  let podBStore: Keyv;
  let podA: FlowStateManager<string>;
  let podB: FlowStateManager<string>;
  const flowIds = new Set<string>();

  beforeAll(async () => {
    if (!keyvRedisClient || !keyvRedisClientReady) {
      throw new Error('MCP cross-instance flow tests require a real Redis client');
    }
    await keyvRedisClientReady;
    const namespace = `MCPFlowRedis-${process.pid}-${randomUUID()}`;
    podAStore = standardCache(namespace, FLOW_TTL);
    podBStore = standardCache(namespace, FLOW_TTL);
    podA = new FlowStateManager<string>(podAStore, {
      ttl: FLOW_TTL,
      retainedFailureTypes: [FLOW_TYPE],
      ci: true,
    });
    podB = new FlowStateManager<string>(podBStore, {
      ttl: FLOW_TTL,
      retainedFailureTypes: [FLOW_TYPE],
      ci: true,
    });
  });

  afterEach(async () => {
    await Promise.all([...flowIds].map((flowId) => podA.deleteFlow(flowId, FLOW_TYPE)));
    flowIds.clear();
  });

  afterAll(async () => {
    await closeRedisClients();
  });

  function createFlowId(): string {
    const flowId = randomUUID();
    flowIds.add(flowId);
    return flowId;
  }

  it('shares pending and completed OAuth state between pod instances', async () => {
    const flowId = createFlowId();

    await podA.initFlow(flowId, FLOW_TYPE, { authorizationUrl: 'https://oauth.example/auth' });
    await expect(podB.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'PENDING' }),
    );

    await podB.completeFlow(flowId, FLOW_TYPE, 'authorized');
    await expect(podA.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'COMPLETED', result: 'authorized' }),
    );
  });

  it('preserves a retryable handler failure across Redis pods', async () => {
    const flowId = createFlowId();
    await podA.initFlow(flowId, FLOW_TYPE);
    const flow = await podA.getFlowState(flowId, FLOW_TYPE);
    const waiter = podB.createFlowWithHandler(flowId, FLOW_TYPE, async () => 'unexpected');
    const error = new Error('refresh lease unavailable');
    error.name = 'MCPTokenRefreshUnavailableError';
    await podA.failFlowIfCurrent(flowId, FLOW_TYPE, flow!.createdAt, '', error);
    await expect(waiter).rejects.toMatchObject({ name: error.name, message: error.message });
    expect(await podB.getFlowState(flowId, FLOW_TYPE)).toMatchObject({
      error: error.message,
      errorName: error.name,
    });
  });

  it('retains a terminal OAuth failure for polling on another pod', async () => {
    const flowId = createFlowId();

    await podA.initFlow(flowId, FLOW_TYPE);
    const waiter = podA.createFlow(flowId, FLOW_TYPE);
    await podB.failFlow(flowId, FLOW_TYPE, new Error('provider rejected request'));

    await expect(waiter).rejects.toThrow('provider rejected request');
    await expect(podB.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'FAILED', error: 'provider rejected request' }),
    );
  });

  it('does not delete a replacement attempt observed on another pod', async () => {
    const flowId = createFlowId();
    await podA.initFlow(flowId, FLOW_TYPE, { state: 'old-state' });
    const oldFlow = await podA.getFlowState(flowId, FLOW_TYPE);

    await podB.initFlow(flowId, FLOW_TYPE, { state: 'new-state' });

    await expect(
      podA.deleteFlowIfCurrent(flowId, FLOW_TYPE, oldFlow!.createdAt, 'old-state'),
    ).resolves.toBe('stale');
    await expect(podB.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'PENDING', metadata: { state: 'new-state' } }),
    );
  });

  it('fails the exact observed attempt across pods', async () => {
    const flowId = createFlowId();
    await podA.initFlow(flowId, FLOW_TYPE, { state: 'cancelled-state' });
    const flow = await podB.getFlowState(flowId, FLOW_TYPE);

    await expect(
      podB.failFlowIfCurrent(flowId, FLOW_TYPE, flow!.createdAt, 'cancelled-state', 'cancelled'),
    ).resolves.toBe('updated');
    await expect(podA.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'FAILED', error: 'cancelled' }),
    );
  });

  it('settles a fresher result over a completion from the same attempt across pods', async () => {
    const flowId = createFlowId();
    await podA.initFlow(flowId, FLOW_TYPE, { state: 'observed-state' });
    const flow = await podB.getFlowState(flowId, FLOW_TYPE);

    await podA.completeFlow(flowId, FLOW_TYPE, 'stale-result');
    await expect(
      podB.settleFlowIfCurrent(
        flowId,
        FLOW_TYPE,
        flow!.createdAt,
        'observed-state',
        'fresh-result',
      ),
    ).resolves.toBe('updated');
    await expect(podA.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'COMPLETED', result: 'fresh-result' }),
    );
  });

  it('runs one handler when two pods replace the same failed non-retained flow', async () => {
    const flowId = createFlowId();
    const type = 'mcp_get_tokens';
    try {
      await expect(
        podA.createFlowWithHandler(flowId, type, async () => {
          throw new Error('earlier attempt failed');
        }),
      ).rejects.toThrow('earlier attempt failed');
      const first = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'first';
      });
      const second = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'second';
      });

      const results = await Promise.all([
        podA.createFlowWithHandler(flowId, type, first),
        podB.createFlowWithHandler(flowId, type, second),
      ]);

      expect(new Set(results).size).toBe(1);
      expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    } finally {
      await podA.deleteFlow(flowId, type);
    }
  }, 15000);

  it('runs one handler when two pods create the same absent flow', async () => {
    const flowId = createFlowId();
    const type = 'mcp_get_tokens';
    try {
      const first = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'first';
      });
      const second = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'second';
      });

      const results = await Promise.all([
        podA.createFlowWithHandler(flowId, type, first),
        podB.createFlowWithHandler(flowId, type, second),
      ]);

      expect(new Set(results).size).toBe(1);
      expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    } finally {
      await podA.deleteFlow(flowId, type);
    }
  }, 15000);

  it('settles a fresher result over a failure from the same attempt across pods', async () => {
    const flowId = createFlowId();
    await podA.initFlow(flowId, FLOW_TYPE, { state: 'observed-state' });
    const flow = await podB.getFlowState(flowId, FLOW_TYPE);

    await podA.failFlow(flowId, FLOW_TYPE, new Error('stale failure'));
    await expect(
      podB.settleFlowIfCurrent(
        flowId,
        FLOW_TYPE,
        flow!.createdAt,
        'observed-state',
        'fresh-result',
      ),
    ).resolves.toBe('updated');
    await expect(podA.getFlowState(flowId, FLOW_TYPE)).resolves.toEqual(
      expect.objectContaining({ status: 'COMPLETED', result: 'fresh-result' }),
    );
  });
});
