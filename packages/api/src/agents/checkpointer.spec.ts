import {
  resolveCheckpointerConfig,
  getApprovalTtlMs,
  getAgentCheckpointer,
  captureAgentCheckpointGeneration,
  deleteAgentCheckpoint,
  deleteOwnedAgentCheckpoints,
  DEFAULT_CHECKPOINT_TTL_SECONDS,
  __resetCheckpointerForTests,
} from './checkpointer';

beforeEach(() => {
  __resetCheckpointerForTests();
});

describe('resolveCheckpointerConfig', () => {
  test('applies defaults when nothing is configured', () => {
    expect(resolveCheckpointerConfig(undefined)).toEqual({
      type: 'mongo',
      ttlSeconds: DEFAULT_CHECKPOINT_TTL_SECONDS,
      checkpointCollectionName: 'agent_checkpoints',
      checkpointWritesCollectionName: 'agent_checkpoint_writes',
    });
  });

  test('honors explicit type, ttl, and collection overrides', () => {
    expect(
      resolveCheckpointerConfig({
        type: 'memory',
        ttl: 60,
        checkpointCollectionName: 'cp',
        checkpointWritesCollectionName: 'cpw',
      }),
    ).toEqual({
      type: 'memory',
      ttlSeconds: 60,
      checkpointCollectionName: 'cp',
      checkpointWritesCollectionName: 'cpw',
    });
  });

  test('falls back to the default ttl for non-positive values', () => {
    expect(resolveCheckpointerConfig({ ttl: 0 }).ttlSeconds).toBe(DEFAULT_CHECKPOINT_TTL_SECONDS);
    expect(resolveCheckpointerConfig({ ttl: -5 }).ttlSeconds).toBe(DEFAULT_CHECKPOINT_TTL_SECONDS);
  });
});

describe('getApprovalTtlMs', () => {
  test('converts the resolved ttl to milliseconds', () => {
    expect(getApprovalTtlMs(undefined)).toBe(DEFAULT_CHECKPOINT_TTL_SECONDS * 1000);
    expect(getApprovalTtlMs({ ttl: 60 })).toBe(60_000);
  });
});

describe('owner checkpoint cleanup', () => {
  test('requires an authenticated owner', async () => {
    await expect(deleteOwnedAgentCheckpoints('', undefined, undefined)).rejects.toThrow('owner');
  });
  test('does not require a database in memory mode', async () => {
    await expect(
      deleteOwnedAgentCheckpoints('user-1', undefined, undefined, { type: 'memory' }),
    ).resolves.toBeUndefined();
  });
  test('fails closed when the durable database is unavailable', async () => {
    await expect(deleteOwnedAgentCheckpoints('user-1', undefined, undefined)).rejects.toThrow(
      'unavailable',
    );
  });
});

describe('getAgentCheckpointer', () => {
  test('returns undefined for the in-memory type (SDK MemorySaver fallback)', async () => {
    await expect(getAgentCheckpointer({ type: 'memory' })).resolves.toBeUndefined();
  });

  test('returns undefined when Mongo is not connected', async () => {
    // No mongoose connection is established in the unit test env (readyState 0).
    await expect(getAgentCheckpointer(undefined)).resolves.toBeUndefined();
  });
});

describe('deleteAgentCheckpoint', () => {
  test('is a no-op (no throw) for a missing threadId', async () => {
    await expect(deleteAgentCheckpoint(undefined)).resolves.toBeUndefined();
  });

  test('is a no-op (no throw) when no durable saver is available', async () => {
    await expect(deleteAgentCheckpoint('conversation-1')).resolves.toBeUndefined();
  });

  test('captures an empty generation when no durable saver is available', async () => {
    await expect(captureAgentCheckpointGeneration('conversation-1')).resolves.toEqual({
      threadId: 'conversation-1',
      checkpointIds: [],
    });
  });

  test('normalizes an explicit empty namespace to a thread-wide legacy capture', async () => {
    await expect(
      captureAgentCheckpointGeneration('conversation-1', undefined, {
        checkpointNamespace: '',
      }),
    ).resolves.toEqual({
      threadId: 'conversation-1',
      checkpointIds: [],
    });
  });
});
