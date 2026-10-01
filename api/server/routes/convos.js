const fs = require('fs');
const multer = require('multer');
const express = require('express');
const mongoose = require('mongoose');
const { sleep } = require('@librechat/agents');
const {
  reportLocatorTraversalFailure,
  isEnabled,
  normalizeLimit,
  normalizeSortDirection,
  normalizeSortField,
  resolveConversationListFilters,
  CONVERSATION_SORT_FIELDS,
  openCheckpointDeletion,
  waitForGenerationPersistence,
  createArchiveAllHandler,
  createSubagentActivityStreamHandler,
  createSubagentControlHandler,
  isValidSubagentControlRequest,
  exemptAgentTriggerFromIpLimiter,
  createParentSubagentIndexHandler,
  createBackgroundTaskIndexHandler,
  createBackgroundTaskCancelHandler,
  createBackgroundTaskPolicyMiddleware,
  backgroundTaskRegistry,
  createSubagentThreadViewHandler,
  createMarkConvoSeenHandler,
  createMarkConvoUnreadHandler,
  runImport,
  GROK_SOURCE,
  GROK_ENDPOINT,
  inspectExport,
  ImportJobStore,
  sanitizeImportError,
  extractLegacyArchiveEntry,
  resolveImportMaxFileSize,
  resolveImportMaxConcurrency,
  restoreTenantContextFromReq,
  deleteAllSharedLinksWithCleanup,
  deleteConvoSharedLinksWithCleanup,
  inspectContent,
  createContentFilter,
  isContentFilterError,
  isConversationImportError,
  contentFilterBlockResponse,
  extractConversationTitleContent,
  extractStoredMessageContent,
  GenerationJobManager,
  isStopConfirmed,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys, EModelEndpoint } = require('librechat-data-provider');
const {
  createImportLimiters,
  validateConvoAccess,
  createForkLimiters,
  configMiddleware,
  messageIpLimiter,
  messageUserLimiter,
  moderateText,
} = require('~/server/middleware');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createImportBatchBuilder } = require('~/server/utils/import/importBatchBuilder');
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { resolveImportDefaultModel } = require('~/server/utils/import/defaults');
const { importStorage, importFileFilter } = require('~/server/routes/files/multer');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { importConversations } = require('~/server/utils/import');
const { getAppConfig } = require('~/server/services/Config');
const subagentThreadTaskStore = require('~/server/services/Endpoints/agents/subagentThreadStore');
const {
  pendingBackgroundToolCompletions,
} = require('~/server/services/Endpoints/agents/backgroundCompletion');
const getLogStores = require('~/cache/getLogStores');
const db = require('~/models');

const assistantClients = {
  [EModelEndpoint.azureAssistants]: require('~/server/services/Endpoints/azureAssistants'),
  [EModelEndpoint.assistants]: require('~/server/services/Endpoints/assistants'),
};

const router = express.Router();
const archiveAllHandler = createArchiveAllHandler({ archiveAllConvos: db.archiveAllConvos });
const subagentThreadViewHandler = createSubagentThreadViewHandler({
  getConvoOwnership: db.getConvoOwnership,
  getSubagentThreadForParent: db.getSubagentThreadForParent,
  getMessagesForSubagentThreadView: db.getMessagesForSubagentThreadView,
});
const parentSubagentIndexHandler = createParentSubagentIndexHandler({
  getConvoOwnership: db.getConvoOwnership,
  listSubagentThreadsForParent: db.listSubagentThreadsForParent,
  listSubagentTasksForThreads: db.listSubagentTasksForThreads,
});
const filterConversationTitle = createContentFilter({
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  extract: (req) => extractConversationTitleContent(req.body),
});
const filterSubagentControlMessage = createContentFilter({
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  getLegacyPii: (req) => req.config?.messageFilter?.pii,
  extract: (req) =>
    ['steer', 'queue', 'interrupt'].includes(req.body?.action)
      ? extractStoredMessageContent({ text: req.body?.message })
      : [],
});
const unless = (isExempt, middleware) => (req, res, next) =>
  isExempt(req) ? next() : middleware(req, res, next);
const subagentControlLimiters = [];
if (isEnabled(process.env.LIMIT_MESSAGE_IP)) {
  subagentControlLimiters.push(unless(exemptAgentTriggerFromIpLimiter, messageIpLimiter));
}
if (isEnabled(process.env.LIMIT_MESSAGE_USER)) {
  subagentControlLimiters.push(messageUserLimiter);
}

function validateSubagentControlRequest(req, res, next) {
  if (!isValidSubagentControlRequest(req.body)) {
    return res.status(400).json({ error: 'Invalid subagent control request' });
  }
  next();
}

/** Present guidance to the existing moderation middleware as ordinary user text.
 * The controller continues to consume `message`; `text` is restored before it runs. */
async function moderateSubagentControlMessage(req, res, next) {
  const body = (req.body ??= {});
  if (!['steer', 'queue', 'interrupt'].includes(body.action)) {
    next();
    return;
  }
  const hadText = Object.prototype.hasOwnProperty.call(body, 'text');
  const originalText = body.text;
  if (typeof body.message === 'string') {
    body.text = body.message;
  }
  const restore = () => {
    if (hadText) {
      body.text = originalText;
    } else {
      delete body.text;
    }
  };
  try {
    await moderateText(req, res, (error) => {
      restore();
      next(error);
    });
  } finally {
    restore();
  }
}
const subagentActivityStreamHandler = createSubagentActivityStreamHandler(
  {
    getConvoOwnership: db.getConvoOwnership,
    getSubagentThreadForParent: db.getSubagentThreadForParent,
    getMessages: db.getMessages,
  },
  {
    subscribe: subagentThreadTaskStore.subscribeActivity.bind(subagentThreadTaskStore),
  },
);
const subagentControlHandler = createSubagentControlHandler({
  getConvoOwnership: db.getConvoOwnership,
  getSubagentThreadForParent: db.getSubagentThreadForParent,
  getMessages: db.getMessages,
  getSubagentTaskControlReceipt: db.getSubagentTaskControlReceipt,
  store: subagentThreadTaskStore,
});
const markConvoSeenHandler = createMarkConvoSeenHandler({ markConvoSeen: db.markConvoSeen });
const markConvoUnreadHandler = createMarkConvoUnreadHandler({
  markConvoUnread: db.markConvoUnread,
});
const backgroundTaskPolicy = createBackgroundTaskPolicyMiddleware({ getAppConfig });
const backgroundTaskIndexHandler = createBackgroundTaskIndexHandler({
  registry: backgroundTaskRegistry,
  pending: pendingBackgroundToolCompletions,
});
const backgroundTaskCancelHandler = createBackgroundTaskCancelHandler({
  registry: backgroundTaskRegistry,
});
router.use(requireJwtAuth);

