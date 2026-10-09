const mongoose = require('mongoose');
const { MeiliSearch } = require('meilisearch');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { isEnabled, FlowStateManager, evalKeyvRedisScript } = require('@librechat/api');
const { getLogStores } = require('~/cache');
const { batchResetMeiliFlags } = require('./utils');

const searchEnabled = isEnabled(process.env.SEARCH);
const indexingDisabled = isEnabled(process.env.MEILI_NO_SYNC);
let currentTimeout = null;

const defaultSyncThreshold = 1000;
const syncThreshold = process.env.MEILI_SYNC_THRESHOLD
  ? parseInt(process.env.MEILI_SYNC_THRESHOLD, 10)
  : defaultSyncThreshold;

class MeiliSearchClient {
  static instance = null;

  static getInstance() {
    if (!MeiliSearchClient.instance) {
      if (!process.env.MEILI_HOST || !process.env.MEILI_MASTER_KEY) {
        throw new Error('Meilisearch configuration is missing.');
      }
      MeiliSearchClient.instance = new MeiliSearch({
        host: process.env.MEILI_HOST,
        apiKey: process.env.MEILI_MASTER_KEY,
      });
    }
    return MeiliSearchClient.instance;
  }
}

/**
 * Deletes documents from MeiliSearch index that are missing the user field
 * @param {import('meilisearch').Index} index - MeiliSearch index instance
 * @param {string} indexName - Name of the index for logging
 * @returns {Promise<number>} - Number of documents deleted
 */
async function deleteDocumentsWithoutUserField(index, indexName) {
  let deletedCount = 0;
  let offset = 0;
  const batchSize = 1000;

  try {
    while (true) {
      const searchResult = await index.search('', {
        limit: batchSize,
        offset: offset,
      });

      if (searchResult.hits.length === 0) {
        break;
      }

      const idsToDelete = searchResult.hits.filter((hit) => !hit.user).map((hit) => hit.id);

      if (idsToDelete.length > 0) {
        logger.info(
          `[indexSync] Deleting ${idsToDelete.length} documents without user field from ${indexName} index`,
        );
        await index.deleteDocuments(idsToDelete);
        deletedCount += idsToDelete.length;
      }

      if (searchResult.hits.length < batchSize) {
        break;
      }

      offset += batchSize;
    }

    if (deletedCount > 0) {
      logger.info(`[indexSync] Deleted ${deletedCount} orphaned documents from ${indexName} index`);
    }
  } catch (error) {
    logger.error(`[indexSync] Error deleting documents from ${indexName}:`, error);
  }

  return deletedCount;
}

/**
 * Ensures indexes have proper filterable attributes configured and checks if documents have user field
 * @param {MeiliSearch} client - MeiliSearch client instance
 * @returns {Promise<{settingsUpdated: boolean, orphanedDocsFound: boolean}>} - Status of what was done
 */
async function ensureFilterableAttributes(client) {
  let settingsUpdated = false;
  let hasOrphanedDocs = false;

  try {
    // Check and update messages index
    try {
      const messagesIndex = client.index('messages');
      const settings = await messagesIndex.getSettings();

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        logger.info('[indexSync] Configuring messages index to filter by user...');
        await messagesIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        logger.info('[indexSync] Messages index configured for user filtering');
        settingsUpdated = true;
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await messagesIndex.search('', { limit: 1 });
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing messages missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        logger.debug('[indexSync] Could not check message documents:', searchError.message);
      }
    } catch (error) {
      if (error.code !== 'index_not_found') {
        logger.warn('[indexSync] Could not check/update messages index settings:', error.message);
      }
    }

    // Check and update conversations index
    try {
      const convosIndex = client.index('convos');
      const settings = await convosIndex.getSettings();

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        logger.info('[indexSync] Configuring convos index to filter by user...');
        await convosIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        logger.info('[indexSync] Convos index configured for user filtering');
        settingsUpdated = true;
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await convosIndex.search('', { limit: 1 });
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing conversations missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        logger.debug('[indexSync] Could not check conversation documents:', searchError.message);
      }
    } catch (error) {
      if (error.code !== 'index_not_found') {
        logger.warn('[indexSync] Could not check/update convos index settings:', error.message);
      }
    }

    // If either index has orphaned documents, clean them up (but don't force resync)
    if (hasOrphanedDocs) {
      try {
        const messagesIndex = client.index('messages');
        await deleteDocumentsWithoutUserField(messagesIndex, 'messages');
      } catch (error) {
        logger.debug('[indexSync] Could not clean up messages:', error.message);
      }

      try {
        const convosIndex = client.index('convos');
        await deleteDocumentsWithoutUserField(convosIndex, 'convos');
      } catch (error) {
        logger.debug('[indexSync] Could not clean up convos:', error.message);
      }

      logger.info('[indexSync] Orphaned documents cleaned up without forcing resync.');
    }

    if (settingsUpdated) {
      logger.info('[indexSync] Index settings updated. Full re-sync will be triggered.');
    }
  } catch (error) {
    logger.error('[indexSync] Error ensuring filterable attributes:', error);
  }

  return { settingsUpdated, orphanedDocsFound: hasOrphanedDocs };
}

