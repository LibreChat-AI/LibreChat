/**
 * Integration tests for the HITL resume controller (POST /agents/chat/resume).
 *
 * Drives the real `ResumeAgentController` end-to-end over supertest with the SDK
 * run, durable checkpointer, Mongo, and concurrency cache mocked out. The pure
 * decision/liveness helpers (`isPendingActionStale`, `mapToolApprovalResolutions`,
 * `findUndecidedToolCalls`, `findDisallowedDecisions`, `buildAbortedResponseMetadata`,
 * `sanitizeMessageForTransmit`) run for real via `requireActual`, so the test
 * exercises the actual guard ladder and the pause -> approve -> resume -> finalize
 * lifecycle rather than re-implemented stubs.
 *
 * Covers:
 *  - the authorization / staleness / agent-and-endpoint / actionId guard ladder
 *  - tool_approval validation (undecided, policy-disallowed decision)
 *  - ask_user_question answer requirement
 *  - concurrency gate (429) and the atomic single-winner claim (409)
 *  - the happy path: ACK, run reconstruction, resumeCompletion, finalize (save the
 *    now-finished response, emit done, complete job, prune checkpoint)
 *  - re-pause (no double finalize), abort-during-resume (no double finalize),
 *    and the resume-failure terminal path
 */

const express = require('express');
const request = require('supertest');
const { Tools, Constants, ResourceType, AgentCapabilities } = require('librechat-data-provider');

const USER_ID = 'user-1';
const TENANT_ID = 'tenant-1';
const AGENT_ID = 'agent-abc';
const CONVO_ID = 'convo-123';
const ACTION_ID = 'action-xyz';
const NEXT_ACTION_ID = 'action-next';
const RESPONSE_MSG_ID = 'resp-1';
const USER_MSG_ID = 'umsg-1';
const THREAD_PARENT_ID = 'thread-parent-1';

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockJobStore = {
  getJob: jest.fn(),
  updateJob: jest.fn(),
};

const mockGenerationJobManager = {
  detachedAgentEventActionStoreMode: 'distributed',
  supportsDetachedAgentEventActions: true,
  getJob: jest.fn(),
  getJobStore: jest.fn(() => mockJobStore),
  getResumeState: jest.fn(),
  updateMetadata: jest.fn(),
  setContentParts: jest.fn(),
  /** Resume moves ownership and rebuilds armed interrupts from the durable queue. */
  rearmQueuedPreempts: jest.fn().mockResolvedValue(0),
  emitChunk: jest.fn(),
  emitDone: jest.fn(),
  emitError: jest.fn(),
  claimTerminalJob: jest.fn(),
  publishTerminalClaim: jest.fn(),
  finishTerminalJob: jest.fn(),
  completeJob: jest.fn(),
  abortJob: jest.fn(),
  beginProviderExecution: jest.fn(),
  markProviderExecutionDrained: jest.fn(),
  failPausePersistence: jest.fn(),
  expireApproval: jest.fn(),
  approvals: {
    resolve: jest.fn(),
    ownsPausePersistence: jest.fn(),
    finishPausePersistence: jest.fn(),
  },
};

const mockDeleteAgentCheckpoint = jest.fn();
const mockCaptureAgentCheckpointGeneration = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockCheckAndIncrementPendingRequest = jest.fn();
const mockGetAgentCheckpointer = jest.fn();
const mockCheckpointGetTuple = jest.fn();

const mockSaveMessage = jest.fn();
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockGetFiles = jest.fn();
const mockGetAgent = jest.fn();
const mockGetActions = jest.fn();
const mockGetUserMemories = jest.fn();
const mockGetRoleByName = jest.fn();
const mockCheckAccess = jest.fn();
const mockCheckPermission = jest.fn();
const mockDecryptMetadata = jest.fn();
const mockDisposeClient = jest.fn();
const mockGetMCPRequestContext = jest.fn();
const mockCleanupMCPRequestContextForReq = jest.fn();
const mockRecordScheduleOutcome = jest.fn();
const mockIsScheduleLive = jest.fn();
const mockClaimScheduleResume = jest.fn();
const mockReleaseScheduleResumeClaim = jest.fn();
const mockFinalizeScheduleResumeClaim = jest.fn();
const mockReleaseScheduleResumeFence = jest.fn();
const mockAcquireEventChildGenerationLease = jest.fn();
const mockReleaseEventChildLease = jest.fn();
const mockIsSubagentOwnerAdmissible = jest.fn();
const mockCompleteAgentEventActorLegacyTurn = jest.fn();
const mockGetAgentEventActorSnapshot = jest.fn();
const mockCommitAgentEventActorState = jest.fn();
const mockStoreAgentEventActorSuspension = jest.fn();
const mockClaimAgentEventActorSuspension = jest.fn();
const mockSettleAgentEventActorSuspension = jest.fn();
const mockRecordAgentEventActorReconciliation = jest.fn();
const mockResumeAgentEventActor = jest.fn();
const mockCreateAgentEventActorDetachedActionLifecycle = jest.fn();
const mockGetAgentTriggerDelivery = jest.fn();
const mockReserveAgentEventActorDetachedAction = jest.fn();
const mockMarkAgentEventActorDetachedActionRunning = jest.fn();
const mockSettleAgentEventActorDetachedAction = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: mockGenerationJobManager,
  GENERATION_RECOVERY_FAILED_ERROR: 'generation_recovery_failed',
  captureAgentCheckpointGeneration: (...args) => mockCaptureAgentCheckpointGeneration(...args),
  deleteAgentCheckpoint: (...args) => mockDeleteAgentCheckpoint(...args),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  isSteerPreemptSupported: jest.fn(() => true),
  isSteerTerminalContinuationSupported: jest.fn(() => false),
  createMCPRuntimeRequestBody: ({ messageId, conversationId, parentMessageId }) => ({
    messageId,
    conversationId,
    parentMessageId,
  }),
  getAgentCheckpointer: (...args) => mockGetAgentCheckpointer(...args),
  checkAccess: (...args) => mockCheckAccess(...args),
  resumeAgentEventActor: (...args) => mockResumeAgentEventActor(...args),
  settleAgentEventActorHistoryTurn: (input, complete) => complete(input),
  createAgentEventActorDetachedActionLifecycle: (...args) =>
    mockCreateAgentEventActorDetachedActionLifecycle(...args),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getConvo: (...args) => mockGetConvo(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getFiles: (...args) => mockGetFiles(...args),
  getAgent: (...args) => mockGetAgent(...args),
  getActions: (...args) => mockGetActions(...args),
  getUserMemories: (...args) => mockGetUserMemories(...args),
  getRoleByName: (...args) => mockGetRoleByName(...args),
  getAgentTriggerDelivery: (...args) => mockGetAgentTriggerDelivery(...args),
  isSubagentOwnerAdmissible: (...args) => mockIsSubagentOwnerAdmissible(...args),
  completeAgentEventActorLegacyTurn: (...args) => mockCompleteAgentEventActorLegacyTurn(...args),
  getAgentEventActorSnapshot: (...args) => mockGetAgentEventActorSnapshot(...args),
  commitAgentEventActorState: (...args) => mockCommitAgentEventActorState(...args),
  storeAgentEventActorSuspension: (...args) => mockStoreAgentEventActorSuspension(...args),
  claimAgentEventActorSuspension: (...args) => mockClaimAgentEventActorSuspension(...args),
  settleAgentEventActorSuspension: (...args) => mockSettleAgentEventActorSuspension(...args),
  recordAgentEventActorReconciliation: (...args) =>
    mockRecordAgentEventActorReconciliation(...args),
  reserveAgentEventActorDetachedAction: (...args) =>
    mockReserveAgentEventActorDetachedAction(...args),
  markAgentEventActorDetachedActionRunning: (...args) =>
    mockMarkAgentEventActorDetachedActionRunning(...args),
  settleAgentEventActorDetachedAction: (...args) =>
    mockSettleAgentEventActorDetachedAction(...args),
}));

jest.mock('~/server/services/Endpoints/agents/eventChildLease', () => ({
  acquireEventChildGenerationLease: (...args) => mockAcquireEventChildGenerationLease(...args),
}));

jest.mock('~/server/services/ActionService', () => ({
  decryptMetadata: (...args) => mockDecryptMetadata(...args),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockCheckPermission(...args),
}));

jest.mock('~/server/services/Schedules', () => ({
  recordScheduleOutcome: (...args) => mockRecordScheduleOutcome(...args),
  claimScheduleResume: (...args) => mockClaimScheduleResume(...args),
  releaseScheduleResumeClaim: (...args) => mockReleaseScheduleResumeClaim(...args),
  finalizeScheduleResumeClaim: (...args) => mockFinalizeScheduleResumeClaim(...args),
  releaseScheduleResumeFence: (...args) => mockReleaseScheduleResumeFence(...args),
  isScheduleLive: (...args) => mockIsScheduleLive(...args),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: (...args) => mockDisposeClient(...args),
}));

jest.mock('~/server/services/MCPRequestContext', () => ({
  getMCPRequestContext: (...args) => mockGetMCPRequestContext(...args),
  cleanupMCPRequestContextForReq: (...args) => mockCleanupMCPRequestContextForReq(...args),
}));

// Import after mocks
const ResumeAgentController = require('~/server/controllers/agents/resume');
const { captureCodeExecutionApprovalBinding } = require('@librechat/api');

/** Drain the microtask + immediate queues so the post-ACK continuation settles. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A live, resolvable paused tool-approval job (single tool call `tc1`). */
function makeToolApprovalJob(overrides = {}) {
  const metaOverrides = overrides.metadata ?? {};
  const pendingOverrides = metaOverrides.pendingAction ?? {};
  return {
    status: 'requires_action',
    createdAt: 1000,
    abortController: new AbortController(),
    ...overrides,
    metadata: {
      userId: USER_ID,
      tenantId: TENANT_ID,
      agent_id: AGENT_ID,
      endpoint: 'agents',
      responseMessageId: RESPONSE_MSG_ID,
      sender: 'TestAgent',
      iconURL: 'https://example.com/icon.png',
      model: 'claude-test',
      isTemporary: false,
      userMessage: {
        messageId: USER_MSG_ID,
        parentMessageId: THREAD_PARENT_ID,
        text: 'please run the tool',
      },
      ...metaOverrides,
      pendingAction: {
        actionId: ACTION_ID,
        expiresAt: Date.now() + 60_000,
        payload: {
          type: 'tool_approval',
          action_requests: [{ tool_call_id: 'tc1' }],
          review_configs: [{ tool_call_id: 'tc1', allowed_decisions: ['approve', 'reject'] }],
        },
        ...pendingOverrides,
      },
    },
  };
}

/** A live, resolvable paused ask-user-question job. */
function makeAskUserJob(overrides = {}) {
  const job = makeToolApprovalJob(overrides);
  job.metadata.pendingAction.payload = {
    type: 'ask_user_question',
    question: 'What should I name the file?',
  };
  return job;
}

function makeAskUserBatchJob(overrides = {}) {
  const job = makeToolApprovalJob(overrides);
  job.metadata.pendingAction.payload = {
    type: 'ask_user_question',
    question: { question: 'Which environment?' },
    questions: [
      { id: 'environment', question: 'Which environment?' },
      { id: 'window', question: 'Which time window?' },
    ],
    tool_call_id: 'tc1',
  };
  return job;
}

/** A mock reconstructed client for the post-ACK path. */
function makeClient(overrides = {}) {
  return {
    sender: 'TestAgent',
    contentParts: [{ type: 'text', text: 'resumed answer' }],
    artifactPromises: [],
    pendingApproval: false,
    buildResponseMetadata: jest.fn(() => null),
    resumeCompletion: jest.fn().mockResolvedValue(undefined),
    seedContextMeta: jest.fn(),
    ...overrides,
  };
}

function makeToolCallContent(overrides = {}) {
  return {
    type: 'tool_call',
    tool_call: {
      id: 'tc1',
      name: 'lookup',
      args: '{}',
      ...overrides,
    },
  };
}