const isValidProjectFilter = (projectId) =>
  !projectId || projectId === 'unassigned' || /^[a-f\d]{24}$/i.test(projectId);

router.get('/', async (req, res) => {
  const limit = normalizeLimit(req.query.limit);
  const cursor = req.query.cursor;
  const isArchived = isEnabled(req.query.isArchived);
  const pinned = isEnabled(req.query.pinned);
  const search =
    typeof req.query.search === 'string' ? req.query.search.trim() || undefined : undefined;
  const sortBy = normalizeSortField(req.query.sortBy, {
    fields: CONVERSATION_SORT_FIELDS,
    fallback: 'updatedAt',
  });
  const sortDirection = normalizeSortDirection(req.query.sortDirection);
  const projectId = Array.isArray(req.query.projectId)
    ? req.query.projectId[0]
    : req.query.projectId;

  if (!isValidProjectFilter(projectId)) {
    return res.status(400).json({ error: 'projectId must be a valid project id or unassigned' });
  }

  let tags;
  if (req.query.tags) {
    tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
  }

  try {
    const { filters, error: filterError } = await resolveConversationListFilters(
      req.query,
      getAppConfig,
    );
    if (filterError) {
      return res.status(400).json({ error: filterError });
    }

    const result = await db.getConvosByCursor(req.user.id, {
      cursor,
      limit,
      isArchived,
      pinned,
      tags,
      search,
      sortBy,
      sortDirection,
      projectId,
      ...filters,
    });
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching conversations', error);
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

router.get(
  '/:parentConversationId/subagents/:threadId/tasks/:taskId/activity',
  subagentActivityStreamHandler,
);
router.post(
  '/:parentConversationId/subagents/:threadId/control',
  configMiddleware,
  ...subagentControlLimiters,
  validateSubagentControlRequest,
  filterSubagentControlMessage,
  moderateSubagentControlMessage,
  subagentControlHandler,
);
router.get('/:parentConversationId/subagents', parentSubagentIndexHandler);
router.get('/:conversationId/background-tasks', backgroundTaskPolicy, backgroundTaskIndexHandler);
router.post(
  '/:conversationId/background-tasks/cancel',
  backgroundTaskPolicy,
  backgroundTaskCancelHandler,
);
router.get('/:parentConversationId/subagents/:threadId', subagentThreadViewHandler);

router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const convo = await db.getConvo(req.user.id, conversationId);

  if (convo && convo.subagentThread == null) {
    res.status(200).json(convo);
  } else {
    res.status(404).end();
  }
});

router.get('/gen_title/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;
  let title = await titleCache.get(key);

  if (!title) {
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s (total ~15.5s max wait)
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const delay of delays) {
      await sleep(delay);
      title = await titleCache.get(key);
      if (title) {
        break;
      }
    }
  }

  if (title) {
    await titleCache.delete(key);
    res.status(200).json({ title });
  } else {
    res.status(404).json({
      message: "Title not found or method not implemented for the conversation's endpoint",
    });
  }
});

const POST_DELETE_CANCEL_ATTEMPTS = 3;
const POST_DELETE_CANCEL_BACKOFF_MS = 250;
const GENERATION_LOOKUP_ATTEMPTS = 3;

