const archiveAllHandler = jest.fn();
const generationJobManager = {
  getCleanupJob: jest.fn().mockResolvedValue(null),
  abortJob: jest.fn().mockResolvedValue({ success: true }),
  getCleanupBlockingJobIdsForUser: jest.fn().mockResolvedValue([]),
  getCleanupBlockingJobIdsForConversations: jest.fn().mockResolvedValue([]),
};
const subagentActivityHandlerInputs = [];
const moderatedTexts = [];
const moderateText = jest.fn((req, _res, next) => {
  moderatedTexts.push(req.body?.text);
  next();
});
const messageIpLimiter = jest.fn((_req, _res, next) => next());
const messageUserLimiter = jest.fn((_req, _res, next) => next());
const checkpointRows = [];
const deleteAgentCheckpoints = jest.fn(async (threadIds = []) => {
  for (let index = checkpointRows.length - 1; index >= 0; index -= 1) {
    if (threadIds.includes(checkpointRows[index].threadId)) {
      checkpointRows.splice(index, 1);
    }
  }
});
const ownerPrefix = (userId, tenantId) =>
  `lcg:v2:${require('crypto')
    .createHash('sha256')
    .update(JSON.stringify([tenantId ?? null, userId]))
    .digest('hex')}:`;
const deleteOwnedAgentCheckpoints = jest.fn(async (userId, tenantId, threadIds) => {
  for (let index = checkpointRows.length - 1; index >= 0; index -= 1) {
    const row = checkpointRows[index];
    if (
      (threadIds == null || threadIds.includes(row.threadId)) &&
      row.checkpointNamespace.startsWith(ownerPrefix(userId, tenantId))
    ) {
      checkpointRows.splice(index, 1);
    }
  }
});
const deletionTargets = new Map();
const openCheckpointDeletion = jest.fn(async (userId, tenantId, root, cfg) => {
  const key = JSON.stringify([userId, tenantId, root]);
  const ids = deletionTargets.get(key) ?? new Set();
  deletionTargets.set(key, ids);
  return {
    conversationIds: () => [...ids],
    remember: async (targets) => targets.forEach((id) => ids.add(id)),
    cleanup: async () =>
      deleteOwnedAgentCheckpoints(userId, tenantId, root == null ? undefined : [...ids], cfg),
    acknowledge: async () => deletionTargets.delete(key),
  };
});

function resetCheckpointRows(rows = []) {
  checkpointRows.splice(0, checkpointRows.length, ...rows);
  deletionTargets.clear();
}