/**
 * Performs the actual sync operations for messages and conversations
 * @param {FlowStateManager} flowManager - Flow state manager instance
 * @param {string} flowId - Flow identifier
 * @param {string} flowType - Flow type
 */
async function performSync(flowManager, flowId, flowType) {
  try {
    if (indexingDisabled === true) {
      logger.info('[indexSync] Indexing is disabled, skipping...');
      return { messagesSync: false, convosSync: false };
    }

    const Message = mongoose.models.Message;
    const Conversation = mongoose.models.Conversation;
    if (!Message || !Conversation) {
      throw new Error(
        '[indexSync] Models not registered. Ensure createModels() has been called before indexSync.',
      );
    }

    const client = MeiliSearchClient.getInstance();

    const { status } = await client.health();
    if (status !== 'available') {
      throw new Error('Meilisearch not available');
    }

    /** Ensures indexes have proper filterable attributes configured */
    const { settingsUpdated, orphanedDocsFound: _orphanedDocsFound } =
      await ensureFilterableAttributes(client);

    let messagesSync = false;
    let convosSync = false;

    // Only reset flags if settings were actually updated (not just for orphaned doc cleanup)
    if (settingsUpdated) {
      logger.info(
        '[indexSync] Settings updated. Forcing full re-sync to reindex with new configuration...',
      );

      // Reset sync flags to force full re-sync
      await batchResetMeiliFlags(Message.collection);
      await batchResetMeiliFlags(Conversation.collection);
    }

    let messageSyncError;
    try {
      // Check if we need to sync messages
      logger.info('[indexSync] Requesting message sync progress...');
      const messageProgress = await Message.getSyncProgress();
      if (!messageProgress.isComplete || settingsUpdated) {
        logger.info(
          `[indexSync] Messages need syncing: ${messageProgress.totalProcessed}/${messageProgress.totalDocuments} indexed`,
        );

        const messageCount = messageProgress.totalDocuments;
        const messagesIndexed = messageProgress.totalProcessed;
        const unindexedMessages = messageCount - messagesIndexed;
        const messagesPendingIndexing = messageProgress.pendingIndexing ?? 0;
        const messagesPendingCleanup = messageProgress.pendingCleanup ?? 0;
        const noneIndexed = messagesIndexed === 0 && unindexedMessages > 0;

        if (
          settingsUpdated ||
          noneIndexed ||
          messagesPendingIndexing > 0 ||
          unindexedMessages > syncThreshold
        ) {
          if (noneIndexed && !settingsUpdated) {
            logger.info('[indexSync] No messages marked as indexed, forcing full sync');
          }
          logger.info(
            messagesPendingCleanup > 0
              ? `[indexSync] Starting message sync (${unindexedMessages} unindexed, ${messagesPendingCleanup} pending cleanup)`
              : `[indexSync] Starting message sync (${unindexedMessages} unindexed)`,
          );
          await Message.syncWithMeili();
          messagesSync = true;
        } else if (messagesPendingCleanup > 0) {
          logger.info(
            `[indexSync] Cleaning ${messagesPendingCleanup} excluded messages from search`,
          );
          await Message.cleanupExcludedMeiliIndex();
          messagesSync = true;
        } else if (unindexedMessages > 0) {
          logger.info(
            `[indexSync] ${unindexedMessages} messages unindexed (below threshold: ${syncThreshold}, skipping)`,
          );
        }
      } else {
        logger.info(
          `[indexSync] Messages are fully synced: ${messageProgress.totalProcessed}/${messageProgress.totalDocuments}`,
        );
      }
    } catch (error) {
      messageSyncError = error;
      logger.error(
        '[indexSync] Message reconciliation failed; continuing with conversations:',
        error,
      );
    }

    // Check if we need to sync conversations
    const convoProgress = await Conversation.getSyncProgress();
    if (!convoProgress.isComplete || settingsUpdated) {
      logger.info(
        `[indexSync] Conversations need syncing: ${convoProgress.totalProcessed}/${convoProgress.totalDocuments} indexed`,
      );

      const convoCount = convoProgress.totalDocuments;
      const convosIndexed = convoProgress.totalProcessed;
      const unindexedConvos = convoCount - convosIndexed;
      const convosPendingIndexing = convoProgress.pendingIndexing ?? 0;
      const convosPendingCleanup = convoProgress.pendingCleanup ?? 0;
      const noneConvosIndexed = convosIndexed === 0 && unindexedConvos > 0;

      if (
        settingsUpdated ||
        noneConvosIndexed ||
        convosPendingIndexing > 0 ||
        unindexedConvos > syncThreshold
      ) {
        if (noneConvosIndexed && !settingsUpdated) {
          logger.info('[indexSync] No conversations marked as indexed, forcing full sync');
        }
        logger.info(
          convosPendingCleanup > 0
            ? `[indexSync] Starting convos sync (${unindexedConvos} unindexed, ${convosPendingCleanup} pending cleanup)`
            : `[indexSync] Starting convos sync (${unindexedConvos} unindexed)`,
        );
        await Conversation.syncWithMeili();
        convosSync = true;
      } else if (convosPendingCleanup > 0) {
        logger.info(
          `[indexSync] Cleaning ${convosPendingCleanup} excluded conversations from search`,
        );
        await Conversation.cleanupExcludedMeiliIndex();
        convosSync = true;
      } else if (unindexedConvos > 0) {
        logger.info(
          `[indexSync] ${unindexedConvos} convos unindexed (below threshold: ${syncThreshold}, skipping)`,
        );
      }
    } else {
      logger.info(
        `[indexSync] Conversations are fully synced: ${convoProgress.totalProcessed}/${convoProgress.totalDocuments}`,
      );
    }

    if (messageSyncError) {
      throw messageSyncError;
    }

    return { messagesSync, convosSync };
  } finally {
    if (indexingDisabled === true) {
      logger.info('[indexSync] Indexing is disabled, skipping cleanup...');
    } else if (flowManager && flowId && flowType) {
      try {
        await flowManager.deleteFlow(flowId, flowType);
        logger.debug('[indexSync] Flow state cleaned up');
      } catch (cleanupErr) {
        logger.debug('[indexSync] Could not clean up flow state:', cleanupErr.message);
      }
    }
  }
}