async function readGenerationForDeletion(conversationId) {
  let lastError;
  for (let attempt = 1; attempt <= GENERATION_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      return await GenerationJobManager.getCleanupJob(conversationId);
    } catch (error) {
      lastError = error;
      if (attempt < GENERATION_LOOKUP_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }
  throw lastError;
}

/** Replays a cancellation plan after deletion, retrying a transiently unreachable
 * owner rather than losing the only pass that can stop a late-admitted child. */
async function retryPostDeleteCancellation(cancellationPlan, deletedConversationIds) {
  for (let attempt = 1; attempt <= POST_DELETE_CANCEL_ATTEMPTS; attempt += 1) {
    try {
      await subagentThreadTaskStore.cancelPlan(cancellationPlan, deletedConversationIds);
      return;
    } catch (error) {
      if (attempt === POST_DELETE_CANCEL_ATTEMPTS) {
        logger.warn('Post-delete subagent cancellation failed', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POST_DELETE_CANCEL_BACKOFF_MS * attempt));
    }
  }
}

/** Confirms every exact generation is stopped before its conversation wave is removed. */
async function confirmAgentGenerationsDrained(
  userId,
  conversationIds,
  leaseTaskIds = [],
  tenantId,
  ownerWide = false,
) {
  const drainErrors = [];
  let conversationRunIds;
  try {
    conversationRunIds = ownerWide
      ? await GenerationJobManager.getCleanupBlockingJobIdsForUser(userId, tenantId)
      : await GenerationJobManager.getCleanupBlockingJobIdsForConversations(
          userId,
          conversationIds,
          tenantId,
        );
  } catch (error) {
    logger.warn('Conversation generation index lookup failed', error);
    throw new Error('Conversation generations could not be confirmed drained.');
  }
  const generationIds = [...new Set([...conversationIds, ...leaseTaskIds, ...conversationRunIds])];
  await Promise.all(
    generationIds.map(async (conversationId) => {
      let job;
      try {
        job = await readGenerationForDeletion(conversationId);
      } catch (error) {
        logger.warn('Deleted child generation lookup failed', error);
        drainErrors.push(error);
        return;
      }
      if (job == null || job.metadata?.userId !== userId) {
        return;
      }
      const jobTenantId = job.metadata?.tenantId;
      if (jobTenantId != null && jobTenantId !== tenantId) {
        return;
      }
      const needsDrain =
        job.status === 'running' ||
        job.status === 'requires_action' ||
        job.metadata?.providerDrained === false ||
        job.metadata?.terminalPersistencePending === true ||
        job.metadata?.terminalHostActionPending === true;
      if (!needsDrain) return;
      try {
        const abortResult = await GenerationJobManager.abortJob(conversationId, {
          expectedCreatedAt: job.createdAt,
          awaitProviderDrain: true,
        });
        if (!isStopConfirmed(abortResult)) {
          throw new Error(
            `Could not confirm generation stop for ${conversationId}: ${abortResult?.failureReason ?? 'unknown'}`,
          );
        }
        await waitForGenerationPersistence(conversationId, job.createdAt, (id) =>
          GenerationJobManager.getCleanupJob(id),
        );
      } catch (error) {
        logger.warn('Deleted child generation drain failed', error);
        drainErrors.push(error);
      }
    }),
  );
  if (drainErrors.length > 0) {
    throw new Error('One or more deleted child generations could not be confirmed drained.');
  }
}

/** Repeats generation discovery after the conversation wave is gone, then always
 * removes remnants for that immutable deletion set. A remote run may settle and
 * leave the cleanup index between persisting and this lookup; absence from the
 * index is therefore not evidence that the second persistence sweep is unnecessary. */
async function drainDeletedAgentGenerations(
  userId,
  conversationIds,
  leaseTaskIds = [],
  tenantId,
  deletion,
) {
  await confirmAgentGenerationsDrained(userId, conversationIds, leaseTaskIds, tenantId);
  await db.deleteConvos(
    userId,
    { conversationId: { $in: conversationIds } },
    {
      allowEmpty: true,
      beforeDelete: async (ids) => {
        await deletion?.remember(ids);
        await confirmAgentGenerationsDrained(userId, ids, [], tenantId);
        await deletion?.remember(ids);
      },
    },
  );
  await db.deleteMessages({ user: userId, conversationId: { $in: conversationIds } });
}

/** Orders every owner-scoped agent execution against a delete-all persistence
 * snapshot. The recovery callback repeats the non-subagent drain if the durable
 * fence ever lapses and must be reacquired after deletion has started. */
async function withAgentOwnerDeletionFence(userId, tenantId, deletion, recoverPersistence) {
  const drainRemoteRuns = () => confirmAgentGenerationsDrained(userId, [], [], tenantId, true);
  let recoveryConversationIds = [];
  const result = await subagentThreadTaskStore.withOwnerDeletionFence(
    userId,
    tenantId,
    async () => {
      await drainRemoteRuns();
      return deletion();
    },
    async () => {
      await drainRemoteRuns();
      /** Runs only after the fence was restored. No new provider may enter while
       * persistence created during the gap is removed idempotently. */
      const recovery = await recoverPersistence();
      recoveryConversationIds = recovery.conversationIds ?? [];
    },
  );
  return { result, recoveryConversationIds };
}

async function deleteOwnerConversationPersistence(userId, filter, tenantId, checkpointer) {
  const deletion = await openCheckpointDeletion(userId, tenantId, undefined, checkpointer);
  const result = await db.deleteConvos(userId, filter, {
    allowEmpty: true,
    beforeDelete: async (conversationIds) => {
      await deletion.remember(conversationIds);
      await confirmAgentGenerationsDrained(userId, conversationIds, [], tenantId);
      await deletion.remember(conversationIds);
    },
  });
  const targets = [...new Set([...deletion.conversationIds(), ...(result.conversationIds ?? [])])];
  if (targets.length > 0) {
    await drainDeletedAgentGenerations(userId, targets, [], tenantId, deletion);
  }
  await deletion.cleanup();
  await db.deleteMessages({ user: userId });
  await deletion.acknowledge();
  return { ...result, conversationIds: targets };
}

router.delete('/', configMiddleware, async (req, res) => {
  let filter = {};
  const { conversationId, source, thread_id, endpoint } = req.body?.arg ?? {};

  if (conversationId != null && typeof conversationId !== 'string') {
    return res.status(400).json({ error: 'Invalid conversationId' });
  }

  // Prevent deletion of all conversations
  if (!conversationId && !source && !thread_id && !endpoint) {
    return res.status(400).json({
      error: 'no parameters provided',
    });
  }

  if (conversationId) {
    filter = { conversationId };
  } else if (source === 'button') {
    return res.status(200).send('No conversationId provided');
  }

  if (
    typeof endpoint !== 'undefined' &&
    Object.prototype.propertyIsEnumerable.call(assistantClients, endpoint)
  ) {
    /** @type {{ openai: OpenAI }} */
    const { openai } = await assistantClients[endpoint].initializeClient({ req, res });
    try {
      const response = await openai.beta.threads.delete(thread_id);
      logger.debug('Deleted OpenAI thread:', response);
    } catch (error) {
      logger.error('Error deleting OpenAI thread:', error);
    }
  }

  try {
    const tenantId =
      typeof req.user.tenantId === 'string' && req.user.tenantId !== ''
        ? req.user.tenantId
        : undefined;
    const checkpointer = req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
    let cancellationPlan;
    let checkpointDeletion;
    let dbResponse;
    if (filter.conversationId) {
      checkpointDeletion = await openCheckpointDeletion(
        req.user.id,
        tenantId,
        filter.conversationId,
        checkpointer,
      );
      await checkpointDeletion.remember([filter.conversationId]);
      cancellationPlan = await subagentThreadTaskStore.planCancellationForConversations(
        req.user.id,
        checkpointDeletion.conversationIds(),
        tenantId,
      );
      await subagentThreadTaskStore.cancelPlan(cancellationPlan);
      dbResponse = await db.deleteConvos(req.user.id, filter, {
        allowEmpty: true,
        beforeDelete: async (conversationIds) => {
          await checkpointDeletion.remember(conversationIds);
          await confirmAgentGenerationsDrained(req.user.id, conversationIds, [], tenantId);
          await checkpointDeletion.remember(conversationIds);
        },
      });
    } else {
      /** An empty filter deletes every conversation this owner has, so it runs behind
       * the same admission fence as `DELETE /all` rather than a bare drain. */
      const fencedDeletion = await withAgentOwnerDeletionFence(
        req.user.id,
        tenantId,
        () => deleteOwnerConversationPersistence(req.user.id, filter, tenantId, checkpointer),
        () => deleteOwnerConversationPersistence(req.user.id, filter, tenantId, checkpointer),
      );
      return res.status(201).json(fencedDeletion.result);
    }
    let deletedConversationIds = [
      ...new Set([
        ...(dbResponse.conversationIds ?? (filter.conversationId ? [filter.conversationId] : [])),
        ...(checkpointDeletion?.conversationIds() ?? []),
      ]),
    ];
    /** Root deletion closes new child admission. Replay the plan to catch a task
     * admitted after the first pass but before that fence, extended with the cascade
     * this deletion reported. */
    if (cancellationPlan != null && deletedConversationIds.length > 0) {
      /** Confirm late children stopped before payload cleanup. A failed retry leaves
       * durable deletion intent available even though conversation deletion committed. */
      await retryPostDeleteCancellation(cancellationPlan, deletedConversationIds);
      await drainDeletedAgentGenerations(
        req.user.id,
        deletedConversationIds,
        cancellationPlan.leases
          .filter(
            (lease) =>
              deletedConversationIds.includes(lease.parentConversationId) ||
              deletedConversationIds.includes(lease.conversationId),
          )
          .map((lease) => lease.taskId),
        tenantId,
        checkpointDeletion,
      );
    } else if (deletedConversationIds.length > 0) {
      /** Owner-wide deletion drains lease-backed tasks before the cascade, but a
       * requires_action event actor has intentionally released its lease. Its durable
       * generation is still addressable by the deleted conversation id and must be
       * terminalized before its checkpoint is pruned. */
      await drainDeletedAgentGenerations(
        req.user.id,
        deletedConversationIds,
        [],
        tenantId,
        checkpointDeletion,
      );
    }
    deletedConversationIds = [
      ...new Set([...deletedConversationIds, ...(checkpointDeletion?.conversationIds() ?? [])]),
    ];
    if (checkpointDeletion != null) {
      await checkpointDeletion.cleanup();
    }
    if (filter.conversationId) {
      await Promise.all(deletedConversationIds.map((id) => db.deleteToolCalls(req.user.id, id)));
      await Promise.all(
        deletedConversationIds.map((id) => deleteConvoSharedLinksWithCleanup(req.user.id, id)),
      );
    }
    await checkpointDeletion?.acknowledge();
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.delete('/all', configMiddleware, async (req, res) => {
  try {
    const tenantId =
      typeof req.user.tenantId === 'string' && req.user.tenantId !== ''
        ? req.user.tenantId
        : undefined;
    const checkpointer = req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
    /** Fences new child admission for this owner, drains the live ones, and deletes
     * inside that fence: a child admitted on another replica mid-deletion would
     * otherwise keep running against conversations that no longer exist. */
    const fencedDeletion = await withAgentOwnerDeletionFence(
      req.user.id,
      tenantId,
      () => deleteOwnerConversationPersistence(req.user.id, {}, tenantId, checkpointer),
      () => deleteOwnerConversationPersistence(req.user.id, {}, tenantId, checkpointer),
    );
    const dbResponse = fencedDeletion.result;
    await db.deleteToolCalls(req.user.id);
    await deleteAllSharedLinksWithCleanup(req.user.id);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

/**
 * Archives or unarchives a conversation.
 * @route POST /archive
 * @param {string} req.body.arg.conversationId - The conversation ID to archive/unarchive.
 * @param {boolean} req.body.arg.isArchived - Whether to archive (true) or unarchive (false).
 * @returns {object} 200 - The updated conversation object.
 */
router.post('/archive', validateConvoAccess, async (req, res) => {
  const { conversationId, isArchived } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (typeof isArchived !== 'boolean') {
    return res.status(400).json({ error: 'isArchived must be a boolean' });
  }

  try {
    const dbResponse = await db.saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.resolvedConversation?.isTemporary,
        expiredAt: req?.resolvedConversation?.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      { conversationId, isArchived },
      {
        context: `POST /api/convos/archive ${conversationId}`,
        /** Filing a chat away is not activity: `updatedAt` stays the chat's own last
         * activity so unarchiving restores it to its real place in the date groups.
         * When it was archived is recorded separately, on `archivedAt`. */
        preserveUpdatedAt: true,
        /** Without timestamps, an upsert would insert a conversation that has none. */
        noUpsert: true,
      },
    );

    if (!dbResponse) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.status(200).json(dbResponse);
  } catch (error) {
    logger.error('Error archiving conversation', error);
    res.status(500).send('Error archiving conversation');
  }
});

/**
 * Archives every conversation currently visible to the user.
 * @route POST /archive/all
 * @returns {object} 200 - The number of conversations archived.
 */
router.post('/archive/all', archiveAllHandler);

router.post('/pin', validateConvoAccess, async (req, res) => {
  const { conversationId, pinned } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (pinned === undefined) {
    return res.status(400).json({ error: 'pinned is required' });
  }

  if (typeof pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be a boolean' });
  }

  try {
    const dbResponse = await db.setConvoPinned(req.user.id, conversationId, pinned);

    if (!dbResponse) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.status(200).json(dbResponse);
  } catch (error) {
    logger.error('Error pinning conversation', error);
    res.status(500).send('Error pinning conversation');
  }
});

router.post('/seen', validateConvoAccess, markConvoSeenHandler);

router.post('/unread', validateConvoAccess, markConvoUnreadHandler);

/** Maximum allowed length for conversation titles */
const MAX_CONVO_TITLE_LENGTH = 1024;

/**
 * Updates a conversation's title.
 * @route POST /update
 * @param {string} req.body.arg.conversationId - The conversation ID to update.
 * @param {string} req.body.arg.title - The new title for the conversation.
 * @returns {object} 201 - The updated conversation object.
 */
router.post('/update', validateConvoAccess, configMiddleware, async (req, res) => {
  const { conversationId, title } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (title === undefined) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }

  const sanitizedTitle = title.trim().slice(0, MAX_CONVO_TITLE_LENGTH);
  if (req.config?.filters != null) {
    const finding = inspectContent(extractConversationTitleContent({ title: sanitizedTitle }), {
      filters: req.config.filters,
    });
    if (finding != null) {
      return res.status(400).json(contentFilterBlockResponse(finding));
    }
  }

  try {
    const dbResponse = await db.saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.resolvedConversation?.isTemporary,
        expiredAt: req?.resolvedConversation?.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      { conversationId, title: sanitizedTitle },
      { context: `POST /api/convos/update ${conversationId}` },
    );
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error updating conversation', error);
    res.status(500).send('Error updating conversation');
  }
});

const { importIpLimiter, importUserLimiter } = createImportLimiters();
/** Fork and duplicate share one rate-limit budget (same "clone" operation class) */
const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
const importMaxFileSize = resolveImportMaxFileSize();
const upload = multer({
  storage: importStorage,
  fileFilter: importFileFilter,
  limits: { fileSize: importMaxFileSize },
});
const uploadSingle = upload.single('file');
const importJobs = new ImportJobStore(getLogStores(CacheKeys.IMPORT_JOBS));

/**
 * Imports running right now, per user. A run decompresses and JSON-parses a
 * whole shard, which peaks at several times the shard's size in heap, so
 * letting one account start its 50 uploaded archives at once is an OOM rather
 * than a slow import. Process-local by design: it bounds what a single node
 * will take on, which is exactly the resource being protected.
 */
const activeImports = new Map();
const MAX_CONCURRENT_IMPORTS_PER_USER = 1;
/**
 * Heavy import stages in flight across every user on this node. The per-user
 * map bounds what one account can start; it says nothing about aggregate work,
 * so twenty accounts each inside their own limit are still twenty concurrent
 * shard parses on one process. Inspection is counted with the runs because it
 * is the same cost in the same heap: it decompresses and JSON-parses the
 * whole export in the upload request to build the summary.
 */
const MAX_CONCURRENT_IMPORT_STAGES = resolveImportMaxConcurrency();
let activeImportStages = 0;
/**
 * `Retry-After` for a start that could not take the job's cross-replica claim.
 * Sized to the claim's own TTL (`IMPORT_JOB_LOCK_TTL`), which is the longest a
 * claim taken by a replica that then died can keep the job unstartable.
 */
const IMPORT_CLAIM_RETRY_AFTER_SECONDS = 60;
/** Minimum gap between job-store progress writes. The client polls every two
 * seconds, so anything below that is written for nobody to read. */
const PROGRESS_WRITE_INTERVAL_MS = 500;

function activeImportCount(userId) {
  return activeImports.get(userId) ?? 0;
}

function trackImportStart(userId) {
  activeImports.set(userId, activeImportCount(userId) + 1);
  activeImportStages += 1;
}

function trackImportEnd(userId) {
  releaseImportStage();
  const remaining = activeImportCount(userId) - 1;
  if (remaining > 0) {
    activeImports.set(userId, remaining);
    return;
  }
  activeImports.delete(userId);
}

function atImportCapacity() {
  return activeImportStages >= MAX_CONCURRENT_IMPORT_STAGES;
}

function releaseImportStage() {
  activeImportStages = Math.max(activeImportStages - 1, 0);
}

/**
 * Takes a node-wide import stage before multer reads the body. Checked after
 * the upload, a request at capacity has already streamed up to the upload limit
 * to disk before being told to retry, so the ceiling would protect the heap but
 * not the bandwidth or the temp volume it exists for.
 *
 * Until the import handler claims the stage, it is released when the response
 * closes, which covers a rejected or aborted upload and a request turned away
 * by a later middleware. Once claimed, only the handler releases it: a client
 * that drops the socket mid-inspection must not free a slot while the parse it
 * started is still holding the heap.
 */
function reserveImportStage(req, res, next) {
  if (atImportCapacity()) {
    res.status(429).json({ message: 'Too many imports are running, try again shortly' });
    return;
  }
  activeImportStages += 1;
  let held = true;
  let claimed = false;
  const release = () => {
    if (!held) {
      return;
    }
    held = false;
    releaseImportStage();
  };
  res.locals.importStage = {
    claim: () => {
      claimed = true;
      return release;
    },
  };
  res.on('close', () => {
    if (!claimed) {
      release();
    }
  });
  next();
}

function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File exceeds the maximum allowed size' });
    }
    if (err) {
      return res.status(typeof err.statusCode === 'number' ? err.statusCode : 400).json({
        message: sanitizeImportError(err, `Import upload rejected for user ${req.user?.id}`),
      });
    }
    next();
  });
}

