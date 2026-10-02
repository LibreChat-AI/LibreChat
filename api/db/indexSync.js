const mongoose = require('mongoose');
const { MeiliSearch, MeiliSearchTimeOutError } = require('meilisearch');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  MEILI_HTTP_REQUEST_TIMEOUT_MS,
  MEILI_INDEX_SYNC_INTERVAL_MS,
  MEILI_INDEX_SYNC_LEASE_MS,
  MEILI_INDEX_SYNC_REFRESH_MS,
  runDistributedJob,
  waitForMeiliTask,
} = require('@librechat/api');
const {
  batchResetMeiliFlags,
  getMeiliRebuildState,
  requestMeiliRebuild,
  markMeiliRebuildSyncing,
  completeMeiliRebuild,
} = require('./utils');

const searchEnabled = isEnabled(process.env.SEARCH);
const indexingDisabled = isEnabled(process.env.MEILI_NO_SYNC);

const defaultSyncThreshold = 1000;
const syncThreshold = process.env.MEILI_SYNC_THRESHOLD
  ? parseInt(process.env.MEILI_SYNC_THRESHOLD, 10)
  : defaultSyncThreshold;
const indexSyncCancellationGraceMs = MEILI_HTTP_REQUEST_TIMEOUT_MS * 2 + 5_000;

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Index sync cancelled');
  }
};

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
        timeout: MEILI_HTTP_REQUEST_TIMEOUT_MS,
      });
    }
    return MeiliSearchClient.instance;
  }
}

/**
 * Deletes documents from MeiliSearch index that are missing the user field
 * @param {import('meilisearch').Index} index - MeiliSearch index instance
 * @param {string} indexName - Name of the index for logging
 * @param {string} primaryKey - Primary key configured for the index
 * @returns {Promise<number>} - Number of documents deleted
 */
async function deleteDocumentsWithoutUserField(index, indexName, primaryKey, signal) {
  let deletedCount = 0;
  let offset = 0;
  let previousPageSignature;
  const batchSize = 1000;

  try {
    while (true) {
      const searchResult = await index.search('', {
        limit: batchSize,
        offset: offset,
      });
      throwIfAborted(signal);

      if (searchResult.hits.length === 0) {
        break;
      }

      const orphanedHits = searchResult.hits.filter((hit) => !hit.user);
      const missingPrimaryKey = orphanedHits.some((hit) => hit[primaryKey] == null);
      if (missingPrimaryKey) {
        throw new Error(`[indexSync] Cannot clean ${indexName} document without ${primaryKey}`);
      }
      const pageSignature = `${offset}:${searchResult.hits
        .map((hit) => String(hit[primaryKey]))
        .join(',')}`;
      if (pageSignature === previousPageSignature) {
        throw new Error(`[indexSync] ${indexName} cleanup made no progress`);
      }
      previousPageSignature = pageSignature;
      const idsToDelete = orphanedHits.map((hit) => hit[primaryKey]);

      if (idsToDelete.length > 0) {
        logger.info(
          `[indexSync] Deleting ${idsToDelete.length} documents without user field from ${indexName} index`,
        );
        throwIfAborted(signal);
        const deletion = await index.deleteDocuments(idsToDelete);
        throwIfAborted(signal);
        await waitForMeiliTask(
          MeiliSearchClient.getInstance(),
          deletion.taskUid,
          `${indexName} cleanup`,
          (error) => error instanceof MeiliSearchTimeOutError,
          { signal },
        );
        throwIfAborted(signal);
        deletedCount += idsToDelete.length;
      }

      if (searchResult.hits.length < batchSize) {
        break;
      }

      offset += searchResult.hits.length - idsToDelete.length;
    }

    if (deletedCount > 0) {
      logger.info(`[indexSync] Deleted ${deletedCount} orphaned documents from ${indexName} index`);
    }
  } catch (error) {
    logger.error(`[indexSync] Error deleting documents from ${indexName}:`, error);
    throw error;
  }

  return deletedCount;
}

/**
 * Ensures indexes have proper filterable attributes configured and checks if documents have user field
 * @param {MeiliSearch} client - MeiliSearch client instance
 * @returns {Promise<{
 *   messagesRebuild: {generation: string, phase: string} | null,
 *   conversationsRebuild: {generation: string, phase: string} | null,
 *   orphanedDocsFound: boolean,
 *   missingIndexes: {messages: boolean, conversations: boolean}
 * }>} - Status of what was done
 */