describe('ResumeAgentController (POST /agents/chat/resume)', () => {
  let app;
  let mockInitializeClient;
  let mockAddTitle;
  let capturedInit;
  let requestConfigOverrides;
  let requestStateOverrides;
  let endpointAgent;
  let settle;
  let settled;

  beforeEach(() => {
    jest.clearAllMocks();

    capturedInit = null;
    requestConfigOverrides = {};
    requestStateOverrides = {};
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockDeleteAgentCheckpoint.mockResolvedValue(undefined);
    mockCaptureAgentCheckpointGeneration.mockResolvedValue({
      threadId: CONVO_ID,
      checkpointIds: ['checkpoint-old'],
    });
    mockCleanupMCPRequestContextForReq.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue({});
    mockGetConvo.mockResolvedValue(null);
    mockGetMessages.mockResolvedValue([]);
    mockGetFiles.mockResolvedValue([]);
    mockGetAgent.mockResolvedValue(null);
    mockGetActions.mockResolvedValue([]);
    mockGetUserMemories.mockResolvedValue([]);
    mockGetRoleByName.mockResolvedValue(null);
    mockCheckAccess.mockResolvedValue(true);
    mockCheckPermission.mockResolvedValue(true);
    mockDecryptMetadata.mockImplementation(async (metadata) => metadata);
    mockCheckpointGetTuple.mockResolvedValue({
      checkpoint: { channel_values: { messages: [] } },
    });
    mockGetAgentCheckpointer.mockResolvedValue({ getTuple: mockCheckpointGetTuple });
    mockJobStore.getJob.mockResolvedValue({
      createdAt: 1000,
      tokenUsage: null,
      contextUsage: null,
    });
    mockJobStore.updateJob.mockResolvedValue(undefined);
    mockGenerationJobManager.getResumeState.mockResolvedValue({ aggregatedContent: [] });
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockGenerationJobManager.claimTerminalJob.mockResolvedValue({
      streamId: CONVO_ID,
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
    mockGenerationJobManager.completeJob.mockResolvedValue(true);
    mockGenerationJobManager.abortJob.mockResolvedValue({ success: true });
    mockGenerationJobManager.beginProviderExecution.mockResolvedValue(true);
    mockGenerationJobManager.markProviderExecutionDrained.mockResolvedValue(true);
    mockGenerationJobManager.failPausePersistence.mockResolvedValue(true);
    mockGenerationJobManager.isRedis = true;
    mockGenerationJobManager.detachedAgentEventActionStoreMode = 'distributed';
    mockGenerationJobManager.supportsDetachedAgentEventActions = true;
    mockGenerationJobManager.persistAgentEventDetachedTerminalEvidence = jest
      .fn()
      .mockResolvedValue(true);
    mockGenerationJobManager.retryTerminalHostAction = jest.fn().mockResolvedValue(undefined);
    mockGenerationJobManager.approvals.resolve.mockResolvedValue(true);
    mockGenerationJobManager.approvals.ownsPausePersistence.mockResolvedValue(true);
    mockGenerationJobManager.approvals.finishPausePersistence.mockResolvedValue(true);
    mockRecordScheduleOutcome.mockResolvedValue(true);
    mockIsScheduleLive.mockResolvedValue(true);
    mockClaimScheduleResume.mockResolvedValue({
      capacitySlot: 0,
      claimToken: 'resume-token',
      leaseBy: 'resume:resume-token',
    });
    mockReleaseScheduleResumeClaim.mockResolvedValue(true);
    mockFinalizeScheduleResumeClaim.mockResolvedValue(true);
    mockReleaseScheduleResumeFence.mockResolvedValue(undefined);
    mockAcquireEventChildGenerationLease.mockResolvedValue(mockReleaseEventChildLease);
    mockReleaseEventChildLease.mockResolvedValue(undefined);
    mockIsSubagentOwnerAdmissible.mockResolvedValue(true);
    mockCompleteAgentEventActorLegacyTurn.mockResolvedValue(true);
    mockGetAgentEventActorSnapshot.mockResolvedValue(undefined);
    mockCommitAgentEventActorState.mockResolvedValue({ status: 'committed' });
    mockStoreAgentEventActorSuspension.mockResolvedValue({ status: 'stored' });
    mockClaimAgentEventActorSuspension.mockResolvedValue({ status: 'claimed' });
    mockSettleAgentEventActorSuspension.mockResolvedValue({ status: 'settled' });
    mockRecordAgentEventActorReconciliation.mockResolvedValue(true);
    mockGetAgentTriggerDelivery.mockResolvedValue(undefined);
    mockCreateAgentEventActorDetachedActionLifecycle.mockReturnValue(undefined);
    endpointAgent = {
      _id: 'mongo-agent-abc',
      id: AGENT_ID,
      provider: 'openAI',
      model: 'gpt-test',
      instructions: 'Help the user.',
      model_parameters: {},
      tools: [],
      edges: [],
    };

    // `decrementPendingRequest` runs in the controller's `finally` on every
    // post-ACK path, so resolving on it signals the async continuation is done.
    settled = new Promise((resolve) => {
      settle = resolve;
    });
    mockDecrementPendingRequest.mockImplementation(async () => {
      settle();
    });

    mockAddTitle = jest.fn().mockResolvedValue(undefined);
    mockInitializeClient = jest.fn(
      async ({ req, checkpointNamespace, foregroundRunId, requestBody }) => {
        // Capture the request state the controller seeds BEFORE reconstruction.
        capturedInit = {
          parentMessageId: req.body.parentMessageId,
          files: req.body.files,
          isTemporary: req.body.isTemporary,
          turnStartedAt: req.turnStartedAt,
          isScheduledFire: req._isScheduledFire,
          timezone: req.body.timezone,
          checkpointNamespace,
          foregroundRunId,
          requestBody,
        };
        return { client: makeClient(), userMCPAuthMap: { server1: { token: 't' } } };
      },
    );

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: USER_ID, tenantId: TENANT_ID, role: 'USER' };
      req.config = {
        endpoints: { agents: { checkpointer: { type: 'mongo' } } },
        interfaceConfig: {},
        ...requestConfigOverrides,
      };
      req.body.endpointOption = {
        endpoint: 'agents',
        agent_id: AGENT_ID,
        model_parameters: {},
        agent: Promise.resolve(endpointAgent),
      };
      Object.assign(req, requestStateOverrides);
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) =>
      ResumeAgentController(req, res, next, mockInitializeClient, mockAddTitle),
    );
  });

  const post = (body) => request(app).post('/api/agents/chat/resume').send(body);

  const approveBody = (extra = {}) => ({
    conversationId: CONVO_ID,
    actionId: ACTION_ID,
    agent_id: AGENT_ID,
    endpoint: 'agents',
    decisions: [{ tool_call_id: 'tc1', decision: 'approve' }],
    ...extra,
  });

  const configureEventActorResume = (expiredAt = new Date(Date.now() + 60_000)) => {
    requestStateOverrides = {
      _agentEventBindingParentConversationId: 'parent-conversation',
      _agentEventBindingParentAgentId: 'parent-agent',
      _agentEventBindingTenantId: TENANT_ID,
      _agentEventBindingRetention: { isTemporary: true, expiredAt },
    };
    mockGetConvo.mockResolvedValue({
      conversationId: 'parent-conversation',
      agent_id: 'parent-agent',
      tenantId: TENANT_ID,
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    return expiredAt;
  };

  describe('event-bound actor resume lifecycle', () => {
    it('claims a versioned Conversation suspension and recovers an ambiguous job projection ACK', async () => {
      configureEventActorResume();
      requestStateOverrides._agentEventBindingId = 'binding-1';
      const expectedAction = { toolName: 'lookup' };
      const suspension = {
        version: 1,
        suspensionId: 'suspension-1',
        attempt: 0,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        invocation: {
          invocationId: 'trigger_event_delivery',
          continuation: 'warm',
          base: { actorThreadId: CONVO_ID, generation: 1 },
          fork: {
            threadId: CONVO_ID,
            checkpointNs: 'event-actor',
            checkpointId: 'checkpoint-paused',
            invocationId: 'trigger_event_delivery',
          },
        },
        checkpoint: {
          threadId: CONVO_ID,
          checkpointNs: 'event-actor',
          checkpointId: 'checkpoint-paused',
          invocationId: 'trigger_event_delivery',
        },
        interrupt: {
          id: 'interrupt-1',
          payload: {
            type: 'tool_approval',
            _librechatEventActor: { expectedAction },
          },
        },
        suspensionDigest: 'signed-digest',
      };
      const pausedJob = makeToolApprovalJob({
        metadata: {
          idempotencyClientRequestId: 'trigger_event_delivery',
          agentEventDeliveryKey: 'completion-delivery-1',
          agentEventInvocationKey: 'trigger_event_delivery',
          agentEventExpectedAction: expectedAction,
          agentEventSuspension: {
            version: 1,
            suspensionId: suspension.suspensionId,
            attempt: suspension.attempt,
          },
        },
      });
      pausedJob.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['respond'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(pausedJob);
      const detachedSuspension = {
        kind: 'internal_completion',
        actionId: 'detached-action-next',
      };
      const repausedSuspension = {
        ...suspension,
        suspensionId: 'suspension-detached-next',
        attempt: 1,
      };
      mockCreateAgentEventActorDetachedActionLifecycle.mockReturnValue({
        readSuspension: () => detachedSuspension,
      });
      let projectedProviderExecutionId;
      mockGenerationJobManager.approvals.resolve.mockImplementation(
        async (_streamId, _actionId, resumePatch) => {
          projectedProviderExecutionId = resumePatch.providerExecutionId;
          mockGenerationJobManager.getJob.mockResolvedValue({
            ...pausedJob,
            status: 'running',
            metadata: {
              ...pausedJob.metadata,
              providerExecutionId: resumePatch.providerExecutionId,
            },
          });
          throw new Error('redis committed the CAS but lost its reply');
        },
      );
      mockGetAgentEventActorSnapshot.mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          kind: 'internal_completion',
          handlingGenerationCreatedAt: 500,
          actionId: ACTION_ID,
          jobCreatedAt: 1000,
          status: 'pending',
        },
      });
      const resumedClient = makeClient({
        publishStagedApproval: jest.fn(),
        contentParts: [makeToolCallContent({ output: 'human supplied output' })],
        run: {
          getRunSteps: () => [
            {
              type: 'tool_calls',
              status: 'completed',
              stepDetails: {
                type: 'tool_calls',
                tool_calls: [
                  {
                    id: 'tc1',
                    name: 'lookup',
                    args: {},
                    output: 'human supplied output',
                  },
                ],
              },
            },
          ],
        },
      });
      mockInitializeClient.mockImplementation(async ({ req }) => {
        expect(req._agentEventDetachedActionLifecycle).toBe(
          mockCreateAgentEventActorDetachedActionLifecycle.mock.results[0].value,
        );
        return { client: resumedClient, userMCPAuthMap: {} };
      });
      mockResumeAgentEventActor.mockImplementation(async (input, dependencies) => {
        expect(input.readSuspension()).toBe(detachedSuspension);
        await dependencies.claimSuspension({
          user: USER_ID,
          tenantId: TENANT_ID,
          conversationId: CONVO_ID,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
          actionId: ACTION_ID,
          jobCreatedAt: 1000,
          resumeAttemptId: input.resumeAttemptId,
        });
        expect(await input.claimProjection()).toBe(true);
        expect(input.resumeAttemptId).toBe(projectedProviderExecutionId);
        const value = await input.resume({
          checkpointNamespace: 'event-actor',
          checkpointId: 'checkpoint-paused',
          invocationId: 'trigger_event_delivery',
          continuation: 'warm',
          signal: input.signal,
        });
        return {
          value,
          execution: { status: 'suspended', suspension: repausedSuspension },
        };
      });

      const res = await post(
        approveBody({
          decisions: [
            { tool_call_id: 'tc1', decision: 'respond', responseText: 'human supplied output' },
          ],
        }),
      );
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGetAgentEventActorSnapshot).toHaveBeenCalledWith({
        user: USER_ID,
        tenantId: TENANT_ID,
        conversationId: CONVO_ID,
      });
      expect(mockClaimAgentEventActorSuspension.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.resolve.mock.invocationCallOrder[0],
      );
      expect(mockGenerationJobManager.getJob).toHaveBeenCalledTimes(2);
      expect(mockGetAgentTriggerDelivery).not.toHaveBeenCalled();
      expect(mockCreateAgentEventActorDetachedActionLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          invocationId: 'trigger_event_delivery',
          generationCreatedAt: 500,
          turnCreatedAt: 1000,
          expectedAction,
        }),
        expect.objectContaining({
          reserveAgentEventActorDetachedAction: expect.any(Function),
          markAgentEventActorDetachedActionRunning: expect.any(Function),
          settleAgentEventActorDetachedAction: expect.any(Function),
        }),
      );
      expect(
        mockCreateAgentEventActorDetachedActionLifecycle.mock.invocationCallOrder[0],
      ).toBeLessThan(mockInitializeClient.mock.invocationCallOrder[0]);
      const lifecycleDependencies =
        mockCreateAgentEventActorDetachedActionLifecycle.mock.calls[0][1];
      expect(lifecycleDependencies.storeMode()).toBe('distributed');
      mockGenerationJobManager.detachedAgentEventActionStoreMode = 'process_local';
      expect(lifecycleDependencies.storeMode()).toBe('process_local');
      expect(resumedClient.resumeCompletion).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
        CONVO_ID,
        {
          agentEventSuspension: {
            version: repausedSuspension.version,
            suspensionId: repausedSuspension.suspensionId,
            attempt: repausedSuspension.attempt,
          },
        },
        1000,
      );
      expect(resumedClient.publishStagedApproval).not.toHaveBeenCalled();
      expect(mockRecordAgentEventActorReconciliation).not.toHaveBeenCalled();
    });

    it('refuses a prior-head expected-action suspension before claiming it on an incapable replica', async () => {
      configureEventActorResume();
      requestStateOverrides._agentEventBindingId = 'binding-1';
      const expectedAction = { toolName: 'submit_move' };
      const suspension = {
        version: 1,
        suspensionId: 'suspension-producer-required',
        attempt: 0,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        invocation: { invocationId: 'trigger_event_delivery' },
        interrupt: {
          id: 'interrupt-producer-required',
          payload: {
            type: 'tool_approval',
            _librechatEventActor: { expectedAction },
          },
        },
        suspensionDigest: 'signed-digest',
      };
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            idempotencyClientRequestId: 'trigger_event_delivery',
            agentEventDeliveryKey: 'trigger_event_delivery',
            agentEventExpectedAction: expectedAction,
            agentEventSuspension: {
              version: 1,
              suspensionId: suspension.suspensionId,
              attempt: suspension.attempt,
            },
          },
        }),
      );
      mockGetAgentEventActorSnapshot.mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          kind: 'human_decision',
          handlingGenerationCreatedAt: 1000,
          actionId: ACTION_ID,
          jobCreatedAt: 1000,
          status: 'pending',
        },
      });
      mockGenerationJobManager.isRedis = false;
      mockGenerationJobManager.supportsDetachedAgentEventActions = false;

      const res = await post(approveBody());

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'EVENT_ACTOR_RESUME_CAPABILITY_UNAVAILABLE',
      });
      expect(res.headers['retry-after']).toBe('1');
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockResumeAgentEventActor).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledTimes(1);
      expect(mockReleaseEventChildLease).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['pre-feature expected-action', { toolName: 'lookup' }, undefined],
      ['actionless PR-era', undefined, 1000],
    ])(
      'preserves a %s suspension when client reconstruction fails before continuation',
      async (_case, expectedAction, handlingGenerationCreatedAt) => {
        configureEventActorResume();
        const suspension = {
          version: 1,
          suspensionId: 'suspension-init-failure',
          attempt: 0,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          invocation: {
            invocationId: 'trigger_event_delivery',
            continuation: 'warm',
            base: { actorThreadId: CONVO_ID, generation: 0 },
            fork: {
              threadId: CONVO_ID,
              checkpointNs: 'event-actor',
              checkpointId: 'checkpoint-paused',
              invocationId: 'trigger_event_delivery',
            },
          },
          checkpoint: {
            threadId: CONVO_ID,
            checkpointNs: 'event-actor',
            checkpointId: 'checkpoint-paused',
            invocationId: 'trigger_event_delivery',
          },
          interrupt: {
            id: 'interrupt-init-failure',
            payload: {
              type: 'tool_approval',
              _librechatEventActor: expectedAction == null ? {} : { expectedAction },
            },
          },
          suspensionDigest: 'signed-digest',
        };
        mockGenerationJobManager.getJob.mockResolvedValue(
          makeToolApprovalJob({
            metadata: {
              idempotencyClientRequestId: 'trigger_event_delivery',
              ...(expectedAction == null ? {} : { agentEventExpectedAction: expectedAction }),
              agentEventSuspension: {
                version: 1,
                suspensionId: suspension.suspensionId,
                attempt: suspension.attempt,
              },
            },
          }),
        );
        mockGetAgentEventActorSnapshot.mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            suspension,
            ...(handlingGenerationCreatedAt == null ? {} : { handlingGenerationCreatedAt }),
            actionId: ACTION_ID,
            jobCreatedAt: 1000,
            status: 'pending',
          },
        });
        mockGenerationJobManager.isRedis = false;
        mockInitializeClient.mockRejectedValue(new Error('client reconstruction failed'));
        mockResumeAgentEventActor.mockImplementation(async (input) => {
          expect(await input.claimProjection()).toBe(true);
          return input.resume({
            checkpointNamespace: 'event-actor',
            checkpointId: 'checkpoint-paused',
            invocationId: 'trigger_event_delivery',
            continuation: 'warm',
            signal: input.signal,
          });
        });

        const res = await post(approveBody());
        expect(res.status).toBe(200);
        await settled;
        await flush();

        expect(mockInitializeClient).toHaveBeenCalledTimes(1);
        expect(mockCreateAgentEventActorDetachedActionLifecycle).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.beginProviderExecution).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.completeJob).toHaveBeenCalled();
      },
    );

    it.each([null, 'pending_owned', 'claimed_owned'])(
      'does not consume approval for an unsupported raw suspension state: %s',
      async (status) => {
        configureEventActorResume();
        mockGenerationJobManager.getJob.mockResolvedValue(
          makeToolApprovalJob({
            metadata: {
              agentEventSuspension: { version: 1, suspensionId: 'stale', attempt: 0 },
            },
          }),
        );
        mockGetAgentEventActorSnapshot.mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension:
            status == null
              ? null
              : {
                  status,
                  actionId: ACTION_ID,
                  jobCreatedAt: 1000,
                  suspension: { suspensionId: 'stale', attempt: 0 },
                },
        });

        const res = await post(approveBody());

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'EVENT_ACTOR_SUSPENSION_STALE' });
        expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
        expect(mockResumeAgentEventActor).not.toHaveBeenCalled();
      },
    );

    it('fails promptly when suspension validation rejects before the job claim callback', async () => {
      configureEventActorResume();
      const suspension = {
        version: 1,
        suspensionId: 'suspension-invalid-signature',
        attempt: 0,
        invocation: { invocationId: 'trigger_event_delivery' },
        interrupt: {
          payload: { _librechatEventActor: { expectedAction: { toolName: 'lookup' } } },
        },
      };
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            idempotencyClientRequestId: 'trigger_event_delivery',
            agentEventSuspension: {
              version: 1,
              suspensionId: suspension.suspensionId,
              attempt: 0,
            },
          },
        }),
      );
      mockGetAgentEventActorSnapshot.mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          actionId: ACTION_ID,
          jobCreatedAt: 1000,
          status: 'pending',
        },
      });
      mockResumeAgentEventActor.mockRejectedValue(new Error('invalid signed suspension'));

      const res = await post(approveBody());

      expect(res.status).toBe(500);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalled();
    });

    it('leaves the approval pending when the previous segment still owns the lease', async () => {
      configureEventActorResume();
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockAcquireEventChildGenerationLease.mockResolvedValue(null);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EVENT_ACTOR_NOT_READY' });
      expect(mockAcquireEventChildGenerationLease).toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('classifies an expired binding as ended when no lease can be acquired', async () => {
      configureEventActorResume(new Date(Date.now() - 1));
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockAcquireEventChildGenerationLease.mockResolvedValue(null);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EVENT_BINDING_PARENT_ENDED' });
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('owns the lease before consuming approval and preserves the inherited deadline', async () => {
      const expiredAt = configureEventActorResume();
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            isTemporary: true,
            idempotencyClientRequestId: 'trigger_event_delivery',
          },
        }),
      );

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockAcquireEventChildGenerationLease.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.resolve.mock.invocationCallOrder[0],
      );
      expect(mockIsSubagentOwnerAdmissible.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.resolve.mock.invocationCallOrder[0],
      );
      expect(mockAcquireEventChildGenerationLease).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'trigger_event_delivery',
          retentionExpiresAt: expiredAt,
        }),
      );
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isTemporary: true, expiredAt }),
        expect.anything(),
        expect.anything(),
      );
      expect(mockReleaseEventChildLease).toHaveBeenCalledTimes(1);
    });

    it('preserves the inherited deadline when the resumed actor pauses again', async () => {
      const expiredAt = configureEventActorResume();
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { isTemporary: true } }),
      );
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'partial' }],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isTemporary: true, expiredAt }),
        expect.objectContaining({ unfinished: true }),
        expect.objectContaining({
          context: 'api/server/controllers/agents/resume.js - re-pause progress persist',
        }),
      );
    });

    it('defers a resume when the owner admission fence is temporarily closed', async () => {
      configureEventActorResume();
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockIsSubagentOwnerAdmissible.mockResolvedValue(false);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EVENT_ACTOR_NOT_READY' });
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('rejects a binding that expires after the route guard but before approval consumption', async () => {
      configureEventActorResume(new Date(Date.now() - 1));
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.body).toMatchObject({ code: 'EVENT_BINDING_PARENT_ENDED' });
      expect(res.status).toBe(409);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('uses the guard-normalized tenant for a legacy untenanted event actor', async () => {
      const expiredAt = configureEventActorResume();
      requestStateOverrides._agentEventBindingTenantId = undefined;
      mockGetConvo.mockResolvedValue({
        conversationId: 'parent-conversation',
        agent_id: 'parent-agent',
      });
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockAcquireEventChildGenerationLease).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: undefined, retentionExpiresAt: expiredAt }),
      );
    });
  });

  describe('scheduled occurrence lifecycle', () => {
    const scheduledFor = '2026-08-17T12:00:00.000Z';
    const makeScheduledJob = () =>
      makeToolApprovalJob({
        metadata: {
          scheduleId: 'schedule-1',
          scheduledFor,
          scheduleConfigRevision: 4,
          checkpointNamespace: '1000',
        },
      });

    it('persists the server namespace when a scheduled approval pauses again', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ pendingApproval: { actionId: NEXT_ACTION_ID } }),
        userMCPAuthMap: {},
      });
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: 'schedule-1',
          status: 'requires_action',
          checkpointNamespace: '1000',
        }),
      );
    });

    it('settles and prunes a scheduled occurrence terminalized by recovery validation', async () => {
      const scheduledJob = makeScheduledJob();
      mockGenerationJobManager.getJob.mockResolvedValueOnce(scheduledJob).mockResolvedValueOnce({
        ...scheduledJob,
        status: 'error',
        error: 'generation_recovery_failed',
      });
      mockGenerationJobManager.getResumeState.mockRejectedValueOnce(
        new Error('terminal cleanup read failed'),
      );

      const res = await post(approveBody());

      expect(res.status).toBe(500);
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'error',
        conversationId: CONVO_ID,
        error: 'generation_recovery_failed',
      });
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        undefined,
        { checkpointNamespace: '1000' },
      );
      expect(mockClaimScheduleResume).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    });

    it('stops and settles an occurrence that became inactive while awaiting approval', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockIsScheduleLive.mockResolvedValue(false);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SCHEDULE_NO_LONGER_ACTIVE' });
      // `scheduledFor` identifies the OCCURRENCE: a later fire can redirect the
      // schedule while this run sits paused, so the policy recheck validates the
      // destination this run recorded rather than the schedule's current one.
      expect(mockIsScheduleLive).toHaveBeenCalledWith('schedule-1', 4, {
        automatic: true,
        policy: true,
        scheduledFor,
      });
      expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith(CONVO_ID, {
        expectedCreatedAt: 1000,
        awaitProviderDrain: true,
      });
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'interrupted',
        conversationId: CONVO_ID,
        error: 'Schedule was disabled, changed, or deleted before approval',
      });
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        undefined,
        { checkpointNamespace: '1000' },
      );
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('fails closed without settling or pruning when provider drain cannot be confirmed', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockIsScheduleLive.mockResolvedValue(false);
      mockGenerationJobManager.abortJob.mockRejectedValue(new Error('drain timed out'));

      const res = await post(approveBody());

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'SCHEDULE_STOP_UNCONFIRMED' });
      expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    // `abortJob` reports `success: false` with a REASON on every failure path. Gating on
    // the absence of a reason treated an unreached job and a replacement generation as
    // confirmed stops, settling the occurrence and pruning a checkpoint on neither.
    it.each([
      ['the job vanished before the abort landed', 'job_not_found'],
      ['a replacement generation owns the conversation', 'generation_replaced'],
      ['the generation is still live', 'job_still_active'],
    ])('refuses to settle or prune when %s', async (_label, failureReason) => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockIsScheduleLive.mockResolvedValue(false);
      mockGenerationJobManager.abortJob.mockResolvedValue({ success: false, failureReason });

      const res = await post(approveBody());

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'SCHEDULE_STOP_UNCONFIRMED' });
      expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    // The exact regression: an abort that reported `success: false` and nothing else was
    // read as a confirmed stop, so the occurrence was settled and its checkpoint pruned.
    it('refuses to settle or prune on a bare unsuccessful abort with no reason', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockIsScheduleLive.mockResolvedValue(false);
      mockGenerationJobManager.abortJob.mockResolvedValue({ success: false });

      const res = await post(approveBody());

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'SCHEDULE_STOP_UNCONFIRMED' });
      expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    });

    it('settles an occurrence whose generation was already terminal and drained', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockIsScheduleLive.mockResolvedValue(false);
      // No transition was needed, but `awaitProviderDrain` still proved the provider
      // segment can no longer persist — a stop, just not one this call made. Refusing
      // here would 503 a permanently terminal generation on every retry.
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        failureReason: 'already_settled',
      });

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SCHEDULE_NO_LONGER_ACTIVE' });
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId: 'schedule-1', status: 'interrupted' }),
      );
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalled();
    });

    it('refuses to settle the stale resume handoff on an unconfirmed stop', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockFinalizeScheduleResumeClaim.mockResolvedValue(false);
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        failureReason: 'generation_replaced',
      });

      const res = await post(approveBody());

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'SCHEDULE_STOP_UNCONFIRMED' });
      expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('records success after resumed persistence and before terminal publication', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;

      expect(capturedInit.isScheduledFire).toBe(true);
      expect(mockInitializeClient.mock.calls[0][0].scheduledTokenContext).toEqual({
        scheduleId: 'schedule-1',
        ownerId: USER_ID,
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        invocationMode: 'delegated',
      });

      expect(mockClaimScheduleResume).toHaveBeenCalledWith('schedule-1', scheduledFor, {
        expectedConfigRevision: 4,
        automatic: true,
      });
      expect(mockFinalizeScheduleResumeClaim).toHaveBeenCalledWith(
        'schedule-1',
        'resume-token',
        'resume:resume-token',
        { expectedConfigRevision: 4, automatic: true },
      );

      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'success',
        conversationId: CONVO_ID,
      });
      expect(mockRecordScheduleOutcome.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0],
      );
    });

    it('keeps the approval paused when global scheduled-run capacity is full', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockClaimScheduleResume.mockResolvedValue({ conflict: 'capacity' });

      const res = await post(approveBody());

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'SCHEDULE_CAPACITY' });
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
    });

    it('rolls back scheduled capacity when the approval CAS does not consume the action', async () => {
      const job = makeScheduledJob();
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.approvals.resolve.mockResolvedValue(false);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(mockReleaseScheduleResumeClaim).toHaveBeenCalledWith('schedule-1', scheduledFor, 0);
      expect(mockReleaseScheduleResumeFence).toHaveBeenCalledWith(
        'schedule-1',
        'resume:resume-token',
      );
    });

    it('stops before provider execution when an edit wins the final resume handoff', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockFinalizeScheduleResumeClaim.mockResolvedValue(false);

      const res = await post(approveBody());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SCHEDULE_NO_LONGER_ACTIVE' });
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith(CONVO_ID, {
        expectedCreatedAt: 1000,
        awaitProviderDrain: true,
      });
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'interrupted',
        conversationId: CONVO_ID,
        error: 'Schedule was disabled, changed, or deleted before approval',
      });
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('settles a scheduled continuation stopped during its resumed segment', async () => {
      const job = makeScheduledJob();
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockInitializeClient.mockImplementation(async () => {
        job.abortController.abort();
        return { client: makeClient(), userMCPAuthMap: {} };
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'interrupted',
        conversationId: CONVO_ID,
        error: 'Scheduled run was stopped',
      });
    });

    it('records an empty-preempt resumed segment as interrupted, not successful', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          run: {
            getPreemptStats: () => ({ emptyBoundaries: 1 }),
            getHaltReason: () => 'preempt_incomplete',
          },
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ unfinished: true }),
        expect.anything(),
      );
      expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
        scheduleId: 'schedule-1',
        scheduledFor,
        streamId: CONVO_ID,
        jobCreatedAt: 1000,
        status: 'interrupted',
        conversationId: CONVO_ID,
        error: 'Scheduled run was interrupted before completion',
      });
    });

    it('does not overwrite the terminal winner when failed-resume finalization loses its CAS', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeScheduledJob());
      mockGenerationJobManager.completeJob.mockResolvedValue(false);
      mockInitializeClient.mockRejectedValue(new Error('resume reconstruction failed'));

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;

      expect(mockGenerationJobManager.completeJob).toHaveBeenCalled();
      expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
    });
  });

  describe('temporal context restore', () => {
    it('restores the paused turn start from the durable job before initializeClient', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob({ createdAt: 1234 }));
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      expect(capturedInit.turnStartedAt).toBe(1234);
    });

    /**
     * `approvals.resolve` atomically records capability and flips the job to
     * running. Durable-arm reconstruction follows; ioredis queues rather than
     * rejects during an outage, so an unbounded await there would strand the
     * client after the action is already spent.
     */
    it('answers the resume even when steering bookkeeping never settles', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      let releaseRearm;
      mockGenerationJobManager.rearmQueuedPreempts.mockReturnValue(
        new Promise((resolve) => {
          releaseRearm = () => resolve(0);
        }),
      );

      try {
        const res = await post(approveBody());
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('resuming');
      } finally {
        releaseRearm?.();
        mockGenerationJobManager.rearmQueuedPreempts.mockResolvedValue(0);
      }
    }, 15000);
  });

  describe('content policy preflight', () => {
    it('preserves the default-off path without reading the durable checkpoint', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGetAgentCheckpointer).not.toHaveBeenCalled();
      expect(mockInitializeClient).toHaveBeenCalledTimes(1);
    });

    it('does not read the checkpoint for a source unrelated to resume content', async () => {
      requestConfigOverrides = {
        filters: {
          prompts: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGetAgentCheckpointer.mockRejectedValue(new Error('checkpoint unavailable'));

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGetAgentCheckpointer).not.toHaveBeenCalled();
      expect(mockInitializeClient).toHaveBeenCalledTimes(1);
    });

    it('blocks the current saved agent instructions before consuming or acknowledging approval', async () => {
      requestConfigOverrides = {
        filters: {
          agentInstructions: {
            pii: {
              fields: ['instructions'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      endpointAgent.instructions = 'Use sk-current-agent-secret when answering.';
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'instructions',
        }),
      );
      expect(mockGetAgentCheckpointer).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGetMCPRequestContext).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('blocks model parameters on a currently reachable nested agent before ACK', async () => {
      requestConfigOverrides = {
        filters: {
          modelParameters: {
            pii: {
              fields: ['request_fields'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      endpointAgent.edges = [{ from: AGENT_ID, to: 'nested-agent' }];
      mockGetAgent.mockResolvedValue({
        _id: 'mongo-nested-agent',
        id: 'nested-agent',
        provider: 'openAI',
        model: 'gpt-test',
        model_parameters: { privateHeader: 'sk-nested-model-secret' },
        tools: [],
        edges: [],
      });
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'model_parameter',
          field: 'request_fields',
        }),
      );
      expect(mockGetAgent).toHaveBeenCalledWith({ id: 'nested-agent' });
      expect(mockCheckPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          resourceType: ResourceType.AGENT,
          resourceId: 'mongo-nested-agent',
        }),
      );
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('blocks current action metadata before consuming approval', async () => {
      requestConfigOverrides = {
        filters: {
          actionMetadata: {
            pii: {
              fields: ['privacy_policy_url'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      endpointAgent.tools = ['lookup_action_example'];
      mockGetActions.mockResolvedValue([
        {
          action_id: 'action-1',
          agent_id: AGENT_ID,
          metadata: {
            domain: 'example.test',
            privacy_policy_url: 'sk-current-action-secret',
          },
        },
      ]);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(mockGetActions).toHaveBeenCalledWith({ agentId: [AGENT_ID] }, false);
      expect(mockDecryptMetadata).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('blocks current model-bound memory before consuming approval', async () => {
      requestConfigOverrides = {
        memory: { disabled: false },
        filters: {
          memories: {
            pii: {
              fields: ['value'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockGetUserMemories.mockResolvedValue([
        { key: 'credential', value: 'sk-current-memory-secret' },
      ]);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(mockGetUserMemories).toHaveBeenCalledWith({
        userId: USER_ID,
        agentId: undefined,
      });
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('claims and ACKs a safe current agent graph, action, and memory snapshot', async () => {
      requestConfigOverrides = {
        memory: { disabled: false },
        endpoints: {
          agents: {
            checkpointer: { type: 'mongo' },
            capabilities: [AgentCapabilities.memory],
          },
        },
        filters: {
          agentInstructions: {
            pii: { fields: ['instructions'], starterPatterns: ['sk_prefix'] },
          },
          modelParameters: {
            pii: { fields: ['request_fields'], starterPatterns: ['sk_prefix'] },
          },
          actionMetadata: {
            pii: { fields: ['privacy_policy_url'], starterPatterns: ['sk_prefix'] },
          },
          memories: {
            pii: { fields: ['value'], starterPatterns: ['sk_prefix'] },
          },
        },
      };
      endpointAgent.edges = [{ from: AGENT_ID, to: 'nested-agent' }];
      endpointAgent.tools = ['lookup_action_example'];
      mockGetAgent.mockResolvedValue({
        _id: 'mongo-nested-agent',
        id: 'nested-agent',
        provider: 'openAI',
        model: 'gpt-test',
        instructions: 'Safe nested instructions.',
        model_parameters: { privateHeader: 'safe-header' },
        tools: [Tools.memory],
        edges: [],
      });
      mockGetActions.mockResolvedValue([
        {
          action_id: 'action-1',
          agent_id: AGENT_ID,
          metadata: {
            domain: 'example.test',
            privacy_policy_url: 'https://example.test/privacy',
          },
        },
      ]);
      mockGetUserMemories.mockResolvedValue([{ key: 'preference', value: 'Likes tea.' }]);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        streamId: CONVO_ID,
        conversationId: CONVO_ID,
        status: 'resuming',
        generationProtocolVersion: 1,
      });
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerDrained: true,
          providerExecutionId: expect.any(String),
        }),
        1000,
      );
      await settled;
      await flush();
      expect(mockInitializeClient).toHaveBeenCalledTimes(1);
    });

    it('blocks legacy checkpoint content before initializeClient', async () => {
      requestConfigOverrides = {
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'user', content: 'sk-legacy-checkpoint-secret' }],
          },
        },
      });

      const res = await post(approveBody());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'message',
        }),
      );

      expect(mockCheckpointGetTuple).toHaveBeenCalledWith({
        configurable: {
          thread_id: CONVO_ID,
          checkpoint_ns: '',
        },
      });
      expect(mockGetMessages).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        user: USER_ID,
      });
      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGetMCPRequestContext).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    });

    it('blocks checkpoint-only content from the active generation namespace', async () => {
      requestConfigOverrides = {
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const job = makeToolApprovalJob({
        metadata: { checkpointNamespace: 'generation-1000' },
      });
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'user', content: 'sk-namespaced-checkpoint-secret' }],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'message',
        }),
      );
      expect(mockCheckpointGetTuple).toHaveBeenCalledWith({
        configurable: {
          thread_id: CONVO_ID,
          checkpoint_ns: '',
          __librechat_checkpoint_ns: 'generation-1000',
        },
      });
      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('keeps checkpoint tool arguments visible to files-only fail-close policy', async () => {
      requestConfigOverrides = {
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                content: 'inspect the attachment',
                tool_calls: [
                  {
                    name: 'inspect_file',
                    args: { file_id: 'checkpoint-tool-file' },
                  },
                ],
              },
            ],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
          source: 'file',
          field: 'content',
        }),
      );
      expect(mockGetFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['checkpoint-tool-file'] }, user: USER_ID, tenantId: TENANT_ID },
        {},
        {},
      );
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('keeps structured checkpoint text metadata visible to files-only policy', async () => {
      requestConfigOverrides = {
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: {
                      value: 'inspect the attachment',
                      annotations: [{ file_id: 'checkpoint-annotation-file' }],
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
          source: 'file',
          field: 'content',
        }),
      );
      expect(mockGetFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['checkpoint-annotation-file'] }, user: USER_ID, tenantId: TENANT_ID },
        {},
        {},
      );
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('blocks protected values nested in cyclic checkpoint tool arguments', async () => {
      requestConfigOverrides = {
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const cyclicArguments = { token: 'sk-cyclic-checkpoint-secret' };
      cyclicArguments.self = cyclicArguments;
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ name: 'lookup', args: cyclicArguments }],
              },
            ],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'tool_argument',
          field: 'arguments',
        }),
      );
      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('fails closed when selected checkpoint tool arguments cannot be fully traversed', async () => {
      requestConfigOverrides = {
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const deepArguments = {};
      let current = deepArguments;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      Object.defineProperty(deepArguments, 'toJSON', {
        value: () => {
          throw new Error('cannot serialize');
        },
      });
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ name: 'lookup', args: deepArguments }],
              },
            ],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
          source: 'tool_argument',
          field: 'arguments',
        }),
      );
      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('allows incomplete checkpoint arguments when only tool output is selected', async () => {
      requestConfigOverrides = {
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const deepArguments = {};
      let current = deepArguments;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      Object.defineProperty(deepArguments, 'toJSON', {
        value: () => {
          throw new Error('cannot serialize');
        },
      });
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockCheckpointGetTuple.mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ name: 'lookup', args: deepArguments }],
              },
            ],
          },
        },
      });

      const res = await post(approveBody());

      expect(res.status).toBe(200);
      await settled;
      await flush();
      expect(mockInitializeClient).toHaveBeenCalledTimes(1);
    });

    it('blocks legacy seed tool content before initializeClient', async () => {
      requestConfigOverrides = {
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [makeToolCallContent({ output: 'sk-legacy-seed-secret' })],
      });

      const res = await post(approveBody());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'tool_argument',
          field: 'output',
        }),
      );

      expect(mockInitializeClient).not.toHaveBeenCalled();
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.getResumeState).toHaveBeenCalledWith(
        CONVO_ID,
        job.createdAt,
        { validateEarlyBufferRecovery: true },
      );
    });

    it('blocks a user-authored respond decision before consuming the action', async () => {
      requestConfigOverrides = {
        filters: {
          messages: {
            pii: {
              fields: ['decision_response'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'respond'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);

      const res = await post(
        approveBody({
          decisions: [
            {
              tool_call_id: 'tc1',
              decision: 'respond',
              responseText: 'sk-user-response-secret',
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'message',
          field: 'decision_response',
        }),
      );
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('blocks user-edited tool arguments before consuming the action', async () => {
      requestConfigOverrides = {
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'edit'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);

      const res = await post(
        approveBody({
          decisions: [
            {
              tool_call_id: 'tc1',
              decision: 'edit',
              editedArguments: { token: 'sk-user-edited-secret' },
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'tool_argument',
          field: 'arguments',
        }),
      );
      expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });
  });

  describe('MCP request-context lifecycle', () => {
    it('pre-seeds the run-scoped MCP context before initializeClient and tears it down after', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled; // the controller's finally has run

      // Seeded with a null `res` + cleanupOnResponse:false so the post-ACK tool load
      // finds the existing store instead of getting undefined (res is already finished).
      expect(mockGetMCPRequestContext).toHaveBeenCalledWith(expect.anything(), undefined, {
        cleanupOnResponse: false,
      });
      // ...and seeded BEFORE the client (hence tool loading) is built.
      expect(mockGetMCPRequestContext.mock.invocationCallOrder[0]).toBeLessThan(
        mockInitializeClient.mock.invocationCallOrder[0],
      );
      // ...then torn down exactly once in the finally.
      expect(mockCleanupMCPRequestContextForReq).toHaveBeenCalledTimes(1);
    });

    it('marks the exact resumed provider segment drained only after request cleanup', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      const resumePatch = mockGenerationJobManager.approvals.resolve.mock.calls[0][2];
      expect(mockGenerationJobManager.beginProviderExecution).toHaveBeenCalledWith(
        CONVO_ID,
        1000,
        resumePatch.providerExecutionId,
      );
      expect(mockGenerationJobManager.markProviderExecutionDrained).toHaveBeenCalledWith(
        CONVO_ID,
        1000,
        resumePatch.providerExecutionId,
      );
      expect(mockCleanupMCPRequestContextForReq.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.markProviderExecutionDrained.mock.invocationCallOrder[0],
      );
      expect(
        mockGenerationJobManager.beginProviderExecution.mock.invocationCallOrder[0],
      ).toBeGreaterThan(mockInitializeClient.mock.invocationCallOrder[0]);
    });
  });

  describe('request guards (rejected before claiming the action)', () => {
    it('400 when conversationId is missing', async () => {
      const res = await post({ actionId: ACTION_ID });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/conversationId is required/i);
      expect(mockGenerationJobManager.getJob).not.toHaveBeenCalled();
    });

    it('400 when conversationId is the "new" placeholder', async () => {
      const res = await post({ conversationId: 'new', actionId: ACTION_ID });
      expect(res.status).toBe(400);
      expect(mockGenerationJobManager.getJob).not.toHaveBeenCalled();
    });

    it('404 when there is no paused job for the conversation', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);
      const res = await post(approveBody());
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no paused generation/i);
    });

    it('403 when the job belongs to another user', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { userId: 'someone-else' } }),
      );
      const res = await post(approveBody());
      expect(res.status).toBe(403);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('fails closed when the stored job owner is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { userId: undefined } }),
      );

      const res = await post(approveBody());

      expect(res.status).toBe(403);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('403 on a tenant mismatch', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { tenantId: 'other-tenant' } }),
      );
      const res = await post(approveBody());
      expect(res.status).toBe(403);
    });

    it('403 when the resume omits the paused agent_id', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ agent_id: undefined }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different agent/i);
    });

    it('403 when the resume claims a different agent_id', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ agent_id: 'agent-other' }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different agent/i);
    });

    it('403 when the resume claims a different endpoint', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ endpoint: 'bedrock' }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different endpoint/i);
    });

    it('403 when the resume OMITS the paused endpoint (no fall-through to ephemeral)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ endpoint: undefined }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different endpoint/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('409s a resume targeting a replaced generation before claiming the action', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(approveBody({ generationCreatedAt: 999 }));

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'RUN_REPLACED', generationProtocolVersion: 1 });
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('409 when the job is not in requires_action (already terminal; no expire)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob({ status: 'running' }));
      const res = await post(approveBody());
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no live pending action/i);
      // Already resolved/terminal — nothing to expire.
      expect(mockGenerationJobManager.expireApproval).not.toHaveBeenCalled();
    });

    it('409 AND drives expiry when the pending action has expired (stale)', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.expiresAt = Date.now() - 1_000;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no live pending action/i);
      // The stale action is expired NOW (expire CAS + terminal SSE) so an attached SSE
      // client gets a terminal event instead of hanging until the periodic sweeper runs.
      expect(mockGenerationJobManager.expireApproval).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        1000,
      );
    });

    it('400 when actionId is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ actionId: undefined }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/actionId is required/i);
    });

    it('409 when actionId targets a stale action', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody({ actionId: 'stale-action' }));
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/stale action/i);
    });

    it('400 when a tool call is left undecided', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.action_requests = [
        { tool_call_id: 'tc1' },
        { tool_call_id: 'tc2' },
      ];
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'reject'] },
        { tool_call_id: 'tc2', allowed_decisions: ['approve', 'reject'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody()); // only decides tc1
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be decided/i);
      expect(res.body.undecided).toEqual(['tc2']);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when a persisted approval payload aliases two calls to the same id', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.action_requests = [
        { tool_call_id: 'tc1', name: 'write', arguments: { value: 'hidden' } },
        { tool_call_id: 'tc1', name: 'write', arguments: { value: 'visible' } },
      ];
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', action_name: 'write', allowed_decisions: ['approve', 'reject'] },
        { tool_call_id: 'tc1', action_name: 'write', allowed_decisions: ['approve', 'reject'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);

      const res = await post(approveBody());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid tool approval payload/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when the client submits duplicate decisions for one tool-call id', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());

      const res = await post(
        approveBody({
          decisions: [
            { tool_call_id: 'tc1', decision: 'approve' },
            { tool_call_id: 'tc1', decision: 'reject' },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid tool approval decisions/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('403 when a decision is not permitted by the tool policy', async () => {
      const job = makeToolApprovalJob();
      // Policy restricts tc1 to reject only; an `approve` must be refused.
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['reject'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not permitted/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when an edit decision omits editedArguments', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'edit'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(
        approveBody({ decisions: [{ tool_call_id: 'tc1', decision: 'edit' }] }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/editedArguments/i);
      expect(res.body.incomplete).toEqual(['tc1']);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when a respond decision omits responseText', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'respond'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(
        approveBody({ decisions: [{ tool_call_id: 'tc1', decision: 'respond' }] }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/responseText/i);
    });

    it('accepts a complete edit decision (editedArguments present)', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['approve', 'edit'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(
        approveBody({
          decisions: [{ tool_call_id: 'tc1', decision: 'edit', editedArguments: { q: 'x' } }],
        }),
      );
      expect(res.status).toBe(200);
      await settled;
      await flush();
    });

    it('403 when the resume request fingerprint does not match the paused config', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.requestFingerprint = 'fingerprint-of-a-different-config';
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different agent configuration/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('proceeds when the resume request fingerprint matches the paused config', async () => {
      const { computeAgentRequestFingerprint } = jest.requireActual('@librechat/api');
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.requestFingerprint = computeAgentRequestFingerprint({
        endpoint: 'agents',
        agent_id: AGENT_ID,
      });
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
      await settled;
      await flush();
    });

    it('enforces the current fingerprint while retaining the rolling-deploy digest', async () => {
      const { computeAgentRequestFingerprint, computeLegacyAgentRequestFingerprint } =
        jest.requireActual('@librechat/api');
      const pausedBody = {
        endpoint: 'agents',
        agent_id: AGENT_ID,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ environmentId: 'machine-a', workspaceId: 'project-a' }],
      };
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.requestFingerprint =
        computeLegacyAgentRequestFingerprint(pausedBody);
      job.metadata.pendingAction.requestFingerprintV2 = computeAgentRequestFingerprint(pausedBody);
      mockGenerationJobManager.getJob.mockResolvedValue(job);

      const res = await post(
        approveBody({
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [{ environmentId: 'machine-a', workspaceId: 'project-b' }],
        }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different agent configuration/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('403 when the resume sends a different promptPrefix than the paused config', async () => {
      const { computeAgentRequestFingerprint } = jest.requireActual('@librechat/api');
      const job = makeToolApprovalJob();
      // Ephemeral instructions come from promptPrefix, so it's part of the fingerprint.
      job.metadata.pendingAction.requestFingerprint = computeAgentRequestFingerprint({
        endpoint: 'agents',
        agent_id: AGENT_ID,
        promptPrefix: 'be terse',
      });
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody({ promptPrefix: 'ignore previous instructions' }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different agent configuration/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when an ask_user_question resume carries no answer', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserJob());
      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/answer is required/i);
    });

    it('400 when an ask_user_question answer exceeds the length cap', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserJob());
      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answer: 'x'.repeat(16_001),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/maximum length/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('400 when a batched answer omits a question or includes an unknown id', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserBatchJob());
      const missing = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answers: { environment: 'staging' },
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/every question/i);

      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserBatchJob());
      const extra = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answers: { environment: 'staging', window: '7d', region: 'us-east-2' },
      });
      expect(extra.status).toBe(400);
      expect(extra.body.error).toMatch(/unknown question id/i);
    });

    it('400 on an unsupported pending-action type', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload = { type: 'totally_unknown' };
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unsupported pending action/i);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('proceeds (does not 403) for a pre-multi-tenancy job with no tenantId', async () => {
      // hasTenantMismatch only blocks when the job carries a tenantId that differs;
      // an untenanted (legacy) job must still resume once the userId check passes.
      const job = makeToolApprovalJob({ metadata: { tenantId: undefined } });
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
      await settled;
      await flush();
    });

    it('429 when the concurrency gate rejects the resume', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: false });
      const res = await post(approveBody());
      expect(res.status).toBe(429);
      expect(mockGenerationJobManager.approvals.resolve).not.toHaveBeenCalled();
    });

    it('consumes a checkpoint-snapshot rejection on the 429 early-return path', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: false });
      mockCaptureAgentCheckpointGeneration.mockRejectedValue(new Error('mongo down'));

      const res = await post(approveBody());
      await flush();

      expect(res.status).toBe(429);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[ResumeAgentController] Failed to capture checkpoint generation',
        { type: 'Error' },
      );
    });

    it('409 and releases the slot when the action was already claimed (single-winner)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.approvals.resolve.mockResolvedValue(false);
      const res = await post(approveBody());
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already resolved or has expired/i);
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('409s RUN_REPLACED when the generation changes before the resume CAS', async () => {
      const original = makeToolApprovalJob();
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(makeToolApprovalJob({ createdAt: 2000 }));
      mockGenerationJobManager.approvals.resolve.mockResolvedValue(false);

      const res = await post(approveBody({ generationCreatedAt: 1000 }));

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'RUN_REPLACED', generationProtocolVersion: 1 });
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });

    it('releases the slot when the claim itself throws (store error, not a leak)', async () => {
      // The increment happens before the claim, which runs before the run's own
      // try/finally — a store error here must still release the slot or a retry of the
      // still-paused approval gets spuriously 429'd until the counter TTL expires.
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.approvals.resolve.mockRejectedValue(new Error('redis down'));
      const res = await post(approveBody());
      expect(res.status).toBe(500);
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockInitializeClient).not.toHaveBeenCalled();
    });
  });

  describe('happy path: approve -> reconstruct -> resume -> finalize', () => {
    const statefulCodeAgent = (bridgeWorkerId) => ({
      id: AGENT_ID,
      codeExecutionContext: {
        baseUrl: 'https://bridge.example/v1',
        codeSessionKey: `execute_code:stateful:route-a:${bridgeWorkerId}`,
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:route-a',
        runtimeSessionHint: 'v3:environment-a:agent-user:scope-a',
        statefulSessions: true,
        environmentId: 'environment-a',
        environmentType: 'attached',
        bridgeWorkerId,
      },
    });

    it('resumes when the rebuilt stateful code target matches the paused approval', async () => {
      const agent = statefulCodeAgent('worker-a');
      const codeExecutionBinding = captureCodeExecutionApprovalBinding([agent]);
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { pendingAction: { codeExecutionBinding } } }),
      );
      const resumedClient = makeClient({
        options: { agent },
        agentConfigs: new Map(),
      });
      mockInitializeClient.mockResolvedValue({ client: resumedClient, userMCPAuthMap: {} });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.beginProviderExecution).toHaveBeenCalledTimes(1);
      expect(resumedClient.resumeCompletion).toHaveBeenCalledTimes(1);
    });

    it('fails before provider execution when the approved stateful code target changed', async () => {
      const pausedAgent = statefulCodeAgent('worker-a');
      const codeExecutionBinding = captureCodeExecutionApprovalBinding([pausedAgent]);
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { pendingAction: { codeExecutionBinding } } }),
      );
      const resumedClient = makeClient({
        options: { agent: statefulCodeAgent('worker-b') },
        agentConfigs: new Map(),
      });
      mockInitializeClient.mockResolvedValue({ client: resumedClient, userMCPAuthMap: {} });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.beginProviderExecution).not.toHaveBeenCalled();
      expect(resumedClient.resumeCompletion).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        CONVO_ID,
        expect.stringContaining('Retry the request and review the action again'),
        1000,
      );
      expect(mockDisposeClient).toHaveBeenCalledWith(resumedClient);
    });

    it('seals the exact paused legacy-event fence only after resumed history persists', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { agentEventLegacyTurnToken: 'legacy-hitl-token' } }),
      );

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockCompleteAgentEventActorLegacyTurn).toHaveBeenCalledWith({
        user: USER_ID,
        tenantId: TENANT_ID,
        conversationId: CONVO_ID,
        token: 'legacy-hitl-token',
      });
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockCompleteAgentEventActorLegacyTurn.mock.invocationCallOrder[0],
      );
    });

    it('ACKs immediately and claims the action atomically with the submitted actionId', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const res = await post(approveBody());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        streamId: CONVO_ID,
        conversationId: CONVO_ID,
        status: 'resuming',
        generationProtocolVersion: 1,
      });
      expect(mockCaptureAgentCheckpointGeneration).toHaveBeenCalledWith(CONVO_ID, {
        type: 'mongo',
      });
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
      expect(mockCaptureAgentCheckpointGeneration.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.resolve.mock.invocationCallOrder[0],
      );
      await settled;
      await flush();
    });

    it('preserves and exactly echoes a paused generation protocol v2 marker', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { generationProtocolVersion: 2 } }),
      );

      const res = await post(approveBody({ generationProtocolVersion: 2 }));

      expect(res.status).toBe(200);
      expect(res.headers['x-librechat-generation-protocol']).toBe('2');
      expect(res.body).toEqual({
        streamId: CONVO_ID,
        conversationId: CONVO_ID,
        status: 'resuming',
        generationProtocolVersion: 2,
      });
      await settled;
      await flush();
    });

    it('seeds the thread parent before reconstruction and maps the decision to the SDK', async () => {
      const compactionSemanticIndex = {
        version: 1,
        entries: [
          {
            type: 'activity_phase',
            sourceMessageId: 'assistant-history',
            sourceContentIndex: 1,
            revision: 1,
            status: 'committed',
            text: 'Verified the release state',
          },
        ],
      };
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { compactionSemanticIndex } }),
      );
      await post(approveBody());
      await settled;
      await flush();

      // initializeAgent scopes thread files off req.body.parentMessageId, seeded
      // from the paused user message's parent before initializeClient runs.
      expect(capturedInit.parentMessageId).toBe(THREAD_PARENT_ID);
      expect(capturedInit.requestBody).toEqual({
        messageId: RESPONSE_MSG_ID,
        conversationId: CONVO_ID,
        parentMessageId: USER_MSG_ID,
      });
      expect(capturedInit.foregroundRunId).toBe(RESPONSE_MSG_ID);

      expect(mockInitializeClient).toHaveBeenCalledTimes(1);
      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.resumeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeValue: { tc1: { type: 'approve' } },
          userMCPAuthMap: { server1: { token: 't' } },
          compactionSemanticIndex,
        }),
      );
    });

    it('seeds the rebuilt client from the context meta captured at the pause', async () => {
      const contextMeta = {
        calibrationRatio: 1.25,
        encoding: 'claude',
        fading: { v: 1, budgetTokens: 50_000, masked: true },
      };
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { contextMeta } }),
      );
      await post(approveBody());
      await settled;
      await flush();

      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.seedContextMeta).toHaveBeenCalledWith(contextMeta);
      expect(client.seedContextMeta.mock.invocationCallOrder[0]).toBeLessThan(
        client.resumeCompletion.mock.invocationCallOrder[0],
      );
    });

    it('reuses the persisted MCP identity for edited and overridden turns', async () => {
      const persistedMCPRequestBody = {
        messageId: RESPONSE_MSG_ID,
        conversationId: 'overridden-conversation',
        parentMessageId: RESPONSE_MSG_ID,
      };
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { mcpRequestBody: persistedMCPRequestBody } }),
      );

      await post(approveBody());
      await settled;
      await flush();

      expect(capturedInit.requestBody).toBe(persistedMCPRequestBody);
    });

    it('reuses the persisted generation checkpoint namespace and keeps legacy fallback explicit', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { checkpointNamespace: 'generation-1000' } }),
      );
      await post(approveBody());
      await settled;
      await flush();

      expect(capturedInit.checkpointNamespace).toBe('generation-1000');
      expect(mockCaptureAgentCheckpointGeneration).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        undefined,
        { checkpointNamespace: 'generation-1000' },
      );
    });

    it('passes persisted run steps into the rebuilt run for tool-result correlation', async () => {
      const runSteps = [
        {
          id: 'step-approval',
          index: 1,
          type: 'tool_calls',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'tc1', name: 'approval_probe', args: '{}' }],
          },
          usage: null,
        },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [],
        runSteps,
      });

      await post(approveBody());
      await settled;
      await flush();

      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.resumeCompletion).toHaveBeenCalledWith(expect.objectContaining({ runSteps }));
    });

    it('reapplies retained ask answers before resuming a later tool approval', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            resolvedAskUserQuestions: [
              {
                request: 'Which environment?',
                output: 'staging',
                toolCallId: 'ask-1',
              },
            ],
          },
        }),
      );
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [
          {
            type: 'tool_call',
            tool_call: { id: 'ask-1', name: 'ask_user_question', args: '' },
          },
        ],
        runSteps: [],
      });

      await post(approveBody());
      await settled;
      await flush();

      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.resumeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          seedContent: [
            expect.objectContaining({
              tool_call: expect.objectContaining({
                id: 'ask-1',
                args: JSON.stringify('Which environment?'),
                output: 'staging',
                progress: 1,
              }),
            }),
          ],
        }),
      );
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
        }),
        1000,
      );
    });

    it('restores the paused user message files before reconstruction (execute-code files)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // The resume body carries no files; the controller must source them from the
      // persisted user message so an approved code/read-file tool keeps its uploads.
      mockGetMessages.mockResolvedValue([{ files: [{ file_id: 'f1' }] }]);

      await post(approveBody());
      await settled;
      await flush();

      expect(capturedInit.files).toEqual([{ file_id: 'f1' }]);
    });

    it.each([false, true])('preserves the job deadline when re-pause=%s', async (rePause) => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: { isTemporary: true, retentionExpiresAt: expiredAt.toISOString() },
        }),
      );
      if (rePause) {
        mockInitializeClient.mockResolvedValue({
          client: makeClient({
            pendingApproval: { actionId: NEXT_ACTION_ID },
            contentParts: [{ type: 'text', text: 'partial' }],
          }),
          userMCPAuthMap: {},
        });
      }
      const res = await post(approveBody({ isTemporary: false }));
      expect(res.status).toBe(200);
      await settled;
      await flush();
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isTemporary: true, expiredAt }),
        expect.anything(),
        expect.anything(),
      );
    });

    it.each([
      { stored: true, supplied: false, expected: true },
      { stored: false, supplied: true, expected: false },
      { stored: undefined, supplied: true, expected: false },
    ])(
      'restores authoritative isTemporary=$stored before reconstruction',
      async ({ stored, supplied, expected }) => {
        mockGenerationJobManager.getJob.mockResolvedValue(
          makeToolApprovalJob({ metadata: { isTemporary: stored } }),
        );

        const res = await post(approveBody({ isTemporary: supplied }));
        expect(res.status).toBe(200);
        await settled;

        expect(capturedInit.isTemporary).toBe(expected);
      },
    );

    it('ignores client-supplied resume files, sourcing from the paused job (security)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // The paused turn's authoritative files (DB row); a crafted client tries to swap them.
      mockGetMessages.mockResolvedValue([{ files: [{ file_id: 'paused' }] }]);

      await post(approveBody({ files: [{ file_id: 'attacker-supplied' }] }));
      await settled;
      await flush();

      // The crafted client files must NOT reach initializeAgent — only the paused set.
      expect(capturedInit.files).toEqual([{ file_id: 'paused' }]);
    });

    it('clears client-supplied resume files when the paused turn had none (security)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGetMessages.mockResolvedValue([{ files: [] }]); // the paused turn had no files

      await post(approveBody({ files: [{ file_id: 'attacker-supplied' }] }));
      await settled;
      await flush();

      expect(capturedInit.files).toEqual([]);
    });

    it('prefers job-metadata files over both the client body and the DB row', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            userMessage: {
              messageId: USER_MSG_ID,
              parentMessageId: THREAD_PARENT_ID,
              text: 'x',
              files: [{ file_id: 'meta' }],
            },
          },
        }),
      );
      mockGetMessages.mockResolvedValue([{ files: [{ file_id: 'db' }] }]);

      await post(approveBody({ files: [{ file_id: 'attacker-supplied' }] }));
      await settled;
      await flush();

      expect(capturedInit.files).toEqual([{ file_id: 'meta' }]);
    });

    it('carries the restored files onto the final requestMessage (user bubble keeps attachments)', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // job.metadata.userMessage is persisted without files; the final SSE must still
      // carry the restored uploads or the user bubble loses its attachments on resume.
      mockGetMessages.mockResolvedValue([{ files: [{ file_id: 'f1', filename: 'a.pdf' }] }]);

      await post(approveBody());
      await settled;
      await flush();

      const [, finalEvent] = mockGenerationJobManager.publishTerminalClaim.mock.calls[0];
      expect(finalEvent.requestMessage).toMatchObject({
        messageId: USER_MSG_ID,
        isCreatedByUser: true,
        files: [{ file_id: 'f1', filename: 'a.pdf' }],
      });
    });

    it('persists the response, claims terminal ownership, emits done, finishes, and prunes', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, isTemporary: false }),
        expect.objectContaining({
          messageId: RESPONSE_MSG_ID,
          parentMessageId: USER_MSG_ID,
          conversationId: CONVO_ID,
          content: [{ type: 'text', text: 'resumed answer' }],
          unfinished: false,
          error: false,
          isCreatedByUser: false,
          user: USER_ID,
          agent_id: AGENT_ID,
        }),
        expect.objectContaining({
          context: 'api/server/controllers/agents/resume.js - resumed response end',
        }),
      );

      // Assert the finalEvent STRUCTURE, not just the hardcoded `final: true` literal —
      // a `final: true`-only check would still pass if the entire content / title /
      // requestMessage build in finalizeResumedTurn were deleted.
      const [terminalClaim, finalEvent] =
        mockGenerationJobManager.publishTerminalClaim.mock.calls[0];
      expect(terminalClaim).toMatchObject({ streamId: CONVO_ID, persistencePending: true });
      expect(finalEvent).toMatchObject({
        final: true,
        conversation: { conversationId: CONVO_ID },
        responseMessage: {
          messageId: RESPONSE_MSG_ID,
          content: [{ type: 'text', text: 'resumed answer' }],
          unfinished: false,
        },
        requestMessage: { messageId: USER_MSG_ID, isCreatedByUser: true },
      });
      expect(typeof finalEvent.title).toBe('string');

      expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
        CONVO_ID,
        'complete',
        undefined,
        1000,
        { persistencePending: true },
      );
      const claim = await mockGenerationJobManager.claimTerminalJob.mock.results[0].value;
      expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledWith(claim);
      expect(mockGenerationJobManager.claimTerminalJob.mock.invocationCallOrder[0]).toBeLessThan(
        mockSaveMessage.mock.invocationCallOrder[0],
      );
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0],
      );
      expect(
        mockGenerationJobManager.publishTerminalClaim.mock.invocationCallOrder[0],
      ).toBeLessThan(mockGenerationJobManager.finishTerminalJob.mock.invocationCallOrder[0]);
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        { threadId: CONVO_ID, checkpointIds: ['checkpoint-old'] },
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockDisposeClient).toHaveBeenCalledTimes(1);
    });

    it('publishes reconciliation instead of a normal FINAL when the resumed response save returns no row', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.completeJob.mockResolvedValue(false);
      mockSaveMessage.mockResolvedValue(undefined);

      await post(approveBody());
      await settled;
      await flush();

      const claim = await mockGenerationJobManager.claimTerminalJob.mock.results[0].value;
      expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledWith(claim, null);
      expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledWith(claim);
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        CONVO_ID,
        'Resumed response could not be persisted before terminal publication',
        1000,
      );
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('degrades a failed checkpoint snapshot to scoped no-op cleanup', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockCaptureAgentCheckpointGeneration.mockRejectedValue(new Error('mongo down'));

      await post(approveBody());
      await settled;
      await flush();

      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        { threadId: CONVO_ID, checkpointIds: [] },
      );
    });

    it('skips finalization when the job was replaced mid-resume', async () => {
      // The paused job has createdAt 1000; a concurrent request reused this conversationId,
      // so the live job now has a different createdAt — finalizing would clobber the newer
      // turn's job. The finally still runs (slot release), so `settled` resolves.
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob({ createdAt: 1000 }));
      mockJobStore.getJob.mockResolvedValue({
        tokenUsage: null,
        contextUsage: null,
        createdAt: 2000,
      });
      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.claimTerminalJob).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.finishTerminalJob).not.toHaveBeenCalled();
    });

    it('does not write a completed response when a pause or abort wins the terminal claim', async () => {
      const job = makeToolApprovalJob();
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      let signalResumeBoundary;
      const resumeBoundary = new Promise((resolve) => {
        signalResumeBoundary = resolve;
      });
      let releaseResume;
      const resumeGate = new Promise((resolve) => {
        releaseResume = resolve;
      });
      const client = makeClient({
        resumeCompletion: jest.fn(async () => {
          signalResumeBoundary();
          await resumeGate;
        }),
      });
      mockInitializeClient.mockResolvedValue({ client, userMCPAuthMap: {} });

      await post(approveBody());
      await resumeBoundary;
      // Cross-replica Stop wins durably while its abort pub/sub is delayed, so
      // the local signal remains live and only the terminal CAS can fence this
      // resumed completion's Mongo write.
      mockGenerationJobManager.claimTerminalJob.mockResolvedValue(null);
      releaseResume();
      await settled;
      await flush();

      expect(job.abortController.signal.aborted).toBe(false);
      expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
        CONVO_ID,
        'complete',
        undefined,
        1000,
        { persistencePending: true },
      );
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.finishTerminalJob).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    });

    it('finishes a winning terminal claim even when FINAL publication throws', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.publishTerminalClaim.mockRejectedValue(new Error('transport down'));

      await post(approveBody());
      await settled;
      await flush();

      const claim = await mockGenerationJobManager.claimTerminalJob.mock.results[0].value;
      expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledWith(claim);
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        CONVO_ID,
        'transport down',
        1000,
      );
    });

    it('does not release the slot in the finally when the client already released it on pause', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // Simulate handleRunInterrupt having released the concurrency slot on a re-pause.
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ pendingRequestReleased: true }),
        userMCPAuthMap: {},
      });
      let disposed;
      const disposedP = new Promise((resolve) => {
        disposed = resolve;
      });
      mockDisposeClient.mockImplementation(() => disposed());

      await post(approveBody());
      await disposedP;
      await flush();

      // The finally must NOT double-release — handleRunInterrupt already did.
      expect(mockDecrementPendingRequest).not.toHaveBeenCalled();
    });

    it('persists tool artifacts produced by the resumed continuation as attachments', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const artifact = { type: 'image', file_id: 'img-1' };
      // The lean resume path bypasses BaseClient.sendMessage's artifact await, so the
      // controller must await client.artifactPromises itself (and drop null results).
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          artifactPromises: [Promise.resolve(artifact), Promise.resolve(null)],
        }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ attachments: [artifact] }),
        expect.anything(),
      );
    });

    it('falls back to the aggregated store content when the live client content is empty', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // No live content on the rebuilt client → the saved response must use the
      // pre-pause aggregated content from the store, not an empty array.
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ contentParts: [] }),
        userMCPAuthMap: {},
      });
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [{ type: 'text', text: 'from-store' }],
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ content: [{ type: 'text', text: 'from-store' }] }),
        expect.anything(),
      );
    });

    it('strips malformed tool_call parts from the saved content', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          contentParts: [
            { type: 'text', text: 'kept' },
            { type: 'tool_call' }, // malformed: no tool_call payload — must be filtered
          ],
        }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ content: [{ type: 'text', text: 'kept' }] }),
        expect.anything(),
      );
    });

    it('merges previously persisted attachments with the resumed segment artifacts', async () => {
      const priorArtifact = { type: 'image', file_id: 'prior-1' };
      const newArtifact = { type: 'image', file_id: 'new-1' };
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      // An earlier pause segment already saved an attachment on the response row.
      mockGetMessages.mockResolvedValue([{ attachments: [priorArtifact] }]);
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ artifactPromises: [Promise.resolve(newArtifact)] }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ attachments: [priorArtifact, newArtifact] }),
        expect.anything(),
      );
    });

    it('persists the resumed run context calibration (contextMeta) onto the saved response', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const contextMeta = { calibrationRatio: 0.8 };
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ contextMeta }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ contextMeta }),
        expect.anything(),
      );
    });

    it('unsets the paused row context meta when the resumed run completes neutrally', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({
          metadata: {
            contextMeta: {
              calibrationRatio: 1.2,
              encoding: 'claude',
              fading: { v: 1, budgetTokens: 50_000, masked: true },
            },
          },
        }),
      );
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ contextMeta: undefined }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ contextMeta: null }),
        expect.objectContaining({ context: expect.stringContaining('resumed response end') }),
      );
    });

    it('carries manualSkills/alwaysAppliedSkills onto the resumed requestMessage', async () => {
      const job = makeToolApprovalJob();
      job.metadata.userMessage.manualSkills = ['skill-a'];
      job.metadata.userMessage.alwaysAppliedSkills = ['skill-b'];
      mockGenerationJobManager.getJob.mockResolvedValue(job);

      await post(approveBody());
      await settled;
      await flush();

      const [, finalEvent] = mockGenerationJobManager.publishTerminalClaim.mock.calls[0];
      expect(finalEvent.requestMessage).toMatchObject({
        manualSkills: ['skill-a'],
        alwaysAppliedSkills: ['skill-b'],
      });
    });

    it('attaches client response metadata to the saved message when present', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const contextUsage = { tokenCount: 1234 };
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ buildResponseMetadata: jest.fn(() => ({ contextUsage })) }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metadata: expect.objectContaining({ contextUsage }) }),
        expect.anything(),
      );
    });

    it('resumes an ask_user_question with the free-form answer', async () => {
      const job = makeAskUserJob();
      const olderAsk = {
        type: 'tool_call',
        tool_call: { id: 'older-ask', name: 'ask_user_question', args: '' },
      };
      const currentAsk = {
        type: 'tool_call',
        tool_call: { id: 'current-ask', name: 'ask_user_question', args: '' },
      };
      const answeredPart = makeToolCallContent({
        id: 'current-ask',
        name: 'ask_user_question',
        output: 'call it report.pdf',
      });
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [olderAsk, currentAsk],
      });
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          contentParts: [olderAsk, answeredPart, { type: 'text', text: 'Done' }],
        }),
        userMCPAuthMap: {},
      });
      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answer: 'call it report.pdf',
      });
      expect(res.status).toBe(200);
      await settled;
      await flush();

      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.resumeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ resumeValue: { answer: 'call it report.pdf' } }),
      );
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
          resolvedAskUserQuestions: [
            {
              request: 'What should I name the file?',
              output: 'call it report.pdf',
              contentIndex: 1,
            },
          ],
        }),
        1000,
      );
      expect(mockJobStore.updateJob).toHaveBeenCalledWith(
        CONVO_ID,
        {
          userSubmittedMessageFieldPaths: [
            { path: '/content/1/tool_call/output', field: 'answer' },
          ],
        },
        1000,
      );
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userSubmittedMessageFieldPaths: [
            { path: '/content/1/tool_call/output', field: 'answer' },
          ],
        }),
        expect.anything(),
      );
      expect(mockSaveMessage.mock.calls[0][1]).not.toHaveProperty('userSubmittedPaths');
      expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
        CONVO_ID,
        'complete',
        undefined,
        1000,
        { persistencePending: true },
      );
    });

    it('retains an ID-less answer when earlier text exists but the ask part is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserJob());
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [{ type: 'text', text: 'Let me check.' }],
      });

      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answer: 'call it report.pdf',
      });

      expect(res.status).toBe(200);
      await settled;
      await flush();
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
          resolvedAskUserQuestions: [
            {
              request: 'What should I name the file?',
              output: 'call it report.pdf',
              contentMissing: true,
            },
          ],
        }),
        1000,
      );
    });

    it('resumes a batched ask_user_question with answers keyed by question id', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeAskUserBatchJob());
      const answers = { environment: 'staging', window: '7d' };
      const output = JSON.stringify({ answers });
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [
          makeToolCallContent({ id: 'tc1', name: 'ask_user_question', args: '', output: '' }),
        ],
      });
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          contentParts: [
            makeToolCallContent({ id: 'tc1', name: 'ask_user_question', output }),
            { type: 'text', text: 'Done' },
          ],
        }),
        userMCPAuthMap: {},
      });
      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answers,
      });
      expect(res.status).toBe(200);
      await settled;
      await flush();

      const client = await mockInitializeClient.mock.results[0].value.then((r) => r.client);
      expect(client.resumeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ resumeValue: { answers } }),
      );
      expect(mockGenerationJobManager.approvals.resolve).toHaveBeenCalledWith(
        CONVO_ID,
        ACTION_ID,
        expect.objectContaining({
          preemptCapable: true,
          providerExecutionId: expect.any(String),
          providerDrained: true,
          resolvedAskUserQuestions: [
            {
              request: { questions: expect.any(Array) },
              output,
              toolCallId: 'tc1',
            },
          ],
        }),
        1000,
      );
      const exactProvenance = [{ path: '/content/0/tool_call/output', field: 'answer' }];
      expect(mockJobStore.updateJob).toHaveBeenCalledWith(
        CONVO_ID,
        { userSubmittedMessageFieldPaths: exactProvenance },
        1000,
      );
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userSubmittedMessageFieldPaths: exactProvenance }),
        expect.anything(),
      );
    });

    it('persists answer provenance for the payload tool_call_id in a multi-ask turn', async () => {
      const job = makeAskUserJob();
      job.metadata.pendingAction.payload.tool_call_id = 'ask-first';
      const firstAsk = makeToolCallContent({
        id: 'ask-first',
        name: 'ask_user_question',
        args: '',
        output: '',
      });
      const secondAsk = makeToolCallContent({
        id: 'ask-second',
        name: 'ask_user_question',
        args: '',
        output: '',
      });
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [firstAsk, secondAsk],
      });
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          contentParts: [
            makeToolCallContent({
              id: 'ask-first',
              name: 'ask_user_question',
              output: 'first answer',
            }),
            secondAsk,
          ],
        }),
        userMCPAuthMap: {},
      });

      const res = await post({
        conversationId: CONVO_ID,
        actionId: ACTION_ID,
        agent_id: AGENT_ID,
        endpoint: 'agents',
        answer: 'first answer',
      });
      expect(res.status).toBe(200);
      await settled;
      await flush();

      const exactProvenance = [{ path: '/content/0/tool_call/output', field: 'answer' }];
      expect(mockJobStore.updateJob).toHaveBeenCalledWith(
        CONVO_ID,
        { userSubmittedMessageFieldPaths: exactProvenance },
        1000,
      );
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userSubmittedMessageFieldPaths: exactProvenance }),
        expect.anything(),
      );
    });

    it.each([
      {
        name: 'respond text',
        resolution: { tool_call_id: 'tc1', decision: 'respond', responseText: 'human response' },
        finalToolCall: { output: 'human response' },
        expectedPath: '/content/0/tool_call/output',
        expectedField: 'decision_response',
      },
      {
        name: 'reject reason',
        resolution: { tool_call_id: 'tc1', decision: 'reject', reason: 'human rejection' },
        finalToolCall: { output: 'human rejection' },
        expectedPath: '/content/0/tool_call/output',
        expectedField: 'decision_reason',
      },
      {
        name: 'edited arguments',
        resolution: { tool_call_id: 'tc1', decision: 'edit', editedArguments: { q: 'human edit' } },
        finalToolCall: { args: '{"q":"human edit"}' },
        expectedPath: '/content/0/tool_call/args',
        expectedField: undefined,
      },
    ])(
      'persists exact provenance for $name',
      async ({ resolution, finalToolCall, expectedPath, expectedField }) => {
        const job = makeToolApprovalJob();
        job.metadata.pendingAction.payload.review_configs = [
          {
            tool_call_id: 'tc1',
            allowed_decisions: ['approve', resolution.decision],
          },
        ];
        mockGenerationJobManager.getJob.mockResolvedValue(job);
        mockGenerationJobManager.getResumeState.mockResolvedValue({
          aggregatedContent: [makeToolCallContent()],
        });
        mockInitializeClient.mockResolvedValue({
          client: makeClient({
            contentParts: [makeToolCallContent(finalToolCall), { type: 'text', text: 'Done' }],
          }),
          userMCPAuthMap: {},
        });

        await post(approveBody({ decisions: [resolution] }));
        await settled;
        await flush();

        const expectedProvenance = expectedField
          ? {
              userSubmittedMessageFieldPaths: [{ path: expectedPath, field: expectedField }],
            }
          : { userSubmittedPaths: [expectedPath] };
        expect(mockJobStore.updateJob).toHaveBeenCalledWith(CONVO_ID, expectedProvenance, 1000);
        expect(mockSaveMessage).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining(expectedProvenance),
          expect.anything(),
        );
        if (expectedField) {
          expect(mockSaveMessage.mock.calls[0][1]).not.toHaveProperty('userSubmittedPaths');
        } else {
          expect(mockSaveMessage.mock.calls[0][1]).not.toHaveProperty(
            'userSubmittedMessageFieldPaths',
          );
        }
      },
    );

    it('does not mark approve-only HITL content as user-submitted', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [makeToolCallContent()],
      });
      mockInitializeClient.mockResolvedValue({
        client: makeClient({ contentParts: [makeToolCallContent({ output: 'tool result' })] }),
        userMCPAuthMap: {},
      });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockJobStore.updateJob).not.toHaveBeenCalledWith(
        CONVO_ID,
        expect.objectContaining({ userSubmittedPaths: expect.anything() }),
      );
      expect(mockSaveMessage.mock.calls[0][1]).not.toHaveProperty('userSubmittedPaths');
    });

    it('generates a title for a first-turn pause before completing the stream', async () => {
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGetConvo.mockResolvedValue({ title: 'New Chat' });

      await post(approveBody());
      await settled;
      await flush();

      expect(mockAddTitle).toHaveBeenCalledTimes(1);
      // Terminal ownership precedes title persistence and final stream publication.
      expect(mockGenerationJobManager.claimTerminalJob).toHaveBeenCalledWith(
        CONVO_ID,
        'complete',
        undefined,
        1000,
        { persistencePending: true },
      );
      expect(mockGenerationJobManager.claimTerminalJob.mock.invocationCallOrder[0]).toBeLessThan(
        mockAddTitle.mock.invocationCallOrder[0],
      );
    });

    it('still finalizes the turn when first-turn title generation throws', async () => {
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGetConvo.mockResolvedValue({ title: 'New Chat' });
      // Title generation is best-effort: a throw must not break the resumed turn.
      mockAddTitle.mockRejectedValue(new Error('title service down'));

      await post(approveBody());
      await settled;
      await flush();

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockSaveMessage).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.publishTerminalClaim).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: CONVO_ID }),
        expect.any(Object),
      );
      expect(mockGenerationJobManager.finishTerminalJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-finalizing outcomes', () => {
    it('re-pause: does not finalize when the run pauses again', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      const exposePendingApproval = jest.fn().mockResolvedValue(undefined);
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          exposePendingApproval,
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      // It persists progress (unfinished) but must NOT finalize the turn.
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ unfinished: true }),
        expect.anything(),
      );
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.claimTerminalJob).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.approvals.ownsPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        1000,
      );
      expect(mockGenerationJobManager.approvals.finishPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        1000,
      );
      expect(mockGenerationJobManager.failPausePersistence).not.toHaveBeenCalled();
      expect(exposePendingApproval.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.finishPausePersistence.mock.invocationCallOrder[0],
      );
      // The slot is still released and the client disposed.
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockDisposeClient).toHaveBeenCalledTimes(1);
    });

    it('re-pause: persists the segment content (unfinished) so an expiring re-pause keeps it', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'streamed this segment' }],
          artifactPromises: [],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          content: [{ type: 'text', text: 'streamed this segment' }],
          unfinished: true,
        }),
        expect.objectContaining({
          context: 'api/server/controllers/agents/resume.js - re-pause progress persist',
        }),
      );
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
    });

    it('re-pause: preserves HITL response provenance on the unfinished row', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['respond'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [makeToolCallContent()],
      });
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: true,
          contentParts: [makeToolCallContent({ output: 'human response' })],
        }),
        userMCPAuthMap: {},
      });

      await post(
        approveBody({
          decisions: [{ tool_call_id: 'tc1', decision: 'respond', responseText: 'human response' }],
        }),
      );
      await settled;
      await flush();

      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          unfinished: true,
          userSubmittedMessageFieldPaths: [
            { path: '/content/0/tool_call/output', field: 'decision_response' },
          ],
        }),
        expect.anything(),
      );
    });

    it('re-pause: persists artifacts produced before pausing again (unfinished)', async () => {
      const artifact = { type: 'image', file_id: 'seg-1' };
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          artifactPromises: [Promise.resolve(artifact)],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      // No finalize, but the segment's artifact is persisted unfinished so the next
      // resume's finalize can merge it (otherwise the fresh client drops it).
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ attachments: [artifact], unfinished: true }),
        expect.objectContaining({
          context: 'api/server/controllers/agents/resume.js - re-pause progress persist',
        }),
      );
    });

    it('re-pause: holds the exact Stop/resume barrier until progress persistence settles', async () => {
      let signalSaveStarted;
      const saveStarted = new Promise((resolve) => {
        signalSaveStarted = resolve;
      });
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      mockSaveMessage.mockImplementation(async () => {
        signalSaveStarted();
        await saveGate;
        return {};
      });
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'must be durable before another action' }],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await saveStarted;

      expect(mockGenerationJobManager.approvals.ownsPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        1000,
      );
      expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).not.toHaveBeenCalled();

      releaseSave();
      await settled;
      await flush();

      expect(mockGenerationJobManager.approvals.finishPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        1000,
      );
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.approvals.finishPausePersistence.mock.invocationCallOrder[0],
      );
    });

    it('re-pause: terminalizes instead of exposing the next action when persistence fails', async () => {
      mockSaveMessage.mockRejectedValue(new Error('re-pause save failed'));
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'progress that must not be lost' }],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.failPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        're-pause save failed',
        1000,
      );
      expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        { threadId: CONVO_ID, checkpointIds: ['checkpoint-old'] },
      );
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockGenerationJobManager.failPausePersistence.mock.invocationCallOrder[0],
      );
    });

    it('re-pause: contains checkpoint deletion failure after exact persistence terminalization', async () => {
      const checkpointError = new Error('checkpoint delete unavailable');
      mockSaveMessage.mockRejectedValue(new Error('re-pause save failed'));
      mockDeleteAgentCheckpoint.mockRejectedValue(checkpointError);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'progress that must not be lost' }],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.failPausePersistence).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ResumeAgentController] Failed to prune checkpoint after re-pause persistence failure',
        { type: 'Error' },
      );
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockDisposeClient).toHaveBeenCalledTimes(1);
    });

    it('re-pause: leaves a replacement checkpoint untouched when exact persistence failure loses ownership', async () => {
      mockSaveMessage.mockResolvedValue(undefined);
      mockGenerationJobManager.failPausePersistence.mockResolvedValue(false);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          pendingApproval: { actionId: NEXT_ACTION_ID },
          contentParts: [{ type: 'text', text: 'stale segment progress' }],
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.failPausePersistence).toHaveBeenCalledWith(
        CONVO_ID,
        NEXT_ACTION_ID,
        'Re-pause response progress could not be persisted',
        1000,
      );
      expect(mockGenerationJobManager.approvals.finishPausePersistence).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    });

    it('abort-during-resume: lets the abort route finalize, does not double-save', async () => {
      const job = makeToolApprovalJob();
      job.metadata.pendingAction.payload.review_configs = [
        { tool_call_id: 'tc1', allowed_decisions: ['respond'] },
      ];
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [makeToolCallContent()],
      });
      mockInitializeClient.mockImplementation(async () => {
        job.abortController.abort();
        return { client: makeClient(), userMCPAuthMap: {} };
      });

      const res = await post(
        approveBody({
          decisions: [{ tool_call_id: 'tc1', decision: 'respond', responseText: 'human response' }],
        }),
      );
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.publishTerminalClaim).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockJobStore.updateJob).toHaveBeenCalledWith(
        CONVO_ID,
        {
          userSubmittedMessageFieldPaths: [
            { path: '/content/0/tool_call/output', field: 'decision_response' },
          ],
        },
        1000,
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
    });

    it('resume failure delegates safe single-winner error publication and prunes the checkpoint', async () => {
      const rawValue = 'PRIVATE-RESUME-PROVIDER-ECHO';
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error(`Provider echoed ${rawValue}`)),
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200); // already ACKed before the failure
      await settled;
      await flush();

      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        CONVO_ID,
        `Provider echoed ${rawValue}`,
        1000,
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(rawValue);
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        CONVO_ID,
        { type: 'mongo' },
        { threadId: CONVO_ID, checkpointIds: ['checkpoint-old'] },
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    it('uses a normalized resume error when protection is active', async () => {
      const rawValue = 'PRIVATE-RESUME-PROVIDER-ECHO';
      requestConfigOverrides = { filters: { messages: { pii: {} } } };
      const job = makeToolApprovalJob();
      job.metadata.userMessage.parentMessageId = Constants.NO_PARENT;
      mockGenerationJobManager.getJob.mockResolvedValue(job);
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error(`Provider echoed ${rawValue}`)),
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        CONVO_ID,
        'Resume failed',
        1000,
      );
      expect(JSON.stringify(mockGenerationJobManager.completeJob.mock.calls)).not.toContain(
        rawValue,
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(rawValue);
    });

    it('preserves resume error behavior for an unrelated-only source policy', async () => {
      const rawValue = 'PROMPT-SOURCE-DOES-NOT-PARTICIPATE-IN-RESUME';
      requestConfigOverrides = {
        filters: {
          prompts: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error(rawValue)),
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGetAgentCheckpointer).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(CONVO_ID, rawValue, 1000);
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(rawValue);
    });

    it('contains checkpoint deletion failure after winning ordinary resume-error finalization', async () => {
      const checkpointError = new Error('checkpoint delete unavailable');
      mockDeleteAgentCheckpoint.mockRejectedValue(checkpointError);
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error('boom')),
        }),
        userMCPAuthMap: {},
      });

      const res = await post(approveBody());
      expect(res.status).toBe(200);
      await settled;
      await flush();

      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(CONVO_ID, 'boom', 1000);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ResumeAgentController] Failed to prune checkpoint after failed resume finalization',
        { type: 'Error' },
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
      expect(mockDisposeClient).toHaveBeenCalledTimes(1);
    });

    it('keeps a re-pause checkpoint when failed-resume terminal ownership is lost', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(
        makeToolApprovalJob({ metadata: { checkpointNamespace: 'generation-1000' } }),
      );
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error('boom')),
        }),
        userMCPAuthMap: {},
      });
      // A fresh interrupt moved the same epoch back to requires_action before
      // the error path's terminal CAS. Its newly written checkpoint is live.
      mockGenerationJobManager.completeJob.mockResolvedValue(false);

      await post(approveBody());
      await settled;
      await flush();

      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(CONVO_ID, 'boom', 1000);
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    });

    it('does not overwrite the job when guarded error finalization itself fails', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(makeToolApprovalJob());
      mockInitializeClient.mockResolvedValue({
        client: makeClient({
          resumeCompletion: jest.fn().mockRejectedValue(new Error('boom')),
        }),
        userMCPAuthMap: {},
      });
      // An unconditional fallback update could overwrite a pause or replacement
      // that won while completeJob was failing.
      mockGenerationJobManager.completeJob.mockRejectedValue(new Error('complete failed'));

      await post(approveBody());
      await settled;
      await flush();

      expect(mockJobStore.updateJob).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(USER_ID);
    });
  });
});