/**
 * Existing `importedFrom.externalId` values already saved for this user, used
 * to skip conversations a prior (interrupted or re-run) import already wrote.
 * Scoped to the export's own source: a ChatGPT conversation id can never
 * collide with a Claude one, and treating them as one namespace would let one
 * provider's ids suppress the other's.
 * @param {string} userId
 * @param {string} source - `importedFrom.source` of the export being imported.
 * @returns {Promise<Set<string>>}
 */
async function loadExistingExternalIds(userId, source) {
  const Conversation = mongoose.models.Conversation;
  /** `_id: 0` is what makes this a covered query: without it Mongo fetches
   * every matching document off disk to read one 36-character string, which
   * for a user with 100k imported conversations is 50-200 MB of collection
   * reads and an equivalent eviction from the WiredTiger cache. The cursor
   * avoids materializing the whole result set before the Set is built. */
  const cursor = Conversation.find(
    { user: userId, 'importedFrom.source': source },
    { 'importedFrom.externalId': 1, _id: 0 },
  )
    .lean()
    .cursor();

  const ids = new Set();
  for await (const row of cursor) {
    const externalId = row.importedFrom?.externalId;
    if (externalId) {
      ids.add(externalId);
    }
  }
  return ids;
}

/**
 * The converter, endpoint and `importedFrom.source` a confirmed job needs,
 * derived from the summary `inspectExport` already recorded on it. Passing the
 * format through means `runImport` never re-reads a shard just to re-learn a
 * shape the inspect step already established.
 * @param {import('@librechat/api').ImportJob} job
 * @returns {{ format: string, endpoint: string, source: string }}
 */