async function ensureFilterableAttributes(client, rebuildStates, signal) {
  let messagesRebuild = await getMeiliRebuildState(rebuildStates, 'messages', { signal });
  let conversationsRebuild = await getMeiliRebuildState(rebuildStates, 'convos', { signal });
  let hasOrphanedDocs = false;
  const missingIndexes = {
    messages: false,
    conversations: false,
  };

  try {
    // Check and update messages index
    try {
      const messagesIndex = client.index('messages');
      const settings = await messagesIndex.getSettings();
      throwIfAborted(signal);

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        messagesRebuild = await requestMeiliRebuild(rebuildStates, 'messages', { signal });
        logger.info('[indexSync] Configuring messages index to filter by user...');
        throwIfAborted(signal);
        const settingsTask = await messagesIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        throwIfAborted(signal);
        await waitForMeiliTask(
          client,
          settingsTask.taskUid,
          'messages settings',
          (error) => error instanceof MeiliSearchTimeOutError,
          { signal },
        );
        throwIfAborted(signal);
        logger.info('[indexSync] Messages index configured for user filtering');
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await messagesIndex.search('', { limit: 1 });
        throwIfAborted(signal);
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing messages missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        if (searchError.code === 'index_not_found') {
          missingIndexes.messages = true;
          messagesRebuild = await requestMeiliRebuild(rebuildStates, 'messages', { signal });
        } else {
          throw searchError;
        }
      }
    } catch (error) {
      if (error.code === 'index_not_found') {
        missingIndexes.messages = true;
        messagesRebuild = await requestMeiliRebuild(rebuildStates, 'messages', { signal });
      } else {
        logger.warn('[indexSync] Could not check/update messages index settings:', error.message);
        throw error;
      }
    }

    // Check and update conversations index
    try {
      const convosIndex = client.index('convos');
      const settings = await convosIndex.getSettings();
      throwIfAborted(signal);

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        conversationsRebuild = await requestMeiliRebuild(rebuildStates, 'convos', { signal });
        logger.info('[indexSync] Configuring convos index to filter by user...');
        throwIfAborted(signal);
        const settingsTask = await convosIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        throwIfAborted(signal);
        await waitForMeiliTask(
          client,
          settingsTask.taskUid,
          'convos settings',
          (error) => error instanceof MeiliSearchTimeOutError,
          { signal },
        );
        throwIfAborted(signal);
        logger.info('[indexSync] Convos index configured for user filtering');
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await convosIndex.search('', { limit: 1 });
        throwIfAborted(signal);
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing conversations missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        if (searchError.code === 'index_not_found') {
          missingIndexes.conversations = true;
          conversationsRebuild = await requestMeiliRebuild(rebuildStates, 'convos', { signal });
        } else {
          throw searchError;
        }
      }
    } catch (error) {
      if (error.code === 'index_not_found') {
        missingIndexes.conversations = true;
        conversationsRebuild = await requestMeiliRebuild(rebuildStates, 'convos', { signal });
      } else {
        logger.warn('[indexSync] Could not check/update convos index settings:', error.message);
        throw error;
      }
    }

    // If either index has orphaned documents, clean them up (but don't force resync)
    if (hasOrphanedDocs) {
      try {
        const messagesIndex = client.index('messages');
        await deleteDocumentsWithoutUserField(messagesIndex, 'messages', 'messageId', signal);
      } catch (error) {
        if (error.code === 'index_not_found') {
          missingIndexes.messages = true;
          logger.debug('[indexSync] Messages index disappeared before cleanup');
        } else {
          throw error;
        }
      }

      try {
        const convosIndex = client.index('convos');
        await deleteDocumentsWithoutUserField(convosIndex, 'convos', 'conversationId', signal);
      } catch (error) {
        if (error.code === 'index_not_found') {
          missingIndexes.conversations = true;
          logger.debug('[indexSync] Conversations index disappeared before cleanup');
        } else {
          throw error;
        }
      }

      logger.info('[indexSync] Orphaned documents cleaned up without forcing resync.');
    }

    if (messagesRebuild || conversationsRebuild) {
      logger.info('[indexSync] A durable index rebuild is pending.');
    }
  } catch (error) {
    logger.error('[indexSync] Error ensuring filterable attributes:', error);
    throw error;
  }

  return {
    messagesRebuild,
    conversationsRebuild,
    orphanedDocsFound: hasOrphanedDocs,
    missingIndexes,
  };
}

