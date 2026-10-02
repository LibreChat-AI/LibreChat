/**
 * Unit tests for performSync() function in indexSync.js
 *
 * Tests use real mongoose with mocked model methods, only mocking external calls.
 */

const mongoose = require('mongoose');

// Mock only external dependencies (not internal classes/models)
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockMeiliHealth = jest.fn();
const mockMeiliIndex = jest.fn();
const mockCreateIndex = jest.fn();
const mockWaitForTask = jest.fn();
const mockMeiliSearch = jest.fn(() => ({
  health: mockMeiliHealth,
  index: mockMeiliIndex,
  createIndex: mockCreateIndex,
  waitForTask: mockWaitForTask,
}));
const mockBatchResetMeiliFlags = jest.fn();
const mockGetMeiliRebuildState = jest.fn();
const mockRequestMeiliRebuild = jest.fn();
const mockMarkMeiliRebuildSyncing = jest.fn();
const mockCompleteMeiliRebuild = jest.fn();
const mockIsEnabled = jest.fn();
const mockRunDistributedJob = jest.fn();
const mockWaitForMeiliTask = jest.fn();

// Create mock models that will be reused
const createMockModel = (collectionName) => ({
  collection: { name: collectionName },
  getSyncProgress: jest.fn(),
  syncWithMeili: jest.fn(),
  cleanupExcludedMeiliIndex: jest.fn(),
  countDocuments: jest.fn(),
});

const originalMessageModel = mongoose.models.Message;
const originalConversationModel = mongoose.models.Conversation;

// Mock external modules
jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('meilisearch', () => ({
  MeiliSearchTimeOutError: class MeiliSearchTimeOutError extends Error {},
  MeiliSearch: mockMeiliSearch,
}));

jest.mock('./utils', () => ({
  batchResetMeiliFlags: (collection) => mockBatchResetMeiliFlags(collection),
  getMeiliRebuildState: mockGetMeiliRebuildState,
  requestMeiliRebuild: mockRequestMeiliRebuild,
  markMeiliRebuildSyncing: mockMarkMeiliRebuildSyncing,
  completeMeiliRebuild: mockCompleteMeiliRebuild,
}));

jest.mock('@librechat/api', () => ({
  isEnabled: mockIsEnabled,
  MEILI_HTTP_REQUEST_TIMEOUT_MS: 10_000,
  MEILI_INDEX_SYNC_INTERVAL_MS: 60_000,
  MEILI_INDEX_SYNC_LEASE_MS: 180_000,
  MEILI_INDEX_SYNC_REFRESH_MS: 60_000,
  runDistributedJob: mockRunDistributedJob,
  waitForMeiliTask: mockWaitForMeiliTask,
}));

// Set environment before module load
process.env.MEILI_HOST = 'http://localhost:7700';
process.env.MEILI_MASTER_KEY = 'test-key';
process.env.SEARCH = 'true';
process.env.MEILI_SYNC_THRESHOLD = '1000'; // Set threshold before module loads