function resolveJobTarget(job) {
  switch (job.summary?.source) {
    case 'claude':
      return { format: 'claude', endpoint: EModelEndpoint.anthropic, source: 'claude' };
    /** xAI has no first-class endpoint, so Grok conversations land on OpenAI;
     * see `GROK_ENDPOINT`, which this must stay in step with. */
    case 'grok':
      return { format: 'grok', endpoint: GROK_ENDPOINT, source: GROK_SOURCE };
    case 'chatgpt':
    case 'chatgpt-legacy':
      return { format: 'chatgpt', endpoint: EModelEndpoint.openAI, source: 'chatgpt' };
    /** Defaulting to chatgpt would be worse than failing: `source` also scopes
     * the already-imported id lookup, so a Claude archive that fell through
     * here would compare against the chatgpt namespace, find nothing, and
     * duplicate every conversation on each re-import. */
    default:
      throw new Error('Import job has no inspected summary');
  }
}

/**
 * Runs a confirmed import job to completion in the background, updating the
 * job record as it progresses. Never throws: failures are recorded on the job
 * itself so a polling client observes a `failed` phase instead of a dropped
 * connection. Every step (including building the storage strategy and
 * batch builder) runs inside the try/finally so a synchronous setup
 * failure still marks the job `failed` and still cleans up the temp file,
 * instead of leaving the job pinned at `phase: 'conversations'` forever.
 * @param {object} req - The Express request that created/confirmed the job.
 * @param {import('@librechat/api').ImportJob} job
 * @returns {Promise<void>}
 */
