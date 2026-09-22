const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

let activeTenantContext;
const mockTenantStorageRun = jest.fn(async (context, callback) => {
  activeTenantContext = context;
  try {
    return await callback();
  } finally {
    activeTenantContext = undefined;
  }
});
const mockSaveMessage = jest.fn();
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockIsAgentTriggerPrincipalActive = jest.fn();
const mockFilterPersistableAbortContent = jest.fn((content) => content);
const mockCheckAndIncrementPendingRequest = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockGenerationJobManager = {
  createJob: jest.fn(),
  emitError: jest.fn(),
  completeJob: jest.fn(),
  beginProviderExecution: jest.fn(),
  markProviderExecutionDrained: jest.fn(),
  getResumeState: jest.fn(),
  getJobStore: jest.fn(),
  updateMetadata: jest.fn(),
  claimGeneration: jest.fn(),
  releaseGeneration: jest.fn(),
  hasJob: jest.fn(),
  steering: {
    closeAndDrain: jest.fn(),
    park: jest.fn(),
  },
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  tenantStorage: {
    run: (...args) => mockTenantStorageRun(...args),
  },
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  resolvePersistedReasoningOverride:
    jest.requireActual('@librechat/api').resolvePersistedReasoningOverride,
  isScheduleFireRequest: jest.fn(() => false),
  exemptFromConcurrencyLimiter: jest.fn(() => false),
  toPendingSteer: jest.fn((item) => item),
  isSteerPreemptSupported: jest.fn(() => true),
  isSteerTerminalContinuationSupported: jest.fn(() => false),
  buildRecoveredSteerPayload: jest.fn(() => null),
  deleteAgentCheckpoint: jest.fn(),
  getViolationInfo: jest.fn(() => ({
    type: 'concurrent',
    limit: 2,
    pendingRequests: 3,
    score: 1,
  })),
  buildMessageFiles: jest.fn(() => []),
  resolveTitleTiming: jest.fn(() => 'immediate'),
  createConvoPersistenceSignal: jest.requireActual('@librechat/api').createConvoPersistenceSignal,
  recoverTurnMessageReference: jest.requireActual('@librechat/api').recoverTurnMessageReference,
  resolveConversationAnchor: jest.requireActual('@librechat/api').resolveConversationAnchor,
  resolveRunCodeWorkspaces: jest.requireActual('@librechat/api').resolveRunCodeWorkspaces,
  shouldPersistCodeWorkspaceInitializationError:
    jest.requireActual('@librechat/api').shouldPersistCodeWorkspaceInitializationError,
  resolvePersistableCodeEnvironmentDecision: (...args) =>
    jest.requireActual('@librechat/api').resolvePersistableCodeEnvironmentDecision(...args),
  getSafeErrorMetadata: jest.requireActual('@librechat/api').getSafeErrorMetadata,
  getSafeErrorText: jest.requireActual('@librechat/api').getSafeErrorText,
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn(() => null),
  cleanupMCPRequestContext: jest.fn(),
  createMCPRequestContext: jest.fn(() => ({
    connections: new Map(),
    pending: new Map(),
    cleanupStarted: false,
  })),
  getMCPRequestContext: jest.fn(() => ({
    connections: new Map(),
    pending: new Map(),
    cleanupStarted: false,
  })),
  filterPersistableAbortContent: (...args) => mockFilterPersistableAbortContent(...args),
  cleanupMCPRequestContextForReq: jest.fn(),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  getAgentStartupTelemetry: jest.fn(() => undefined),
  acceptAgentStartupTelemetry: jest.fn(),
  isUnpersistedPreliminaryParent: jest.fn(async () => false),
  createMCPRuntimeRequestBody: ({ messageId, conversationId, parentMessageId }) => ({
    messageId,
    conversationId,
    parentMessageId,
  }),
  parseAgentEventActorDetachedCompletion: jest.fn(() => undefined),
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
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
  isAgentTriggerPrincipalActive: (...args) => mockIsAgentTriggerPrincipalActive(...args),
}));

const AgentController = require('../request');

describe('ResumableAgentController tenant context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeTenantContext = undefined;
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGetConvo.mockResolvedValue({ createdAt: '2026-07-31T00:00:00.000Z' });
    mockGetMessages.mockResolvedValue([]);
    mockIsAgentTriggerPrincipalActive.mockResolvedValue(true);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockResolvedValue(undefined);
    mockGenerationJobManager.beginProviderExecution.mockResolvedValue(true);
    mockGenerationJobManager.markProviderExecutionDrained.mockResolvedValue(true);
    mockGenerationJobManager.claimGeneration.mockResolvedValue({ claimed: true });
    mockGenerationJobManager.releaseGeneration.mockResolvedValue(undefined);
    mockGenerationJobManager.hasJob.mockResolvedValue(true);
    mockGenerationJobManager.steering.closeAndDrain.mockResolvedValue([]);
    mockGenerationJobManager.steering.park.mockResolvedValue(undefined);
  });

  /**
   * Drives the controller far enough to register the `allSubscribersLeft` handler,
   * fires it, and returns the tenant context that was active during `saveMessage`.
   */
  const partialContextMeta = {
    calibrationRatio: 1.2,
    encoding: 'claude',
    fading: { v: 1, budgetTokens: 50_000, masked: true },
  };

  const firePartialDisconnect = async (
    user,
    jobRecord = { createdAt: 1000, contextMeta: partialContextMeta },
  ) => {
    let allSubscribersLeftHandler;
    mockGenerationJobManager.getJobStore.mockReturnValue({
      getJob: jest.fn().mockResolvedValue(jobRecord),
    });
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      metadata: {
        providerExecutionId: 'provider-segment-1',
        providerDrained: true,
      },
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
      conversationId: 'conversation-123',
      responseMessageId: 'response-message',
      userMessage: {
        messageId: 'user-message',
      },
    });

    let tenantSeenBySave;
    mockSaveMessage.mockImplementation(async () => {
      tenantSeenBySave = activeTenantContext;
      return {};
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user,
      body: {
        text: 'Continue the analysis',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId: 'conversation-123',
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    await allSubscribersLeftHandler([{ type: 'text', text: 'Partial response' }]);
    return tenantSeenBySave;
  };

  it('carries the context meta the run published onto the partial response saved on disconnect', async () => {
    await firePartialDisconnect({ id: 'user-123', tenantId: 'tenant-a' });

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        messageId: 'response-message',
        unfinished: true,
        contextMeta: partialContextMeta,
      }),
      expect.any(Object),
    );
  });

  it('leaves context meta off the partial response when the job record belongs to another epoch', async () => {
    await firePartialDisconnect(
      { id: 'user-123', tenantId: 'tenant-a' },
      { createdAt: 2000, contextMeta: partialContextMeta },
    );

    const [, savedMessage] = mockSaveMessage.mock.calls[0];
    expect(savedMessage).not.toHaveProperty('contextMeta');
  });

  it('restores the authenticated tenant before saving a partial response on disconnect', async () => {
    const tenantSeenBySave = await firePartialDisconnect({ id: 'user-123', tenantId: 'tenant-a' });

    expect(mockTenantStorageRun).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', userId: 'user-123' },
      expect.any(Function),
    );
    expect(tenantSeenBySave).toEqual({ tenantId: 'tenant-a', userId: 'user-123' });
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });

  it('saves the partial response without tenant context when the user has no tenant', async () => {
    const tenantSeenBySave = await firePartialDisconnect({ id: 'user-123' });

    expect(mockTenantStorageRun).not.toHaveBeenCalled();
    expect(tenantSeenBySave).toBeUndefined();
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });
});
