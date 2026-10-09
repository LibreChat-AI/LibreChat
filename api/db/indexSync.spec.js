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
const mockBatchResetMeiliFlags = jest.fn();
const mockIsEnabled = jest.fn();
const mockGetLogStores = jest.fn();

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
  MeiliSearch: jest.fn(() => ({
    health: mockMeiliHealth,
    index: mockMeiliIndex,
  })),
}));

jest.mock('./utils', () => ({
  batchResetMeiliFlags: mockBatchResetMeiliFlags,
}));

jest.mock('@librechat/api', () => ({
  isEnabled: mockIsEnabled,
  FlowStateManager: jest.fn(),
}));

jest.mock('~/cache', () => ({
  getLogStores: mockGetLogStores,
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

    // Mock MeiliSearch client responses
    mockMeiliHealth.mockResolvedValue({ status: 'available' });
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
      updateSettings: jest.fn().mockResolvedValue({}),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });

    mockBatchResetMeiliFlags.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  afterAll(() => {
    mongoose.models.Message = originalMessageModel;
    mongoose.models.Conversation = originalConversationModel;
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

  test('triggers message sync when settingsUpdated even if below syncThreshold', async () => {
    // Arrange: Only 50 unindexed messages (< 1000 threshold), but settings were updated
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

    Message.syncWithMeili.mockResolvedValue(undefined);

    // Mock settings update scenario
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: [] }), // No user field
      updateSettings: jest.fn().mockResolvedValue({}),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: Flags were reset due to settings update
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Conversation.collection);

    // Assert: Message sync triggered despite being below threshold (50 < 1000)
    expect(Message.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Settings updated. Forcing full re-sync to reindex with new configuration...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (50 unindexed)',
    );
  });

  test('triggers conversation sync when settingsUpdated even if below syncThreshold', async () => {
    // Arrange: Messages complete, conversations have 50 unindexed (< 1000 threshold), but settings were updated
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

    // Mock settings update scenario
    mockMeiliIndex.mockReturnValue({
      getSettings: jest.fn().mockResolvedValue({ filterableAttributes: [] }), // No user field
      updateSettings: jest.fn().mockResolvedValue({}),
      search: jest.fn().mockResolvedValue({ hits: [] }),
    });

    process.env.MEILI_SYNC_THRESHOLD = '1000';

    // Act
    const indexSync = require('./indexSync');
    await indexSync();

    // Assert: Flags were reset due to settings update
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Message.collection);
    expect(mockBatchResetMeiliFlags).toHaveBeenCalledWith(Conversation.collection);

    // Assert: Conversation sync triggered despite being below threshold (50 < 1000)
    expect(Conversation.syncWithMeili).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Settings updated. Forcing full re-sync to reindex with new configuration...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (50 unindexed)');
  });

  test('triggers both message and conversation sync when settingsUpdated even if both below syncThreshold', async () => {
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
      updateSettings: jest.fn().mockResolvedValue({}),
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
      '[indexSync] Settings updated. Forcing full re-sync to reindex with new configuration...',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[indexSync] Starting message sync (50 unindexed)',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('[indexSync] Starting convos sync (50 unindexed)');
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
});