async function runImportJob(context, job) {
  const { userId, userRole, tenantId, appConfig } = context;
  try {
    /**
     * `sweepStaleTempUploads` deletes temp uploads by mtime alone, and the job
     * TTL matches its age cutoff, so a job confirmed just short of a day after
     * its upload would have its archive removed out from under the run. Marking
     * the file as touched when the run claims it restarts that clock, which is
     * the only signal the sweep can see.
     */
    await fs.promises.utimes(job.filepath, new Date(), new Date()).catch(() => undefined);

    /**
     * Both backends are resolved up front (a misconfigured strategy is a
     * setup failure that should fail the job immediately, not surface as a
     * per-asset error halfway through), but the choice between them is made
     * per asset. A deployment can point `fileStrategies.image` and
     * `fileStrategies.document` at different places, and an export mixes
     * images with audio, video, and PDFs; fixing `isImage: true` for the whole
     * archive put non-image attachments on the image backend, where the
     * deployment never meant them to live.
     */
    const imageSource = getFileStrategy(appConfig, { isImage: true });
    const documentSource = getFileStrategy(appConfig, { isImage: false });
    /**
     * `basePath` travels with the backend because the strategies default it to
     * `images`, and on the local strategy that base is `client/public/images`,
     * which is served statically with no auth unless `secureImageLinks` is on.
     * A PDF or audio attachment written there is anonymously retrievable by
     * URL, so non-images take the same `uploads` base every other document
     * upload in the app uses, reachable only through the file download route.
     */
    const imageBackend = {
      source: imageSource,
      fns: getStrategyFunctions(imageSource),
      basePath: 'images',
    };
    const documentBackend = {
      source: documentSource,
      fns: getStrategyFunctions(documentSource),
      basePath: 'uploads',
    };
    const backendFor = (type) =>
      (type ?? '').startsWith('image/') ? imageBackend : documentBackend;

    const saveBuffer = async ({ userId: owner, buffer, fileName, type, tenantId: tenant }) => {
      const backend = backendFor(type);
      const filepath = await backend.fns.saveBuffer({
        userId: owner,
        buffer,
        fileName,
        basePath: backend.basePath,
        tenantId: tenant,
      });
      return { filepath, source: backend.source };
    };

    /** The strategy's delete takes a request-shaped object for its paths and
     * owner; the background run has both on its snapshot. Used to release
     * assets no committed conversation claimed: a run cancelled between the
     * asset phase and the first conversation would otherwise leave every file
     * it created referenced by nothing and exempt from every sweep. */
    const storageContext = { config: appConfig, user: { id: userId, tenantId } };
    const releaseAsset = async (asset) => {
      await backendFor(asset.type).fns.deleteFile(storageContext, {
        ...asset,
        user: userId,
        tenantId,
      });
      await db.deleteFiles([asset.file_id], userId);
    };
    const batch = createImportBatchBuilder(
      userId,
      appConfig?.interfaceConfig,
      appConfig?.filters,
      appConfig?.messageFilter?.pii,
    );
    const target = resolveJobTarget(job);

    const defaultModel = await resolveImportDefaultModel({
      endpoint: target.endpoint,
      requestUserId: userId,
      userRole,
    });

    let lastProgressWrite = 0;
    let latestProgress = job.progress;
    const report = await runImport({
      filepath: job.filepath,
      userId,
      tenantId,
      /** The same deadline the builder stamps on this import's conversations
       * and messages, so an attachment expires with the chat that shows it. */
      expiredAt: batch.getRetentionFields().expiredAt,
      format: target.format,
      defaultModel,
      deps: { saveBuffer, createFile: db.createFile, deleteFile: releaseAsset },
      batch,
      existingExternalIds: await loadExistingExternalIds(userId, target.source),
      isCancelled: () => importJobs.isCancelled(userId, job.jobId),
      onProgress: async (progress) => {
        latestProgress = progress;
        /** Throttled because this fires once per conversation and once per
         * asset, and each call is a read and a write against the job store.
         * On a Redis-backed deployment a 10k-conversation import is tens of
         * thousands of serialized round trips, which at managed-Redis latency
         * costs more wall time than the import itself. The client polls on an
         * interval, so a sub-second write cadence is invisible to it. */
        const now = Date.now();
        if (now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) {
          return;
        }
        lastProgressWrite = now;
        try {
          await importJobs.patchProgress(userId, job.jobId, progress);
        } catch (error) {
          /** Progress is telemetry, not import state. A transient cache error
           * must not abort database or file work that is otherwise healthy. */
          logger.warn(
            `[import] Could not persist progress for job ${job.jobId} and user ${userId}`,
            error,
          );
        }
      },
      onPhase: async (phase) => {
        if (await importJobs.isCancelled(userId, job.jobId)) {
          return;
        }
        await importJobs.patch(userId, job.jobId, { phase });
      },
    });

    /**
     * `runImport` returns normally when the cancel flag breaks its loop, so
     * the completion patch has to check: a cancelled job keeps its
     * `cancelled` phase and only gains the partial report describing what
     * was already written.
     */
    const current = await importJobs.get(userId, job.jobId);
    if (current?.status === 'cancelled') {
      await importJobs.patch(userId, job.jobId, { report, progress: latestProgress });
      return;
    }

    await importJobs.patch(userId, job.jobId, {
      report,
      progress: latestProgress,
      phase: 'completed',
      status: 'completed',
    });
  } catch (error) {
    const message = sanitizeImportError(error, `Import job ${job.jobId} failed for user ${userId}`);
    /** The recovery patch is best-effort: it writes to the same store whose
     * unavailability is the likeliest reason we are in this catch, and a
     * rejection here would escape a function nobody awaits. */
    await importJobs
      .patch(userId, job.jobId, { phase: 'failed', status: 'failed', error: message })
      .catch((patchError) =>
        logger.error(`[runImportJob] Could not record the failure of job ${job.jobId}`, patchError),
      );
  } finally {
    trackImportEnd(userId);
    await fs.promises.unlink(job.filepath).catch(() => undefined);
  }
}

async function isZipUpload(filepath) {
  const handle = await fs.promises.open(filepath, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return (
      bytesRead === signature.length && signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    );
  } finally {
    await handle.close();
  }
}

/**
 * Imports a bare export synchronously through the old, un-jobbed importer.
 * Reached only for uploads that are neither a zip nor recognizable ChatGPT,
 * Claude or Grok content: `getImporter`, invoked inside `importConversations`,
 * detects ChatbotUI and LibreChat exports from their content.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
async function importLegacyConversation(req, res, filepath = req.file.path) {
  try {
    /* TODO: optimize to return imported conversations and add manually */
    await importConversations({
      filepath,
      requestUserId: req.user.id,
      userRole: req.user.role,
      interfaceConfig: req.config?.interfaceConfig,
      filters: req.config?.filters,
      ...(req.config?.messageFilter?.pii == null
        ? {}
        : { legacyPii: req.config.messageFilter.pii }),
    });
    res.status(201).json({ message: 'Conversation(s) imported successfully' });
  } catch (error) {
    if (isContentFilterError(error) || isConversationImportError(error)) {
      res.status(error.statusCode).json(error.body);
      return;
    }
    logger.error('Error processing file', error);
    res.status(500).send('Error processing file');
  }
}