/**
 * Main index sync function that uses FlowStateManager to prevent concurrent execution
 */
async function indexSync() {
  if (!searchEnabled) {
    return;
  }

  logger.info('[indexSync] Starting index synchronization check...');

  // Get or create FlowStateManager instance
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  if (!flowsCache) {
    logger.warn('[indexSync] Flows cache not available, falling back to direct sync');
    return await performSync(null, null, null);
  }

  const flowManager = new FlowStateManager(flowsCache, {
    ttl: 60000 * 10, // 10 minutes TTL for sync operations
    redisScriptExecutor: evalKeyvRedisScript,
  });

  // Use a unique flow ID for the sync operation
  const flowId = 'meili-index-sync';
  const flowType = 'MEILI_SYNC';

  try {
    // This will only execute the handler if no other instance is running the sync
    const result = await flowManager.createFlowWithHandler(flowId, flowType, () =>
      performSync(flowManager, flowId, flowType),
    );

    if (result.messagesSync || result.convosSync) {
      logger.info('[indexSync] Sync completed successfully');
    } else {
      logger.debug('[indexSync] No sync was needed');
    }

    return result;
  } catch (err) {
    if (err.message.includes('flow already exists')) {
      logger.info('[indexSync] Sync already running on another instance');
      return;
    }

    if (err.message.includes('not found')) {
      logger.debug('[indexSync] Creating indices...');
      currentTimeout = setTimeout(async () => {
        try {
          const Message = mongoose.models.Message;
          const Conversation = mongoose.models.Conversation;
          if (!Message || !Conversation) {
            throw new Error(
              '[indexSync] Models not registered. Ensure createModels() has been called before indexSync.',
            );
          }
          await Message.syncWithMeili();
          await Conversation.syncWithMeili();
        } catch (err) {
          logger.error('[indexSync] Trouble creating indices, try restarting the server.', err);
        }
      }, 750);
    } else if (err.message.includes('Meilisearch not configured')) {
      logger.info('[indexSync] Meilisearch not configured, search will be disabled.');
    } else {
      logger.error('[indexSync] error', err);
    }
  }
}

process.on('exit', () => {
  logger.debug('[indexSync] Clearing sync timeouts before exiting...');
  clearTimeout(currentTimeout);
});

module.exports = indexSync;