module.exports = {
  archiveAllHandler,
  ownerPrefix,
  generationJobManager,
  subagentActivityHandlerInputs,
  moderateText,
  moderatedTexts,
  messageIpLimiter,
  messageUserLimiter,
  checkpointRows,
  resetCheckpointRows,

  agents: () => ({ sleep: jest.fn() }),

  api: (overrides = {}) => ({
    /** Mirrors the real helper so query-flag parsing (`isArchived`, `pinned`) is exercised. */
    isEnabled: jest.fn((value) => {
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'string') {
        return value.toLowerCase().trim() === 'true';
      }
      return false;
    }),
    /** Mirrors the real helper so the route's page-size clamping is exercised. */
    normalizeLimit: jest.fn((value, { fallback = 25, max = 100 } = {}) => {
      const raw = Array.isArray(value) ? value[0] : value;
      const limit = parseInt(typeof raw === 'string' ? raw : '', 10);
      if (!Number.isFinite(limit)) {
        return fallback;
      }
      return Math.min(Math.max(limit, 1), max);
    }),
    /** Mirrors the real whitelist and helpers so the route's sort normalization is exercised. */
    CONVERSATION_SORT_FIELDS: {
      title: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
    },
    normalizeSortField: jest.fn((value, { fields, fallback }) => {
      const raw = Array.isArray(value) ? value[0] : value;
      return typeof raw === 'string' && fields[raw] === true ? raw : fallback;
    }),
    normalizeSortDirection: jest.fn((value, { fallback = 'desc' } = {}) => {
      const raw = Array.isArray(value) ? value[0] : value;
      return raw === 'asc' || raw === 'desc' ? raw : fallback;
    }),
    resolveImportMaxFileSize: jest.fn(() => 262144000),
    createAxiosInstance: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    })),
    logAxiosError: jest.fn(),
    restoreTenantContextFromReq: jest.fn((req, res, next) => next()),
    createArchiveAllHandler: jest.fn(({ archiveAllConvos }) => {
      archiveAllHandler.mockImplementation(async (req, res) => {
        const result = await archiveAllConvos(req.user.id);
        return res.status(200).json(result);
      });
      return archiveAllHandler;
    }),
    createSubagentThreadViewHandler: jest.fn(() => (_req, res) => res.status(200).json({})),
    createSubagentControlHandler: jest.fn(() => (_req, res) => res.status(200).json({})),
    createBackgroundTaskIndexHandler: jest.fn(
      () => (_req, res) => res.status(200).json({ tasks: [] }),
    ),
    createBackgroundTaskPolicyMiddleware: jest.fn(() => (_req, _res, next) => next()),
    createBackgroundTaskCancelHandler: jest.fn(
      () => (_req, res) => res.status(200).json({ results: [] }),
    ),
    isValidSubagentControlRequest: jest.fn((body) => {
      if (body == null || typeof body !== 'object') return false;
      const commonKeys = ['taskId', 'invocationId', 'action'];
      let allowedKeys = [...commonKeys, 'message'];
      if (body.action === 'cancel_message') allowedKeys = [...commonKeys, 'controlId'];
      if (body.action === 'cancel') allowedKeys = commonKeys;
      if (Object.keys(body).some((key) => !allowedKeys.includes(key))) return false;
      if (typeof body.taskId !== 'string' || body.taskId.length === 0 || body.taskId.length > 256) {
        return false;
      }
      if (
        typeof body.invocationId !== 'string' ||
        body.invocationId.length === 0 ||
        body.invocationId.length > 128
      ) {
        return false;
      }
      if (body.action === 'cancel') return true;
      if (body.action === 'cancel_message') {
        return typeof body.controlId === 'string' && body.controlId.length > 0;
      }
      return (
        ['steer', 'queue', 'interrupt'].includes(body.action) &&
        typeof body.message === 'string' &&
        body.message.trim() !== '' &&
        body.message.length <= 4 * 1024
      );
    }),
    exemptAgentTriggerFromIpLimiter: jest.fn(() => false),
    createParentSubagentIndexHandler: jest.fn(
      () => (_req, res) => res.status(200).json({ threads: [] }),
    ),
    GenerationJobManager: generationJobManager,
    waitForGenerationPersistence: jest.requireActual(
      '../../../../packages/api/src/stream/persistence.ts',
    ).waitForGenerationPersistence,
    isStopConfirmed: jest.fn(
      (result) => result?.success === true || result?.failureReason === 'already_settled',
    ),
    createSubagentActivityStreamHandler: jest.fn((deps, stream) => {
      subagentActivityHandlerInputs.push({ deps, stream });
      return (_req, res) => res.status(200).end();
    }),
    deleteConvoSharedLinksWithCleanup: jest.fn(),
    deleteAllSharedLinksWithCleanup: jest.fn(),
    deleteAgentCheckpoints,
    deleteOwnedAgentCheckpoints,
    openCheckpointDeletion,
    isConversationImportError: jest.fn((error) => error?.name === 'ConversationImportError'),
    ...overrides,
  }),

  dataSchemas: () => ({
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    createModels: jest.fn(() => ({
      User: {},
      Conversation: {},
      Message: {},
      SharedLink: {},
    })),
  }),

  dataProvider: (overrides = {}) => ({
    CacheKeys: { GEN_TITLE: 'GEN_TITLE' },
    EModelEndpoint: {
      azureAssistants: 'azureAssistants',
      assistants: 'assistants',
    },
    ...overrides,
  }),

  conversationModel: () => ({
    getConvosByCursor: jest.fn(),
    getConvo: jest.fn(),
    deleteConvos: jest.fn(),
    deleteMessages: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    saveConvo: jest.fn(),
  }),

  toolCallModel: () => ({ deleteToolCalls: jest.fn() }),

  sharedModels: () => ({
    getConvosByCursor: jest.fn(),
    getConvo: jest.fn(),
    deleteConvos: jest.fn(),
    deleteMessages: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    archiveAllConvos: jest.fn(),
    saveConvo: jest.fn(),
    setConvoPinned: jest.fn(),
    deleteAllSharedLinks: jest.fn(),
    deleteConvoSharedLink: jest.fn(),
    deleteToolCalls: jest.fn(),
  }),

  requireJwtAuth: () => (req, res, next) => next(),

  middlewarePassthrough: () => ({
    createImportLimiters: jest.fn(() => ({
      importIpLimiter: (req, res, next) => next(),
      importUserLimiter: (req, res, next) => next(),
    })),
    createForkLimiters: jest.fn(() => ({
      forkIpLimiter: (req, res, next) => next(),
      forkUserLimiter: (req, res, next) => next(),
    })),
    configMiddleware: (req, res, next) => next(),
    moderateText,
    messageIpLimiter,
    messageUserLimiter,
    validateConvoAccess: (req, res, next) => next(),
  }),

  forkUtils: () => ({
    forkConversation: jest.fn(),
    duplicateConversation: jest.fn(),
  }),

  importUtils: () => ({ importConversations: jest.fn() }),

  logStores: () => jest.fn(),

  multerSetup: () => ({
    storage: {},
    importFileFilter: jest.fn(),
  }),

  multerLib: () =>
    jest.fn(() => ({
      single: jest.fn(() => (req, res, next) => {
        req.file = { path: '/tmp/test-file.json' };
        next();
      }),
    })),

  assistantEndpoint: () => ({ initializeClient: jest.fn() }),

  subagentThreadStore: () => ({
    subscribeActivity: jest.fn(),
    cancelAndDrainForOwner: jest.fn().mockResolvedValue(undefined),
    withOwnerDeletionFence: jest.fn().mockImplementation(async (_userId, _tenantId, deletion) => {
      return deletion();
    }),
    planCancellationForConversations: jest
      .fn()
      .mockImplementation(async (userId, conversationIds, tenantId) => ({
        userId,
        tenantId,
        conversationIds: [...conversationIds],
        scopes: [],
        leases: [],
      })),
    cancelPlan: jest.fn().mockResolvedValue(0),
    cancelForOwner: jest.fn(),
  }),
};