async function importLegacyZip(req, res) {
  const extracted = await extractLegacyArchiveEntry(req.file.path);
  if (!extracted) {
    return false;
  }
  try {
    await importLegacyConversation(req, res, extracted.filepath);
  } finally {
    await extracted
      .cleanup()
      .catch((error) => logger.warn('[import] Could not remove extracted legacy archive', error));
  }
  return true;
}

/**
 * Imports a conversation export and saves it to the database.
 *
 * `.zip` uploads and bare ChatGPT, Claude and Grok exports share one pipeline:
 * `openArchive` wraps a non-zip file in a single-entry archive, so
 * `inspectExport` sees the same shape either way and this request only inspects
 * the upload and returns a summary awaiting confirmation; the actual import
 * runs after POST /import/jobs/:jobId/start. An unsupported export first tries
 * the bounded sole-JSON archive fallback, then the legacy synchronous importer
 * for bare JSON layouts.
 * @route POST /import
 * @param {Express.Multer.File} req.file - The uploaded export file.
 * @returns {object} 201 - legacy (non-ChatGPT) JSON import succeeded
 * @returns {object} 202 - archive inspected, job awaiting confirmation
 * @returns {object} 400 - the upload could not be read as any supported format
 */
router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  reserveImportStage,
  handleUpload,
  restoreTenantContextFromReq,
  async (req, res) => {
    const releaseStage = res.locals.importStage.claim();
    try {
      await handleImportUpload(req, res);
    } finally {
      releaseStage();
    }
  },
);

/**
 * Inspects an uploaded export and records a job awaiting confirmation, or runs
 * the legacy importer for a format the job pipeline does not take. Runs inside
 * the import stage `reserveImportStage` took for this request.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
async function handleImportUpload(req, res) {
  /** Multer leaves `req.file` undefined for a non-multipart body or a
   * multipart body with no `file` part, and reports neither as an error, so
   * without this the handler throws a TypeError and the client gets a 500
   * with no JSON message for what is plainly a bad request. */
  if (!req.file) {
    res.status(400).json({ message: 'No file uploaded' });
    return;
  }

  let inspected;

  try {
    inspected = await inspectExport(req.file.path);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unsupported import type') {
      try {
        if (await isZipUpload(req.file.path)) {
          if (await importLegacyZip(req, res)) {
            await fs.promises.unlink(req.file.path).catch(() => undefined);
            return;
          }
        } else {
          /** The bare legacy importer reads the upload in place, so the
           * temporary file has to be removed here: this branch returns
           * before the shared cleanup below. */
          try {
            await importLegacyConversation(req, res);
          } finally {
            await fs.promises.unlink(req.file.path).catch(() => undefined);
          }
          return;
        }
      } catch (legacyError) {
        logger.error('Error processing legacy import archive', legacyError);
      }
    }
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(400).json({
      message: sanitizeImportError(error, `Error inspecting import file for user ${req.user.id}`),
    });
    return;
  }

  try {
    const job = await importJobs.create({
      userId: req.user.id,
      filepath: req.file.path,
      filename: req.file.originalname,
    });
    const updated = await importJobs.patch(req.user.id, job.jobId, {
      summary: inspected.summary,
      phase: 'awaiting_confirmation',
    });
    await fs.promises.utimes(req.file.path, new Date(), new Date()).catch(() => undefined);
    res.status(202).json({ jobId: job.jobId, summary: updated.summary });
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    res.status(400).json({
      message: sanitizeImportError(error, `Error creating import job for user ${req.user.id}`),
    });
  }
}

/**
 * Confirms an inspected import job and starts running it in the background.
 * The phase transition out of `awaiting_confirmation` is atomic (see
 * `ImportJobStore.confirmStart`), so a second `/start` call for the same
 * job (a double-click, a client retry, a replay) never launches a
 * second background run over the same archive: `importedFrom` is not a
 * unique index (a deliberate choice, see Task 13), so a duplicate run
 * would otherwise duplicate conversations the first run has not yet
 * committed.
 *
 * That guarantee holds across replicas too: the transition takes a
 * `SET NX PX` claim on the shared job store, so of two replicas confirming the
 * same job one starts it and the other is told it is no longer awaiting
 * confirmation. A single-node deployment on the in-memory job store keeps the
 * in-process lock, which is the whole of what such a store can be shared by.
 *
 * The concurrency ceilings below are a separate matter and remain per node:
 * they bound the heap of the process enforcing them, so the aggregate ceiling
 * of a deployment is `replicas x CONVERSATION_IMPORT_MAX_CONCURRENT`. That is
 * a resource limit, not a correctness one, since each job now runs on exactly
 * one replica.
 *
 * No import limiter runs here. The upload request already consumed that
 * budget, and this confirmation is mandatory for every inspected job, so
 * charging the same limiter twice would reject the second half of an import
 * the first half was allowed to make. What bounds this route instead is the
 * job claim plus the two concurrency ceilings below.
 *
 * The archive itself stays on the disk of the replica that received the
 * upload, so a scaled deployment needs the upload and its confirmation to
 * reach the same replica: run the backend behind session affinity, or give
 * `uploads/temp` shared storage.
 * @route POST /import/jobs/:jobId/start
 * @returns {object} 202 - the job has started
 * @returns {object} 404 - no such job for this user
 * @returns {object} 409 - the job already started, completed, failed, or was cancelled
 * @returns {object} 503 - the shared job store could not hand out the claim, so
 *   the job is untouched and the client should retry
 */
