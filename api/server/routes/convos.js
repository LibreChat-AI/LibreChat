const multer = require('multer');
const express = require('express');
const { sleep } = require('@librechat/agents');
const {
  reportLocatorTraversalFailure,
  isEnabled,
  normalizeLimit,
  normalizeSortDirection,
  normalizeSortField,
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
  resolveImportMaxFileSize,
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
const { getAppConfig } = require('~/server/services/Config/app');
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
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { storage, importFileFilter } = require('~/server/routes/files/multer');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { importConversations } = require('~/server/utils/import');
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
  storage,
  fileFilter: importFileFilter,
  limits: { fileSize: importMaxFileSize },
});
const uploadSingle = upload.single('file');

function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File exceeds the maximum allowed size' });
    }
    if (err) {
      return next(err);
    }
    next();
  });
}

/**
 * Imports a conversation from a JSON file and saves it to the database.
 * @route POST /import
 * @param {Express.Multer.File} req.file - The JSON file to import.
 * @returns {object} 201 - success response - application/json
 */
router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  handleUpload,
  restoreTenantContextFromReq,
  async (req, res) => {
    try {
      /* TODO: optimize to return imported conversations and add manually */
      await importConversations({
        filepath: req.file.path,
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
      if (isContentFilterError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      if (isConversationImportError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      logger.error('Error processing file', error);
      res.status(500).send('Error processing file');
    }
  },
);

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
