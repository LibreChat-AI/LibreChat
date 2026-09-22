const { EventEmitter } = require('events');

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  isRedis: false,
  detachedAgentEventActionStoreMode: 'process_local',
  supportsDetachedAgentEventActions: true,
  createJob: jest.fn(),
  getJob: jest.fn(),
  emitError: jest.fn(),
  emitChunk: jest.fn(),
  emitDone: jest.fn(),
  claimTerminalJob: jest.fn(),
  publishTerminalClaim: jest.fn(),
  finishTerminalJob: jest.fn(),
  completeJob: jest.fn(),
  beginProviderExecution: jest.fn(),
  markProviderExecutionDrained: jest.fn(),
  failPausePersistence: jest.fn(),
  getResumeState: jest.fn(),
  getJobStore: jest.fn(),
  updateMetadata: jest.fn(),
  persistAgentEventDetachedTerminalEvidence: jest.fn(),
  claimGeneration: jest.fn(),
  resumeClaimedGeneration: jest.fn(),
  takeoverGeneration: jest.fn(),
  releaseGeneration: jest.fn(),
  hasJob: jest.fn(),
  approvals: {
    ownsPausePersistence: jest.fn(),
    finishPausePersistence: jest.fn(),
  },
  steering: {
    closeAndDrain: jest.fn(),
    park: jest.fn(),
    consumeRecovered: jest.fn(),
  },
};

const DEFAULT_OWNED_CLAIM = Object.freeze({
  streamId: 'conversation-123',
  conversationId: 'conversation-123',
  claimedAt: 100,
  claimToken: 'claim-token',
});

function wonGenerationClaim(overrides = {}) {
  return { claimed: true, existing: { ...DEFAULT_OWNED_CLAIM, ...overrides } };
}

const mockCheckAndIncrementPendingRequest = jest.fn();
const mockGetFailedTurnTraceFields = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockGetViolationInfo = jest.fn(() => ({
  type: 'concurrent',
  limit: 2,
  pendingRequests: 3,
  score: 1,
}));
const mockFilterPersistableAbortContent = jest.fn((content) =>
  content.filter((part) => part?.type !== 'tool_call'),
);
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockStampConvoLastResponse = jest.fn().mockResolvedValue(undefined);
const mockSaveMessage = jest.fn();
const mockSaveConvo = jest.fn();
const mockAppendConvoMessageReference = jest.fn();
const mockIsAgentTriggerPrincipalActive = jest.fn();
const mockIsSubagentOwnerAdmissible = jest.fn();
const mockAcquireEventChildGenerationLease = jest.fn();
const mockIsScheduleFireRequest = jest.fn();
const mockExemptFromConcurrencyLimiter = jest.fn();
const mockRecordScheduleOutcome = jest.fn();
const mockIsScheduleLive = jest.fn();
const mockDeleteAgentCheckpoint = jest.fn();
const mockSettleAgentQueuedTurnExecutionAdmission = jest.fn();
const mockVerifyAgentQueuedTurnExecutionAdmission = jest.fn();
const mockExecuteAgentEventActor = jest.fn();
const mockResumeAgentEventActor = jest.fn();
const mockCreateAgentEventActorTurn = jest.fn((input, dependencies) => {
  let historyToken;
  let historyOwner;
  return {
    run: async () => {
      if (input.strategy === 'checkpoint') {
        const result =
          input.checkpoint.kind === 'resume'
            ? await mockResumeAgentEventActor(input.checkpoint.input, dependencies.actor)
            : await mockExecuteAgentEventActor(input.checkpoint.input, dependencies.actor);
        return { adapter: 'checkpoint', ...result };
      }
      const token = 'event-actor-history-token';
      const acquired = await dependencies.history.begin({ ...input.history.owner, token });
      if (!acquired) {
        throw Object.assign(new Error('The event actor is temporarily unavailable'), {
          code: 'EVENT_ACTOR_NOT_READY',
          status: 409,
        });
      }
      historyToken = token;
      historyOwner = input.history.owner;
      try {
        await input.history.persistToken(token);
      } catch (error) {
        historyToken = undefined;
        historyOwner = undefined;
        await dependencies.history.complete({ ...input.history.owner, token });
        throw error;
      }
      return { adapter: 'history', value: await input.history.invoke() };
    },
    historyPersisted: async () => {
      if (historyToken == null) {
        return;
      }
      const token = historyToken;
      historyToken = undefined;
      await dependencies.history.complete({ ...historyOwner, token });
    },
  };
});
const mockCreateAgentEventActorDetachedActionLifecycle = jest.fn(() => undefined);
const mockFindAgentEventAppliedAction = jest.fn();
const mockResolveAgentTurnExecutionPlan = jest.fn((input) => {
  let origin = 'user';
  if (input.isSchedule) {
    origin = 'schedule';
  } else if (input.isEvent || input.event) {
    origin = 'event';
  }
  const checkpointCompatible =
    input.event?.binding != null &&
    input.event?.expectedAction != null &&
    input.checkpointerType !== 'memory' &&
    (!input.canPause || input.durableEventActorSuspensions);
  let strategy = 'history';
  if (input.isNewConversation) {
    strategy = 'fresh';
  } else if (checkpointCompatible) {
    strategy = 'checkpoint';
  }
  return {
    origin,
    strategy,
    conversationId: input.conversationId,
    parentMessageId: input.parentMessageId,
    canPause: input.canPause,
    expectedAction: input.event?.expectedAction,
    binding: input.event?.binding,
  };
});
/** Faithful stand-in for the graph-context action recorder: first observed
 * tool end with a name becomes the receipt. Matching fences are unit-tested
 * against the real implementation in packages/api. */
const mockCreateAgentEventActionRecorder = jest.fn(() => {
  let receipt;
  return {
    observeToolEnd: (data) => {
      if (receipt == null && data?.output?.name != null) {
        receipt = {
          toolName: data.output.name,
          ...(data.output.tool_call_id == null ? {} : { toolCallId: data.output.tool_call_id }),
        };
      }
    },
    read: () => receipt,
  };
});
const mockGetAgentEventActorSnapshot = jest.fn();
const mockCommitAgentEventActorState = jest.fn();
const mockBeginAgentEventActorLegacyTurn = jest.fn();
const mockCompleteAgentEventActorLegacyTurn = jest.fn();
const mockRecordAgentEventActorReconciliation = jest.fn();
const mockResolveAgentEventActorReconciliation = jest.fn();
const mockClearAgentEventActorReconciliation = jest.fn();
const mockAdmitAgentEventActorAction = jest.fn();
const mockReleaseAgentEventActorAction = jest.fn();
const mockHasAgentEventActorActionAdmission = jest.fn();
const mockGetAgentEventActorReceipt = jest.fn();
const mockGetAgentEventActorDetachedAction = jest.fn();
const mockClaimAgentEventActorSuspension = jest.fn();
const mockSettleAgentEventActorSuspension = jest.fn();
const mockStartupTelemetry = {
  mark: jest.fn(),
  setStreamId: jest.fn(),
  recordGenerationEvent: jest.fn(),
  end: jest.fn(),
};
const mockGetAgentStartupTelemetry = jest.fn(() => mockStartupTelemetry);
const mockAcceptAgentStartupTelemetry = jest.fn();
let mockMCPContexts = new WeakMap();

const mockCreateMCPRequestContext = jest.fn(() => ({
  connections: new Map(),
  pending: new Map(),
  cleanupStarted: false,
  cleanupOnResponse: false,
  responseCleanupAttached: false,
}));
const mockGetMCPRequestContext = jest.fn((req) => {
  if (!req) {
    return undefined;
  }

  let context = mockMCPContexts.get(req);
  if (!context) {
    context = mockCreateMCPRequestContext();
    mockMCPContexts.set(req, context);
  }

  return context.cleanupStarted ? undefined : context;
});
const mockCleanupMCPRequestContext = jest.fn(async (context) => {
  if (!context || context.cleanupStarted) {
    return;
  }

  context.cleanupStarted = true;
  const connections = new Set(context.connections.values());
  const settled = await Promise.allSettled(context.pending.values());
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      connections.add(result.value);
    }
  }

  await Promise.allSettled(Array.from(connections).map((connection) => connection.disconnect?.()));
  context.connections.clear();
  context.pending.clear();
});
const mockCleanupMCPRequestContextForReq = jest.fn(async (req) => {
  const context = mockMCPContexts.get(req);
  if (!context) {
    return;
  }

  try {
    await mockCleanupMCPRequestContext(context);
  } finally {
    mockMCPContexts.delete(req);
  }
});

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  /** Real, because whether a skipped-persistence turn may raise an indicator is under test. */
  isAnnounceableReply: jest.requireActual('@librechat/api').isAnnounceableReply,
  announceReply: jest.requireActual('@librechat/api').announceReply,
  announceErrorTurn: jest.requireActual('@librechat/api').announceErrorTurn,
  resolvePersistedReasoningOverride:
    jest.requireActual('@librechat/api').resolvePersistedReasoningOverride,
  logAgentMemorySnapshot: jest.fn(),
  isScheduleFireRequest: (...args) => mockIsScheduleFireRequest(...args),
  exemptFromConcurrencyLimiter: (...args) => mockExemptFromConcurrencyLimiter(...args),
  toPendingSteer: jest.fn((item) => item),
  /** Recorded onto the job so the steer route can honour the OWNING replica's
   *  seal capability rather than its own probe. */
  isSteerPreemptSupported: jest.fn(() => true),
  isSteerTerminalContinuationSupported: jest.fn(() => false),
  buildRecoveredSteerPayload: jest.fn((text, files) => {
    if (typeof text !== 'string' || (files != null && !Array.isArray(files))) {
      return null;
    }
    const fileIds = [...new Set((files ?? []).map((file) => file?.file_id))];
    if (fileIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return null;
    }
    return { text, fileIds: fileIds.sort() };
  }),
  getViolationInfo: (...args) => mockGetViolationInfo(...args),
  buildMessageFiles: jest.fn(() => []),
  resolveTitleTiming: jest.fn(() => 'immediate'),
  createConvoPersistenceSignal: jest.requireActual('@librechat/api').createConvoPersistenceSignal,
  recoverTurnMessageReference: jest.requireActual('@librechat/api').recoverTurnMessageReference,
  resolveConversationAnchor: jest.requireActual('@librechat/api').resolveConversationAnchor,
  resolveRunCodeWorkspaces: jest.requireActual('@librechat/api').resolveRunCodeWorkspaces,
  AttachmentStorageError: jest.requireActual('@librechat/api').AttachmentStorageError,
  encodeAndFormatImages: jest.requireActual('@librechat/api').encodeAndFormatImages,
  getCodeWorkspaceSelectionErrorDetails:
    jest.requireActual('@librechat/api').getCodeWorkspaceSelectionErrorDetails,
  shouldPersistCodeWorkspaceInitializationError:
    jest.requireActual('@librechat/api').shouldPersistCodeWorkspaceInitializationError,
  resolvePersistableCodeEnvironmentDecision: (...args) =>
    jest.requireActual('@librechat/api').resolvePersistableCodeEnvironmentDecision(...args),
  getSafeErrorMetadata: jest.requireActual('@librechat/api').getSafeErrorMetadata,
  getSafeErrorText: jest.requireActual('@librechat/api').getSafeErrorText,
  resolveFailedTurnContent: jest.requireActual('@librechat/api').resolveFailedTurnContent,
  getFailedTurnTraceFields: (...args) => mockGetFailedTurnTraceFields(...args),
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn((quotes) => {
    if (!Array.isArray(quotes)) {
      return null;
    }
    const normalized = quotes
      .filter((quote) => typeof quote === 'string' && quote.trim().length > 0)
      .map((quote) => quote.trim());
    return normalized.length > 0 ? normalized : null;
  }),
  cleanupMCPRequestContext: (...args) => mockCleanupMCPRequestContext(...args),
  createMCPRequestContext: (...args) => mockCreateMCPRequestContext(...args),
  getMCPRequestContext: (...args) => mockGetMCPRequestContext(...args),
  filterPersistableAbortContent: (...args) => mockFilterPersistableAbortContent(...args),
  cleanupMCPRequestContextForReq: (...args) => mockCleanupMCPRequestContextForReq(...args),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  getAgentStartupTelemetry: (...args) => mockGetAgentStartupTelemetry(...args),
  acceptAgentStartupTelemetry: (...args) => mockAcceptAgentStartupTelemetry(...args),
  isUnpersistedPreliminaryParent: async ({
    userId,
    conversationId,
    parentMessageId,
    getMessages,
  }) => {
    if (typeof parentMessageId !== 'string' || !parentMessageId.endsWith('_')) {
      return false;
    }

    const filter = { user: userId, messageId: parentMessageId };
    if (conversationId && conversationId !== 'new') {
      filter.conversationId = conversationId;
    }

    const messages = await getMessages(filter, '_id');
    return messages.length === 0;
  },
  deleteAgentCheckpoint: (...args) => mockDeleteAgentCheckpoint(...args),
  createAgentEventActorTurn: (...args) => mockCreateAgentEventActorTurn(...args),
  createAgentEventActorDetachedActionLifecycle: (...args) =>
    mockCreateAgentEventActorDetachedActionLifecycle(...args),
  parseAgentEventActorDetachedCompletion: (value) => (value?.version === 1 ? value : undefined),
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE: 'librechat-event-actor',
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE: 'librechat.event_actor.detached_completion',
  findAgentEventAppliedAction: (...args) => mockFindAgentEventAppliedAction(...args),
  createAgentEventActionRecorder: (...args) => mockCreateAgentEventActionRecorder(...args),
  resolveAgentTurnExecutionPlan: (...args) => mockResolveAgentTurnExecutionPlan(...args),
  isHITLEnabled: (policy) => policy?.enabled === true,
  agentRequestsAskUserQuestion: (agent) =>
    agent?.toolDefinitions?.some((tool) => tool?.name === 'ask_user_question') === true,
  isAgentEventRetentionActive: (expiredAt) =>
    expiredAt == null || new Date(expiredAt).getTime() > Date.now(),
  createMCPRuntimeRequestBody: ({
    messageId,
    conversationId,
    parentMessageId,
    codeEnvironmentMode,
    codeWorkspaces,
  }) => ({
    messageId,
    conversationId,
    parentMessageId,
    ...(codeEnvironmentMode !== undefined ? { codeEnvironmentMode } : {}),
    ...(codeWorkspaces !== undefined ? { codeWorkspaces } : {}),
  }),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: {
    set: jest.fn(),
  },
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(() => Promise.resolve()),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
  appendConvoMessageReference: (...args) => mockAppendConvoMessageReference(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
  getAgentEventActorSnapshot: (...args) => mockGetAgentEventActorSnapshot(...args),
  commitAgentEventActorState: (...args) => mockCommitAgentEventActorState(...args),
  beginAgentEventActorLegacyTurn: (...args) => mockBeginAgentEventActorLegacyTurn(...args),
  completeAgentEventActorLegacyTurn: (...args) => mockCompleteAgentEventActorLegacyTurn(...args),
  recordAgentEventActorReconciliation: (...args) =>
    mockRecordAgentEventActorReconciliation(...args),
  resolveAgentEventActorReconciliation: (...args) =>
    mockResolveAgentEventActorReconciliation(...args),
  clearAgentEventActorReconciliation: (...args) => mockClearAgentEventActorReconciliation(...args),
  admitAgentEventActorAction: (...args) => mockAdmitAgentEventActorAction(...args),
  releaseAgentEventActorAction: (...args) => mockReleaseAgentEventActorAction(...args),
  hasAgentEventActorActionAdmission: (...args) => mockHasAgentEventActorActionAdmission(...args),
  getAgentEventActorReceipt: (...args) => mockGetAgentEventActorReceipt(...args),
  getAgentEventActorDetachedAction: (...args) => mockGetAgentEventActorDetachedAction(...args),
  claimAgentEventActorSuspension: (...args) => mockClaimAgentEventActorSuspension(...args),
  settleAgentEventActorSuspension: (...args) => mockSettleAgentEventActorSuspension(...args),
  stampConvoLastResponse: (...args) => mockStampConvoLastResponse(...args),
  isAgentTriggerPrincipalActive: (...args) => mockIsAgentTriggerPrincipalActive(...args),
  isSubagentOwnerAdmissible: (...args) => mockIsSubagentOwnerAdmissible(...args),
}));

jest.mock('~/server/services/Endpoints/agents/eventChildLease', () => ({
  acquireEventChildGenerationLease: (...args) => mockAcquireEventChildGenerationLease(...args),
}));

jest.mock('~/server/services/Schedules', () => ({
  recordScheduleOutcome: (...args) => mockRecordScheduleOutcome(...args),
  isScheduleLive: (...args) => mockIsScheduleLive(...args),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  settleAgentQueuedTurnExecutionAdmission: (...args) =>
    mockSettleAgentQueuedTurnExecutionAdmission(...args),
  verifyAgentQueuedTurnExecutionAdmission: (...args) =>
    mockVerifyAgentQueuedTurnExecutionAdmission(...args),
}));

const AgentController = require('../request');
const { AttachmentStorageError, encodeAndFormatImages } = require('@librechat/api');
const { ErrorTypes } = require('librechat-data-provider');
const { disposeClient: mockDisposeClient } = require('~/server/cleanup');
const { getMCPRequestContext } = require('~/server/services/MCPRequestContext');

function createResumableResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.finished = false;
  res.destroyed = false;
  res.json = jest.fn(() => {
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    res.emit('finish');
    return res;
  });
  res.status = jest.fn(() => res);
  res.set = jest.fn(() => res);
  return res;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ResumableAgentController resume metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMCPContexts = new WeakMap();
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGetConvo.mockResolvedValue({ createdAt: '2026-06-07T00:00:00.000Z' });
    mockGetMessages.mockResolvedValue([]);
    mockIsAgentTriggerPrincipalActive.mockResolvedValue(true);
    mockIsSubagentOwnerAdmissible.mockResolvedValue(true);
    mockAcquireEventChildGenerationLease.mockResolvedValue(jest.fn());
    mockIsScheduleFireRequest.mockImplementation((req) => req?._isScheduledFire === true);
    mockExemptFromConcurrencyLimiter.mockImplementation(
      (req) => req?._isScheduledFire === true && req?._isManualScheduledFire !== true,
    );
    mockRecordScheduleOutcome.mockResolvedValue(true);
    mockIsScheduleLive.mockResolvedValue(true);
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      metadata: {
        checkpointNamespace: '1000',
        providerExecutionId: 'provider-segment-1',
        providerDrained: true,
      },
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: { on: jest.fn() },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue(null);
    mockGenerationJobManager.getJobStore.mockReturnValue({
      getJob: jest.fn().mockResolvedValue(null),
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.isRedis = false;
    mockGenerationJobManager.detachedAgentEventActionStoreMode = 'process_local';
    mockGenerationJobManager.supportsDetachedAgentEventActions = true;
    mockGenerationJobManager.persistAgentEventDetachedTerminalEvidence.mockResolvedValue(true);
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.claimTerminalJob.mockResolvedValue({
      streamId: 'conversation-123',
      createdAt: 1000,
      status: 'complete',
      persistencePending: true,
      drainedSteers: [],
    });
    mockGenerationJobManager.publishTerminalClaim.mockImplementation(
      async (_claim, finalEvent) => ({
        finalEvent: finalEvent ?? {
          final: true,
          reconcile: true,
          reconcileReason: 'terminal_payload_missing',
          terminalStatus: 'error',
        },
        persistenceFailed: finalEvent == null,
      }),
    );
    mockGenerationJobManager.finishTerminalJob.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockImplementation(
      async (_streamId, _error, _createdAt, options) => {
        await options?.beforeErrorPublication?.();
        return true;
      },
    );
    mockGenerationJobManager.beginProviderExecution.mockResolvedValue(true);
    mockGenerationJobManager.markProviderExecutionDrained.mockResolvedValue(true);
    mockGenerationJobManager.failPausePersistence.mockResolvedValue(true);
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    mockGenerationJobManager.resumeClaimedGeneration.mockResolvedValue(null);
    mockGenerationJobManager.takeoverGeneration.mockResolvedValue({ claimed: false });
    mockGenerationJobManager.releaseGeneration.mockResolvedValue(undefined);
    mockGenerationJobManager.hasJob.mockResolvedValue(true);
    mockGenerationJobManager.approvals.ownsPausePersistence.mockResolvedValue(true);
    mockGenerationJobManager.approvals.finishPausePersistence.mockResolvedValue(true);
    mockGenerationJobManager.steering.closeAndDrain.mockResolvedValue([]);
    mockGenerationJobManager.steering.park.mockResolvedValue(undefined);
    mockGenerationJobManager.steering.consumeRecovered.mockResolvedValue(true);
    mockSaveMessage.mockResolvedValue({});
    mockSaveConvo.mockResolvedValue({});
    mockAppendConvoMessageReference.mockResolvedValue({});
    mockDeleteAgentCheckpoint.mockResolvedValue(undefined);
    mockSettleAgentQueuedTurnExecutionAdmission.mockResolvedValue(true);
    mockVerifyAgentQueuedTurnExecutionAdmission.mockResolvedValue(true);
    mockGetAgentEventActorSnapshot.mockResolvedValue({ state: null, reconciliations: [] });
    mockCommitAgentEventActorState.mockResolvedValue({ status: 'stale' });
    mockBeginAgentEventActorLegacyTurn.mockResolvedValue(true);
    mockCompleteAgentEventActorLegacyTurn.mockResolvedValue(true);
    mockRecordAgentEventActorReconciliation.mockResolvedValue(true);
    mockResolveAgentEventActorReconciliation.mockResolvedValue(true);
    mockClearAgentEventActorReconciliation.mockResolvedValue(true);
    mockAdmitAgentEventActorAction.mockResolvedValue(true);
    mockReleaseAgentEventActorAction.mockResolvedValue(true);
    mockHasAgentEventActorActionAdmission.mockResolvedValue(false);
    mockGetAgentEventActorReceipt.mockResolvedValue(null);
    mockGetAgentEventActorDetachedAction.mockResolvedValue(null);
    mockClaimAgentEventActorSuspension.mockResolvedValue({ status: 'claimed' });
    mockSettleAgentEventActorSuspension.mockResolvedValue({ status: 'settled' });
  });

  it.each([
    ['non-string', { arbitrary: true }],
    ['empty', ''],
    ['oversized', 'a'.repeat(129)],
    ['unsafe characters', 'request id with spaces'],
  ])(
    'rejects a %s clientRequestId before creating durable state',
    async (_label, clientRequestId) => {
      const req = {
        user: { id: 'user-123' },
        body: {
          text: 'Invalid request identity',
          messageId: 'user-message',
          clientRequestId,
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };
      const res = { json: jest.fn(), status: jest.fn(() => res) };

      await AgentController(req, res, jest.fn(), jest.fn(), null);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_CLIENT_REQUEST_ID' }),
      );
      expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000'])(
    'rejects invalid expected predecessor epoch %p before creating durable state',
    async (expectedPredecessorCreatedAt) => {
      const req = {
        user: { id: 'user-123' },
        body: {
          text: 'Conditional queued follow-up',
          messageId: 'user-message',
          clientRequestId: 'conditional-request',
          expectedPredecessorCreatedAt,
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };
      const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

      await AgentController(req, res, jest.fn(), jest.fn(), null);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_GENERATION_PREDECESSOR' }),
      );
      expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['overrideUserMessageId', 'overrideConvoId'])(
    'rejects a non-string %s before admission',
    async (field) => {
      const req = {
        user: { id: 'user-123' },
        body: {
          text: 'Invalid override identity',
          messageId: 'user-message',
          clientRequestId: 'override-request',
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
          [field]: { malformed: true },
        },
        config: {},
      };
      const res = { json: jest.fn(), status: jest.fn(() => res) };

      await AgentController(req, res, jest.fn(), jest.fn(), null);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_OVERRIDE_ID' }),
      );
      expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['empty recovery id', { clientRequestId: 'steer-recovery:' }],
    ['regenerate', { isRegenerate: true }],
    ['continued response', { isContinued: true }],
    ['content edit', { editedContent: { index: 0, type: 'text', text: 'edited' } }],
    ['response reuse', { responseMessageId: 'existing-response' }],
    ['mismatched user-row override', { overrideUserMessageId: 'existing-user__1' }],
    ['malformed files', { files: [{}] }],
  ])('rejects a recovered steer submitted as an incompatible %s shape', async (_label, shape) => {
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Recovered words',
        messageId: 'recovered-user-message',
        clientRequestId: 'steer-recovery:server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        ...shape,
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res) };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_RECOVERY_REQUEST' }),
    );
    expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['missing attempt id', { clientRequestId: undefined, recoverySteerId: 'server-steer-1' }],
    ['invalid source id', { clientRequestId: 'attempt-1', recoverySteerId: 'bad source id' }],
    [
      'mismatched legacy and explicit ids',
      { clientRequestId: 'steer-recovery:legacy-source', recoverySteerId: 'explicit-source' },
    ],
  ])('rejects an explicit recovery with %s', async (_label, recoveryFields) => {
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Recovered words',
        messageId: 'recovered-user-message',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        ...recoveryFields,
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res) };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_RECOVERY_REQUEST' }),
    );
    expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('rejects an underscore-suffixed parent that is not persisted', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up too early.',
        messageId: 'follow-up-user',
        parentMessageId: 'pending-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'pending-response_', conversationId },
      '_id',
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('selected parent response is still being saved'),
      }),
    );
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('allows an underscore-suffixed parent when it is already persisted', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up to persisted underscore id.',
        messageId: 'follow-up-user',
        parentMessageId: 'persisted-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'persisted-response_', conversationId },
      '_id',
    );
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      expect.objectContaining({
        startupTelemetry: mockStartupTelemetry,
        initialMetadata: expect.objectContaining({
          conversationId,
          endpoint: 'agents',
        }),
      }),
    );
  });

  it('defers a trusted trigger resume while its parent generation is still active', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    mockGenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId: 'user-123' },
    });
    const initializeClient = jest.fn();
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123' },
      body: {
        text: 'Collect the completed child.',
        messageId: 'wakeup-user-message',
        parentMessageId: 'persisted-response_',
        conversationId,
        clientRequestId: 'trigger_resume_1',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PARENT_NOT_READY' }));
    expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('labels a trigger parent-state lookup failure as provably pre-admission', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    mockGenerationJobManager.getJob.mockRejectedValue(new Error('redis unavailable'));
    const initializeClient = jest.fn();
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123' },
      body: {
        text: 'Collect the completed child.',
        messageId: 'wakeup-user-message',
        parentMessageId: 'persisted-response_',
        conversationId,
        clientRequestId: 'trigger_resume_1',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.set).toHaveBeenCalledWith('Retry-After', '1');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PARENT_STATE_UNAVAILABLE' }),
    );
    expect(mockGenerationJobManager.claimGeneration).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('deduplicates the active continuation whose admission response was lost', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'requires_action',
      metadata: {
        userId: 'user-123',
        idempotencyClientRequestId: 'trigger_resume_1',
      },
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: conversationId,
        conversationId,
        claimedAt: 100,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123' },
      body: {
        text: 'Collect the completed child.',
        messageId: 'wakeup-user-message',
        parentMessageId: 'persisted-response_',
        conversationId,
        clientRequestId: 'trigger_resume_1',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      streamId: conversationId,
      conversationId,
      generationCreatedAt: 1000,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
  });

  it('creates the job with the in-flight turn before MCP initialization can emit OAuth', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Check Google Workspace availability.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        isTemporary: true,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/spec-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      {
        startupTelemetry: mockStartupTelemetry,
        initialMetadata: {
          conversationId,
          generationProtocolVersion: 1,
          endpoint: 'agents',
          iconURL: 'https://example.com/spec-icon.png',
          model: 'gpt-3.5-turbo',
          /** The OWNING replica's seal capability, read by the steer route. */
          preemptCapable: true,
          steerQuotesCapable: true,
          agent_id: undefined,
          isTemporary: true,
          responseMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          mcpRequestBody: {
            messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            conversationId,
            parentMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          },
          userMessage: {
            messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            parentMessageId: 'original-response',
            conversationId,
            text: 'Check Google Workspace availability.',
          },
        },
      },
    );
    expect(mockGenerationJobManager.createJob.mock.invocationCallOrder[0]).toBeLessThan(
      initializeClient.mock.invocationCallOrder[0],
    );
    expect(initializeClient).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointNamespace: '1000', jobCreatedAt: 1000 }),
    );
    const [{ foregroundRunId, requestBody }] = initializeClient.mock.calls[0];
    expect(foregroundRunId).toBe(requestBody.messageId);
    expect(foregroundRunId).not.toBe(req.body.messageId);
    expect(req.turnStartedAt).toBe(1000);
    expect(mockGenerationJobManager.updateMetadata).not.toHaveBeenCalled();
    const startupMilestones = mockStartupTelemetry.mark.mock.calls.map(([milestone]) => milestone);
    expect(startupMilestones.slice(0, 2)).toEqual(['request_admitted', 'job_created']);
    expect(new Set(startupMilestones.slice(2))).toEqual(
      new Set(['conversation_resolved', 'metadata_persisted']),
    );
    expect(mockAcceptAgentStartupTelemetry).toHaveBeenCalledWith(req, conversationId);
    expect(mockStartupTelemetry.end).toHaveBeenCalledWith('error', expect.any(Error));
  });

  it('persists and exactly echoes protocol v2 on a newly created generation', async () => {
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      metadata: { checkpointNamespace: '1000', generationProtocolVersion: 2 },
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: { on: jest.fn() },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Negotiate the rollout protocol.',
        messageId: 'user-message',
        conversationId: 'conversation-123',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after negotiation'));

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'conversation-123',
      'user-123',
      'conversation-123',
      expect.objectContaining({
        initialMetadata: expect.objectContaining({ generationProtocolVersion: 2 }),
      }),
    );
    expect(res.set).toHaveBeenCalledWith('x-librechat-generation-protocol', '2');
    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 1000,
      status: 'started',
      generationProtocolVersion: 2,
    });
  });

  it('rejects any session fenced after authentication before generation execution starts', async () => {
    mockIsAgentTriggerPrincipalActive.mockResolvedValue(false);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Run after a slow trigger admission.',
        messageId: 'user-message',
        clientRequestId: 'trigger-request',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();
    const initializeClient = jest.fn();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledTimes(1);
    expect(mockIsAgentTriggerPrincipalActive).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockIsAgentTriggerPrincipalActive.mock.invocationCallOrder[0],
    );
    expect(mockGenerationJobManager.beginProviderExecution).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: 409,
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      error: 'Account deletion is in progress',
      generationProtocolVersion: 1,
    });
    expect(initializeClient).not.toHaveBeenCalled();
    expect(mockAcceptAgentStartupTelemetry).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      JSON.stringify({
        status: 409,
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
        error: 'Account deletion is in progress',
      }),
      1000,
    );
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'trigger-request',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
  });

  it('rejects a superseded automatic occurrence after durable job creation and preserves its outcome', async () => {
    const conversationId = 'scheduled-conversation-123';
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: conversationId, conversationId }),
    );
    mockIsScheduleLive.mockResolvedValue(false);
    const req = {
      _isScheduledFire: true,
      _isManualScheduledFire: false,
      user: { id: 'user-123' },
      body: {
        text: 'Run the scheduled digest.',
        messageId: 'scheduled-user-message',
        clientRequestId: 'sched:schedule-1:2026-08-17T12:00:00-000Z',
        conversationId: 'new',
        newConversationId: conversationId,
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
        scheduleConfigRevision: 7,
        endpointOption: { endpoint: 'agents', agent_id: 'agent-1' },
      },
      config: {},
    };
    const res = createResumableResponse();
    const initializeClient = jest.fn();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      expect.objectContaining({
        initialMetadata: expect.objectContaining({
          scheduleId: 'schedule-1',
          scheduledFor: '2026-08-17T12:00:00.000Z',
          scheduleConfigRevision: 7,
          preserveForScheduleReconcile: true,
        }),
      }),
    );
    // `scheduledFor` identifies the OCCURRENCE, matching the resume path: the run row
    // is reserved before this loopback request is dispatched, so a pin introduced while
    // it sat queued must not be validated in place of the destination the envelope was
    // already built with.
    expect(mockIsScheduleLive).toHaveBeenCalledWith('schedule-1', 7, {
      automatic: true,
      policy: true,
      scheduledFor: '2026-08-17T12:00:00.000Z',
    });
    expect(initializeClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: 409,
      code: 'SCHEDULE_NO_LONGER_ACTIVE',
      error: 'This scheduled occurrence is no longer active',
      generationProtocolVersion: 1,
    });
    expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      scheduledFor: '2026-08-17T12:00:00.000Z',
      streamId: conversationId,
      jobCreatedAt: 1000,
      status: 'interrupted',
      conversationId,
      clearConversationId: false,
      error: 'This scheduled occurrence is no longer active',
    });
    expect(mockDecrementPendingRequest).not.toHaveBeenCalled();
  });

  it('does not start a provider when account deletion or replacement wins the startup CAS', async () => {
    mockGenerationJobManager.beginProviderExecution.mockResolvedValue(false);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Race destructive cleanup.',
        messageId: 'user-message',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();
    const initializeClient = jest.fn();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockIsAgentTriggerPrincipalActive).toHaveBeenCalledWith('user-123');
    expect(mockIsAgentTriggerPrincipalActive.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.beginProviderExecution.mock.invocationCallOrder[0],
    );
    expect(initializeClient).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      expect.stringContaining('Generation stopped before provider startup'),
      1000,
    );
    expect(mockGenerationJobManager.markProviderExecutionDrained).toHaveBeenCalledWith(
      'conversation-123',
      1000,
      'provider-segment-1',
    );
  });

  it('keeps a queued-turn source nonterminal when provider initialization fails', async () => {
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    const admissionSource = {
      source: 'agent-queued-turn',
      sourceId: 'queued-turn-1',
      claimId: 'queued-delivery-1',
      claimBy: 'queued-worker-1',
    };
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Run the queued turn.',
        messageId: 'queued-user-message',
        parentMessageId: 'persisted-response_',
        conversationId: 'conversation-123',
        clientRequestId: 'queued-delivery-1',
        agentContinuationAdmission: admissionSource,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before provider'));

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(initializeClient).toHaveBeenCalledTimes(1);
    expect(mockSettleAgentQueuedTurnExecutionAdmission).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('commits a queued-turn receipt after provider invocation and before accepting HTTP', async () => {
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    const admissionSource = {
      source: 'agent-queued-turn',
      sourceId: 'queued-turn-1',
      claimId: 'queued-delivery-1',
      claimBy: 'queued-worker-1',
    };
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Run the queued turn.',
        messageId: 'queued-user-message',
        parentMessageId: 'persisted-response_',
        conversationId: 'conversation-123',
        clientRequestId: 'queued-delivery-1',
        agentContinuationAdmission: admissionSource,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const sendMessage = jest.fn(() => new Promise(() => {}));
    const initializeClient = jest.fn().mockResolvedValue({ client: { options: {}, sendMessage } });
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);
    await nextTick();

    expect(mockSettleAgentQueuedTurnExecutionAdmission).toHaveBeenCalledWith(admissionSource, {
      userId: 'user-123',
      tenantId: 'tenant-1',
      conversationId: 'conversation-123',
      clientRequestId: 'queued-delivery-1',
      generationId: 'conversation-123',
      generationCreatedAt: 1000,
    });
    expect(initializeClient.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0],
    );
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockSettleAgentQueuedTurnExecutionAdmission.mock.invocationCallOrder[0],
    );
    expect(mockSettleAgentQueuedTurnExecutionAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      res.json.mock.invocationCallOrder[0],
    );
  });

  it('fails closed after provider invocation when the queued-turn receipt is unavailable', async () => {
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    mockSettleAgentQueuedTurnExecutionAdmission.mockRejectedValue(new Error('mongo unavailable'));
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123' },
      body: {
        text: 'Run the queued turn.',
        messageId: 'queued-user-message',
        parentMessageId: 'persisted-response_',
        conversationId: 'conversation-123',
        clientRequestId: 'queued-delivery-1',
        agentContinuationAdmission: {
          source: 'agent-queued-turn',
          sourceId: 'queued-turn-1',
          claimId: 'queued-delivery-1',
          claimBy: 'queued-worker-1',
        },
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const sendMessage = jest.fn(() => new Promise(() => {}));
    const initializeClient = jest.fn().mockResolvedValue({ client: { options: {}, sendMessage } });
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);
    await nextTick();

    expect(mockGenerationJobManager.beginProviderExecution).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      'mongo unavailable',
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
    expect(mockGenerationJobManager.markProviderExecutionDrained).toHaveBeenCalledWith(
      'conversation-123',
      1000,
      'provider-segment-1',
    );
  });

  it('prefetches conversation state before admission and joins it with job metadata', async () => {
    let resolveConversation;
    let signalMetadataStarted;
    const conversationPromise = new Promise((resolve) => {
      resolveConversation = resolve;
    });
    const metadataStarted = new Promise((resolve) => {
      signalMetadataStarted = resolve;
    });
    mockGetConvo.mockReturnValue(conversationPromise);
    mockGenerationJobManager.createJob.mockImplementation(() => {
      signalMetadataStarted();
      return Promise.resolve({
        createdAt: 1000,
        readyPromise: Promise.resolve(),
        abortController: new AbortController(),
        emitter: { on: jest.fn() },
      });
    });
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after startup reads'));
    const conversationId = 'conversation-123';
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Run independent startup work together.',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = createResumableResponse();

    const controllerPromise = AgentController(req, res, jest.fn(), initializeClient, null);
    expect(mockGetConvo).toHaveBeenCalledWith('user-123', conversationId);
    await metadataStarted;
    await nextTick();

    expect(mockGetConvo.mock.invocationCallOrder[0]).toBeLessThan(
      mockCheckAndIncrementPendingRequest.mock.invocationCallOrder[0],
    );
    expect(res.json).toHaveBeenCalledWith({
      streamId: conversationId,
      conversationId,
      generationCreatedAt: 1000,
      status: 'started',
      generationProtocolVersion: 1,
    });
    expect(initializeClient).not.toHaveBeenCalled();

    resolveConversation({ createdAt: '2026-06-07T00:00:00.000Z' });
    await controllerPromise;

    expect(initializeClient).toHaveBeenCalledTimes(1);
  });

  it('keeps request-scoped MCP connections until resumable initialization finishes', async () => {
    const conversationId = 'conversation-123';
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const initializeClient = jest.fn(async ({ req, res }) => {
      const context = getMCPRequestContext(req, res);
      context.connections.set('mcp-server', { disconnect });

      await nextTick();
      expect(disconnect).not.toHaveBeenCalled();

      throw new Error('stop after request-scoped MCP connection');
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use a BODY-scoped MCP server.',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: conversationId,
      conversationId,
      generationCreatedAt: 1000,
      status: 'started',
      generationProtocolVersion: 1,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockDecrementPendingRequest.mock.invocationCallOrder[0],
    );
  });

  it('preallocates response-scoped MCP identities before native Agent initialization', async () => {
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after MCP discovery'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use request-scoped headers.',
        messageId: 'incoming-client-message',
        parentMessageId: 'previous-response',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);

    expect(initializeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: {
          messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          conversationId: 'conversation-123',
          parentMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      }),
    );
    const [{ requestBody }] = initializeClient.mock.calls[0];
    const jobOptions = mockGenerationJobManager.createJob.mock.calls[0][3];
    expect(jobOptions.initialMetadata.responseMessageId).toBe(requestBody.messageId);
    expect(jobOptions.initialMetadata.userMessage.messageId).toBe(requestBody.parentMessageId);
    expect(jobOptions.initialMetadata.mcpRequestBody).toBe(requestBody);
    expect(requestBody.messageId).not.toBe(req.body.messageId);
  });

  it('pins a normalized code-environment decision before provider execution', async () => {
    let signalProviderStarted;
    const providerStarted = new Promise((resolve) => {
      signalProviderStarted = resolve;
    });
    const sendMessage = jest.fn(() => {
      signalProviderStarted();
      return new Promise(() => {});
    });
    const initializeClient = jest.fn(async ({ req }) => {
      req.body.codeEnvironmentMode = 'without_attached';
      delete req.body.codeWorkspaces;
      return { client: { options: {}, sendMessage } };
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Continue without my attached machine.',
        messageId: 'incoming-client-message',
        parentMessageId: 'previous-response',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);
    await providerStarted;

    const initialRequestBody =
      mockGenerationJobManager.createJob.mock.calls[0][3].initialMetadata.mcpRequestBody;
    expect(initialRequestBody).not.toHaveProperty('codeEnvironmentMode');
    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      'conversation-123',
      {
        mcpRequestBody: {
          ...initialRequestBody,
          codeEnvironmentMode: 'without_attached',
        },
      },
      1000,
    );
    expect(mockGenerationJobManager.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0],
    );
  });

  it('uses the effective overridden conversation in the MCP request body', async () => {
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after MCP discovery'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Continue in the overridden conversation.',
        messageId: 'incoming-client-message',
        parentMessageId: 'previous-response',
        conversationId: 'source-conversation',
        overrideConvoId: 'overridden-conversation__0',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);

    const [{ requestBody }] = initializeClient.mock.calls[0];
    const jobOptions = mockGenerationJobManager.createJob.mock.calls[0][3];
    expect(requestBody.conversationId).toBe('overridden-conversation');
    expect(jobOptions.initialMetadata.mcpRequestBody).toBe(requestBody);
  });

  it('preallocates the replacement response as the MCP parent for edited content', async () => {
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after MCP discovery'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Edited response text.',
        messageId: 'existing-user-message',
        responseMessageId: 'existing-response-message',
        parentMessageId: 'previous-response',
        overrideParentMessageId: 'existing-user-message',
        editedContent: { index: 0, type: 'text', text: 'Edited response text.' },
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);

    const [{ requestBody }] = initializeClient.mock.calls[0];
    const jobOptions = mockGenerationJobManager.createJob.mock.calls[0][3];
    expect(requestBody.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestBody.parentMessageId).toBe(requestBody.messageId);
    expect(requestBody.messageId).not.toBe('existing-response-message');
    expect(jobOptions.initialMetadata.mcpRequestBody).toBe(requestBody);
  });

  it('stores model spec icon fallbacks and agent ids in early resume metadata', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the resume spec.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        isTemporary: true,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      expect.objectContaining({
        initialMetadata: expect.objectContaining({
          iconURL: 'https://example.com/preset-icon.png',
          model: 'agent_resume_spec',
          agent_id: 'agent_resume_spec',
          isTemporary: true,
        }),
      }),
    );
  });

  it('records regeneration ownership for exact-ID resume reconstruction', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Regenerate the edited response.',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        responseMessageId: 'edited-response',
        isRegenerate: true,
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      expect.objectContaining({
        initialMetadata: expect.objectContaining({
          responseMessageId: 'edited-response',
          isRegenerate: true,
        }),
      }),
    );
  });

  it('falls back to the model spec preset endpoint when no icon URL is configured', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the endpoint icon.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'endpoint-icon-spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'endpoint-icon-spec',
              preset: {
                endpoint: 'anthropic',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
      expect.objectContaining({
        initialMetadata: expect.objectContaining({
          iconURL: 'anthropic',
          model: 'gpt-4.1',
        }),
      }),
    );
  });

  it('filters OAuth prompts before saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      iconURL: 'https://example.com/spec-icon.png',
      model: 'gpt-4.1',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use Google Workspace',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use Google Workspace',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/fallback-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));
    mockSaveMessage.mockClear();
    mockSaveConvo.mockClear();

    const oauthPart = {
      type: 'tool_call',
      tool_call: {
        name: 'oauth_mcp_Google-Workspace',
        auth: 'https://auth.example.com/oauth',
      },
    };
    const textPart = { type: 'text', text: 'Partial response...' };

    mockSaveMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce({});
    await allSubscribersLeftHandler([oauthPart, textPart]);
    await allSubscribersLeftHandler([oauthPart, textPart]);

    expect(mockFilterPersistableAbortContent).toHaveBeenCalledWith([oauthPart, textPart]);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-4.1',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[ResumableAgentController] Error saving partial response:',
      expect.objectContaining({
        message: 'Partial response could not be persisted after disconnect',
      }),
    );
  });

  it('uses model spec and agent fallbacks when saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use fallback metadata',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use fallback metadata',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    const textPart = { type: 'text', text: 'Partial response...' };
    await allSubscribersLeftHandler([textPart]);

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/preset-icon.png',
        model: 'agent_resume_spec',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
  });

  it('dedups a retried start-generation request to the original stream', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: 100,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'running',
      metadata: { userId: 'user-123', idempotencyClientRequestId: 'req-abc' },
    });
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retried after a lost response.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'orig-stream',
      conversationId: 'orig-stream',
      generationCreatedAt: 1000,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
    expect(mockStartupTelemetry.end).toHaveBeenCalledWith('deduplicated');
  });

  it('attaches a new-chat retry to a tokenless legacy random stream after owner validation', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      source: 'legacy',
      existing: {
        streamId: 'legacy-random-stream',
        conversationId: 'legacy-random-stream',
        claimedAt: Date.now() - 100,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'running',
      metadata: { userId: 'user-123' },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry an old-server new chat.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'new',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'legacy-random-stream',
      conversationId: 'legacy-random-stream',
      generationCreatedAt: 1000,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.takeoverGeneration).not.toHaveBeenCalled();
  });

  it('never takes over a tokenless legacy claim after its job has disappeared', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      source: 'legacy',
      existing: {
        streamId: 'legacy-random-stream',
        conversationId: 'legacy-random-stream',
        claimedAt: Date.now() - 60_000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry after an old generation was cleaned.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'new',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'legacy-random-stream',
      conversationId: 'legacy-random-stream',
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.takeoverGeneration).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('rejects a tokenless legacy claim that miscorrelates an existing conversation', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      source: 'legacy',
      existing: {
        streamId: 'different-conversation',
        conversationId: 'different-conversation',
        claimedAt: Date.now() - 100,
      },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Do not cross-wire this retry.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockGenerationJobManager.getJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it.each([
    ['a different stream', { streamId: 'foreign-stream' }],
    ['a different conversation', { conversationId: 'foreign-conversation' }],
    ['a missing claim token', { claimToken: undefined }],
    ['an invalid claim timestamp', { claimedAt: 'not-a-timestamp' }],
    ['an invalid started timestamp', { startedAt: -1 }],
  ])('fails closed when the idempotency claim contains %s', async (_name, override) => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: 100,
        claimToken: 'existing-token',
        ...override,
      },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry against corrupt claim state.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
    expect(mockGenerationJobManager.getJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.takeoverGeneration).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it.each([
    ['another user', { userId: 'someone-else' }, { id: 'user-123' }],
    ['a missing owner', {}, { id: 'user-123' }],
    [
      'another tenant',
      { userId: 'user-123', tenantId: 'tenant-b' },
      { id: 'user-123', tenantId: 'tenant-a' },
    ],
  ])(
    'fails closed when a valid idempotency claim resolves to %s',
    async (_name, jobMetadata, requestUser) => {
      mockGenerationJobManager.claimGeneration.mockResolvedValue({
        claimed: false,
        existing: {
          streamId: 'orig-stream',
          conversationId: 'orig-stream',
          claimedAt: 100,
          claimToken: 'existing-token',
          startedAt: 1000,
        },
      });
      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: 1000,
        status: 'running',
        metadata: { ...jobMetadata, idempotencyClientRequestId: 'req-abc' },
      });
      const req = {
        user: requestUser,
        body: {
          text: 'Do not attach this retry to a foreign run.',
          messageId: 'user-msg',
          clientRequestId: 'req-abc',
          conversationId: 'orig-stream',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };
      const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

      await AgentController(req, res, jest.fn(), jest.fn(), null);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
      expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    },
  );

  it('keeps a terminal duplicate without a durable payload on the readiness path', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: 100,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'aborted',
      metadata: {
        userId: 'user-123',
        idempotencyClientRequestId: 'req-abc',
        terminalPersistencePending: true,
      },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry while abort persistence is still in flight.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.set).toHaveBeenCalledWith('Retry-After', '1');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
  });

  it('allows a terminal duplicate with a stored FINAL to replay through SSE', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: 100,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'complete',
      finalEvent: JSON.stringify({ final: true }),
      metadata: { userId: 'user-123', idempotencyClientRequestId: 'req-abc' },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry after the terminal payload was persisted.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'orig-stream',
      conversationId: 'orig-stream',
      generationCreatedAt: 1000,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('derives the same new-conversation stream for a lost-response retry', async () => {
    mockGenerationJobManager.claimGeneration.mockImplementation(
      async (_userId, _requestId, streamId, conversationId) =>
        wonGenerationClaim({ streamId, conversationId }),
    );
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after deterministic id'));
    const makeReq = () => ({
      user: { id: 'user-123' },
      body: {
        text: 'Create a stable new chat.',
        messageId: 'user-msg',
        clientRequestId: '4ea9fc40-f28f-4f89-a575-aa5854d10c19',
        conversationId: 'new',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    });

    await AgentController(makeReq(), createResumableResponse(), jest.fn(), initializeClient, null);
    await AgentController(makeReq(), createResumableResponse(), jest.fn(), initializeClient, null);

    const firstStreamId = mockGenerationJobManager.claimGeneration.mock.calls[0][2];
    const retryStreamId = mockGenerationJobManager.claimGeneration.mock.calls[1][2];
    expect(firstStreamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retryStreamId).toBe(firstStreamId);
  });

  it('resumes a matching live generation when its fixed claim lease was reacquired', async () => {
    const reacquired = wonGenerationClaim({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      claimToken: 'reacquired-token',
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue(reacquired);
    mockGenerationJobManager.resumeClaimedGeneration.mockResolvedValue({
      ...reacquired.existing,
      startedAt: 42,
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry after sleeping through a long approval.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(mockGenerationJobManager.resumeClaimedGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      reacquired.existing,
    );
    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 42,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('fails closed when a deduplicated queued generation lacks its source receipt', async () => {
    const reacquired = wonGenerationClaim({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      claimToken: 'reacquired-token',
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue(reacquired);
    mockGenerationJobManager.resumeClaimedGeneration.mockResolvedValue({
      ...reacquired.existing,
      startedAt: 42,
    });
    mockVerifyAgentQueuedTurnExecutionAdmission.mockRejectedValue(
      new Error('source receipt missing'),
    );
    const admissionSource = {
      source: 'agent-queued-turn',
      sourceId: 'queued-turn-1',
      claimId: 'queued-delivery-1',
      claimBy: 'queued-worker-1',
    };
    const req = {
      _isAgentTrigger: true,
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Retry a queued generation.',
        messageId: 'user-msg',
        parentMessageId: 'assistant-1',
        clientRequestId: 'queued-delivery-1',
        conversationId: 'conversation-123',
        agentContinuationAdmission: admissionSource,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(mockVerifyAgentQueuedTurnExecutionAdmission).toHaveBeenCalledWith(admissionSource, {
      userId: 'user-123',
      tenantId: 'tenant-1',
      conversationId: 'conversation-123',
      clientRequestId: 'queued-delivery-1',
      generationId: 'conversation-123',
      generationCreatedAt: 42,
    });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SERVER_NOT_READY',
      }),
    );
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('caps a reacquired v2 lease to the immutable v1 live-job protocol', async () => {
    const reacquired = wonGenerationClaim({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      claimToken: 'reacquired-v2-token',
      generationProtocolVersion: 2,
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue(reacquired);
    mockGenerationJobManager.resumeClaimedGeneration.mockResolvedValue({
      ...reacquired.existing,
      startedAt: 42,
      generationProtocolVersion: 1,
    });
    const req = {
      user: { id: 'user-123' },
      headers: { 'x-librechat-generation-protocol': '2' },
      body: {
        text: 'Retry a v1 job from an upgraded client.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 42,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('returns a settled response when the original job completed and was cleaned up', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: Date.now() - 60000,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry after a fast, already-cleaned-up generation.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'orig-stream',
      conversationId: 'orig-stream',
      generationCreatedAt: 1000,
      status: 'resumed',
      generationProtocolVersion: 1,
    });
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('uses the v2 settled control only when the durable claim confirms protocol v2', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: Date.now() - 60_000,
        claimToken: 'existing-token',
        startedAt: 2000,
        generationProtocolVersion: 2,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry a completed v2 generation.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.json).toHaveBeenCalledWith({
      conversationId: 'orig-stream',
      generationCreatedAt: 2000,
      status: 'settled',
      generationProtocolVersion: 2,
    });
  });

  it('does not attach a stale retry to a newer generation on the same conversation stream', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'conversation-123',
        conversationId: 'conversation-123',
        claimedAt: Date.now() - 60_000,
        claimToken: 'existing-token',
        startedAt: 1000,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 2000,
      status: 'running',
      metadata: { userId: 'user-123', idempotencyClientRequestId: 'newer-request' },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry the earlier turn after its response was lost.',
        messageId: 'old-user-msg',
        clientRequestId: 'older-request',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'RUN_REPLACED',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
  });

  it('uses the v2 replacement handoff only when both claim and live job confirm v2', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'conversation-123',
        conversationId: 'conversation-123',
        claimedAt: Date.now() - 60_000,
        claimToken: 'existing-token',
        startedAt: 1000,
        generationProtocolVersion: 2,
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 2000,
      status: 'running',
      metadata: {
        userId: 'user-123',
        idempotencyClientRequestId: 'newer-request',
        generationProtocolVersion: 2,
      },
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry the earlier v2 turn.',
        messageId: 'old-user-msg',
        clientRequestId: 'older-request',
        conversationId: 'conversation-123',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 2000,
      status: 'replaced',
      generationProtocolVersion: 2,
    });
  });

  it('takes over an abandoned old pre-create claim and fences the prior owner', async () => {
    const abandonedClaim = {
      streamId: 'orig-stream',
      conversationId: 'orig-stream',
      claimedAt: Date.now() - 60000,
      claimToken: 'abandoned-token',
    };
    const takeover = wonGenerationClaim({
      streamId: 'orig-stream',
      conversationId: 'orig-stream',
      claimToken: 'takeover-token',
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: abandonedClaim,
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    mockGenerationJobManager.takeoverGeneration.mockResolvedValue(takeover);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after takeover'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Recover the abandoned request.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.takeoverGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'orig-stream',
      abandonedClaim,
    );
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'orig-stream',
      'user-123',
      'orig-stream',
      expect.objectContaining({
        idempotencyClientRequestId: 'req-abc',
        idempotencyClaimToken: 'takeover-token',
      }),
    );
  });

  it('returns 503 SERVER_NOT_READY when a fresh claim still has no job (winner is between claim and createJob)', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: Date.now(),
        claimToken: 'existing-token',
      },
    });
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Concurrent duplicate before the winner wrote its job.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.set).toHaveBeenCalledWith('Retry-After', '1');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('never starts a second generation when the job lookup fails for a confirmed duplicate', async () => {
    // A store hiccup while checking an existing claim must not fail open into createJob.
    mockGenerationJobManager.claimGeneration.mockResolvedValue({
      claimed: false,
      existing: {
        streamId: 'orig-stream',
        conversationId: 'orig-stream',
        claimedAt: Date.now(),
        claimToken: 'existing-token',
      },
    });
    mockGenerationJobManager.getJob.mockRejectedValue(new Error('redis down'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Duplicate during a Redis hiccup.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'orig-stream',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('does not finalize an unscoped generation when job creation rejects before returning', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    mockGenerationJobManager.createJob.mockRejectedValue(new Error('create failed before return'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Fail before receiving a job epoch.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'create failed before return',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
  });

  it('names the failure class at the initialization boundary', async () => {
    const initializeClient = jest.fn().mockRejectedValue(new AttachmentStorageError());
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Describe the attached image.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    const [message, ...metadata] = mockLogger.error.mock.calls.find((call) =>
      String(call[0]).startsWith('[ResumableAgentController] Initialization error:'),
    );
    expect(metadata).toEqual([]);
    expect(message).toContain(
      'AttachmentStorageError: An attached file could not be read from storage.',
    );
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      'An attached file could not be read from storage. Try again or upload it again.',
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it('redacts a signed storage URL an initialization failure carries into the log', async () => {
    const signedUrl =
      'https://minio.example.com/bucket/image.png?X-Amz-Credential=secret&X-Amz-Signature=signed';
    const initializeClient = jest
      .fn()
      .mockRejectedValue(new Error(`AccessDenied reading ${signedUrl}`));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Describe the attached image.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);

    const [message, ...metadata] = mockLogger.error.mock.calls.find((call) =>
      String(call[0]).startsWith('[ResumableAgentController] Initialization error:'),
    );
    expect(metadata).toEqual([]);
    expect(message).toContain('AccessDenied reading https://minio.example.com/[redacted]');
    expect(message).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(signedUrl);
  });

  it('publishes a safe image storage failure during generation and releases the request', async () => {
    const signedUrl =
      'https://minio.example.com/bucket/image.png?X-Amz-Credential=secret&X-Amz-Signature=signed';
    const storageError = Object.assign(new Error(`Access denied for ${signedUrl}`), {
      code: 'AccessDenied',
      statusCode: 403,
    });
    const getDownloadStream = jest.fn().mockRejectedValue(storageError);
    const file = {
      file_id: 'image-1',
      source: 's3',
      filepath: signedUrl,
      storageKey: 'images/user/image.png',
      height: 10,
      width: 10,
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Describe the attached image.',
        messageId: 'user-msg',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const client = {
      options: {},
      sendMessage: jest.fn(() =>
        encodeAndFormatImages(
          req,
          [file],
          {},
          { getStrategyFunctions: () => ({ getDownloadStream }) },
        ),
      ),
    };
    const initializeClient = jest.fn().mockResolvedValue({ client });

    await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);
    await nextTick();

    const safeError = new AttachmentStorageError();
    expect(getDownloadStream).toHaveBeenCalledWith(req, file.storageKey);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[ResumableAgentController] Generation error for conversation-123:',
      safeError,
    );
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      safeError.message,
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({ error: true, text: safeError.message }),
      expect.any(Object),
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockDisposeClient).toHaveBeenCalledWith(client);
    expect(JSON.stringify(mockGenerationJobManager.completeJob.mock.calls)).not.toContain(
      signedUrl,
    );
    expect(JSON.stringify(mockSaveMessage.mock.calls)).not.toContain(signedUrl);
  });

  it('returns a typed recovery conflict before acknowledging generation startup', async () => {
    const recoveryError = new Error('Attached resources could not be restored');
    recoveryError.code = ErrorTypes.RESOURCE_RECOVERY_REQUIRED;
    mockGenerationJobManager.createJob.mockRejectedValue(recoveryError);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Describe the attached image.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: 409,
      code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      error: 'Attached resources could not be restored',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  it('preserves the recovery code in the durable error after acknowledging startup', async () => {
    const recoveryError = new Error('Attached resources could not be restored');
    recoveryError.code = ErrorTypes.RESOURCE_RECOVERY_REQUIRED;
    const initializeClient = jest.fn().mockRejectedValue(recoveryError);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Describe the attached image.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 1000,
      status: 'started',
      generationProtocolVersion: 1,
    });
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      JSON.stringify({
        status: 409,
        code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
        error: 'Attached resources could not be restored',
      }),
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it.each([
    ['required', 'required'],
    ['future_reason', undefined],
  ])('serializes only allowlisted workspace reason %s', async (reason, expectedReason) => {
    const workspaceError = Object.assign(new Error('Choose an attached workspace'), {
      code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
      reason,
      status: 409,
      statusCode: 409,
    });
    const initializeClient = jest.fn().mockRejectedValue(workspaceError);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Edit the project.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      JSON.stringify({
        status: 409,
        code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
        ...(expectedReason == null ? {} : { reason: expectedReason }),
        error: 'Choose an attached workspace',
      }),
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it('preserves a stateful scope policy denial in the durable initialization error', async () => {
    const policyError = Object.assign(
      new Error('Stateful code environment is not allowed by this deployment: conversation'),
      {
        code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
        status: 403,
        statusCode: 403,
      },
    );
    const initializeClient = jest.fn().mockRejectedValue(policyError);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Run code.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      JSON.stringify({
        status: 403,
        code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
        error: 'Stateful code environment is not allowed by this deployment: conversation',
      }),
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it('returns a recovery conflict when the atomic store rejects changed source content', async () => {
    const mismatch = new Error('recovery mismatch');
    mismatch.code = 'RECOVERY_PAYLOAD_MISMATCH';
    mockGenerationJobManager.createJob.mockRejectedValue(mismatch);
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Changed words',
        messageId: 'recovered-user-msg',
        clientRequestId: 'steer-recovery:server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'conversation-123',
      'user-123',
      'conversation-123',
      expect.objectContaining({
        recoveredSteerId: 'server-steer-1',
        recoveredSteerPayload: { text: 'Changed words', fileIds: [] },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RECOVERY_PAYLOAD_MISMATCH' }),
    );
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
  });

  it('restores a conditional queued send when a newer generation wins the create CAS', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ generationProtocolVersion: 2 }),
    );
    const mismatch = new Error('predecessor changed');
    mismatch.code = 'GENERATION_PREDECESSOR_MISMATCH';
    mismatch.currentJob = {
      createdAt: 2000,
      status: 'running',
      conversationId: 'conversation-123',
      verified: true,
    };
    mockGenerationJobManager.createJob.mockRejectedValue(mismatch);
    const req = {
      user: { id: 'user-123' },
      headers: { 'x-librechat-generation-protocol': '2' },
      body: {
        text: 'Queued follow-up C',
        messageId: 'queued-message-c',
        clientRequestId: 'queued-attempt-c',
        expectedPredecessorCreatedAt: 1000,
        conversationId: 'conversation-123',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'conversation-123',
      'user-123',
      'conversation-123',
      expect.objectContaining({ expectedPredecessorCreatedAt: 1000 }),
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: 'predecessor_mismatch',
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      error: 'A newer generation became current before this request could start.',
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 2000,
      predecessorVerified: true,
      active: true,
      generationProtocolVersion: 2,
    });
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'queued-attempt-c',
      'conversation-123',
      expect.objectContaining(DEFAULT_OWNED_CLAIM),
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
  });

  it('returns a finite fail-closed mismatch when predecessor evidence expired', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ generationProtocolVersion: 2 }),
    );
    const mismatch = new Error('predecessor evidence expired');
    mismatch.code = 'GENERATION_PREDECESSOR_MISMATCH';
    mismatch.currentJob = {
      createdAt: 1000,
      active: false,
      verified: false,
    };
    mockGenerationJobManager.createJob.mockRejectedValue(mismatch);
    const req = {
      user: { id: 'user-123' },
      headers: { 'x-librechat-generation-protocol': '2' },
      body: {
        text: 'Queued follow-up C',
        messageId: 'queued-message-c',
        clientRequestId: 'queued-attempt-c',
        expectedPredecessorCreatedAt: 1000,
        conversationId: 'conversation-123',
        generationProtocolVersion: 2,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: 'predecessor_mismatch',
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      error: 'The prior generation could not be verified. Please retry.',
      streamId: 'conversation-123',
      conversationId: 'conversation-123',
      generationCreatedAt: 1000,
      predecessorVerified: false,
      active: false,
      generationProtocolVersion: 2,
    });
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'queued-attempt-c',
      'conversation-123',
      expect.objectContaining(DEFAULT_OWNED_CLAIM),
    );
  });

  it('does not consume a recovered steer when client initialization fails before persistence', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ claimToken: 'recovery-claim-token' }),
    );
    const initializeClient = jest.fn().mockRejectedValue(new Error('provider init failed'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Recovered words',
        messageId: 'recovered-user-msg',
        clientRequestId: 'recovery-attempt-1',
        recoverySteerId: 'server-steer-1',
        overrideUserMessageId: 'server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'conversation-123',
      'user-123',
      'conversation-123',
      expect.objectContaining({ recoveredSteerId: 'server-steer-1' }),
    );
    expect(mockGenerationJobManager.claimGeneration).toHaveBeenCalledWith(
      'user-123',
      'recovery-attempt-1',
      'conversation-123',
      'conversation-123',
      1,
    );
    expect(req.body.overrideUserMessageId).toBe('server-steer-1__0');
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      'provider init failed',
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it('fails closed when a recovered-turn client derives skipSaveUserMessage', async () => {
    const client = {
      options: {},
      skipSaveUserMessage: true,
      sendMessage: jest.fn(),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Recovered words',
        messageId: 'recovered-user-msg',
        clientRequestId: 'steer-recovery:server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      'Recovered steer cannot skip user message persistence',
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
  });

  it('does not consume a recovered steer when the explicit normal-flow user save returns no row', async () => {
    const userMessage = {
      messageId: 'recovered-user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Recovered words',
    };
    mockSaveMessage.mockImplementation(async (_reqCtx, message) => {
      if (message?.messageId === userMessage.messageId) {
        return undefined;
      }
      return {};
    });
    let signalFinished;
    const finished = new Promise((resolve) => {
      signalFinished = resolve;
    });
    mockGenerationJobManager.finishTerminalJob.mockImplementation(async (...args) => {
      signalFinished(args);
    });
    const client = {
      options: {},
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        return {
          messageId: 'response-msg',
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'conversation-123' },
          }),
        };
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        clientRequestId: 'steer-recovery:server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    const finishArgs = await finished;

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      userMessage,
      expect.objectContaining({ context: expect.stringContaining('resumable user message') }),
    );
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'conversation-123', status: 'complete' }),
      null,
    );
    expect(finishArgs).toEqual([
      expect.objectContaining({ streamId: 'conversation-123', status: 'complete' }),
    ]);
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  it('does not consume a recovered steer when the explicit HITL user save fails', async () => {
    const userMessage = {
      messageId: 'recovered-user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Recovered words before approval',
    };
    const userSaveError = new Error('paused user row unavailable');
    mockSaveMessage.mockRejectedValue(userSaveError);
    let signalPauseFailed;
    const pauseFailed = new Promise((resolve) => {
      signalPauseFailed = resolve;
    });
    mockGenerationJobManager.failPausePersistence.mockImplementation(async (...args) => {
      signalPauseFailed(args);
      return true;
    });
    const client = {
      options: {},
      pendingApproval: { actionId: 'action-paused-save-fails' },
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        return {
          messageId: 'response-msg',
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'conversation-123' },
          }),
        };
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        clientRequestId: 'steer-recovery:server-steer-1',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    const failArgs = await pauseFailed;
    await nextTick();

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      userMessage,
      expect.objectContaining({ context: expect.stringContaining('before HITL pause') }),
    );
    expect(mockGenerationJobManager.steering.consumeRecovered).not.toHaveBeenCalled();
    expect(failArgs).toEqual([
      'conversation-123',
      'action-paused-save-fails',
      userSaveError.message,
      1000,
    ]);
    expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
      'conversation-123',
      undefined,
      undefined,
      { checkpointNamespace: '1000' },
    );
  });

  it('fails the pause when a normal user-row retry resolves without a durable row', async () => {
    const userMessage = {
      messageId: 'user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Pause only after my row is durable.',
    };
    mockSaveMessage.mockResolvedValueOnce(undefined);
    let signalPauseFailed;
    const pauseFailed = new Promise((resolve) => {
      signalPauseFailed = resolve;
    });
    mockGenerationJobManager.failPausePersistence.mockImplementation(async (...args) => {
      signalPauseFailed(args);
      return true;
    });
    const client = {
      options: {},
      pendingApproval: { actionId: 'action-normal-user-falsy' },
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        return {
          messageId: 'response-msg',
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'conversation-123' },
          }),
        };
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    const failArgs = await pauseFailed;
    await nextTick();

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      userMessage,
      expect.objectContaining({ context: expect.stringContaining('before HITL pause') }),
    );
    expect(failArgs).toEqual([
      'conversation-123',
      'action-normal-user-falsy',
      'User message could not be persisted before HITL pause',
      1000,
    ]);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  it.each([
    [
      'message row',
      { message: undefined, conversation: { conversationId: 'conversation-123' } },
      'User message could not be persisted before HITL pause',
    ],
    [
      'conversation row',
      { message: { messageId: 'user-msg' }, conversation: undefined },
      'Conversation could not be persisted before HITL pause',
    ],
  ])(
    'fails the pause when the BaseClient retry returns no %s',
    async (_label, retryResult, expectedError) => {
      const userMessage = {
        messageId: 'user-msg',
        parentMessageId: 'parent-msg',
        conversationId: 'conversation-123',
        text: 'Repair the whole user turn before approval.',
      };
      let signalPauseFailed;
      const pauseFailed = new Promise((resolve) => {
        signalPauseFailed = resolve;
      });
      mockGenerationJobManager.failPausePersistence.mockImplementation(async (...args) => {
        signalPauseFailed(args);
        return true;
      });
      const client = {
        options: {},
        pendingApproval: { actionId: 'action-base-client-retry-falsy' },
        skipSaveUserMessage: false,
        skipSaveConvo: false,
        getSaveOptions: jest.fn(() => ({ endpoint: 'agents' })),
        saveMessageToDatabase: jest.fn().mockResolvedValue(retryResult),
        sendMessage: jest.fn(async (_text, options) => {
          options.onStart(userMessage, 'response-msg');
          return {
            messageId: 'response-msg',
            databasePromise: Promise.resolve({
              conversation: { conversationId: 'conversation-123' },
            }),
          };
        }),
      };
      const req = {
        user: { id: 'user-123' },
        body: {
          text: userMessage.text,
          messageId: userMessage.messageId,
          parentMessageId: userMessage.parentMessageId,
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };

      await AgentController(
        req,
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      const failArgs = await pauseFailed;
      await nextTick();

      expect(client.saveMessageToDatabase).toHaveBeenCalledWith(
        userMessage,
        { endpoint: 'agents' },
        'user-123',
      );
      expect(failArgs).toEqual([
        'conversation-123',
        'action-base-client-retry-falsy',
        expectedError,
        1000,
      ]);
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    },
  );

  it('does not let generic cleanup touch a newer generation after paused persistence loses ownership', async () => {
    let signalPauseFailed;
    const pauseFailed = new Promise((resolve) => {
      signalPauseFailed = resolve;
    });
    mockSaveMessage.mockResolvedValue(undefined);
    mockGenerationJobManager.failPausePersistence.mockImplementation(async (...args) => {
      signalPauseFailed(args);
      return false;
    });
    const client = {
      options: {},
      jobCreatedAt: 1000,
      pendingApproval: { actionId: 'action-replaced-before-pause-save' },
      skipSaveUserMessage: true,
      sendMessage: jest.fn(async () => ({
        messageId: 'response-msg',
        content: [{ type: 'text', text: 'Waiting for approval.' }],
        databasePromise: Promise.resolve({
          conversation: { conversationId: 'conversation-123' },
        }),
      })),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Pause before the tool runs.',
        messageId: 'user-msg',
        parentMessageId: 'parent-msg',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    const failArgs = await pauseFailed;
    await nextTick();

    expect(failArgs).toEqual([
      'conversation-123',
      'action-replaced-before-pause-save',
      'Paused response could not be persisted as unfinished',
      1000,
    ]);
    expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
  });

  it('persists a paused response as unfinished before releasing its Stop/resume barrier', async () => {
    const userMessage = {
      messageId: 'user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Pause before the tool runs.',
    };
    const response = {
      messageId: 'response-msg',
      parentMessageId: userMessage.messageId,
      conversationId: 'conversation-123',
      content: [{ type: 'text', text: 'Waiting for approval.' }],
    };
    let signalPauseSaveStarted;
    const pauseSaveStarted = new Promise((resolve) => {
      signalPauseSaveStarted = resolve;
    });
    let releasePauseSave;
    const pauseSaveGate = new Promise((resolve) => {
      releasePauseSave = resolve;
    });
    mockSaveMessage.mockImplementation(async () => {
      signalPauseSaveStarted();
      await pauseSaveGate;
      return {};
    });
    let observedHookResult;
    const completedResponseWrite = jest.fn();
    const exposePendingApproval = jest.fn().mockResolvedValue(undefined);
    const client = {
      options: {},
      jobCreatedAt: 1000,
      pendingApproval: { actionId: 'action-pause-barrier' },
      exposePendingApproval,
      skipSaveUserMessage: false,
      skipSaveConvo: false,
      getSaveOptions: jest.fn(() => ({ endpoint: 'agents' })),
      saveMessageToDatabase: jest.fn().mockResolvedValue({
        message: userMessage,
        conversation: { conversationId: 'conversation-123' },
      }),
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, response.messageId);
        observedHookResult = await options.beforeResponsePersistence(response);
        response.databasePromise = observedHookResult
          ? completedResponseWrite()
          : Promise.resolve({
              persistenceSkipped: true,
              conversation: { conversationId: 'conversation-123' },
            });
        return response;
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await pauseSaveStarted;

    expect(observedHookResult).toBe(false);
    expect(completedResponseWrite).not.toHaveBeenCalled();
    expect(client.saveMessageToDatabase).toHaveBeenCalledWith(
      userMessage,
      { endpoint: 'agents' },
      'user-123',
    );
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        messageId: response.messageId,
        content: response.content,
        unfinished: true,
      }),
      expect.objectContaining({ context: expect.stringContaining('persist unfinished') }),
    );
    expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();

    releasePauseSave();
    await nextTick();
    await nextTick();

    expect(mockGenerationJobManager.approvals.ownsPausePersistence).toHaveBeenCalledWith(
      'conversation-123',
      'action-pause-barrier',
      1000,
    );
    expect(mockGenerationJobManager.approvals.finishPausePersistence).toHaveBeenCalledWith(
      'conversation-123',
      'action-pause-barrier',
      1000,
    );
    expect(mockGenerationJobManager.failPausePersistence).not.toHaveBeenCalled();
    expect(client.saveMessageToDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      mockSaveMessage.mock.invocationCallOrder[0],
    );
    expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.approvals.finishPausePersistence.mock.invocationCallOrder[0],
    );
    expect(exposePendingApproval.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.approvals.finishPausePersistence.mock.invocationCallOrder[0],
    );
    expect(mockGenerationJobManager.claimTerminalJob).not.toHaveBeenCalled();
  });

  describe('failed-turn persistence', () => {
    const conversationId = 'conversation-123';

    const createFailedRequest = (bodyOverrides = {}) => ({
      user: { id: 'user-123' },
      body: {
        text: 'Hello with a removed model.',
        messageId: 'user-message',
        parentMessageId: 'prior-response',
        conversationId,
        endpointOption: {
          endpoint: 'azureOpenAI',
          modelOptions: { model: 'gpt-4o' },
        },
        ...bodyOverrides,
      },
      config: {},
    });

    async function flushBackgroundGeneration() {
      for (let i = 0; i < 10; i++) {
        await nextTick();
      }
    }

    it('persists an initialization failure before terminal error publication', async () => {
      const events = [];
      mockSaveConvo.mockImplementation(async () => {
        events.push('turn-persisted');
        return {};
      });
      mockGenerationJobManager.completeJob.mockImplementation(
        async (_streamId, _error, _createdAt, options) => {
          await options.beforeErrorPublication();
          events.push('error-published');
          return true;
        },
      );
      const initializeClient = jest
        .fn()
        .mockRejectedValue(new Error('The model "gpt-4o" is not available.'));

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        initializeClient,
        null,
      );

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        expect.objectContaining({
          messageId: 'user-message',
          parentMessageId: 'prior-response',
          conversationId,
          text: 'Hello with a removed model.',
          isCreatedByUser: true,
          error: false,
        }),
        expect.any(Object),
      );
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        expect.objectContaining({
          messageId: 'user-message_',
          parentMessageId: 'user-message',
          conversationId,
          endpoint: 'azureOpenAI',
          model: 'gpt-4o',
          text: 'The model "gpt-4o" is not available.',
          error: true,
          isCreatedByUser: false,
        }),
        expect.any(Object),
      );
      expect(events).toEqual(['turn-persisted', 'error-published']);
      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        { conversationId },
        expect.objectContaining({ noUpsert: true }),
      );
    });

    it('allows a follow-up to chain from the persisted failed response', async () => {
      const initializeClient = jest.fn().mockRejectedValue(new Error('model unavailable'));
      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        initializeClient,
        null,
      );

      expect(mockSaveMessage.mock.calls.map(([, message]) => message.messageId)).toContain(
        'user-message_',
      );
      mockGetMessages.mockResolvedValue([{ _id: 'persisted-error-turn' }]);
      const followUpRes = createResumableResponse();

      await AgentController(
        createFailedRequest({
          text: 'Retry with a valid model.',
          messageId: 'follow-up-user',
          parentMessageId: 'user-message_',
        }),
        followUpRes,
        jest.fn(),
        initializeClient,
        null,
      );

      expect(followUpRes.status).not.toHaveBeenCalledWith(409);
      expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledTimes(2);
    });

    it('persists failures raised before generation saves any message', async () => {
      const client = {
        options: {},
        sendMessage: jest.fn().mockRejectedValue(new Error('provider exploded')),
      };

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await flushBackgroundGeneration();

      expect(mockResolveAgentTurnExecutionPlan).toHaveBeenCalledTimes(1);
      expect(mockResolveAgentTurnExecutionPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          isEvent: false,
          event: undefined,
        }),
      );
      expect(mockExecuteAgentEventActor).not.toHaveBeenCalled();
      expect(mockCreateAgentEventActionRecorder).not.toHaveBeenCalled();
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        expect.objectContaining({
          messageId: 'user-message_',
          text: 'provider exploded',
          error: true,
        }),
        expect.any(Object),
      );
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        conversationId,
        'provider exploded',
        1000,
        expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
      );
    });

    it('uses the live user identity after generation starts', async () => {
      const serverUserMessage = {
        messageId: 'server-user',
        parentMessageId: 'prior-response',
        conversationId,
        sender: 'User',
        text: 'Hello with a removed model.',
        isCreatedByUser: true,
      };
      const client = {
        options: {},
        sendMessage: jest.fn(async (_text, options) => {
          options.onStart(serverUserMessage, 'server-response-uuid');
          throw new Error('failed after onStart');
        }),
      };

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await flushBackgroundGeneration();

      const savedIds = mockSaveMessage.mock.calls.map(([, message]) => message.messageId);
      expect(savedIds).toEqual(expect.arrayContaining(['server-user', 'server-user_']));
      expect(savedIds).not.toContain('user-message_');
    });

    it('points a failed turn at the trace of the run that failed', async () => {
      const traceFields = {
        langfuseSampled: true,
        langfuseDestinationIds: ['destination-1'],
        langfuseRunId: 'server-response-uuid',
      };
      mockGetFailedTurnTraceFields.mockResolvedValue(traceFields);
      const serverUserMessage = {
        messageId: 'server-user',
        parentMessageId: 'prior-response',
        conversationId,
        sender: 'User',
        text: 'Hello with a removed model.',
        isCreatedByUser: true,
      };
      const client = {
        options: {},
        sendMessage: jest.fn(async (_text, options) => {
          options.onStart(serverUserMessage, 'server-response-uuid');
          client.run = {};
          throw new Error('failed inside the run');
        }),
      };

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await flushBackgroundGeneration();

      const errorRow = mockSaveMessage.mock.calls
        .map(([, message]) => message)
        .find((message) => message.messageId === 'server-user_');
      expect(mockGetFailedTurnTraceFields).toHaveBeenCalledWith(expect.anything(), {
        messageId: 'server-user_',
        runId: 'server-response-uuid',
        runCreated: true,
      });
      expect(errorRow).toMatchObject({ error: true, isCreatedByUser: false, ...traceFields });
    });

    it('tells the trace lookup when a failure came before the run was created', async () => {
      mockGetFailedTurnTraceFields.mockResolvedValue({});
      const client = {
        options: {},
        sendMessage: jest.fn(async (_text, options) => {
          options.onStart(
            { messageId: 'server-user', conversationId, isCreatedByUser: true, text: 'Hi' },
            'server-response-uuid',
          );
          throw new Error('failed before the run');
        }),
      };

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await flushBackgroundGeneration();

      const errorRow = mockSaveMessage.mock.calls
        .map(([, message]) => message)
        .find((message) => message.messageId === 'server-user_');
      expect(mockGetFailedTurnTraceFields).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ runCreated: false }),
      );
      expect(errorRow).toMatchObject({ error: true });
      expect(errorRow).not.toHaveProperty('langfuseSampled');
    });

    it('does not overwrite an existing response row', async () => {
      mockGetMessages.mockResolvedValue([{ _id: 'already-saved' }]);

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockRejectedValue(new Error('late failure')),
        null,
      );

      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockSaveConvo).not.toHaveBeenCalled();
    });

    it('does not persist a first turn whose code environment decision was rejected', async () => {
      const res = createResumableResponse();
      mockGenerationJobManager.claimGeneration.mockImplementation(
        async (_userId, _clientRequestId, streamId, claimedConversationId) =>
          wonGenerationClaim({ streamId, conversationId: claimedConversationId }),
      );
      const req = createFailedRequest({
        conversationId: undefined,
        clientRequestId: 'invalid-code-decision',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: undefined,
      });
      const workspaceError = Object.assign(new Error('Choose an attached workspace'), {
        code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
        reason: 'required',
        status: 409,
        statusCode: 409,
      });

      await AgentController(req, res, jest.fn(), jest.fn().mockRejectedValue(workspaceError), null);

      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(ErrorTypes.CODE_WORKSPACE_UNAVAILABLE),
        1000,
      );
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockSaveConvo).not.toHaveBeenCalled();
    });

    it('creates the conversation row for a failed first turn', async () => {
      const res = createResumableResponse();
      mockGenerationJobManager.claimGeneration.mockImplementation(
        async (_userId, _clientRequestId, streamId, claimedConversationId) =>
          wonGenerationClaim({ streamId, conversationId: claimedConversationId }),
      );
      const req = createFailedRequest({
        conversationId: undefined,
        clientRequestId: 'failed-new-conversation',
        agent_id: 'unverified-agent',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        endpointOption: {
          endpoint: 'azureOpenAI',
          agent_id: 'unverified-agent',
          modelOptions: { model: 'gpt-4o' },
          chatProjectId: '507f1f77bcf86cd799439011',
        },
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
      });
      const initializeClient = jest.fn().mockImplementation(async ({ req: request }) => {
        request._codeEnvironmentDecision = {
          mode: 'attached',
          codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
        };
        throw new Error('model unavailable');
      });

      await AgentController(req, res, jest.fn(), initializeClient, null);

      const mintedConversationId = res.json.mock.calls[0][0].conversationId;
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          messageId: 'user-message_',
          conversationId: mintedConversationId,
        }),
        expect.any(Object),
      );
      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        expect.objectContaining({
          conversationId: mintedConversationId,
          endpoint: 'azureOpenAI',
          model: 'gpt-4o',
          chatProjectId: '507f1f77bcf86cd799439011',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
        }),
        expect.objectContaining({ initialAgentId: null }),
      );
    });

    it('records the decision a failed turn of a saved chat ran under', async () => {
      const codeWorkspaces = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];
      const initializeClient = jest.fn().mockImplementation(async ({ req: request }) => {
        request._codeEnvironmentDecision = { mode: 'attached', codeWorkspaces };
        throw new Error('model unavailable');
      });

      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        initializeClient,
        null,
      );

      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        { conversationId, codeEnvironmentMode: 'attached', codeWorkspaces },
        expect.objectContaining({ noUpsert: true }),
      );
    });

    it('does not rewrite the decision a chat already holds', async () => {
      const req = createFailedRequest();
      req.resolvedConversation = {
        conversationId,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
      };
      const initializeClient = jest.fn().mockImplementation(async ({ req: request }) => {
        request._codeEnvironmentDecision = {
          mode: 'attached',
          codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-b' }],
        };
        throw new Error('model unavailable');
      });

      await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, null);

      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        { conversationId },
        expect.objectContaining({ noUpsert: true }),
      );
    });

    it('leaves a saved chat undecided when the turn resolved no decision', async () => {
      await AgentController(
        createFailedRequest(),
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockRejectedValue(new Error('model unavailable')),
        null,
      );

      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
        { conversationId },
        expect.objectContaining({ noUpsert: true }),
      );
    });
  });

  it('finalizes the failed job before releasing the idempotency claim', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    const initializeClient = jest.fn().mockRejectedValue(new Error('init boom after res.json'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Start fails after the initial JSON.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      expect.any(String),
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    // completeJob must finalize the failed job BEFORE the claim is released, or a racing
    // retry could win the key, createJob the same streamId, and be aborted by this completeJob.
    expect(mockGenerationJobManager.completeJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.releaseGeneration.mock.invocationCallOrder[0],
    );
  });

  it('still releases the claim and pending slot when completeJob fails during init-error cleanup', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    mockGenerationJobManager.completeJob.mockRejectedValue(new Error('store hiccup'));
    const initializeClient = jest.fn().mockRejectedValue(new Error('init boom after res.json'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Start fails while the store is degraded.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    // A completeJob rejection must not wedge the retry behind the claim or leak the slot.
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
  });

  it('still finalizes and releases when streaming the initialization error fails', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    mockGenerationJobManager.emitError.mockRejectedValue(new Error('publish failed'));
    const initializeClient = jest.fn().mockRejectedValue(new Error('init boom after res.json'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Start fails while Redis publish is degraded.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      'init boom after res.json',
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockStartupTelemetry.end).toHaveBeenCalledWith('error', expect.any(Error));
  });

  it('finalizes and disposes a client aborted during initialization before releasing the slot', async () => {
    const abortController = new AbortController();
    let resolveCompletion;
    let signalCompletionStarted;
    const completionStarted = new Promise((resolve) => {
      signalCompletionStarted = resolve;
    });
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController,
      emitter: { on: jest.fn() },
    });
    mockGenerationJobManager.completeJob.mockImplementation(() => {
      signalCompletionStarted();
      return new Promise((resolve) => {
        resolveCompletion = resolve;
      });
    });
    const client = { options: {} };
    const initializeClient = jest.fn(async ({ signal }) => {
      expect(signal).toBe(abortController.signal);
      abortController.abort();
      return { client };
    });
    const conversationId = 'conversation-123';
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Stop during initialization.',
        messageId: 'user-msg',
        conversationId,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    const controllerPromise = AgentController(req, res, jest.fn(), initializeClient, null);
    await completionStarted;

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      conversationId,
      'Request aborted during initialization',
      1000,
    );
    expect(mockDecrementPendingRequest).not.toHaveBeenCalled();
    expect(mockDisposeClient).not.toHaveBeenCalled();

    resolveCompletion();
    await controllerPromise;

    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockDisposeClient).toHaveBeenCalledTimes(1);
    expect(mockDisposeClient).toHaveBeenCalledWith(client);
    expect(mockStartupTelemetry.end).toHaveBeenCalledWith('aborted');
  });

  it('awaits background error finalization before releasing the slot and always disposes', async () => {
    const generationError = new Error('generation failed');
    let rejectCompletion;
    let signalCompletionStarted;
    const completionStarted = new Promise((resolve) => {
      signalCompletionStarted = resolve;
    });
    mockGenerationJobManager.completeJob.mockImplementation(() => {
      signalCompletionStarted();
      return new Promise((_, reject) => {
        rejectCompletion = reject;
      });
    });
    const client = {
      options: {},
      sendMessage: jest.fn().mockRejectedValue(generationError),
    };
    const initializeClient = jest.fn().mockResolvedValue({ client });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Fail after initialization.',
        messageId: 'user-msg',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);
    await completionStarted;

    // completeJob owns both the terminal CAS and error publication; the
    // controller must not publish before terminal ownership is established.
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockDecrementPendingRequest).not.toHaveBeenCalled();
    expect(mockDisposeClient).not.toHaveBeenCalled();

    rejectCompletion(new Error('store failed'));
    await nextTick();

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      'conversation-123',
      generationError.message,
      1000,
      expect.objectContaining({ beforeErrorPublication: expect.any(Function) }),
    );
    expect(mockGenerationJobManager.completeJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockDecrementPendingRequest.mock.invocationCallOrder[0],
    );
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockDisposeClient).toHaveBeenCalledWith(client);
  });

  it('claims terminal ownership before FINAL and always finishes the winning claim', async () => {
    const userMessage = {
      messageId: 'user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Finish normally.',
    };
    const terminalClaim = {
      streamId: 'conversation-123',
      createdAt: 1000,
      status: 'complete',
      persistencePending: true,
      drainedSteers: [],
    };
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1000,
      status: 'running',
    });
    mockGenerationJobManager.claimTerminalJob.mockResolvedValue(terminalClaim);
    let signalFinished;
    const finished = new Promise((resolve) => {
      signalFinished = resolve;
    });
    mockGenerationJobManager.finishTerminalJob.mockImplementation(async () => signalFinished());
    const client = {
      options: {},
      savedMessageIds: new Set(),
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        return {
          messageId: 'response-msg',
          parentMessageId: userMessage.messageId,
          conversationId: 'conversation-123',
          content: [{ type: 'text', text: 'Done.' }],
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'conversation-123', title: 'Existing' },
          }),
        };
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await finished;
    await nextTick();

    expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
      'conversation-123',
      'complete',
      undefined,
      1000,
      { persistencePending: true },
    );
    expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledWith(
      terminalClaim,
      expect.objectContaining({ final: true }),
    );
    expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledWith(terminalClaim);
    expect(mockGenerationJobManager.claimTerminalJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0],
    );
    expect(mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.finishTerminalJob.mock.invocationCallOrder[0],
    );
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.steering.closeAndDrain).not.toHaveBeenCalled();
  });

  it.each([
    [
      'completed',
      undefined,
      'api/server/controllers/agents/request.js - resumable response end',
      'Response message could not be persisted before terminal publication',
    ],
    [
      'unfinished preempt',
      {
        getPreemptStats: () => ({ emptyBoundaries: 1 }),
        getHaltReason: () => 'preempt_incomplete',
      },
      'api/server/controllers/agents/request.js - terminal response unfinished',
      'Terminal response could not be persisted as unfinished',
    ],
  ])(
    'publishes reconciliation when a BaseClient-marked %s response save returned no row',
    async (_label, run, expectedContext, expectedError) => {
      const userMessage = {
        messageId: 'user-msg',
        parentMessageId: 'parent-msg',
        conversationId: 'conversation-123',
        text: 'Verify terminal persistence.',
      };
      const terminalClaim = {
        streamId: 'conversation-123',
        createdAt: 1000,
        status: 'complete',
        persistencePending: true,
        drainedSteers: [],
      };
      mockGenerationJobManager.claimTerminalJob.mockResolvedValue(terminalClaim);
      mockSaveMessage.mockImplementation(async (_reqCtx, message) =>
        message?.messageId === userMessage.messageId ? {} : undefined,
      );
      let signalFinished;
      const finished = new Promise((resolve) => {
        signalFinished = resolve;
      });
      mockGenerationJobManager.finishTerminalJob.mockImplementation(async () => signalFinished());
      const client = {
        options: {},
        savedMessageIds: new Set(['response-msg']),
        skipSaveUserMessage: false,
        ...(run && { run }),
        sendMessage: jest.fn(async (_text, options) => {
          options.onStart(userMessage, 'response-msg');
          return {
            messageId: 'response-msg',
            parentMessageId: userMessage.messageId,
            conversationId: 'conversation-123',
            content: [{ type: 'text', text: 'Done.' }],
            databasePromise: Promise.resolve({
              conversation: { conversationId: 'conversation-123', title: 'Existing' },
            }),
          };
        }),
      };
      const req = {
        user: { id: 'user-123' },
        body: {
          text: userMessage.text,
          messageId: userMessage.messageId,
          parentMessageId: userMessage.parentMessageId,
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };

      await AgentController(
        req,
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await finished;
      await nextTick();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          messageId: 'response-msg',
          unfinished: _label === 'unfinished preempt',
        }),
        { context: expectedContext },
      );
      expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledWith(
        terminalClaim,
        null,
      );
      expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledWith(terminalClaim);
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Terminal persistence failed'),
        expect.objectContaining({ message: expectedError }),
      );
    },
  );

  it('suppresses the completed response write when Stop already won terminal ownership', async () => {
    const userMessage = {
      messageId: 'user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Race Stop against completion.',
    };
    let signalClaimStarted;
    const claimStarted = new Promise((resolve) => {
      signalClaimStarted = resolve;
    });
    let resolveTerminalClaim;
    const terminalClaimGate = new Promise((resolve) => {
      resolveTerminalClaim = resolve;
    });
    mockGenerationJobManager.claimTerminalJob.mockImplementation(async () => {
      signalClaimStarted();
      return terminalClaimGate;
    });
    const completedResponseWrite = jest.fn(() =>
      Promise.resolve({ conversation: { conversationId: 'conversation-123' } }),
    );
    let observedHookResult;
    const client = {
      options: {},
      savedMessageIds: new Set(),
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        const response = {
          messageId: 'response-msg',
          parentMessageId: userMessage.messageId,
          conversationId: 'conversation-123',
          content: [{ type: 'text', text: 'Stale completion.' }],
        };
        observedHookResult = await options.beforeResponsePersistence(response);
        response.databasePromise = observedHookResult
          ? completedResponseWrite()
          : Promise.resolve({ persistenceSkipped: true });
        return response;
      }),
    };
    let signalSettled;
    const settled = new Promise((resolve) => {
      signalSettled = resolve;
    });
    mockDecrementPendingRequest.mockImplementationOnce(async () => signalSettled());
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await claimStarted;
    expect(completedResponseWrite).not.toHaveBeenCalled();

    // Model the Stop endpoint winning the durable CAS while completion is
    // blocked at the exact pre-write ownership hook.
    resolveTerminalClaim(null);
    await settled;
    await nextTick();

    expect(observedHookResult).toBe(false);
    expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledTimes(1);
    expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
      'conversation-123',
      'complete',
      undefined,
      1000,
      { persistencePending: true },
    );
    expect(completedResponseWrite).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.finishTerminalJob).not.toHaveBeenCalled();
  });

  it('finishes a claimed request job when FINAL publication throws', async () => {
    const userMessage = {
      messageId: 'user-msg',
      parentMessageId: 'parent-msg',
      conversationId: 'conversation-123',
      text: 'Finish despite transport failure.',
    };
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1000, status: 'running' });
    mockGenerationJobManager.publishTerminalClaim.mockRejectedValue(
      new Error('done publish failed'),
    );
    let signalFinished;
    const finished = new Promise((resolve) => {
      signalFinished = resolve;
    });
    mockGenerationJobManager.finishTerminalJob.mockImplementation(async () => signalFinished());
    const client = {
      options: {},
      savedMessageIds: new Set(),
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'response-msg');
        return {
          messageId: 'response-msg',
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'conversation-123', title: 'Existing' },
          }),
        };
      }),
    };
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await finished;
    await nextTick();

    expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledTimes(1);
    expect(mockGenerationJobManager.finishTerminalJob.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0],
    );
  });

  it.each(['submitted', 'persisted', 'overridden'])(
    'preserves %s workspace selections in the runtime envelope',
    async (source) => {
      mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
      const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
      const codeWorkspaces = [{ environmentId: 'machine-a', workspaceId: 'project-b' }];
      const req = {
        user: { id: 'user-123' },
        ...(source !== 'submitted'
          ? { resolvedConversation: { conversationId: 'conversation-123', codeWorkspaces } }
          : {}),
        body: {
          ...(source === 'submitted' ? { codeWorkspaces } : {}),
          ...(source === 'overridden' ? { overrideConvoId: 'target-conversation' } : {}),
          text: 'Fresh submission.',
          messageId: 'user-msg',
          clientRequestId: 'req-abc',
          conversationId: 'conversation-123',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };
      const res = {
        headersSent: true,
        json: jest.fn(() => {
          res.headersSent = true;
        }),
        status: jest.fn(() => res),
        set: jest.fn(),
      };

      await AgentController(req, res, jest.fn(), initializeClient, null);

      expect(initializeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            conversationId: source === 'overridden' ? 'target-conversation' : 'conversation-123',
          }),
        }),
      );
      expect(initializeClient.mock.calls[0][0].requestBody.codeWorkspaces).toEqual(
        source === 'overridden' ? undefined : codeWorkspaces,
      );
      expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
      expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
        'conversation-123',
        'user-123',
        'conversation-123',
        expect.objectContaining({
          startupTelemetry: mockStartupTelemetry,
          initialMetadata: expect.objectContaining({
            conversationId: 'conversation-123',
            endpoint: 'agents',
          }),
        }),
      );
    },
  );

  it('retains terminal metadata for the first event in an empty bound actor thread', async () => {
    const expiredAt = new Date(Date.now() + 60_000);
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({
        streamId: 'child-conversation',
        conversationId: 'child-conversation',
      }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    mockIsSubagentOwnerAdmissible.mockResolvedValue(false);
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Continue from event.',
        messageId: 'user-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        clientRequestId: 'req-event',
        agentEventDelivery: {
          deliveryKey: 'req-event',
          expectedAction: {
            toolName: 'submit_move',
            argumentSubset: { gameId: 'game-1', expectedPly: 7 },
          },
        },
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { isTemporary: true, expiredAt },
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EVENT_ACTOR_NOT_READY' }),
    );
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledTimes(1);
    expect(mockAcquireEventChildGenerationLease).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'req-event', retentionExpiresAt: expiredAt }),
    );
    const eventJobOptions = mockGenerationJobManager.createJob.mock.calls[0][3];
    expect(eventJobOptions.initialMetadata).toEqual(
      expect.objectContaining({
        responseMessageId: 'req-event:assistant',
        userMessage: expect.objectContaining({ messageId: 'req-event:user' }),
        agentEventDeliveryKey: 'req-event',
        agentEventBindingId: 'binding-1',
        retentionExpiresAt: expiredAt.toISOString(),
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'game-1', expectedPly: 7 },
        },
      }),
    );
  });

  it('routes an enabled authenticated event through the checkpoint-fork executor', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
    });
    const client = {
      options: {},
      sendMessage: jest.fn(async () => {
        throw new Error('stop after event actor invocation started');
      }),
    };
    mockExecuteAgentEventActor.mockImplementationOnce(async (input) => {
      await input.invoke({
        checkpointNamespace: 'event-actor/fork',
        checkpointId: 'checkpoint-base',
        invocationId: 'req-event-fork',
        continuation: 'warm',
        signal: input.signal,
      });
    });
    const event = {
      id: 'game-1:ply-8',
      type: 'chess.\u202Eturn',
      occurredAt: Date.now(),
      source: { id: 'speed-chess', type: 'm\u2066cp' },
      payload: { gameId: 'game-1', expectedPly: 8 },
    };
    const req = {
      user: { id: 'user-123', tenantId: '' },
      body: {
        text: 'Play the next move.',
        clientRequestId: 'req-event-fork',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-fork',
          target: { bindingId: 'binding-1' },
          event,
          expectedAction: { toolName: 'submit_\u200Fmove', argumentSubset: { expectedPly: 8 } },
        },
      },
      config: {
        endpoints: { agents: {} },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: undefined,
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await nextTick();

    expect(mockResolveAgentTurnExecutionPlan).toHaveBeenCalledTimes(1);
    expect(mockResolveAgentTurnExecutionPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'child-conversation',
        isNewConversation: false,
        canPause: false,
      }),
    );
    expect(mockExecuteAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'child-conversation',
        invocationId: 'req-event-fork',
        event,
        expectedAction: { toolName: 'submit_\u200Fmove', argumentSubset: { expectedPly: 8 } },
      }),
      expect.objectContaining({
        getSnapshot: expect.any(Function),
        commitState: expect.any(Function),
        recordReconciliation: expect.any(Function),
        resolveReconciliation: expect.any(Function),
        clearReconciliation: expect.any(Function),
        admitAction: expect.any(Function),
        releaseAction: expect.any(Function),
        hasActionAdmission: expect.any(Function),
        getReceipt: expect.any(Function),
      }),
    );
    expect(mockExecuteAgentEventActor.mock.calls[0][0]).not.toHaveProperty('tenantId');
    expect(req._agentEventTriggerProjection).toEqual({
      version: 1,
      eventType: 'chess. turn',
      sourceType: 'm cp',
      occurredAt: new Date(event.occurredAt),
      expectedActionToolName: 'submit_ move',
    });
    expect(client).toMatchObject({
      checkpointNamespace: 'event-actor/fork',
      eventActorCheckpointId: 'checkpoint-base',
      eventActorInvocationId: 'req-event-fork',
      eventActorContinuation: 'warm',
    });
  });

  it('prefers the execution-time action receipt over lagging run steps', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
    });
    mockFindAgentEventAppliedAction.mockReturnValue(undefined);
    let observedRead;
    mockExecuteAgentEventActor.mockImplementationOnce(async (input) => {
      await input.invoke({
        checkpointNamespace: 'event-actor/fork',
        checkpointId: 'checkpoint-base',
        invocationId: 'req-event-receipt',
        continuation: 'warm',
        signal: input.signal,
      });
      observedRead = input.readAppliedAction();
      throw new Error('stop after evidence read');
    });
    const req = {
      user: { id: 'user-123', tenantId: '' },
      body: {
        text: 'Play the next move.',
        clientRequestId: 'req-event-receipt',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-receipt',
          target: { bindingId: 'binding-1' },
          event: {
            id: 'game-1:ply-9',
            type: 'chess.turn',
            occurredAt: Date.now(),
            source: { id: 'speed-chess', type: 'mcp' },
          },
          expectedAction: { toolName: 'submit_move', argumentSubset: { expectedPly: 9 } },
        },
      },
      config: {
        endpoints: { agents: {} },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: undefined,
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };
    /** Reproduces the observed race: the tool executed (graph context fires
     * the observer during sendMessage) but the run-step collection is still
     * empty when the executor reads evidence right after resolution. */
    const client = {
      options: {},
      sendMessage: jest.fn(async () => {
        req._agentEventActionObserver({
          input: { expectedPly: 9 },
          output: { name: 'submit_move', tool_call_id: 'call-9', content: '{"ok":true}' },
        });
        return {};
      }),
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await nextTick();

    expect(mockExecuteAgentEventActor).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentEventActionRecorder).toHaveBeenCalledWith({
      toolName: 'submit_move',
      argumentSubset: { expectedPly: 9 },
    });
    expect(typeof req._agentEventActionObserver).toBe('function');
    expect(observedRead).toEqual({ toolName: 'submit_move', toolCallId: 'call-9' });
    expect(mockFindAgentEventAppliedAction).not.toHaveBeenCalled();
  });

  it('resumes the original actor suspension from exact detached terminal evidence', async () => {
    mockGenerationJobManager.isRedis = true;
    mockGenerationJobManager.detachedAgentEventActionStoreMode = 'distributed';
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 2000,
      metadata: {
        checkpointNamespace: '2000',
        providerExecutionId: 'provider-segment-2',
        providerDrained: true,
      },
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: { on: jest.fn() },
    });
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    const suspension = {
      version: 1,
      suspensionId: 'suspension-detached-1',
      attempt: 0,
      invocation: { invocationId: 'original-delivery-1' },
    };
    mockGetAgentEventActorSnapshot.mockResolvedValue({
      state: null,
      reconciliations: [],
      suspension: {
        kind: 'internal_completion',
        suspension,
        actionId: 'task-detached-1',
        status: 'pending',
      },
    });
    mockGetAgentEventActorDetachedAction.mockResolvedValue({
      invocationId: 'original-delivery-1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-detached-1',
      taskId: 'task-detached-1',
      idempotencyKey: 'a'.repeat(64),
      status: 'succeeded',
      result: 'move accepted',
    });
    const repaused = { kind: 'internal_completion', actionId: 'task-detached-2' };
    mockCreateAgentEventActorDetachedActionLifecycle.mockReturnValueOnce({
      readSuspension: () => repaused,
    });
    mockResumeAgentEventActor.mockImplementationOnce(async (input) => {
      expect(input.readSuspension()).toBe(repaused);
      throw new Error('stop after resume contract');
    });
    const client = { options: { agent: {} }, sendMessage: jest.fn() };
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Trusted detached completion.',
        clientRequestId: 'detached-resume-generation-1',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'detached-resume-generation-1',
          target: { bindingId: 'binding-1' },
          expectedAction: { toolName: 'submit_move' },
          event: {
            id: 'task-detached-1',
            type: 'librechat.event_actor.detached_completion',
            occurredAt: Date.now(),
            source: { id: 'librechat-event-actor', type: 'internal' },
          },
          internalCompletion: {
            version: 1,
            invocationId: 'original-delivery-1',
            generationCreatedAt: 1000,
            wakeGenerationCreatedAt: 2000,
            taskId: 'task-detached-1',
            idempotencyKey: 'a'.repeat(64),
          },
        },
      },
      config: { endpoints: { agents: {} } },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    await nextTick();

    expect(mockExecuteAgentEventActor).not.toHaveBeenCalled();
    expect(mockResumeAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'child-conversation',
        bindingId: 'binding-1',
        suspension,
        resumeAttemptId: 'detached-resume-generation-1',
        resumeValue: expect.objectContaining({
          taskId: 'task-detached-1',
          status: 'succeeded',
          result: 'move accepted',
        }),
      }),
      expect.objectContaining({
        claimSuspension: expect.any(Function),
        settleSuspension: expect.any(Function),
      }),
    );
    expect(mockGetAgentEventActorDetachedAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'original-delivery-1',
        generationCreatedAt: 1000,
      }),
    );
    expect(mockCreateAgentEventActorDetachedActionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        generationCreatedAt: 1000,
        turnCreatedAt: 2000,
      }),
      expect.any(Object),
    );
    const lifecycleDependencies =
      mockCreateAgentEventActorDetachedActionLifecycle.mock.calls.at(-1)[1];
    expect(lifecycleDependencies.storeMode()).toBe('distributed');
    mockGenerationJobManager.detachedAgentEventActionStoreMode = 'process_local';
    expect(lifecycleDependencies.storeMode()).toBe('process_local');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      'child-conversation',
      'user-123',
      'child-conversation',
      expect.objectContaining({
        initialMetadata: expect.objectContaining({
          agentEventDeliveryKey: 'detached-resume-generation-1',
          agentEventInvocationKey: 'original-delivery-1',
          agentEventInvocationGenerationCreatedAt: 1000,
          agentEventDetachedActionProducerRequired: true,
        }),
      }),
    );
  });

  it('records reconciliation when persistence fails after an event action commits', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    const checkpoint = {
      threadId: 'child-conversation',
      checkpointId: 'checkpoint-applied',
      checkpointNs: 'event-actor/applied',
    };
    mockExecuteAgentEventActor.mockResolvedValueOnce({
      value: {
        messageId: 'req-event-persistence:assistant',
        databasePromise: Promise.resolve().then(() => {
          throw new Error('response persistence unavailable');
        }),
      },
      execution: {
        status: 'applied',
        continuation: 'warm',
        head: { actorThreadId: 'child-conversation', generation: 2, checkpoint },
        result: { action: { toolName: 'submit_move', toolCallId: 'call-move' } },
      },
    });
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Play the next move.',
        clientRequestId: 'req-event-persistence',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-persistence',
          target: { bindingId: 'binding-1' },
          event: {
            id: 'event-persistence',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
          expectedAction: { toolName: 'submit_move' },
        },
      },
      config: {
        endpoints: { agents: {} },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client: { options: {} } }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockRecordAgentEventActorReconciliation.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }

    expect(mockExecuteAgentEventActor).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[event-actor] Bound child event completed',
      expect.any(Object),
    );
    expect(mockRecordAgentEventActorReconciliation).toHaveBeenCalledWith({
      user: 'user-123',
      tenantId: 'tenant-1',
      conversationId: 'child-conversation',
      reconciliation: expect.objectContaining({
        invocationId: 'req-event-persistence',
        status: 'persistence_failed',
        checkpoint,
        action: { toolName: 'submit_move', toolCallId: 'call-move' },
      }),
    });
  });

  it('records the applied actor history barrier only after both deterministic messages persist', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    const checkpoint = {
      threadId: 'child-conversation',
      checkpointId: 'checkpoint-applied',
      checkpointNs: 'event-actor/applied',
    };
    const userMessage = {
      messageId: 'req-event-success:user',
      parentMessageId: 'parent-message',
      conversationId: 'child-conversation',
      text: 'Play the next move.',
    };
    const client = {
      options: {},
      skipSaveUserMessage: false,
      sendMessage: jest.fn(async (_text, options) => {
        options.onStart(userMessage, 'req-event-success:assistant');
        return {
          messageId: 'req-event-success:assistant',
          text: 'Move submitted.',
          databasePromise: Promise.resolve({
            conversation: { conversationId: 'child-conversation' },
          }),
        };
      }),
    };
    mockExecuteAgentEventActor.mockImplementationOnce(async (input) => ({
      value: await input.invoke({
        checkpointNamespace: checkpoint.checkpointNs,
        checkpointId: checkpoint.checkpointId,
        invocationId: 'req-event-success',
        continuation: 'warm',
        signal: input.signal,
      }),
      execution: {
        status: 'applied',
        continuation: 'warm',
        head: { actorThreadId: 'child-conversation', generation: 2, checkpoint },
        result: { action: { toolName: 'submit_move', toolCallId: 'call-move' } },
      },
    }));
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: userMessage.text,
        clientRequestId: 'req-event-success',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-success',
          target: { bindingId: 'binding-1' },
          event: {
            id: 'event-success',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
          expectedAction: { toolName: 'submit_move' },
        },
      },
      config: {
        endpoints: { agents: {} },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockRecordAgentEventActorReconciliation.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ messageId: 'req-event-success:user' }),
      expect.any(Object),
    );
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ messageId: 'req-event-success:assistant' }),
      expect.any(Object),
    );
    expect(mockRecordAgentEventActorReconciliation).toHaveBeenCalledWith({
      user: 'user-123',
      tenantId: 'tenant-1',
      conversationId: 'child-conversation',
      reconciliation: {
        invocationId: 'req-event-success',
        status: 'history_persisted',
        checkpoint,
        action: { toolName: 'submit_move', toolCallId: 'call-move' },
        actionAdmitted: true,
        observedAt: expect.any(Date),
      },
    });
    const lastMessageWrite = Math.max(...mockSaveMessage.mock.invocationCallOrder);
    expect(lastMessageWrite).toBeLessThan(
      mockRecordAgentEventActorReconciliation.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [
      'tool approval',
      { toolDefinitions: [] },
      {
        toolApproval: { enabled: true },
      },
      undefined,
      undefined,
    ],
    [
      'primary ask_user_question',
      { toolDefinitions: [{ name: 'ask_user_question' }] },
      {},
      undefined,
      undefined,
    ],
    [
      'added-agent ask_user_question',
      { toolDefinitions: [] },
      {},
      new Map([['added-agent', { toolDefinitions: [{ name: 'ask_user_question' }] }]]),
      undefined,
    ],
    [
      'memory-checkpointer',
      { toolDefinitions: [] },
      {
        checkpointer: { type: 'memory' },
      },
      undefined,
      undefined,
    ],
    [
      'background-capable expected action',
      { toolDefinitions: [], backgroundToolNames: ['submit_move_mcp_chess'] },
      {},
      undefined,
      undefined,
    ],
    [
      'pre-capability pause consumer fleet',
      { toolDefinitions: [] },
      { toolApproval: { enabled: true } },
      undefined,
      undefined,
      1,
    ],
  ])(
    'routes %s event actors through the compatible continuation path',
    async (_label, agent, config, agentConfigs, clientOptions, generationProtocolVersion = 2) => {
      mockGenerationJobManager.claimGeneration.mockResolvedValue(
        wonGenerationClaim({
          streamId: 'child-conversation',
          conversationId: 'child-conversation',
          generationProtocolVersion,
        }),
      );
      mockGenerationJobManager.createJob.mockResolvedValueOnce({
        createdAt: 1000,
        metadata: {
          checkpointNamespace: '1000',
          providerExecutionId: 'provider-segment-1',
          providerDrained: true,
          generationProtocolVersion,
        },
        readyPromise: Promise.resolve(),
        abortController: new AbortController(),
        emitter: { on: jest.fn() },
      });
      mockGetConvo.mockResolvedValue({
        conversationId: 'parent-conversation',
        agent_id: 'parent-agent',
        tenantId: 'tenant-1',
      });
      const client = {
        options: { agent, ...(clientOptions ?? {}) },
        agentConfigs,
        sendMessage: jest.fn(async () => {
          throw new Error('stop after legacy event invocation started');
        }),
      };
      const shouldCheckpoint =
        _label !== 'memory-checkpointer' && _label !== 'pre-capability pause consumer fleet';
      if (shouldCheckpoint) {
        mockExecuteAgentEventActor.mockImplementationOnce(async (input) => {
          await input.invoke({
            checkpointNamespace: 'event-actor/pause-capable',
            checkpointId: 'checkpoint-pause-capable',
            invocationId: 'req-event-hitl',
            continuation: 'warm',
            signal: input.signal,
          });
        });
      }
      const req = {
        user: { id: 'user-123', tenantId: 'tenant-1' },
        body: {
          text: 'Continue with a pause-capable actor.',
          clientRequestId: 'req-event-hitl',
          conversationId: 'child-conversation',
          generationProtocolVersion,
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
          agentEventDelivery: {
            deliveryKey: 'req-event-hitl',
            target: { bindingId: 'binding-1' },
            expectedAction: { toolName: 'submit_move' },
            event: {
              id: 'event-hitl',
              type: 'test.event',
              occurredAt: Date.now(),
              source: { id: 'test', type: 'api' },
              payload: {},
            },
          },
        },
        config: { endpoints: { agents: config } },
        _isAgentTrigger: true,
        _agentEventBindingId: 'binding-1',
        _agentEventBindingParentConversationId: 'parent-conversation',
        _agentEventBindingParentAgentId: 'parent-agent',
        _agentEventBindingTenantId: 'tenant-1',
        _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
      };

      await AgentController(
        req,
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        null,
      );
      await nextTick();

      if (shouldCheckpoint) {
        expect(mockExecuteAgentEventActor).toHaveBeenCalled();
        expect(mockGetMessages).not.toHaveBeenCalled();
        expect(mockBeginAgentEventActorLegacyTurn).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.updateMetadata).not.toHaveBeenCalledWith(
          'child-conversation',
          expect.objectContaining({ agentEventLegacyTurnToken: expect.any(String) }),
          1000,
        );
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        return;
      }
      expect(mockExecuteAgentEventActor).not.toHaveBeenCalled();
      expect(mockBeginAgentEventActorLegacyTurn).toHaveBeenCalledWith({
        user: 'user-123',
        tenantId: 'tenant-1',
        conversationId: 'child-conversation',
        token: expect.any(String),
      });
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      /** The fence must open before execution and close only after this
       * turn's history is durable, under the same token. */
      const fenceToken = mockBeginAgentEventActorLegacyTurn.mock.calls[0][0].token;
      expect(mockBeginAgentEventActorLegacyTurn.mock.invocationCallOrder[0]).toBeLessThan(
        client.sendMessage.mock.invocationCallOrder[0],
      );
      expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
        'child-conversation',
        { agentEventLegacyTurnToken: fenceToken },
        1000,
      );
      expect(mockGenerationJobManager.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(
        client.sendMessage.mock.invocationCallOrder[0],
      );
      expect(mockCompleteAgentEventActorLegacyTurn).toHaveBeenCalledWith({
        user: 'user-123',
        tenantId: 'tenant-1',
        conversationId: 'child-conversation',
        token: fenceToken,
      });
      expect(mockCompleteAgentEventActorLegacyTurn.mock.invocationCallOrder[0]).toBeGreaterThan(
        client.sendMessage.mock.invocationCallOrder[0],
      );
    },
  );

  it('retains local fence ownership when Redis metadata persistence fails', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    mockGenerationJobManager.updateMetadata.mockRejectedValueOnce(
      new Error('redis metadata unavailable'),
    );
    const client = {
      options: {
        agent: {
          toolDefinitions: [],
          backgroundToolNames: ['submit_move'],
        },
      },
      sendMessage: jest.fn(),
    };
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Persist ownership before Redis metadata.',
        clientRequestId: 'req-event-metadata-failure',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-metadata-failure',
          target: { bindingId: 'binding-1' },
          expectedAction: { toolName: 'submit_move' },
          event: {
            id: 'event-metadata-failure',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
        },
      },
      config: {
        endpoints: { agents: { checkpointer: { type: 'memory' } } },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockCompleteAgentEventActorLegacyTurn.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }

    const fenceToken = mockBeginAgentEventActorLegacyTurn.mock.calls[0][0].token;
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mockCompleteAgentEventActorLegacyTurn).toHaveBeenCalledWith({
      user: 'user-123',
      tenantId: 'tenant-1',
      conversationId: 'child-conversation',
      token: fenceToken,
    });
  });

  it('does not execute a legacy event turn when its durable fence is not acquired', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    mockBeginAgentEventActorLegacyTurn.mockResolvedValueOnce(false);
    const client = {
      options: {
        agent: {
          toolDefinitions: [],
          backgroundToolNames: ['submit_move'],
        },
      },
      sendMessage: jest.fn(async () => ({ messageId: 'must-not-run' })),
    };
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Do not run without the fence.',
        clientRequestId: 'req-event-fence-lost',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-fence-lost',
          target: { bindingId: 'binding-1' },
          expectedAction: { toolName: 'submit_move' },
          event: {
            id: 'event-fence-lost',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
        },
      },
      config: {
        endpoints: { agents: { checkpointer: { type: 'memory' } } },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockBeginAgentEventActorLegacyTurn.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }

    expect(mockBeginAgentEventActorLegacyTurn).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the legacy event fence open when failed-turn persistence cannot complete', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    mockGenerationJobManager.completeJob.mockRejectedValueOnce(new Error('job store unavailable'));
    const client = {
      options: {
        agent: {
          toolDefinitions: [],
          backgroundToolNames: ['submit_move'],
        },
      },
      sendMessage: jest.fn(async () => {
        throw new Error('provider failed');
      }),
    };
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Persist the failed turn before releasing the fence.',
        clientRequestId: 'req-event-error-persistence',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-error-persistence',
          target: { bindingId: 'binding-1' },
          expectedAction: { toolName: 'submit_move' },
          event: {
            id: 'event-error-persistence',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
        },
      },
      config: {
        endpoints: { agents: { checkpointer: { type: 'memory' } } },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockGenerationJobManager.completeJob.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }
    await nextTick();

    expect(mockBeginAgentEventActorLegacyTurn).toHaveBeenCalledTimes(1);
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledTimes(1);
    expect(mockCompleteAgentEventActorLegacyTurn).not.toHaveBeenCalled();
  });

  it('does not replay a stale ambiguous legacy fence based only on age', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({ streamId: 'child-conversation', conversationId: 'child-conversation' }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: 'tenant-1',
    });
    mockBeginAgentEventActorLegacyTurn.mockResolvedValueOnce(false);
    mockGetAgentEventActorSnapshot.mockResolvedValueOnce({
      state: null,
      reconciliations: [],
      epoch: 0,
      legacyTurn: {
        token: 'crashed-legacy-turn',
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const client = {
      options: {
        agent: {
          toolDefinitions: [],
          backgroundToolNames: ['submit_move'],
        },
      },
      sendMessage: jest.fn(async () => {
        throw new Error('stop after recovered execution starts');
      }),
    };
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'Recover the abandoned legacy fence.',
        clientRequestId: 'req-event-stale-legacy',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        agentEventDelivery: {
          deliveryKey: 'req-event-stale-legacy',
          target: { bindingId: 'binding-1' },
          expectedAction: { toolName: 'submit_move' },
          event: {
            id: 'event-stale-legacy',
            type: 'test.event',
            occurredAt: Date.now(),
            source: { id: 'test', type: 'api' },
            payload: {},
          },
        },
      },
      config: {
        endpoints: { agents: { checkpointer: { type: 'memory' } } },
      },
      _isAgentTrigger: true,
      _agentEventBindingId: 'binding-1',
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { expiredAt: new Date(Date.now() + 60_000) },
    };

    await AgentController(
      req,
      createResumableResponse(),
      jest.fn(),
      jest.fn().mockResolvedValue({ client }),
      null,
    );
    for (
      let attempt = 0;
      attempt < 20 && mockBeginAgentEventActorLegacyTurn.mock.calls.length === 0;
      attempt++
    ) {
      await nextTick();
    }

    expect(mockBeginAgentEventActorLegacyTurn).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the guard-normalized tenant for a legacy untenanted event actor', async () => {
    const expiredAt = new Date(Date.now() + 60_000);
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({
        streamId: 'child-conversation',
        conversationId: 'child-conversation',
      }),
    );
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
    });
    const req = {
      user: { id: 'user-123', tenantId: '' },
      body: {
        text: 'Continue from an old untenanted binding.',
        messageId: 'user-msg',
        clientRequestId: 'req-event-legacy',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: undefined,
      _agentEventBindingRetention: { isTemporary: true, expiredAt },
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(mockAcquireEventChildGenerationLease).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined, retentionExpiresAt: expiredAt }),
    );
  });

  it('does not start an event actor whose inherited binding expired after the guard', async () => {
    const expiredAt = new Date(Date.now() - 1);
    mockGenerationJobManager.claimGeneration.mockResolvedValue(
      wonGenerationClaim({
        streamId: 'child-conversation',
        conversationId: 'child-conversation',
      }),
    );
    mockAcquireEventChildGenerationLease.mockResolvedValue(null);
    const req = {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      body: {
        text: 'This event arrived too late.',
        messageId: 'user-msg',
        clientRequestId: 'req-event-expired',
        conversationId: 'child-conversation',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: 'tenant-1',
      _agentEventBindingRetention: { isTemporary: true, expiredAt },
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EVENT_BINDING_PARENT_ENDED' }),
    );
    expect(mockIsSubagentOwnerAdmissible).not.toHaveBeenCalled();
  });

  it('releases the idempotency claim on a 429 only when it won the claim', async () => {
    mockGenerationJobManager.claimGeneration.mockResolvedValue(wonGenerationClaim());
    mockCheckAndIncrementPendingRequest.mockResolvedValue({
      allowed: false,
      pendingRequests: 3,
      limit: 2,
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Over the limit.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockGenerationJobManager.releaseGeneration).toHaveBeenCalledWith(
      'user-123',
      'req-abc',
      'conversation-123',
      DEFAULT_OWNED_CLAIM,
    );
    expect(mockStartupTelemetry.end).toHaveBeenCalledWith('rejected');
  });

  it('fails closed before the limiter when generation ownership is ambiguous', async () => {
    mockGenerationJobManager.claimGeneration.mockRejectedValue(new Error('redis down'));
    mockCheckAndIncrementPendingRequest.mockResolvedValue({
      allowed: false,
      pendingRequests: 3,
      limit: 2,
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Duplicate while the original runs.',
        messageId: 'user-msg',
        clientRequestId: 'req-abc',
        conversationId: 'conversation-123',
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
    const res = { json: jest.fn(), status: jest.fn(() => res), set: jest.fn() };

    await AgentController(req, res, jest.fn(), jest.fn(), null);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_NOT_READY' }));
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.releaseGeneration).not.toHaveBeenCalled();
  });

  describe('immediate title persistence gate', () => {
    const { Constants } = require('librechat-data-provider');

    /**
     * Starts a first turn that stays mid-run until the returned `release` is
     * called, so the gate an immediate title waits on can be observed while the
     * generation is still going. `userMessageWrite` is what the client hands back
     * through `getReqData`, exactly as BaseClient does once it has started the
     * user-message write.
     */
    const startHeldFirstTurn = async ({ userMessageWrite, clientOverrides, responseWrite }) => {
      let signalFinished;
      const finished = new Promise((resolve) => {
        signalFinished = resolve;
      });
      mockGenerationJobManager.finishTerminalJob.mockImplementation(async () => signalFinished());

      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });

      let convoReadyResolved = false;
      const addTitle = jest.fn(async (_req, options) => {
        void options?.convoReady?.then(() => {
          convoReadyResolved = true;
        });
      });

      let turnConversationId;
      const client = {
        options: {},
        savedMessageIds: new Set(),
        skipSaveUserMessage: false,
        ...clientOverrides,
        sendMessage: jest.fn(async (_text, options) => {
          turnConversationId = options.conversationId;
          const userMessage = {
            messageId: 'user-msg',
            parentMessageId: Constants.NO_PARENT,
            conversationId: options.conversationId,
            text: 'First message',
          };
          options.onStart(userMessage, 'response-msg');
          options.getReqData({ userMessagePromise: userMessageWrite(options.conversationId) });
          await held;
          return {
            messageId: 'response-msg',
            parentMessageId: 'user-msg',
            conversationId: options.conversationId,
            content: [{ type: 'text', text: 'Answer' }],
            databasePromise: Promise.resolve(
              responseWrite
                ? responseWrite(options.conversationId)
                : {
                    message: { _id: 'response-row-id' },
                    conversation: { conversationId: options.conversationId, title: null },
                  },
            ),
          };
        }),
      };

      await AgentController(
        {
          user: { id: 'user-123' },
          body: {
            text: 'First message',
            messageId: 'user-msg',
            parentMessageId: Constants.NO_PARENT,
            conversationId: 'new',
            endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
          },
          config: {},
        },
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        addTitle,
      );
      await nextTick();
      await nextTick();

      return {
        addTitle,
        conversationId: () => turnConversationId,
        isConvoReadyResolved: () => convoReadyResolved,
        finish: async () => {
          release();
          await finished;
          await nextTick();
          await nextTick();
        },
      };
    };

    /** The bug this covers: gating the title's save on the end of the turn left
     *  the row on "New Chat" for the whole run, so every reader without the live
     *  stream — a reloaded tab, the sidebar on another device — read the
     *  placeholder until the turn finished. */
    it('lets an immediate title persist as soon as the user message write creates the row', async () => {
      const turn = await startHeldFirstTurn({
        userMessageWrite: (conversationId) =>
          Promise.resolve({ message: { messageId: 'user-msg' }, conversation: { conversationId } }),
      });

      expect(turn.addTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.finishTerminalJob).not.toHaveBeenCalled();
      expect(turn.isConvoReadyResolved()).toBe(true);

      await turn.finish();
    });

    it('keeps the title waiting until the turn ends when no conversation was persisted', async () => {
      const turn = await startHeldFirstTurn({
        userMessageWrite: () => Promise.resolve({}),
      });

      expect(turn.addTitle).toHaveBeenCalledTimes(1);
      expect(turn.isConvoReadyResolved()).toBe(false);

      await turn.finish();

      expect(turn.isConvoReadyResolved()).toBe(true);
    });

    /** The reference repair the title's save used to perform as a side effect of
     *  rebuilding the whole `messages` array. The title now writes metadata only, so
     *  the recovered user row has to carry its own reference. */
    describe('recovered user message reference', () => {
      /** Distinct rows, so one reference says nothing about the other. */
      beforeEach(() => {
        mockSaveMessage.mockImplementation(async (_ctx, message) => ({
          _id: message.messageId === 'response-msg' ? 'response-row-id' : 'user-row-id',
        }));
      });

      const appendedIdsFor = (conversationId) =>
        mockAppendConvoMessageReference.mock.calls
          .filter((call) => call[1] === conversationId)
          .map((call) => call[2]);

      it('appends the recovered reference when no write reported the conversation', async () => {
        const turn = await startHeldFirstTurn({
          /** BaseClient swallows a failed user-message save and resolves with `{}`. */
          userMessageWrite: () => Promise.resolve({}),
        });

        await turn.finish();

        expect(appendedIdsFor(turn.conversationId())).toEqual(['user-row-id']);
        expect(mockAppendConvoMessageReference).toHaveBeenCalledWith(
          'user-123',
          turn.conversationId(),
          'user-row-id',
        );
      });

      it('does not append again when the write already recorded the reference', async () => {
        const turn = await startHeldFirstTurn({
          userMessageWrite: (conversationId) =>
            Promise.resolve({
              message: { _id: 'user-row-id' },
              conversation: { conversationId },
            }),
        });

        await turn.finish();

        expect(appendedIdsFor(turn.conversationId())).toEqual([]);
      });

      /** `saveMessage` can resolve falsy without throwing, and the conversation is still
       *  written and reported with nothing appended. The row existing is not evidence
       *  that this turn is referenced by it. */
      it('appends when the write reported the row but appended no message', async () => {
        const turn = await startHeldFirstTurn({
          userMessageWrite: (conversationId) =>
            Promise.resolve({ message: undefined, conversation: { conversationId } }),
        });

        await turn.finish();

        expect(appendedIdsFor(turn.conversationId())).toEqual(['user-row-id']);
      });

      /** The response row has the same exposure: its write can report the conversation
       *  while appending nothing, and its terminal retry is also a bare `saveMessage`. */
      it('appends the recovered response reference when its write appended nothing', async () => {
        const turn = await startHeldFirstTurn({
          userMessageWrite: (conversationId) =>
            Promise.resolve({
              message: { _id: 'user-row-id' },
              conversation: { conversationId },
            }),
          /** The response write reports the row without appending its id. */
          responseWrite: (conversationId) => ({
            conversation: { conversationId, title: null },
          }),
        });

        await turn.finish();

        expect(appendedIdsFor(turn.conversationId())).toEqual(['response-row-id']);
      });

      /** A first turn that pauses for approval never reaches the terminal, so its rows
       *  cannot wait for one. The paused response is saved bare, and the title write that
       *  used to rebuild the array in passing no longer does. */
      describe('a first turn paused for approval', () => {
        const runPausedFirstTurn = async ({ clientOverrides } = {}) => {
          mockGenerationJobManager.approvals.ownsPausePersistence.mockResolvedValue(true);
          const client = {
            options: {},
            savedMessageIds: new Set(),
            skipSaveUserMessage: false,
            pendingApproval: { actionId: 'action-paused-reference' },
            ...clientOverrides,
            sendMessage: jest.fn(async (_text, options) => {
              options.onStart(
                {
                  messageId: 'user-msg',
                  parentMessageId: Constants.NO_PARENT,
                  conversationId: options.conversationId,
                  text: 'First message',
                },
                'response-msg',
              );
              options.getReqData({
                userMessagePromise: Promise.resolve({
                  message: { _id: 'user-row-id' },
                  conversation: { conversationId: options.conversationId },
                }),
              });
              return { messageId: 'response-msg', conversationId: options.conversationId };
            }),
          };

          await AgentController(
            {
              user: { id: 'user-123' },
              body: {
                text: 'First message',
                messageId: 'user-msg',
                parentMessageId: Constants.NO_PARENT,
                conversationId: 'new',
                endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
              },
              config: {},
            },
            createResumableResponse(),
            jest.fn(),
            jest.fn().mockResolvedValue({ client }),
            jest.fn(async () => {}),
          );
          await nextTick();
          await nextTick();
        };

        it('appends the paused response reference', async () => {
          await runPausedFirstTurn();

          expect(mockAppendConvoMessageReference).toHaveBeenCalledTimes(1);
          expect(mockAppendConvoMessageReference).toHaveBeenCalledWith(
            'user-123',
            expect.any(String),
            'response-row-id',
          );
        });

        /** The BaseClient re-save reports its own conversation write, which the signal
         *  never saw through `getReqData`, so it must not be appended twice. */
        it('does not append the user reference its re-save already recorded', async () => {
          await runPausedFirstTurn({
            clientOverrides: {
              getSaveOptions: () => ({}),
              saveMessageToDatabase: jest.fn().mockResolvedValue({
                message: { _id: 'user-row-id' },
                conversation: { conversationId: 'convo-paused' },
              }),
            },
          });

          const appended = mockAppendConvoMessageReference.mock.calls.map((call) => call[2]);
          expect(appended).toEqual(['response-row-id']);
        });
      });

      it('leaves the conversation alone for a turn that does not save one', async () => {
        const turn = await startHeldFirstTurn({
          userMessageWrite: () => Promise.resolve({ message: {} }),
          clientOverrides: { skipSaveConvo: true },
        });

        await turn.finish();

        expect(appendedIdsFor(turn.conversationId())).toEqual([]);
      });
    });
  });

  describe('preempt-incomplete title gating', () => {
    const { Constants } = require('librechat-data-provider');
    const { resolveTitleTiming } = require('@librechat/api');

    /** An empty preempt boundary ends the turn truncated — the response is
     *  persisted `unfinished`, so it must follow the abort title contract. */
    const preemptIncompleteRun = {
      getPreemptStats: () => ({ emptyBoundaries: 1 }),
      getHaltReason: () => 'preempt_incomplete',
    };

    const runFirstTurn = async ({
      run,
      addTitle: suppliedAddTitle,
      clientOverrides,
      databaseResult,
      responseContent = [{ type: 'text', text: 'Truncated answer' }],
    } = {}) => {
      let signalFinished;
      const finished = new Promise((resolve) => {
        signalFinished = resolve;
      });
      mockGenerationJobManager.finishTerminalJob.mockImplementation(async () => signalFinished());

      let titleSignal;
      const addTitle =
        suppliedAddTitle ??
        jest.fn(async (_req, options) => {
          titleSignal = options?.signal;
        });

      const client = {
        options: {},
        savedMessageIds: new Set(),
        skipSaveUserMessage: false,
        ...(run && { run }),
        ...clientOverrides,
        sendMessage: jest.fn(async (_text, options) => {
          const userMessage = {
            messageId: 'user-msg',
            parentMessageId: Constants.NO_PARENT,
            conversationId: options.conversationId,
            text: 'First message',
          };
          options.onStart(userMessage, 'response-msg');
          return {
            messageId: 'response-msg',
            parentMessageId: 'user-msg',
            conversationId: options.conversationId,
            content: responseContent,
            databasePromise: Promise.resolve(
              databaseResult ?? {
                conversation: { conversationId: options.conversationId, title: null },
              },
            ),
          };
        }),
      };
      const req = {
        user: { id: 'user-123' },
        body: {
          text: 'First message',
          messageId: 'user-msg',
          parentMessageId: Constants.NO_PARENT,
          conversationId: 'new',
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
        },
        config: {},
      };

      await AgentController(
        req,
        createResumableResponse(),
        jest.fn(),
        jest.fn().mockResolvedValue({ client }),
        addTitle,
      );
      await finished;
      await nextTick();
      await nextTick();

      return { addTitle, getTitleSignal: () => titleSignal };
    };

    it('skips deferred title generation when an empty preempt boundary truncates the first turn', async () => {
      resolveTitleTiming.mockReturnValueOnce('final');

      const { addTitle } = await runFirstTurn({ run: preemptIncompleteRun });

      expect(addTitle).not.toHaveBeenCalled();
    });
    it('does not re-stamp an unfinished response already persisted by BaseClient', async () => {
      const stampedAt = new Date('2026-09-07T12:00:00.000Z');

      await runFirstTurn({
        run: preemptIncompleteRun,
        databaseResult: {
          conversation: {
            conversationId: 'new',
            title: null,
            lastResponseAt: stampedAt,
          },
        },
      });

      expect(mockStampConvoLastResponse).not.toHaveBeenCalled();
      const finalEvent = mockGenerationJobManager.publishTerminalClaim.mock.calls.at(-1)[1];
      expect(finalEvent.conversation.lastResponseAt).toEqual(stampedAt);
    });

    it('stamps and acknowledges the fallback conversation when BaseClient persistence is skipped', async () => {
      const stampedAt = new Date('2026-09-07T12:00:00.000Z');
      mockSaveMessage.mockImplementation(async (_ctx, message) => message);
      mockGetConvo.mockResolvedValue({
        conversationId: 'new',
        title: null,
        createdAt: '2026-06-07T00:00:00.000Z',
        lastResponseAt: stampedAt,
      });

      await runFirstTurn({
        run: preemptIncompleteRun,
        databaseResult: {
          persistenceSkipped: true,
          conversation: {
            conversationId: 'new',
            title: null,
            lastResponseAt: new Date('2026-09-07T11:59:00.000Z'),
          },
        },
      });

      expect(mockStampConvoLastResponse).toHaveBeenCalledTimes(1);
      const finalEvent = mockGenerationJobManager.publishTerminalClaim.mock.calls.at(-1)[1];
      expect(finalEvent.conversation.lastResponseAt).toEqual(stampedAt);
    });

    /* A preempted turn can persist its row before the model produced anything readable. A dot
       raised for that row could never be acknowledged, because acknowledgement requires the
       stamped reply to be on screen. */
    it('does not stamp a skipped-persistence turn that persisted nothing to read', async () => {
      mockSaveMessage.mockImplementation(async (_ctx, message) => message);

      await runFirstTurn({
        run: preemptIncompleteRun,
        responseContent: [],
        databaseResult: {
          persistenceSkipped: true,
          conversation: { conversationId: 'new', title: null },
        },
      });

      expect(mockStampConvoLastResponse).not.toHaveBeenCalled();
    });

    it('still generates a deferred title for a completed first turn', async () => {
      resolveTitleTiming.mockReturnValueOnce('final');

      const { addTitle } = await runFirstTurn();

      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(addTitle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ response: expect.anything() }),
      );
    });

    it('does not acknowledge provider drain until deferred title persistence settles', async () => {
      resolveTitleTiming.mockReturnValueOnce('final');
      let resolveTitle;
      const titlePending = new Promise((resolve) => {
        resolveTitle = resolve;
      });
      const addTitle = jest.fn(() => titlePending);

      await runFirstTurn({ addTitle });

      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.markProviderExecutionDrained).not.toHaveBeenCalled();

      resolveTitle();
      await nextTick();
      await nextTick();

      expect(mockGenerationJobManager.markProviderExecutionDrained).toHaveBeenCalledWith(
        expect.any(String),
        1000,
        'provider-segment-1',
      );
    });

    it('cancels an in-flight immediate title when the turn ends preempt-incomplete', async () => {
      const { addTitle, getTitleSignal } = await runFirstTurn({ run: preemptIncompleteRun });

      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(getTitleSignal().aborted).toBe(true);
    });

    it('lets an immediate title proceed for a completed first turn', async () => {
      const { addTitle, getTitleSignal } = await runFirstTurn();

      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(getTitleSignal().aborted).toBe(false);
    });

    /**
     * The hop that makes the client notice possible: `AgentClient` swallows the
     * graph's step-limit error and raises `stepLimitReached`, and the controller
     * must turn that into an `unfinished` row stamped with the tool-call-limit
     * finish reason on BOTH the durable write and the terminal SSE event.
     */
    const stepLimitClient = { stepLimitReached: true };

    const savedResponseRow = () =>
      mockSaveMessage.mock.calls
        .map(([, message]) => message)
        .find((message) => message?.messageId === 'response-msg');

    it('persists a step-limited turn as unfinished with the tool-call-limit finish reason', async () => {
      await runFirstTurn({ clientOverrides: stepLimitClient });

      expect(savedResponseRow()).toEqual(
        expect.objectContaining({
          unfinished: true,
          finish_reason: Constants.TOOL_CALL_LIMIT_FINISH_REASON,
        }),
      );
    });

    it('keeps the partial content on a step-limited turn instead of replacing it with an error', async () => {
      await runFirstTurn({ clientOverrides: stepLimitClient });

      const saved = savedResponseRow();
      expect(saved.content).toEqual([{ type: 'text', text: 'Truncated answer' }]);
      expect(saved.error).not.toBe(true);
    });

    it('publishes the finish reason on the terminal event so the client needs no refetch', async () => {
      await runFirstTurn({ clientOverrides: stepLimitClient });

      const published = mockGenerationJobManager.publishTerminalClaim.mock.calls.at(-1);
      expect(published).toBeDefined();
      expect(JSON.stringify(published)).toContain(Constants.TOOL_CALL_LIMIT_FINISH_REASON);
    });

    it('leaves an ordinary completed turn finished and unstamped', async () => {
      await runFirstTurn();

      const saved = savedResponseRow();
      expect(saved.unfinished).toBe(false);
      expect(saved.finish_reason).toBeUndefined();
    });
  });
});