async function rebuildMissingIndex(client, indexName, primaryKey, signal) {
  logger.info(`[indexSync] Recreating missing ${indexName} index...`);
  throwIfAborted(signal);
  const creationTask = await client.createIndex(indexName, { primaryKey });
  throwIfAborted(signal);
  await waitForMeiliTask(
    client,
    creationTask.taskUid,
    `${indexName} creation`,
    (error) => error instanceof MeiliSearchTimeOutError,
    {
      isTaskSuccessful: (task) =>
        task.status === 'succeeded' || task.error?.code === 'index_already_exists',
      signal,
    },
  );
  throwIfAborted(signal);

  const index = client.index(indexName);
  const settingsTask = await index.updateSettings({
    filterableAttributes: ['user'],
  });
  throwIfAborted(signal);
  await waitForMeiliTask(
    client,
    settingsTask.taskUid,
    `${indexName} settings`,
    (error) => error instanceof MeiliSearchTimeOutError,
    { signal },
  );
  throwIfAborted(signal);
}

/**
 * Performs the actual sync operations for messages and conversations
 * @param {{quiet?: boolean, signal?: AbortSignal}} options - Reconciliation options
 */
async function performSync(options = {}) {
  if (!options.quiet) {
    logger.info('[indexSync] Starting index synchronization check...');
  }
  const logProgress = options.quiet ? logger.debug.bind(logger) : logger.info.bind(logger);
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
    const rebuildStates = mongoose.connection.collection('meiliIndexSyncState');

    const { status } = await client.health();
    throwIfAborted(options.signal);
    if (status !== 'available') {
      throw new Error('Meilisearch not available');
    }

    /** Ensures indexes have proper filterable attributes configured */
    const {
      messagesRebuild: initialMessagesRebuild,
      conversationsRebuild: initialConversationsRebuild,
      orphanedDocsFound: _orphanedDocsFound,
      missingIndexes,
    } = await ensureFilterableAttributes(client, rebuildStates, options.signal);
    let messagesRebuild = initialMessagesRebuild;
    let conversationsRebuild = initialConversationsRebuild;

    let messagesSync = false;
    let convosSync = false;

    if (missingIndexes.messages) {
      logger.warn(
        '[indexSync] Messages index is missing. Resetting message acknowledgements for recovery.',
      );
      await rebuildMissingIndex(client, 'messages', 'messageId', options.signal);
    }
    if (missingIndexes.conversations) {
      logger.warn(
        '[indexSync] Conversations index is missing. Resetting conversation acknowledgements for recovery.',
      );
      await rebuildMissingIndex(client, 'convos', 'conversationId', options.signal);
    }

    if (messagesRebuild?.phase === 'resetting') {
      logger.info('[indexSync] Resetting messages for the pending index rebuild...');
      await batchResetMeiliFlags(Message.collection, { signal: options.signal });
      messagesRebuild = await markMeiliRebuildSyncing(
        rebuildStates,
        'messages',
        messagesRebuild.generation,
        { signal: options.signal },
      );
    }
    if (conversationsRebuild?.phase === 'resetting') {
      logger.info('[indexSync] Resetting conversations for the pending index rebuild...');
      await batchResetMeiliFlags(Conversation.collection, { signal: options.signal });
      conversationsRebuild = await markMeiliRebuildSyncing(
        rebuildStates,
        'convos',
        conversationsRebuild.generation,
        { signal: options.signal },
      );
    }

    let messageSyncError;
    try {
      // Check if we need to sync messages
      logProgress('[indexSync] Requesting message sync progress...');
      const messageProgress = await Message.getSyncProgress();
      throwIfAborted(options.signal);
      const forceMessageSync = messagesRebuild != null || missingIndexes.messages;
      if (!messageProgress.isComplete || forceMessageSync) {
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
          forceMessageSync ||
          noneIndexed ||
          messagesPendingIndexing > 0 ||
          unindexedMessages > syncThreshold
        ) {
          if (noneIndexed && !forceMessageSync) {
            logger.info('[indexSync] No messages marked as indexed, forcing full sync');
          }
          logger.info(
            messagesPendingCleanup > 0
              ? `[indexSync] Starting message sync (${unindexedMessages} unindexed, ${messagesPendingCleanup} pending cleanup)`
              : `[indexSync] Starting message sync (${unindexedMessages} unindexed)`,
          );
          await Message.syncWithMeili(options.signal);
          messagesSync = true;
          if (messagesRebuild?.phase === 'syncing') {
            await completeMeiliRebuild(rebuildStates, 'messages', messagesRebuild.generation, {
              signal: options.signal,
            });
            messagesRebuild = null;
          }
        } else if (messagesPendingCleanup > 0) {
          logger.info(
            `[indexSync] Cleaning ${messagesPendingCleanup} excluded messages from search`,
          );
          await Message.cleanupExcludedMeiliIndex(options.signal);
          messagesSync = true;
        } else if (unindexedMessages > 0) {
          logger.info(
            `[indexSync] ${unindexedMessages} messages unindexed (below threshold: ${syncThreshold}, skipping)`,
          );
        }
      } else {
        logProgress(
          `[indexSync] Messages are fully synced: ${messageProgress.totalProcessed}/${messageProgress.totalDocuments}`,
        );
      }
    } catch (error) {
      throwIfAborted(options.signal);
      messageSyncError = error;
      logger.error(
        '[indexSync] Message reconciliation failed; continuing with conversations:',
        error,
      );
    }

    // Check if we need to sync conversations
    throwIfAborted(options.signal);
    const convoProgress = await Conversation.getSyncProgress();
    throwIfAborted(options.signal);
    const forceConvoSync = conversationsRebuild != null || missingIndexes.conversations;
    if (!convoProgress.isComplete || forceConvoSync) {
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
        forceConvoSync ||
        noneConvosIndexed ||
        convosPendingIndexing > 0 ||
        unindexedConvos > syncThreshold
      ) {
        if (noneConvosIndexed && !forceConvoSync) {
          logger.info('[indexSync] No conversations marked as indexed, forcing full sync');
        }
        logger.info(
          convosPendingCleanup > 0
            ? `[indexSync] Starting convos sync (${unindexedConvos} unindexed, ${convosPendingCleanup} pending cleanup)`
            : `[indexSync] Starting convos sync (${unindexedConvos} unindexed)`,
        );
        await Conversation.syncWithMeili(options.signal);
        convosSync = true;
        if (conversationsRebuild?.phase === 'syncing') {
          await completeMeiliRebuild(rebuildStates, 'convos', conversationsRebuild.generation, {
            signal: options.signal,
          });
          conversationsRebuild = null;
        }
      } else if (convosPendingCleanup > 0) {
        logger.info(
          `[indexSync] Cleaning ${convosPendingCleanup} excluded conversations from search`,
        );
        await Conversation.cleanupExcludedMeiliIndex(options.signal);
        convosSync = true;
      } else if (unindexedConvos > 0) {
        logger.info(
          `[indexSync] ${unindexedConvos} convos unindexed (below threshold: ${syncThreshold}, skipping)`,
        );
      }
    } else {
      logProgress(
        `[indexSync] Conversations are fully synced: ${convoProgress.totalProcessed}/${convoProgress.totalDocuments}`,
      );
    }

    if (messageSyncError) {
      throw messageSyncError;
    }

    const result = { messagesSync, convosSync };
    if (result.messagesSync || result.convosSync) {
      logger.info('[indexSync] Sync completed successfully');
    } else {
      logger.debug('[indexSync] No sync was needed');
    }

    return result;
  } catch (err) {
    if (options.signal?.aborted) {
      throw err;
    }
    if (err.message.includes('Meilisearch not configured')) {
      logger.info('[indexSync] Meilisearch not configured, search will be disabled.');
    } else {
      logger.error('[indexSync] error', err);
      throw err;
    }
  }
}

async function indexSync(options = {}) {
  if (!searchEnabled) {
    return;
  }

  const jobs = mongoose.connection.collection('distributedJobs');
  return runDistributedJob(
    jobs,
    'meili-index-sync',
    (signal) => performSync({ ...options, signal }),
    {
      completionTtlMs: MEILI_INDEX_SYNC_INTERVAL_MS,
      cancellationGraceMs: indexSyncCancellationGraceMs,
      leaseMs: MEILI_INDEX_SYNC_LEASE_MS,
      onLeaseLost: () => process.exit(1),
      refreshMs: MEILI_INDEX_SYNC_REFRESH_MS,
      signal: options.signal,
    },
  );
}

module.exports = indexSync;