router.post('/import/jobs/:jobId/start', configMiddleware, async (req, res) => {
  const userId = req.user.id;

  /** Both ceilings are process-local and checked before `confirmStart` writes
   * anything, so a rejection leaves the job exactly where it was and there is
   * no rollback write that could fail and strand it as `queued`. At capacity
   * the job is only read, so a replay of the import that is already running
   * still gets the honest 409 and an unknown job its 404. */
  const atUserLimit = activeImportCount(userId) >= MAX_CONCURRENT_IMPORTS_PER_USER;
  if (atUserLimit || atImportCapacity()) {
    const job = await importJobs.get(userId, req.params.jobId);
    if (!job) {
      res.status(404).json({ message: 'Import job not found' });
      return;
    }
    if (job.phase !== 'awaiting_confirmation') {
      res.status(409).json({ message: 'Import job is not awaiting confirmation' });
      return;
    }
    res.status(429).json({
      message: atUserLimit
        ? 'Another import is already running'
        : 'Too many imports are running, try again shortly',
    });
    return;
  }

  /** Reserved synchronously, before the first await, so two confirmations on
   * this node cannot both pass the check above. Released unless the job
   * actually starts, in which case the run's own `trackImportEnd` owns it. */
  trackImportStart(userId);
  let started = false;
  try {
    const result = await importJobs.confirmStart(userId, req.params.jobId);

    if (result.status === 'not_found') {
      res.status(404).json({ message: 'Import job not found' });
      return;
    }
    /** A replay of the job that is already running lands here: it has left
     * `awaiting_confirmation`, so the honest answer is that it already started. */
    if (result.status === 'conflict') {
      res.status(409).json({ message: 'Import job is not awaiting confirmation' });
      return;
    }
    /** The shared store could not hand out the job's claim, so this replica
     * cannot prove it is the only one confirming. Nothing was written: the job
     * is still awaiting confirmation, so this is retryable rather than a
     * failure of the job itself, and the client's retry starts it once the
     * store recovers. */
    if (result.status === 'lock_unavailable') {
      res.set('Retry-After', String(IMPORT_CLAIM_RETRY_AFTER_SECONDS));
      res.status(503).json({ message: 'Import service is busy, try again shortly' });
      return;
    }

    startImportJob(req, res, result.job);
    started = true;
  } finally {
    if (!started) {
      trackImportEnd(userId);
    }
  }
});

/**
 * Responds to a confirmed start and launches the background run, which owns
 * the import slot `trackImportStart` reserved from here on.
 * @param {object} req
 * @param {object} res
 * @param {object} job - the job `confirmStart` moved out of confirmation
 * @returns {void}
 */
function startImportJob(req, res, job) {
  /** Everything the background run needs, read while the request is still
   * the thing being handled. Holding `req` instead would pin the socket and
   * its buffers for the length of a multi-minute import, per concurrent job. */
  const context = {
    userId: req.user.id,
    userRole: req.user.role,
    tenantId: req.user.tenantId,
    appConfig: req.config,
  };

  res.status(202).json({ jobId: job.jobId });

  /** Detached on purpose, so the terminal catch is the only thing standing
   * between a rejection in the run's own error handling and an unhandled
   * rejection in a process that serves live chat streams. */
  runImportJob(context, job).catch((error) => {
    logger.error(`[startImportJob] Background import job ${job.jobId} crashed`, error);
  });
}

/**
 * Returns the status of an import job. `filepath` and `userId` are always
 * stripped: the former is a server filesystem path that must never reach a
 * client, and the latter is redundant once the route is scoped to `req.user.id`.
 * @route GET /import/jobs/:jobId
 * @returns {object} 200 - the job status
 * @returns {object} 404 - no such job for this user (also returned once the
 *   job's TTL has expired, since an expired job is indistinguishable from one
 *   that never existed; a polling client should treat both as "stop polling"
 *   rather than hang waiting for a state that will never arrive)
 */
router.get('/import/jobs/:jobId', async (req, res) => {
  const job = await importJobs.get(req.user.id, req.params.jobId);
  if (!job) {
    res.status(404).json({ message: 'Import job not found' });
    return;
  }
  const { filepath: _filepath, userId: _userId, ...safe } = job;
  res.status(200).json(safe);
});

/**
 * Cancels an import job. The temporary upload is removed here only for a
 * job that never started: once `runImportJob` owns the archive its
 * `finally` removes it, and deleting the file out from under a running
 * import turns a clean cancellation into an `ENOENT` failure.
 * @route DELETE /import/jobs/:jobId
 * @returns {object} 200 - the job was cancelled
 * @returns {object} 404 - no such job for this user
 * @returns {object} 503 - the shared job store could not hand out the claim,
 *   so the job and upload are untouched and the client should retry
 */
router.delete('/import/jobs/:jobId', async (req, res) => {
  const job = await importJobs.get(req.user.id, req.params.jobId);
  if (!job) {
    res.status(404).json({ message: 'Import job not found' });
    return;
  }
  const { status, previousPhase } = await importJobs.cancel(req.user.id, job.jobId);
  if (status === 'lock_unavailable') {
    res.set('Retry-After', String(IMPORT_CLAIM_RETRY_AFTER_SECONDS));
    res.status(503).json({ message: 'Import service is busy, try again shortly' });
    return;
  }
  if (status === 'not_found') {
    res.status(404).json({ message: 'Import job not found' });
    return;
  }
  if (previousPhase === 'awaiting_confirmation') {
    await fs.promises.unlink(job.filepath).catch(() => undefined);
  }
  res.status(200).json({ jobId: job.jobId });
});

/**
 * POST /fork
 * This route handles forking a conversation based on the TForkConvoRequest and responds with TForkConvoResponse.
 * @route POST /fork
 * @param {express.Request<{}, TForkConvoResponse, TForkConvoRequest>} req - Express request object.
 * @param {express.Response<TForkConvoResponse>} res - Express response object.
 * @returns {Promise<void>} - The response after forking the conversation.
 */
router.post('/fork', forkIpLimiter, forkUserLimiter, configMiddleware, async (req, res) => {
  try {
    /** @type {TForkConvoRequest} */
    const { conversationId, messageId, option, splitAtTarget, latestMessageId } = req.body;
    const result = await forkConversation({
      requestUserId: req.user.id,
      originalConvoId: conversationId,
      targetMessageId: messageId,
      latestMessageId,
      records: true,
      splitAtTarget,
      option,
      interfaceConfig: req.config?.interfaceConfig,
      filters: req.config?.filters,
      ...(req.config?.messageFilter?.pii == null
        ? {}
        : { legacyPii: req.config.messageFilter.pii }),
    });

    res.json(result);
  } catch (error) {
    if (isContentFilterError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    if (isConversationImportError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    logger.error('Error forking conversation:', error);
    res.status(500).send('Error forking conversation');
  }
});

router.post(
  '/duplicate',
  forkIpLimiter,
  forkUserLimiter,
  configMiddleware,
  filterConversationTitle,
  async (req, res) => {
    const { conversationId, title } = req.body;

    try {
      const result = await duplicateConversation({
        userId: req.user.id,
        conversationId,
        title,
        interfaceConfig: req.config?.interfaceConfig,
        filters: req.config?.filters,
        ...(req.config?.messageFilter?.pii == null
          ? {}
          : { legacyPii: req.config.messageFilter.pii }),
      });
      res.status(201).json(result);
    } catch (error) {
      if (isContentFilterError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      if (isConversationImportError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      logger.error('Error duplicating conversation:', error);
      res.status(500).send('Error duplicating conversation');
    }
  },
);

module.exports = router;