describe('performSync() - syncThreshold logic', () => {
  const ORIGINAL_ENV = process.env;
  let Message;
  let Conversation;
  let rebuildStates;
  let rebuildGeneration;

  beforeAll(() => {
    Message = createMockModel('messages');
    Conversation = createMockModel('conversations');

    mongoose.models.Message = Message;
    mongoose.models.Conversation = Conversation;
  });

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    // Reset modules to ensure fresh load of indexSync.js and its top-level consts (like syncThreshold)
    jest.resetModules();

    // Set up environment
    process.env = { ...ORIGINAL_ENV };
    process.env.MEILI_HOST = 'http://localhost:7700';
    process.env.MEILI_MASTER_KEY = 'test-key';
    process.env.SEARCH = 'true';
    delete process.env.MEILI_NO_SYNC;

    // Re-ensure models are available in mongoose after resetModules
    // We must require mongoose again to get the fresh instance that indexSync will use
    const mongoose = require('mongoose');
    mongoose.models.Message = Message;
    mongoose.models.Conversation = Conversation;

    // Mock isEnabled
    mockIsEnabled.mockImplementation((val) => val === 'true' || val === true);
    mockRunDistributedJob.mockImplementation((_collection, _jobId, handler) =>
      handler(new AbortController().signal),
    );
    mockWaitForMeiliTask.mockImplementation(
      async (client, taskUid, operation, _isTimeout, options) => {
        const task = await client.waitForTask(taskUid, { timeOutMs: 10_000, intervalMs: 100 });
        const isTaskSuccessful = options?.isTaskSuccessful?.(task) ?? task.status === 'succeeded';
        if (!isTaskSuccessful) {
          throw new Error(`${operation} task ${taskUid} ended with ${task.status}`);
        }
      },
    );

    // Mock MeiliSearch client responses
    mockMeiliHealth.mockResolvedValue({ status: 'available' });
    mockCreateIndex.mockResolvedValue({ taskUid: 2 });
    mockWaitForTask.mockResolvedValue({ status: 'succeeded' });
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });

    mockBatchResetMeiliFlags.mockResolvedValue(undefined);
    rebuildStates = new Map();
    rebuildGeneration = 0;
    mockGetMeiliRebuildState.mockImplementation(async (_collection, indexName) =>
      rebuildStates.get(indexName),
    );
    mockRequestMeiliRebuild.mockImplementation(async (_collection, indexName) => {
      const existing = rebuildStates.get(indexName);
      if (existing?.phase === 'resetting') {
        return existing;
      }
      const state = {
        _id: indexName,
        generation: `generation-${++rebuildGeneration}`,
        phase: 'resetting',
      };
      rebuildStates.set(indexName, state);
      return state;
    });
    mockMarkMeiliRebuildSyncing.mockImplementation(async (_collection, indexName, generation) => {
      const state = { _id: indexName, generation, phase: 'syncing' };
      rebuildStates.set(indexName, state);
      return state;
    });
    mockCompleteMeiliRebuild.mockImplementation(async (_collection, indexName) => {
      rebuildStates.delete(indexName);
    });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  afterAll(() => {
    mongoose.models.Message = originalMessageModel;
    mongoose.models.Conversation = originalConversationModel;
  });

  test('skips synchronization when another replica completed the distributed job', async () => {
    mockRunDistributedJob.mockResolvedValue(undefined);

    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockMeiliHealth).not.toHaveBeenCalled();
  });

  test('configures a finite HTTP timeout and renewable distributed job lease', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 0,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 0,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockMeiliSearch).toHaveBeenCalledWith({
      host: 'http://localhost:7700',
      apiKey: 'test-key',
      timeout: 10_000,
    });
    expect(mockRunDistributedJob).toHaveBeenCalledWith(
      expect.anything(),
      'meili-index-sync',
      expect.any(Function),
      expect.objectContaining({
        cancellationGraceMs: 25_000,
        completionTtlMs: 60_000,
        leaseMs: 180_000,
        onLeaseLost: expect.any(Function),
        refreshMs: 60_000,
      }),
    );
    expect(mockRunDistributedJob.mock.calls[0][3]).not.toHaveProperty('timeoutMs');
  });

  test('propagates synchronization failures to the distributed job coordinator', async () => {
    Message.getSyncProgress.mockRejectedValueOnce(new Error('sync failed'));

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow('sync failed');
    expect(mockLogger.error).toHaveBeenCalledWith('[indexSync] error', expect.any(Error));
  });

  test('propagates failed settings tasks to the distributed job coordinator', async () => {
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: [] }),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 17 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });
    mockWaitForTask.mockResolvedValue({ status: 'failed' });

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow('messages settings task 17 ended with failed');
    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalled();
    expect(mockWaitForMeiliTask).toHaveBeenCalledWith(
      expect.anything(),
      17,
      'messages settings',
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('propagates failed orphan-deletion tasks to the distributed job coordinator', async () => {
    const deleteDocuments = jest.fn().mockResolvedValue({ taskUid: 23 });
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn(),
      search: jest.fn().mockResolvedValue({ hits: [{ messageId: 'legacy-document' }] }),
      deleteDocuments,
    });
    mockWaitForTask.mockResolvedValue({ status: 'canceled' });

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow('messages cleanup task 23 ended with canceled');
    expect(deleteDocuments).toHaveBeenCalledWith(['legacy-document']);
  });

  test('does not skip orphaned documents after deleting a full search page', async () => {
    const firstPageIds = Array.from({ length: 1000 }, (_, index) => `legacy-${index}`);
    const deleteDocuments = jest
      .fn()
      .mockResolvedValueOnce({ taskUid: 31 })
      .mockResolvedValueOnce({ taskUid: 32 });
    const search = jest
      .fn()
      .mockResolvedValueOnce({ hits: [{ messageId: firstPageIds[0] }] })
      .mockResolvedValueOnce({ hits: [] })
      .mockResolvedValueOnce({ hits: firstPageIds.map((messageId) => ({ messageId })) })
      .mockResolvedValueOnce({ hits: [{ messageId: 'legacy-final' }] })
      .mockResolvedValueOnce({ hits: [] });
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn(),
      search,
      deleteDocuments,
    });
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(search).toHaveBeenNthCalledWith(4, '', { limit: 1000, offset: 0 });
    expect(deleteDocuments).toHaveBeenNthCalledWith(1, firstPageIds);
    expect(deleteDocuments).toHaveBeenNthCalledWith(2, ['legacy-final']);
  });

  test('fails orphan cleanup when a legacy hit lacks the configured primary key', async () => {
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn(),
      search: jest.fn().mockResolvedValue({ hits: [{ id: 'wrong-key' }] }),
      deleteDocuments: jest.fn(),
    });

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow(
      '[indexSync] Cannot clean messages document without messageId',
    );
  });

  test('fails orphan cleanup when a completed deletion does not advance the page', async () => {
    const stalledPage = Array.from({ length: 1000 }, (_, index) => ({
      messageId: `legacy-${index}`,
    }));
    const deleteDocuments = jest.fn().mockResolvedValue({ taskUid: 41 });
    const search = jest
      .fn()
      .mockResolvedValueOnce({ hits: [{ messageId: stalledPage[0].messageId }] })
      .mockResolvedValueOnce({ hits: [] })
      .mockResolvedValue({ hits: stalledPage });
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn(),
      search,
      deleteDocuments,
    });

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow('[indexSync] messages cleanup made no progress');
    expect(deleteDocuments).toHaveBeenCalledTimes(1);
  });

  test('rebuilds only messages when the provider confirms the messages index is missing', async () => {
    const missingIndexError = Object.assign(new Error('Index not found'), {
      code: 'index_not_found',
    });
    mockMeiliIndex.mockImplementation((indexName) => ({
      getSettings:
        indexName === 'messages'
          ? jest.fn().mockRejectedValue(missingIndexError)
          : jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 3 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    }));
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });
    Message.syncWithMeili.mockResolvedValue(undefined);
    mockWaitForTask
      .mockResolvedValueOnce({
        status: 'failed',
        error: { code: 'index_already_exists' },
      })
      .mockResolvedValue({ status: 'succeeded' });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledTimes(1);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockCreateIndex).toHaveBeenCalledWith('messages', { primaryKey: 'messageId' });
    expect(mockCreateIndex).not.toHaveBeenCalledWith('convos', expect.anything());
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
  });

  test('rebuilds only conversations when the provider confirms the convos index is missing', async () => {
    const missingIndexError = Object.assign(new Error('Index not found'), {
      code: 'index_not_found',
    });
    mockMeiliIndex.mockImplementation((indexName) => ({
      getSettings:
        indexName === 'convos'
          ? jest.fn().mockRejectedValue(missingIndexError)
          : jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 3 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    }));
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 1,
      totalDocuments: 1,
      isComplete: true,
    });
    Conversation.syncWithMeili.mockResolvedValue(undefined);

    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledTimes(1);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Conversation.collection);
    expect(mockCreateIndex).toHaveBeenCalledWith('convos', { primaryKey: 'conversationId' });
    expect(mockCreateIndex).not.toHaveBeenCalledWith('messages', expect.anything());
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
  });

  test('propagates non-provider index inspection errors without resetting acknowledgements', async () => {
    const inspectionError = new Error('Meilisearch connection failed');
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockRejectedValue(inspectionError),
      updateSettings: jest.fn(),
      search: jest.fn(),
    });

    const indexSync = require('./indexSync');

    await expect(indexSync()).rejects.toThrow(inspectionError);
    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalled();
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
  });

  test('keeps healthy periodic checks quiet without resetting or synchronizing', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await indexSync({ quiet: true });

    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalled();
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  test('triggers sync when unindexed messages exceed syncThreshold', async () => {
    // Arrange: Set threshold before module load
    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Arrange: 1050 unindexed messages > 1000 threshold
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 1150, // 1050 unindexed
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    Message.syncWithMeili.mockResolvedValue(undefined);

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls
    expect(Message.countDocuments).not.toHaveBeenCalled();
    expect(Conversation.countDocuments).not.toHaveBeenCalled();

    // Assert: Message sync triggered because 1050 > 1000
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Messages need syncing: 100/1150 indexed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (1050 unindexed)',
    );

    // Assert: Conversation sync NOT triggered (already complete)
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
  });

  test('skips sync when unindexed messages are below syncThreshold', async () => {
    // Arrange: 50 unindexed messages < 1000 threshold
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 150, // 50 unindexed
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls
    expect(Message.countDocuments).not.toHaveBeenCalled();
    expect(Conversation.countDocuments).not.toHaveBeenCalled();

    // Assert: Message sync NOT triggered because 50 < 1000
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Messages need syncing: 100/150 indexed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] 50 messages unindexed (below threshold: 1000, skipping)',
    );

    // Assert: Conversation sync NOT triggered (already complete)
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
  });

  test('reconciles attempted indexing failures below syncThreshold', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 101,
      pendingIndexing: 1,
      isComplete: false,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 51,
      pendingIndexing: 1,
      isComplete: false,
    });
    Message.syncWithMeili.mockResolvedValue(undefined);
    Conversation.syncWithMeili.mockResolvedValue(undefined);

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    const indexSync = require('./indexSync');
    await indexSync();

    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting message sync (1 unindexed)');
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (1 unindexed)');
  });

  test('respects syncThreshold at boundary (exactly at threshold)', async () => {
    // Arrange: 1000 unindexed messages = 1000 threshold (NOT greater than)
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 1100, // 1000 unindexed
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 0,
      isComplete: true,
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls
    expect(Message.countDocuments).not.toHaveBeenCalled();

    // Assert: Message sync NOT triggered because 1000 is NOT > 1000
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Messages need syncing: 100/1100 indexed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] 1000 messages unindexed (below threshold: 1000, skipping)',
    );
  });

  test('triggers sync when unindexed is threshold + 1', async () => {
    // Arrange: 1001 unindexed messages > 1000 threshold
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 1101, // 1001 unindexed
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 0,
      isComplete: true,
    });

    Message.syncWithMeili.mockResolvedValue(undefined);

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls
    expect(Message.countDocuments).not.toHaveBeenCalled();

    // Assert: Message sync triggered because 1001 > 1000
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Messages need syncing: 100/1101 indexed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (1001 unindexed)',
    );
  });

  test('uses totalDocuments from convoProgress for conversation sync decisions', async () => {
    // Arrange: Messages complete, conversations need sync
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      isComplete: true,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 1100, // 1050 unindexed > 1000 threshold
      isComplete: false,
    });

    Conversation.syncWithMeili.mockResolvedValue(undefined);

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls (the optimization)
    expect(Message.countDocuments).not.toHaveBeenCalled();
    expect(Conversation.countDocuments).not.toHaveBeenCalled();

    // Assert: Only conversation sync triggered
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Conversations need syncing: 50/1100 indexed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting convos sync (1050 unindexed)',
    );
  });

  test('skips sync when collections are fully synced', async () => {
    // Arrange: Everything already synced
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      isComplete: true,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: No countDocuments calls
    expect(Message.countDocuments).not.toHaveBeenCalled();
    expect(Conversation.countDocuments).not.toHaveBeenCalled();

    // Assert: No sync triggered
    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();

    // Assert: Correct logs
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Messages are fully synced: 100/100');
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Conversations are fully synced: 50/50',
    );
  });

  test('resets and synchronizes only messages when message settings change', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 150,
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    Message.syncWithMeili.mockResolvedValue(undefined);

    mockMeiliIndex.mockImplementation((indexName) => {
      const settings =
        indexName === 'messages'
          ? { filterableAttributes: [] }
          : { filterableAttributes: ['user'] };
      return {
        getSettings: jest.fn().mockResolvedValue(settings),
        updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
        search: jest.fn().mockResolvedValue({ hits: [] }),
      };
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalledWith(Conversation.collection);

    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Resetting messages for the pending index rebuild...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (50 unindexed)',
    );
  });

  test('resets and synchronizes only conversations when conversation settings change', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      isComplete: true,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 100, // 50 unindexed
      isComplete: false,
    });

    Conversation.syncWithMeili.mockResolvedValue(undefined);

    mockMeiliIndex.mockImplementation((indexName) => {
      const settings =
        indexName === 'convos' ? { filterableAttributes: [] } : { filterableAttributes: ['user'] };
      return {
        getSettings: jest.fn().mockResolvedValue(settings),
        updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
        search: jest.fn().mockResolvedValue({ hits: [] }),
      };
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalledWith(Message.collection);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Conversation.collection);

    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Resetting conversations for the pending index rebuild...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (50 unindexed)');
  });

  test('resets both collections when both index settings change', async () => {
    // Arrange: Set threshold before module load
    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Arrange: Both have documents below threshold (50 each), but settings were updated
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 150, // 50 unindexed
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 100, // 50 unindexed
      isComplete: false,
    });

    Message.syncWithMeili.mockResolvedValue(undefined);
    Conversation.syncWithMeili.mockResolvedValue(undefined);

    // Mock settings update scenario
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: [] }), // No user field
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: Flags were reset due to settings update
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Conversation.collection);

    // Assert: Both syncs triggered despite both being below threshold
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Resetting messages for the pending index rebuild...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Resetting conversations for the pending index rebuild...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (50 unindexed)',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (50 unindexed)');
  });

  test('persists a message rebuild when a later settings check fails before reset', async () => {
    let messagesSettingsNeedUpdate = true;
    let failConversationCheck = true;
    mockMeiliIndex.mockImplementation((indexName) => ({
      getSettings: jest.fn().mockImplementation(async () => {
        if (indexName === 'convos' && failConversationCheck) {
          throw new Error('conversation settings unavailable');
        }
        return {
          filterableAttributes:
            indexName === 'messages' && messagesSettingsNeedUpdate ? [] : ['user'],
        };
      }),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    }));
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 50,
      pendingIndexing: 50,
      isComplete: false,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingIndexing: 0,
      isComplete: true,
    });
    Message.syncWithMeili.mockResolvedValue(undefined);

    const indexSync = require('./indexSync');
    await expect(indexSync()).rejects.toThrow('conversation settings unavailable');

    expect(rebuildStates.get('messages')).toMatchObject({ phase: 'resetting' });
    expect(mockBatchResetMeiliFlags).not.toHaveBeenCalled();

    messagesSettingsNeedUpdate = false;
    failConversationCheck = false;
    await expect(indexSync()).resolves.toEqual({ messagesSync: true, convosSync: false });

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledTimes(1);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockCompleteMeiliRebuild).toHaveBeenCalledWith(
      expect.anything(),
      'messages',
      'generation-1',
      expect.anything(),
    );
    expect(rebuildStates.has('messages')).toBe(false);
  });

  test('retries a partially failed reset before starting the affected rebuild', async () => {
    let messagesSettingsNeedUpdate = true;
    mockMeiliIndex.mockImplementation((indexName) => ({
      getSettings: jest.fn().mockImplementation(async () => ({
        filterableAttributes:
          indexName === 'messages' && messagesSettingsNeedUpdate ? [] : ['user'],
      })),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    }));
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 1001,
      pendingIndexing: 1001,
      isComplete: false,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingIndexing: 0,
      isComplete: true,
    });
    Message.syncWithMeili.mockResolvedValue(undefined);
    mockBatchResetMeiliFlags
      .mockRejectedValueOnce(new Error('reset interrupted'))
      .mockResolvedValueOnce(undefined);

    const indexSync = require('./indexSync');
    await expect(indexSync()).rejects.toThrow('reset interrupted');

    expect(rebuildStates.get('messages')).toMatchObject({ phase: 'resetting' });
    expect(mockMarkMeiliRebuildSyncing).not.toHaveBeenCalled();

    messagesSettingsNeedUpdate = false;
    await expect(indexSync()).resolves.toEqual({ messagesSync: true, convosSync: false });

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledTimes(2);
    expect(mockMarkMeiliRebuildSyncing).toHaveBeenCalledTimes(1);
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockCompleteMeiliRebuild).toHaveBeenCalledTimes(1);
    expect(rebuildStates.has('messages')).toBe(false);
  });

  test('resumes a forced rebuild after interruption leaves a below-threshold remainder', async () => {
    let messagesSettingsNeedUpdate = true;
    mockMeiliIndex.mockImplementation((indexName) => ({
      getSettings: jest.fn().mockImplementation(async () => ({
        filterableAttributes:
          indexName === 'messages' && messagesSettingsNeedUpdate ? [] : ['user'],
      })),
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    }));
    Message.getSyncProgress
      .mockResolvedValueOnce({
        totalProcessed: 0,
        totalDocuments: 1001,
        pendingIndexing: 1001,
        isComplete: false,
      })
      .mockResolvedValueOnce({
        totalProcessed: 1000,
        totalDocuments: 1001,
        pendingIndexing: 1,
        isComplete: false,
      });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingIndexing: 0,
      isComplete: true,
    });
    Message.syncWithMeili
      .mockRejectedValueOnce(new Error('interrupted rebuild'))
      .mockResolvedValueOnce(undefined);

    const indexSync = require('./indexSync');
    await expect(indexSync()).rejects.toThrow('interrupted rebuild');

    messagesSettingsNeedUpdate = false;
    await expect(indexSync()).resolves.toEqual({ messagesSync: true, convosSync: false });

    expect(mockBatchResetMeiliFlags).toHaveBeenCalledTimes(1);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting message sync (1 unindexed)');
  });

  test('forces sync when zero documents indexed (reset scenario) even if below threshold', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 680,
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 76,
      isComplete: false,
    });

    Message.syncWithMeili.mockResolvedValue(undefined);
    Conversation.syncWithMeili.mockResolvedValue(undefined);

    const indexSync = require('./indexSync');
    await indexSync();

    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] No messages marked as indexed, forcing full sync',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (680 unindexed)',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] No conversations marked as indexed, forcing full sync',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (76 unindexed)');
  });

  test('does NOT force sync when some documents already indexed and below threshold', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 630,
      totalDocuments: 680,
      isComplete: false,
    });

    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 70,
      totalDocuments: 76,
      isComplete: false,
    });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      '[indexSync] No messages marked as indexed, forcing full sync',
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      '[indexSync] No conversations marked as indexed, forcing full sync',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] 50 messages unindexed (below threshold: 1000, skipping)',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] 6 convos unindexed (below threshold: 1000, skipping)',
    );
  });

  test('runs bounded cleanup when search contains documents that are now excluded', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      pendingCleanup: 1,
      isComplete: false,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingCleanup: 0,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Message.cleanupExcludedMeiliIndex).toHaveBeenCalledTimes(1);
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Cleaning 1 excluded messages from search',
    );
  });

  test('does not start cleanup for excluded documents that were never indexed', async () => {
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      pendingCleanup: 0,
      isComplete: true,
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingCleanup: 0,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await indexSync();

    expect(Message.syncWithMeili).not.toHaveBeenCalled();
    expect(Message.cleanupExcludedMeiliIndex).not.toHaveBeenCalled();
    expect(Conversation.syncWithMeili).not.toHaveBeenCalled();
    expect(Conversation.cleanupExcludedMeiliIndex).not.toHaveBeenCalled();
  });

  test('continues conversation cleanup when message cleanup fails transiently', async () => {
    const cleanupError = new Error('message cleanup timed out');
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 100,
      totalDocuments: 100,
      pendingCleanup: 1,
      isComplete: false,
    });
    Message.cleanupExcludedMeiliIndex.mockRejectedValue(cleanupError);
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      pendingCleanup: 1,
      isComplete: false,
    });

    const indexSync = require('./indexSync');
    await expect(indexSync()).rejects.toThrow(cleanupError);

    expect(Message.cleanupExcludedMeiliIndex).toHaveBeenCalledTimes(1);
    expect(Conversation.cleanupExcludedMeiliIndex).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[indexSync] Message reconciliation failed; continuing with conversations:',
      cleanupError,
    );
  });

  test('does not start conversation progress reads after message reconciliation is cancelled', async () => {
    const cancellationError = new Error('index sync cancelled');
    const controller = new AbortController();
    mockRunDistributedJob.mockImplementation((_collection, _jobId, handler) =>
      handler(controller.signal),
    );
    Message.getSyncProgress.mockResolvedValue({
      totalProcessed: 0,
      totalDocuments: 1001,
      pendingIndexing: 1001,
      isComplete: false,
    });
    Message.syncWithMeili.mockImplementation(async () => {
      controller.abort(cancellationError);
      throw cancellationError;
    });
    Conversation.getSyncProgress.mockResolvedValue({
      totalProcessed: 50,
      totalDocuments: 50,
      isComplete: true,
    });

    const indexSync = require('./indexSync');
    await expect(indexSync()).rejects.toBe(cancellationError);

    expect(Conversation.getSyncProgress).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      '[indexSync] Message reconciliation failed; continuing with conversations:',
      cancellationError,
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith('[indexSync] error', cancellationError);
  });
});
