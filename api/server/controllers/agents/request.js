const { logger, tenantStorage, createChatExpirationDate } = require('@librechat/data-schemas');
const { v5: uuidv5 } = require('uuid');
const {
  Constants,
  EModelEndpoint,
  ErrorTypes,
  ViolationTypes,
  isEphemeralAgentId,
  reasoningOverrideSchema,
} = require('librechat-data-provider');
const {
  toPendingSteer,
  getViolationInfo,
  buildMessageFiles,
  getReferencedQuotes,
  resolveTitleTiming,
  GenerationJobManager,
  createConvoPersistenceSignal,
  recoverTurnMessageReference,
  filterPersistableAbortContent,
  decrementPendingRequest,
  sanitizeMessageForTransmit,
  checkAndIncrementPendingRequest,
  exemptFromConcurrencyLimiter,
  isScheduleFireRequest,
  isUnpersistedPreliminaryParent,
  resolveConversationAnchor,
  getAgentStartupTelemetry,
  acceptAgentStartupTelemetry,
  isSteerPreemptSupported,
  buildRecoveredSteerPayload,
  deleteAgentCheckpoint,
  getAttachmentTitleText,
  createMCPRuntimeRequestBody,
  resolveRunCodeWorkspaces,
  getSafeErrorText,
  isAgentEventRetentionActive,
  createAgentEventActorTurn,
  createAgentEventActorDetachedActionLifecycle,
  parseAgentEventActorDetachedCompletion,
  EVENT_ACTOR_DETACHED_COMPLETION_SOURCE,
  EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
  findAgentEventAppliedAction,
  createAgentEventActionRecorder,
  isHITLEnabled,
  agentRequestsAskUserQuestion,
  resolveAgentTurnExecutionPlan,
  logAgentMemorySnapshot,
  getCodeWorkspaceSelectionErrorDetails,
  shouldPersistCodeWorkspaceInitializationError,
  resolvePersistableCodeEnvironmentDecision,
  getFailedTurnTraceFields,
  resolveFailedTurnContent,
  announceReply,
  announceErrorTurn,
} = require('@librechat/api');
const { disposeClient } = require('~/server/cleanup');
const {
  getMCPRequestContext,
  cleanupMCPRequestContextForReq,
} = require('~/server/services/MCPRequestContext');
const { logViolation } = require('~/cache');
const { recordScheduleOutcome, isScheduleLive } = require('~/server/services/Schedules');
const {
  saveMessage,
  saveConvo,
  getMessages,
  getConvo,
  getAgentEventActorSnapshot,
  commitAgentEventActorState,
  storeAgentEventActorSuspension,
  beginAgentEventActorLegacyTurn,
  completeAgentEventActorLegacyTurn,
  recordAgentEventActorReconciliation,
  resolveAgentEventActorReconciliation,
  clearAgentEventActorReconciliation,
  admitAgentEventActorAction,
  releaseAgentEventActorAction,
  hasAgentEventActorActionAdmission,
  getAgentEventActorReceipt,
  getAgentEventActorDetachedAction,
  reserveAgentEventActorDetachedAction,
  markAgentEventActorDetachedActionRunning,
  settleAgentEventActorDetachedAction,
  claimAgentEventActorSuspension,
  settleAgentEventActorSuspension,
  stampConvoLastResponse,
  isAgentTriggerPrincipalActive,
  isSubagentOwnerAdmissible,
  appendConvoMessageReference,
} = require('~/models');
const {
  acquireEventChildGenerationLease,
} = require('~/server/services/Endpoints/agents/eventChildLease');
const {
  GENERATION_PROTOCOL_HEADER,
  GENERATION_PROTOCOL_V2,
  negotiateNewGenerationProtocol,
  negotiateExistingGenerationProtocol,
} = require('./protocol');

function sendGenerationJson(res, status, body, generationProtocolVersion) {
  if (typeof res.set === 'function') {
    res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  } else if (typeof res.setHeader === 'function') {
    res.setHeader(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  }
  return res.status(status).json({ ...body, generationProtocolVersion });
}

function getInitializationFailure(error) {
  if (error?.code === ErrorTypes.RESOURCE_RECOVERY_REQUIRED) {
    return {
      status: 409,
      code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      error: error.message || 'Attached resources must be restored before retrying.',
    };
  }

  const candidateStatus = error?.status ?? error?.statusCode;
  if (!Number.isInteger(candidateStatus) || candidateStatus < 400 || candidateStatus >= 600) {
    return null;
  }
  return {
    status: candidateStatus,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...getCodeWorkspaceSelectionErrorDetails(error),
    error: error?.message || 'Failed to start generation',
  };
}

function resolveConversationCreatedAt({ userId, conversationId, isNewConvo, conversation }) {
  return resolveConversationAnchor({
    isNewConversation: isNewConvo,
    loadConversation: () =>
      conversation !== undefined ? Promise.resolve(conversation) : getConvo(userId, conversationId),
    onLoadError: (error) => {
      logger.warn('[AgentController] Failed to resolve conversation timestamp anchor', {
        conversationId,
        error: error.message,
      });
    },
  });
}

async function attachConversationCreatedAt(req, conversationId, conversationAnchorPromise) {
  req.body.conversationId = conversationId;
  const resolved = await conversationAnchorPromise;
  req.conversationCreatedAt = resolved.createdAt;
  if (resolved.conversation !== undefined) {
    req.resolvedConversation = resolved.conversation ?? null;
  }
}

function getPreliminaryResponseMessageId({ messageId, responseMessageId }) {
  if (typeof responseMessageId === 'string' && responseMessageId.length > 0) {
    return responseMessageId;
  }

  if (typeof messageId !== 'string' || messageId.length === 0) {
    return null;
  }

  return `${messageId.replace(/_+$/, '')}_`;
}

/**
 * Manual compaction runs as a summarize-only turn hung off the branch's leaf.
 * It needs an existing branch to summarize, and it cannot be combined with the
 * turn shapes that create or rewrite a user message.
 * @returns {{ status: number, code: string, error: string } | null}
 */
function getCompactionRejection(req, { conversationId, parentMessageId }) {
  if (req.config?.summarization?.enabled === false) {
    return {
      status: 400,
      code: 'COMPACTION_DISABLED',
      error: 'Context compaction is disabled for this deployment.',
    };
  }
  if (!conversationId || conversationId === Constants.NEW_CONVO) {
    return {
      status: 400,
      code: 'INVALID_COMPACTION_REQUEST',
      error: 'Compaction requires an existing conversation.',
    };
  }
  if (
    typeof parentMessageId !== 'string' ||
    parentMessageId.length === 0 ||
    parentMessageId === Constants.NO_PARENT
  ) {
    return {
      status: 400,
      code: 'INVALID_COMPACTION_REQUEST',
      error: 'Compaction requires the message to compact up to.',
    };
  }
  const { isContinued, isRegenerate, editedContent, responseMessageId } = req.body ?? {};
  if (isContinued || isRegenerate || editedContent != null || responseMessageId) {
    return {
      status: 400,
      code: 'INVALID_COMPACTION_REQUEST',
      error: 'Compaction cannot be combined with an edit, regenerate, or continue.',
    };
  }
  return null;
}

/**
 * The leaf a compaction hangs off, in the user-message slot the job metadata
 * and the abort path read before the branch is loaded. Identity only: the
 * client validates the leaf against the history it loads anyway, and the job
 * must not carry the leaf's content.
 */
function projectCompactionAnchor({ messageId, conversationId }) {
  return { messageId, conversationId, text: '' };
}

/**
 * The id the turn's user message is created under. A compaction creates no
 * user message: its "user message" slot holds the leaf it summarizes up to,
 * and a bound event turn keys the id off its task.
 * @returns {string}
 */
function resolvePreallocatedUserMessageId({
  isCompaction,
  parentMessageId,
  eventTaskId,
  overrideUserMessageId,
  overrideParentMessageId,
}) {
  if (isCompaction) {
    return parentMessageId;
  }
  if (eventTaskId != null) {
    return `${eventTaskId}:user`;
  }
  return overrideUserMessageId ?? overrideParentMessageId ?? crypto.randomUUID();
}

function getPreliminaryUserMessage(
  {
    messageId,
    parentMessageId,
    text,
    quotes,
    files,
    manualSkills,
    alwaysAppliedSkills,
    reasoningOverride,
  },
  conversationId,
  subagentTriggerProjection,
) {
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return null;
  }

  /**
   * Seed normalized quotes here too: if the user aborts before `sendMessage`
   * reaches `onStart` (during init/tool loading), `abortMiddleware` falls back
   * to this preliminary metadata, which must carry the excerpts so the stopped
   * turn keeps its `MessageQuotes`.
   */
  const referencedQuotes = getReferencedQuotes(quotes);
  const parsedReasoningOverride = reasoningOverrideSchema.safeParse(reasoningOverride);

  return {
    messageId,
    parentMessageId,
    conversationId,
    text,
    ...(referencedQuotes != null && { quotes: referencedQuotes }),
    // Persist the turn's uploaded files on this AWAITED preliminary write so they land on
    // job.metadata.userMessage BEFORE the run can reach its first interrupt. onStart's
    // later writes are fire-and-forget, so a fast approval could otherwise read the job
    // and resume an approved code/read-file tool without the paused turn's uploads.
    ...(Array.isArray(files) && files.length > 0 && { files }),
    // Carry skill selections so a HITL-resumed turn's reconstructed `requestMessage`
    // keeps its skill pills — the client's final handler replaces the user bubble from
    // this object, and they'd otherwise vanish until a full reload refetches the row.
    ...(Array.isArray(manualSkills) && manualSkills.length > 0 && { manualSkills }),
    ...(Array.isArray(alwaysAppliedSkills) &&
      alwaysAppliedSkills.length > 0 && { alwaysAppliedSkills }),
    ...(parsedReasoningOverride.success && {
      reasoningOverride: parsedReasoningOverride.data,
    }),
    ...(subagentTriggerProjection != null && { subagentTriggerProjection }),
  };
}

const DISPLAY_IDENTITY_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

function sanitizeEventDisplayIdentity(value) {
  if (typeof value !== 'string') return undefined;
  const bounded = Array.from(value).slice(0, 512).join('');
  const sanitized = bounded.normalize('NFC').replace(DISPLAY_IDENTITY_CONTROLS, ' ').trim();
  return sanitized.length === 0 ? undefined : Array.from(sanitized).slice(0, 256).join('');
}

function getAgentEventTriggerProjection(agentEventDelivery) {
  const event = agentEventDelivery?.event;
  const occurredAt = new Date(event?.occurredAt);
  const eventType = sanitizeEventDisplayIdentity(event?.type);
  const sourceType = sanitizeEventDisplayIdentity(event?.source?.type);
  if (eventType == null || sourceType == null || Number.isNaN(occurredAt.getTime())) {
    return undefined;
  }
  const expectedActionToolName = sanitizeEventDisplayIdentity(
    agentEventDelivery?.expectedAction?.toolName,
  );
  return {
    version: 1,
    eventType,
    sourceType,
    occurredAt,
    ...(expectedActionToolName == null ? {} : { expectedActionToolName }),
  };
}

function getRequestModelSpec(req, endpointOption) {
  const spec = endpointOption?.spec ?? req.body?.spec;
  if (typeof spec !== 'string' || spec.length === 0) {
    return;
  }

  const list = req.config?.modelSpecs?.list;
  if (!Array.isArray(list)) {
    return;
  }

  return list.find((modelSpec) => modelSpec?.name === spec);
}

function getModelSpecIconURL(modelSpec) {
  return modelSpec?.iconURL ?? modelSpec?.preset?.iconURL ?? modelSpec?.preset?.endpoint ?? '';
}

function getEndpointIconURL(req, endpointOption) {
  const iconURL =
    endpointOption?.iconURL ?? getModelSpecIconURL(getRequestModelSpec(req, endpointOption));
  return iconURL || undefined;
}

function getEndpointResponseModel(endpointOption) {
  return endpointOption?.modelOptions?.model || endpointOption?.model_parameters?.model;
}

function getAgentResponseModel(req, endpointOption) {
  const agentId = endpointOption?.agent_id || req.body?.agent_id;
  if (typeof agentId === 'string' && agentId.length > 0 && !isEphemeralAgentId(agentId)) {
    return agentId;
  }

  return getEndpointResponseModel(endpointOption);
}

async function finishResumableRequest(req, userId) {
  try {
    await cleanupMCPRequestContextForReq(req);
  } finally {
    if (req._scheduleConcurrencyExempt !== true) {
      await decrementPendingRequest(userId);
    }
  }
}

async function saveErrorTurn(
  req,
  {
    conversationId,
    endpointOption,
    isNewConvo,
    errorText,
    liveUserMessage,
    liveResponseMessageId,
    runCreated = false,
    sender,
    initialAgentId,
  },
) {
  try {
    const { isContinued, isRegenerate, editedContent, responseMessageId, overrideParentMessageId } =
      req.body ?? {};
    if (
      isContinued ||
      editedContent != null ||
      (responseMessageId && !isRegenerate) ||
      req.body?.recoverySteerId != null ||
      req.body?.clientRequestId?.startsWith?.('steer-recovery:') === true
    ) {
      return;
    }

    let userMessage = null;
    let errorMessageId = null;
    let errorParentMessageId = null;
    if (req.body?.compact === true) {
      /** The anchor is the persisted leaf, never rewritten. Without the
       *  loaded anchor (the branch failed to load) there is nothing safe
       *  to parent an error row onto, so nothing is written. */
      if (liveUserMessage?.messageId == null) {
        return;
      }
      errorMessageId = getPreliminaryResponseMessageId({ messageId: liveUserMessage.messageId });
      errorParentMessageId = liveUserMessage.messageId;
    } else if (isRegenerate) {
      errorMessageId =
        typeof responseMessageId === 'string' && responseMessageId.length > 0
          ? responseMessageId
          : null;
      errorParentMessageId = liveUserMessage?.messageId ?? overrideParentMessageId ?? null;
    } else {
      userMessage =
        liveUserMessage != null
          ? {
              ...liveUserMessage,
              ...(liveUserMessage.files == null &&
                Array.isArray(req.body?.files) &&
                req.body.files.length > 0 && { files: req.body.files }),
              ...(liveUserMessage.manualSkills == null &&
                Array.isArray(req.body?.manualSkills) &&
                req.body.manualSkills.length > 0 && { manualSkills: req.body.manualSkills }),
              ...(liveUserMessage.alwaysAppliedSkills == null &&
                Array.isArray(req.body?.alwaysAppliedSkills) &&
                req.body.alwaysAppliedSkills.length > 0 && {
                  alwaysAppliedSkills: req.body.alwaysAppliedSkills,
                }),
            }
          : getPreliminaryUserMessage(req.body, conversationId, req._agentEventTriggerProjection);
      if (!userMessage) {
        return;
      }
      errorMessageId = getPreliminaryResponseMessageId(
        liveUserMessage != null ? { messageId: liveUserMessage.messageId } : req.body,
      );
      errorParentMessageId = userMessage.messageId;
    }
    if (!errorMessageId || !errorParentMessageId) {
      return;
    }

    const userId = req.user.id;
    const existing = await getMessages(
      { user: userId, messageId: errorMessageId, conversationId },
      '_id',
    );
    if (existing.length > 0) {
      return;
    }
    if (liveResponseMessageId != null && liveResponseMessageId !== errorMessageId) {
      const partial = await getMessages(
        { user: userId, messageId: liveResponseMessageId, conversationId },
        '_id',
      );
      if (partial.length > 0) {
        return;
      }
    }

    const reqCtx = {
      userId,
      isTemporary:
        req?._agentEventBindingRetention?.isTemporary ??
        req?.resolvedConversation?.isTemporary ??
        req?.body?.isTemporary,
      expiredAt:
        req?._agentEventBindingRetention?.expiredAt ?? req?.resolvedConversation?.expiredAt,
      interfaceConfig: req?.config?.interfaceConfig,
    };
    const context = 'api/server/controllers/agents/request.js - failed turn';
    const endpoint = endpointOption?.endpoint;
    const model = getAgentResponseModel(req, endpointOption);
    const iconURL = getEndpointIconURL(req, endpointOption);

    if (userMessage) {
      const savedUserMessage = await saveMessage(
        reqCtx,
        {
          ...userMessage,
          user: userId,
          sender: 'User',
          isCreatedByUser: true,
          error: false,
          unfinished: false,
        },
        { context },
      );
      if (!savedUserMessage) {
        throw new Error('Failed user message could not be persisted');
      }
    }
    const langfuseTraceFields = await getFailedTurnTraceFields(req.config, {
      messageId: errorMessageId,
      runId: liveResponseMessageId,
      runCreated,
    });
    const savedErrorMessage = await saveMessage(
      reqCtx,
      {
        ...langfuseTraceFields,
        messageId: errorMessageId,
        conversationId,
        parentMessageId: errorParentMessageId,
        sender: sender ?? 'AI',
        ...(endpoint != null && { endpoint }),
        ...(model != null && { model }),
        ...(iconURL != null && { iconURL }),
        user: userId,
        text: errorText,
        error: true,
        unfinished: false,
        isCreatedByUser: false,
        ...resolveFailedTurnContent(req.body, errorText),
      },
      { context },
    );
    if (!savedErrorMessage) {
      throw new Error('Failed response message could not be persisted');
    }

    const agentId = endpointOption?.agent_id ?? req.body?.agent_id;
    const chatProjectId = endpointOption?.chatProjectId ?? req.body?.chatProjectId;
    const seedConvo = isNewConvo || req.resolvedConversation === null;
    /** A stored turn seals the decision it ran under, on a saved chat as much as on a new one: the
     * error turn below enters the conversation, so leaving its validated decision out would let a
     * retry choose a different workspace than the failure already recorded. The resolver the
     * streaming saves already use decides what this turn may write, so an error turn and a
     * completed one record a decision under one rule. */
    const decisionFields = resolvePersistableCodeEnvironmentDecision({
      conversationId,
      decision: req._codeEnvironmentDecision,
      conversation: req.resolvedConversation,
    });
    const convoFields = seedConvo
      ? {
          ...(endpoint != null && { endpoint }),
          ...(endpointOption?.endpointType != null && {
            endpointType: endpointOption.endpointType,
          }),
          ...(model != null && { model }),
          ...(iconURL != null && { iconURL }),
          ...(endpointOption?.spec != null && { spec: endpointOption.spec }),
          ...(agentId != null && { agent_id: agentId }),
          ...(typeof chatProjectId === 'string' && chatProjectId.length > 0 && { chatProjectId }),
          ...decisionFields,
        }
      : decisionFields;
    await saveConvo(
      reqCtx,
      { conversationId, ...convoFields },
      seedConvo
        ? {
            context,
            initialAgentId:
              typeof initialAgentId === 'string' && !isEphemeralAgentId(initialAgentId)
                ? initialAgentId
                : null,
          }
        : { context, noUpsert: true },
    );
    /* A failed run still persisted an assistant message, and a user on another device has no
       other way to learn the turn ended. */
    await announceErrorTurn(
      { stampConvoLastResponse },
      {
        userId,
        conversationId,
        messageId: savedErrorMessage.messageId,
        isTemporary: reqCtx.isTemporary,
        context: 'AgentController - persisted error turn',
      },
    );
  } catch (err) {
    logger.error('[AgentController] Failed to persist error turn', err);
    throw err;
  }
}

function classifyScheduledFailure(error, aborted = false) {
  if (aborted || error?.code === 'SCHEDULE_NO_LONGER_ACTIVE') {
    return { status: 'interrupted', error: error?.message };
  }
  if (error?.message?.includes(ViolationTypes.TOKEN_BALANCE)) {
    return { status: 'skipped_balance' };
  }
  return { status: 'error', error: error?.message || 'Generation failed' };
}

const JOB_RECORD_WAIT_ATTEMPTS = 5;
const JOB_RECORD_WAIT_DELAY_MS = 60;

// A winner writes its job record within a few ms of claiming; if a losing duplicate still
// sees no job within this window of the claim, the winner is still starting (retry rather
// than hand back a stream that would 404). Past it, a missing job means the original
// already completed and was cleaned up (attach and let the client refetch).
const IDEMPOTENCY_STARTUP_GRACE_MS = 5000;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
/** New-chat retries do not carry a conversation id, so derive the stream id
 * from their stable per-submission id. This keeps both the dedupe key and the
 * Redis hash slot identical across a lost-response retry. */
const NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE = 'd7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43';

function isValidGenerationClaim(value, streamId, conversationId, requireStarted = false) {
  return (
    value != null &&
    typeof value === 'object' &&
    value.streamId === streamId &&
    value.conversationId === conversationId &&
    Number.isSafeInteger(value.claimedAt) &&
    value.claimedAt >= 0 &&
    typeof value.claimToken === 'string' &&
    value.claimToken.length > 0 &&
    value.claimToken.length <= 128 &&
    (value.generationProtocolVersion == null ||
      value.generationProtocolVersion === 1 ||
      value.generationProtocolVersion === GENERATION_PROTOCOL_V2) &&
    (value.startedAt == null || (Number.isSafeInteger(value.startedAt) && value.startedAt >= 0)) &&
    (!requireStarted || value.startedAt != null)
  );
}

/** Pre-bridge servers wrote the legacy global key without a claim token and,
 * for a new conversation, chose a random stream before claiming it. Accept
 * only that tightly bounded legacy shape: existing conversations must still
 * match the requested stream exactly; new-chat claims may point to the old
 * random stream only when streamId === conversationId. Ownership is verified
 * against the live job before attachment. */
function isValidLegacyGenerationClaim(value, streamId, isNewConvo) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.streamId === 'string' &&
    value.streamId.length > 0 &&
    value.streamId.length <= 512 &&
    value.conversationId === value.streamId &&
    (isNewConvo || value.streamId === streamId) &&
    Number.isSafeInteger(value.claimedAt) &&
    value.claimedAt >= 0 &&
    value.claimToken == null &&
    value.startedAt == null &&
    (value.generationProtocolVersion == null || value.generationProtocolVersion === 1)
  );
}

/** Store corruption must not turn a user-scoped idempotency claim into a
 * pointer to another user's/tenant's live stream. Missing tenant metadata is
 * kept as the explicit legacy case, but missing ownership never authorizes. */
function liveJobBelongsToRequester(job, user) {
  return (
    job?.metadata?.userId === user.id &&
    (job.metadata?.tenantId == null || job.metadata.tenantId === user.tenantId)
  );
}

/**
 * Poll briefly for a job record to appear. A deduped retry that loses the idempotency
 * claim must not be handed the winner's stream until its job exists, or the client's
 * subscribe 404s terminally. The winner writes the record a few ms after claiming.
 */
async function waitForJobRecord(streamId) {
  for (let attempt = 0; attempt < JOB_RECORD_WAIT_ATTEMPTS; attempt++) {
    const job = await GenerationJobManager.getJob(streamId);
    if (job) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_RECORD_WAIT_DELAY_MS));
  }
  return GenerationJobManager.getJob(streamId);
}

/** The claimed generation already reached durable/terminal history, but its
 * conversation stream id now belongs to no job or to a newer submission. A
 * success shape with that streamId would attach the stale submission to the
 * replacement, so tell the client to refetch without opening SSE. */
function sendSettledGeneration(
  res,
  streamId,
  conversationId,
  startupTelemetry,
  generationProtocolVersion,
  generationCreatedAt,
) {
  startupTelemetry?.end('deduplicated');
  if (generationProtocolVersion < GENERATION_PROTOCOL_V2) {
    return sendGenerationJson(
      res,
      200,
      {
        streamId,
        conversationId,
        ...(generationCreatedAt != null && { generationCreatedAt }),
        status: 'resumed',
      },
      generationProtocolVersion,
    );
  }
  return sendGenerationJson(
    res,
    200,
    {
      conversationId,
      ...(generationCreatedAt != null && { generationCreatedAt }),
      status: 'settled',
    },
    generationProtocolVersion,
  );
}

function rejectPreliminaryParentMessageId(res, generationProtocolVersion) {
  return sendGenerationJson(
    res,
    409,
    {
      code: 'PARENT_NOT_READY',
      error:
        'Cannot submit a follow-up while the selected parent response is still being saved. Please wait and try again.',
    },
    generationProtocolVersion,
  );
}

function rejectMissingTriggerParentMessageId(res, generationProtocolVersion) {
  return sendGenerationJson(
    res,
    404,
    {
      code: 'PARENT_NOT_FOUND',
      error: 'The selected parent response is no longer available.',
    },
    generationProtocolVersion,
  );
}

/**
 * Resumable Agent Controller - Generation runs independently of HTTP connection.
 * Returns streamId immediately, client subscribes separately via SSE.
 */
const ResumableAgentController = async (req, res, next, initializeClient, addTitle) => {
  const startupTelemetry = getAgentStartupTelemetry(req);
  let generationProtocolVersion = negotiateNewGenerationProtocol(req);
  const {
    text,
    isRegenerate,
    endpointOption,
    conversationId: reqConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
    scheduleId: bodyScheduleId = null,
    scheduledFor: bodyScheduledFor = null,
    scheduleConfigRevision: bodyScheduleConfigRevision = null,
  } = req.body;

  const isScheduledFire = isScheduleFireRequest(req);
  const scheduleId = isScheduledFire ? bodyScheduleId : null;
  const scheduledFor = isScheduledFire ? bodyScheduledFor : null;
  const scheduleConfigRevision = isScheduledFire ? bodyScheduleConfigRevision : undefined;

  const userId = req.user.id;
  const tenantId = req.user.tenantId;
  const isCompaction = req.body?.compact === true;
  if (isCompaction) {
    const rejection = getCompactionRejection(req, {
      conversationId: reqConversationId,
      parentMessageId,
    });
    if (rejection) {
      startupTelemetry?.end('rejected');
      return sendGenerationJson(
        res,
        rejection.status,
        { code: rejection.code, error: rejection.error },
        generationProtocolVersion,
      );
    }
  }
  const rawClientRequestId = req.body?.clientRequestId;
  if (
    rawClientRequestId != null &&
    (typeof rawClientRequestId !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(rawClientRequestId))
  ) {
    startupTelemetry?.end('rejected');
    return sendGenerationJson(
      res,
      400,
      {
        code: 'INVALID_CLIENT_REQUEST_ID',
        error: 'clientRequestId must be a 1-128 character identifier.',
      },
      generationProtocolVersion,
    );
  }
  const clientRequestId = rawClientRequestId;
  const rawOverrideUserMessageId = req.body?.overrideUserMessageId;
  const rawOverrideConversationId = req.body?.overrideConvoId;
  if (
    (rawOverrideUserMessageId != null && typeof rawOverrideUserMessageId !== 'string') ||
    (rawOverrideConversationId != null && typeof rawOverrideConversationId !== 'string')
  ) {
    startupTelemetry?.end('rejected');
    return sendGenerationJson(
      res,
      400,
      {
        code: 'INVALID_OVERRIDE_ID',
        error: 'overrideUserMessageId and overrideConvoId must be strings.',
      },
      generationProtocolVersion,
    );
  }
  const rawExpectedPredecessorCreatedAt = req.body?.expectedPredecessorCreatedAt;
  if (
    rawExpectedPredecessorCreatedAt != null &&
    (!Number.isSafeInteger(rawExpectedPredecessorCreatedAt) || rawExpectedPredecessorCreatedAt < 0)
  ) {
    startupTelemetry?.end('rejected');
    return sendGenerationJson(
      res,
      400,
      {
        code: 'INVALID_GENERATION_PREDECESSOR',
        error: 'expectedPredecessorCreatedAt must be a non-negative safe integer.',
      },
      generationProtocolVersion,
    );
  }
  const expectedPredecessorCreatedAt = rawExpectedPredecessorCreatedAt;
  const legacyRecoveredSteerId =
    clientRequestId?.startsWith('steer-recovery:') === true
      ? clientRequestId.slice('steer-recovery:'.length)
      : undefined;
  const explicitRecoveredSteerId = req.body?.recoverySteerId;
  const invalidExplicitRecoveryId =
    explicitRecoveredSteerId != null &&
    (typeof explicitRecoveredSteerId !== 'string' ||
      !CLIENT_REQUEST_ID_PATTERN.test(explicitRecoveredSteerId));
  const mismatchedRecoveryIds =
    explicitRecoveredSteerId != null &&
    legacyRecoveredSteerId != null &&
    explicitRecoveredSteerId !== legacyRecoveredSteerId;
  if (invalidExplicitRecoveryId || mismatchedRecoveryIds) {
    startupTelemetry?.end('rejected');
    return sendGenerationJson(
      res,
      400,
      {
        code: 'INVALID_RECOVERY_REQUEST',
        error: 'recoverySteerId must identify exactly one parked steer source.',
      },
      generationProtocolVersion,
    );
  }
  const recoveredSteerId = explicitRecoveredSteerId ?? legacyRecoveredSteerId;
  const isRecoveredSteerRequest = recoveredSteerId != null;
  const recoveryUserMessageId = rawOverrideUserMessageId;
  const recoveredSteerPayload = isRecoveredSteerRequest
    ? buildRecoveredSteerPayload(text, req.body?.files, req.body?.quotes)
    : undefined;
  /** A recovered steer is handed off as a new ordinary user turn. Edit,
   * regenerate, continue, and arbitrary override-id shapes can reuse an
   * existing user row (or deliberately skip its save); consuming the parked
   * source from one of those shapes would therefore erase the only durable
   * copy of the recovered words without proving that a new user row contains
   * them. The source steer id itself is the one permitted user-row override:
   * retries intentionally upsert that stable recovery row while each
   * generation attempt uses a fresh clientRequestId. */
  if (
    isRecoveredSteerRequest &&
    (!clientRequestId ||
      !recoveredSteerId ||
      !recoveredSteerPayload ||
      !!isRegenerate ||
      !!isContinued ||
      editedContent != null ||
      overrideParentMessageId != null ||
      editedResponseMessageId != null ||
      (recoveryUserMessageId != null && recoveryUserMessageId !== recoveredSteerId) ||
      !!req.body?.overrideConvoId)
  ) {
    startupTelemetry?.end('rejected');
    return sendGenerationJson(
      res,
      400,
      {
        code: 'INVALID_RECOVERY_REQUEST',
        error: 'A recovered steer must be submitted as a new user turn.',
      },
      generationProtocolVersion,
    );
  }
  if (isRecoveredSteerRequest && recoveryUserMessageId === recoveredSteerId) {
    /** BaseClient treats a bare override id as an already-persisted row and
     * skips its save. Recovery instead needs an idempotent upsert: preserve
     * the source-derived row id while explicitly selecting save index zero. */
    req.body.overrideUserMessageId = `${recoveredSteerId}${Constants.COMMON_DIVIDER}0`;
  }
  const isNewConvo = !reqConversationId || reqConversationId === 'new';
  const scheduledNewConversationId =
    isScheduledFire && typeof req.body?.newConversationId === 'string'
      ? req.body.newConversationId
      : null;
  let conversationId = reqConversationId;
  if (isNewConvo) {
    conversationId =
      scheduledNewConversationId ??
      (typeof clientRequestId === 'string' && clientRequestId.length > 0
        ? uuidv5(`${userId}:${clientRequestId}`, NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE)
        : crypto.randomUUID());
  }
  const conversationAnchorPromise = resolveConversationCreatedAt({
    userId,
    conversationId,
    isNewConvo,
    conversation: Object.prototype.hasOwnProperty.call(req, 'resolvedConversation')
      ? req.resolvedConversation
      : undefined,
  });

  /** A newly bound actor conversation has no child messages yet, so its first
   * event legitimately uses the root parent id. The authenticated write guard
   * supplies the binding identity before this controller; that durable binding,
   * not the presence of an earlier child message, proves this is a continuation. */
  const boundEventBindingId =
    req._agentEventBindingId ?? req.resolvedConversation?.agentEventBinding?.bindingId;
  const isBoundEventContinuation =
    req._isAgentTrigger === true &&
    !isNewConvo &&
    req._agentEventBindingParentConversationId != null &&
    typeof boundEventBindingId === 'string' &&
    boundEventBindingId.length > 0;
  const isTriggerContinuation =
    req._isAgentTrigger === true &&
    !isNewConvo &&
    (parentMessageId !== Constants.NO_PARENT || isBoundEventContinuation);
  const queuedTurnAdmissionSource = isTriggerContinuation
    ? req.body?.agentContinuationAdmission
    : undefined;
  const hasQueuedTurnAdmissionSource = queuedTurnAdmissionSource != null;
  const verifyQueuedTurnAdmission = async (generationId, generationCreatedAt) => {
    if (!hasQueuedTurnAdmissionSource) {
      return true;
    }
    if (
      typeof clientRequestId !== 'string' ||
      !Number.isSafeInteger(generationCreatedAt) ||
      generationCreatedAt < 0
    ) {
      return false;
    }
    try {
      const {
        verifyAgentQueuedTurnExecutionAdmission,
      } = require('~/server/services/Agents/triggers');
      const confirmed = await verifyAgentQueuedTurnExecutionAdmission(queuedTurnAdmissionSource, {
        userId,
        ...(tenantId != null && { tenantId }),
        conversationId,
        clientRequestId,
        generationId,
        generationCreatedAt,
      });
      return confirmed === true;
    } catch (error) {
      logger.warn(
        '[ResumableAgentController] Deduplicated queued-turn admission is not confirmed',
        error,
      );
      return false;
    }
  };
  const rejectUnconfirmedQueuedTurnAdmission = () => {
    res.set('Retry-After', '1');
    startupTelemetry?.end('deduplicated');
    return sendGenerationJson(
      res,
      503,
      {
        code: 'SERVER_NOT_READY',
        error: 'Queued turn execution is still being confirmed. Please retry shortly.',
      },
      generationProtocolVersion,
    );
  };

  if (
    await isUnpersistedPreliminaryParent({
      userId,
      conversationId: reqConversationId,
      parentMessageId,
      getMessages,
    })
  ) {
    if (isTriggerContinuation) {
      let parentJob;
      try {
        parentJob = await GenerationJobManager.getJob(conversationId);
      } catch (error) {
        logger.warn('[ResumableAgentController] Trigger parent lookup failed', error);
        res.set('Retry-After', '1');
        startupTelemetry?.end('rejected');
        return sendGenerationJson(
          res,
          503,
          { code: 'PARENT_STATE_UNAVAILABLE', error: 'Parent generation state is unavailable.' },
          generationProtocolVersion,
        );
      }
      if (
        parentJob != null &&
        liveJobBelongsToRequester(parentJob, req.user) &&
        (parentJob.status === 'running' ||
          parentJob.status === 'requires_action' ||
          parentJob.metadata?.terminalPersistencePending === true) &&
        !(
          typeof clientRequestId === 'string' &&
          parentJob.metadata?.idempotencyClientRequestId === clientRequestId
        )
      ) {
        startupTelemetry?.end('rejected');
        return rejectPreliminaryParentMessageId(res, generationProtocolVersion);
      }
      startupTelemetry?.end('rejected');
      return rejectMissingTriggerParentMessageId(res, generationProtocolVersion);
    }
    startupTelemetry?.end('rejected');
    return rejectPreliminaryParentMessageId(res, generationProtocolVersion);
  }

  /** When to generate the conversation title. `immediate` (default) fires title
   *  generation in parallel with the response, from the user's first message;
   *  `final` defers it until the full response completes (legacy behavior).
   *  Resolved from the agent's actual endpoint once the client is initialized. */
  let titleTiming = 'immediate';

  // Generate conversationId upfront if not provided - streamId === conversationId always
  // Treat "new" as a placeholder that needs a real UUID (frontend may send "new" for new convos)
  const streamId = conversationId;
  req.body.conversationId = conversationId;

  /** A durable continuation trigger appends below a completed parent response. If
   * that response belongs to a still-running or paused generation, admitting
   * another generation on the same conversation stream would replace it.
   * Defer without claiming the continuation idempotency key so the delivery engine
   * can retry after the parent reaches a terminal state. */
  if (isTriggerContinuation) {
    let parentJob;
    try {
      parentJob = await GenerationJobManager.getJob(streamId);
    } catch (error) {
      logger.warn('[ResumableAgentController] Trigger continuation parent lookup failed', error);
      res.set('Retry-After', '1');
      startupTelemetry?.end('rejected');
      return sendGenerationJson(
        res,
        503,
        {
          code: 'PARENT_STATE_UNAVAILABLE',
          error: 'Parent generation state is temporarily unavailable.',
        },
        generationProtocolVersion,
      );
    }
    if (
      parentJob != null &&
      liveJobBelongsToRequester(parentJob, req.user) &&
      (parentJob.status === 'running' ||
        parentJob.status === 'requires_action' ||
        parentJob.metadata?.terminalPersistencePending === true) &&
      !(
        typeof clientRequestId === 'string' &&
        parentJob.metadata?.idempotencyClientRequestId === clientRequestId
      )
    ) {
      res.set('Retry-After', '1');
      startupTelemetry?.end('rejected');
      return sendGenerationJson(
        res,
        409,
        { code: 'PARENT_NOT_READY', error: 'The parent generation has not settled yet.' },
        generationProtocolVersion,
      );
    }
  }

  // Idempotency: a lost/reset start-generation response makes the client re-POST the
  // identical payload, which would otherwise start a second fully-billed generation.
  // Claim the submission's clientRequestId before creating the job so a retry attaches
  // to the original stream instead of spawning a duplicate. Runs before the concurrency
  // check so a deduped retry is never counted against the limiter. Once a
  // stable id is present, an ambiguous store outcome must fail closed.
  let ownedIdempotencyClaim = null;
  if (clientRequestId) {
    let claim = null;
    try {
      claim = await GenerationJobManager.claimGeneration(
        userId,
        clientRequestId,
        streamId,
        conversationId,
        generationProtocolVersion,
      );
    } catch (err) {
      logger.error(
        '[ResumableAgentController] Idempotency claim outcome is unknown; asking the client to retry',
        err,
      );
      res.set('Retry-After', '1');
      startupTelemetry?.end('deduplicated');
      return sendGenerationJson(
        res,
        503,
        {
          code: 'SERVER_NOT_READY',
          error: 'Generation ownership could not be confirmed. Please retry shortly.',
        },
        generationProtocolVersion,
      );
    }

    if (claim?.existing != null) {
      generationProtocolVersion = Math.min(
        generationProtocolVersion,
        claim.existing.generationProtocolVersion === GENERATION_PROTOCOL_V2
          ? GENERATION_PROTOCOL_V2
          : 1,
      );
    }

    const isLegacyTokenlessClaim =
      claim?.source === 'legacy' && claim?.existing != null && claim.existing.claimToken == null;
    const validClaim = isLegacyTokenlessClaim
      ? isValidLegacyGenerationClaim(claim.existing, streamId, isNewConvo)
      : isValidGenerationClaim(claim?.existing, streamId, conversationId);
    if (claim?.existing != null && !validClaim) {
      logger.error('[ResumableAgentController] Invalid or miscorrelated idempotency claim');
      res.set('Retry-After', '1');
      startupTelemetry?.end('deduplicated');
      return sendGenerationJson(
        res,
        503,
        {
          code: 'SERVER_NOT_READY',
          error: 'Generation ownership could not be confirmed. Please retry shortly.',
        },
        generationProtocolVersion,
      );
    }

    if (claim?.claimed && claim.existing?.claimToken) {
      ownedIdempotencyClaim = claim.existing;
      try {
        const existingLiveGeneration = await GenerationJobManager.resumeClaimedGeneration(
          userId,
          clientRequestId,
          streamId,
          ownedIdempotencyClaim,
        );
        if (
          existingLiveGeneration &&
          isValidGenerationClaim(existingLiveGeneration, streamId, conversationId, true)
        ) {
          // A fresh lease may have been negotiated under a different rollout
          // cap than the still-live job it was atomically rebound to. The
          // job's immutable protocol wins; echoing the fresh request's marker
          // would make the client use v2-only recovery against a v1 run (or
          // unnecessarily downgrade a v2 run).
          generationProtocolVersion = Math.min(
            generationProtocolVersion,
            existingLiveGeneration.generationProtocolVersion === GENERATION_PROTOCOL_V2
              ? GENERATION_PROTOCOL_V2
              : 1,
          );
          if (
            !(await verifyQueuedTurnAdmission(
              existingLiveGeneration.streamId,
              existingLiveGeneration.startedAt,
            ))
          ) {
            return rejectUnconfirmedQueuedTurnAdmission();
          }
          startupTelemetry?.end('deduplicated');
          return sendGenerationJson(
            res,
            200,
            {
              streamId: existingLiveGeneration.streamId,
              conversationId: existingLiveGeneration.conversationId,
              generationCreatedAt: existingLiveGeneration.startedAt,
              status: 'resumed',
            },
            generationProtocolVersion,
          );
        } else if (existingLiveGeneration) {
          throw new Error('Live generation idempotency adoption returned invalid ownership');
        }
      } catch (err) {
        logger.error('[ResumableAgentController] Live generation idempotency adoption failed', err);
        res.set('Retry-After', '1');
        startupTelemetry?.end('deduplicated');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'SERVER_NOT_READY',
            error: 'Generation ownership changed. Please retry shortly.',
          },
          generationProtocolVersion,
        );
      }
    } else if (claim?.existing) {
      // A duplicate is confirmed. Attach to the original stream — and never fall through to
      // a second generation, even if the job lookup hiccups.
      const existingStreamId = claim.existing.streamId;
      let liveJob;
      try {
        // Wait briefly for the winner to write the job record (it does so a few ms after
        // claiming) so a still-live stream isn't handed back before its job exists.
        liveJob = await waitForJobRecord(existingStreamId);
      } catch (err) {
        // Store hiccup while checking the job: ask the client to retry rather than starting
        // a second generation for a request we know is a duplicate.
        logger.error(
          '[ResumableAgentController] Job lookup failed for an existing claim; asking the client to retry',
          err,
        );
        res.set('Retry-After', '1');
        startupTelemetry?.end('deduplicated');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'SERVER_NOT_READY',
            error: 'Generation is still starting. Please retry shortly.',
          },
          generationProtocolVersion,
        );
      }
      const claimAgeMs = Date.now() - (claim.existing.claimedAt ?? 0);
      if (!liveJob && claim.existing.startedAt != null) {
        // createJob marked this claim in the same transaction that installed
        // the job. A now-missing record therefore represents an already-owned
        // generation (usually fast completion + cleanup), never an abandoned
        // pre-create lease that may be taken over and billed again. There is no
        // attachable stream; the settled response refetches persisted history.
        if (!(await verifyQueuedTurnAdmission(existingStreamId, claim.existing.startedAt))) {
          return rejectUnconfirmedQueuedTurnAdmission();
        }
        return sendSettledGeneration(
          res,
          existingStreamId,
          claim.existing.conversationId,
          startupTelemetry,
          generationProtocolVersion,
          claim.existing.startedAt,
        );
      }
      if (!liveJob && isLegacyTokenlessClaim && claimAgeMs >= IDEMPOTENCY_STARTUP_GRACE_MS) {
        /** A legacy owner cannot be fenced (its value has no token), so it is
         * never safe to take over. Return its original stream on the legacy
         * attach/refetch path: this covers fast completion without starting a
         * second billed generation, while an abandoned pre-create claim ages
         * out under the old server's bounded TTL. */
        if (!(await verifyQueuedTurnAdmission(existingStreamId, claim.existing.startedAt))) {
          return rejectUnconfirmedQueuedTurnAdmission();
        }
        return sendSettledGeneration(
          res,
          existingStreamId,
          claim.existing.conversationId,
          startupTelemetry,
          generationProtocolVersion,
        );
      }
      if (!liveJob && claimAgeMs < IDEMPOTENCY_STARTUP_GRACE_MS) {
        // The winner claimed but has not written the job yet (still between claim and
        // createJob). Handing back the stream now would 404 and tear down the client while
        // the winner goes on to generate and bill with no UI attached — ask the client to
        // retry via the readiness path instead.
        res.set('Retry-After', '1');
        startupTelemetry?.end('deduplicated');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'SERVER_NOT_READY',
            error: 'Generation is still starting. Please retry shortly.',
          },
          generationProtocolVersion,
        );
      }
      if (liveJob) {
        generationProtocolVersion = negotiateExistingGenerationProtocol(req, liveJob);
        if (!liveJobBelongsToRequester(liveJob, req.user)) {
          logger.error(
            '[ResumableAgentController] Existing idempotency claim resolved to a foreign generation',
          );
          res.set('Retry-After', '1');
          startupTelemetry?.end('deduplicated');
          return sendGenerationJson(
            res,
            503,
            {
              code: 'SERVER_NOT_READY',
              error: 'Generation ownership could not be confirmed. Please retry shortly.',
            },
            generationProtocolVersion,
          );
        }
        const liveClientRequestId = liveJob.metadata?.idempotencyClientRequestId;
        const startedAt = claim.existing.startedAt;
        if (liveJob.metadata?.terminalPersistencePending === true) {
          /** The terminal owner has claimed the outcome but has not yet
           * finished the required persistence hook. Do not let a duplicate
           * start refetch history until that single-winner publication is
           * finalized (or stale-pending recovery publishes failure). */
          res.set('Retry-After', '1');
          startupTelemetry?.end('deduplicated');
          return sendGenerationJson(
            res,
            503,
            {
              code: 'SERVER_NOT_READY',
              error: 'Generation is finalizing. Please retry shortly.',
            },
            generationProtocolVersion,
          );
        }
        const terminalWithoutPayload =
          ['complete', 'error', 'aborted'].includes(liveJob.status) &&
          !liveJob.finalEvent &&
          !liveJob.error;
        if (terminalWithoutPayload) {
          /** A terminal CAS can precede its required DB save and durable FINAL
           * by a narrow window. Returning an attachable/settled success here
           * lets the retry refetch before persistence is complete. Keep the
           * duplicate on the readiness path until the owner publishes its
           * terminal payload (or cleanup makes the job disappear). */
          res.set('Retry-After', '1');
          startupTelemetry?.end('deduplicated');
          return sendGenerationJson(
            res,
            503,
            {
              code: 'SERVER_NOT_READY',
              error: 'Generation is finalizing. Please retry shortly.',
            },
            generationProtocolVersion,
          );
        }
        const replacedGeneration =
          (startedAt != null && liveJob.createdAt !== startedAt) ||
          (liveClientRequestId != null && liveClientRequestId !== clientRequestId);
        if (replacedGeneration) {
          if (!(await verifyQueuedTurnAdmission(existingStreamId, startedAt))) {
            return rejectUnconfirmedQueuedTurnAdmission();
          }
          // streamId === conversationId, so a later turn reuses the same route.
          // Never pair this stale POST's optimistic submission with that newer
          // job's SSE snapshot. If the replacement is still active, distinguish
          // it from an ordinary settled retry so the client hands off to the
          // authoritative B submission instead of going idle and starting C.
          if (liveJob.status === 'running' || liveJob.status === 'requires_action') {
            startupTelemetry?.end('deduplicated');
            if (generationProtocolVersion < GENERATION_PROTOCOL_V2) {
              return sendGenerationJson(
                res,
                409,
                { code: 'RUN_REPLACED' },
                generationProtocolVersion,
              );
            }
            return sendGenerationJson(
              res,
              200,
              {
                streamId: existingStreamId,
                conversationId: claim.existing.conversationId,
                generationCreatedAt: liveJob.createdAt,
                status: 'replaced',
              },
              generationProtocolVersion,
            );
          }
          return sendSettledGeneration(
            res,
            existingStreamId,
            claim.existing.conversationId,
            startupTelemetry,
            generationProtocolVersion,
            claim.existing.startedAt,
          );
        }
        if (liveClientRequestId == null && !isLegacyTokenlessClaim) {
          // A syntactically valid claim plus an uncorrelated live job is
          // outcome-ambiguous (legacy/corrupt/partially written state). Attaching
          // risks cross-wiring two submissions; starting risks double billing.
          res.set('Retry-After', '1');
          startupTelemetry?.end('deduplicated');
          return sendGenerationJson(
            res,
            503,
            {
              code: 'SERVER_NOT_READY',
              error: 'Generation ownership could not be confirmed. Please retry shortly.',
            },
            generationProtocolVersion,
          );
        }
        logger.debug('[ResumableAgentController] Deduped retried start-generation request', {
          userId,
          clientRequestId,
          streamId: existingStreamId,
        });
        if (!(await verifyQueuedTurnAdmission(existingStreamId, liveJob.createdAt))) {
          return rejectUnconfirmedQueuedTurnAdmission();
        }
        startupTelemetry?.end('deduplicated');
        return sendGenerationJson(
          res,
          200,
          {
            streamId: existingStreamId,
            conversationId: claim.existing.conversationId,
            generationCreatedAt: liveJob.createdAt,
            status: 'resumed',
          },
          generationProtocolVersion,
        );
      }

      // The creator held the claim beyond the startup grace but never made a
      // job. Atomically take over its lease; createJob verifies this token in
      // the same Redis transaction as job creation, so the abandoned winner
      // can no longer wake up and start a second generation.
      const takeover = await GenerationJobManager.takeoverGeneration(
        userId,
        clientRequestId,
        existingStreamId,
        claim.existing,
      ).catch((err) => {
        logger.error('[ResumableAgentController] Stale idempotency takeover failed', err);
        return null;
      });
      if (
        !takeover?.claimed ||
        !isValidGenerationClaim(takeover.existing, streamId, conversationId)
      ) {
        res.set('Retry-After', '1');
        startupTelemetry?.end('deduplicated');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'SERVER_NOT_READY',
            error: 'Generation ownership changed. Please retry shortly.',
          },
          generationProtocolVersion,
        );
      }
      ownedIdempotencyClaim = takeover.existing;
    } else {
      // A malformed/unreadable existing claim is outcome-ambiguous. Starting
      // anyway would turn a store parsing failure into duplicate generation.
      res.set('Retry-After', '1');
      startupTelemetry?.end('deduplicated');
      return sendGenerationJson(
        res,
        503,
        {
          code: 'SERVER_NOT_READY',
          error: 'Generation ownership could not be confirmed. Please retry shortly.',
        },
        generationProtocolVersion,
      );
    }
  }

  const scheduleConcurrencyExempt = exemptFromConcurrencyLimiter(req);
  req._scheduleConcurrencyExempt = scheduleConcurrencyExempt;
  if (!scheduleConcurrencyExempt) {
    const { allowed, pendingRequests, limit } = await checkAndIncrementPendingRequest(userId);
    if (!allowed) {
      if (ownedIdempotencyClaim) {
        await GenerationJobManager.releaseGeneration(
          userId,
          clientRequestId,
          streamId,
          ownedIdempotencyClaim,
        ).catch(() => {});
      }
      const violationInfo = getViolationInfo(pendingRequests, limit);
      await logViolation(req, res, ViolationTypes.CONCURRENT, violationInfo, violationInfo.score);
      startupTelemetry?.end('rejected');
      return sendGenerationJson(res, 429, violationInfo, generationProtocolVersion);
    }
  }
  startupTelemetry?.mark('request_admitted');

  /** Allocate the turn identities before Agent initialization. Request-scoped
   * MCP transports resolve BODY placeholders while tools are discovered, so
   * discovery and graph execution must receive the same response-scoped body.
   * BaseClient otherwise allocates these IDs later in `sendMessage`, after MCP
   * connections already exist. */
  const overrideUserMessageId = rawOverrideUserMessageId
    ? rawOverrideUserMessageId.split(Constants.COMMON_DIVIDER)[0]
    : undefined;
  /** Event deliveries already carry a stable, retry-safe idempotency key. Reuse
   * it as the public child-task identity so the lease, persisted turn, and
   * parent activity index continue to agree after the live lease is released. */
  const eventTaskId =
    req._agentEventBindingParentConversationId != null
      ? (clientRequestId ?? crypto.randomUUID())
      : undefined;
  if (eventTaskId != null) {
    req._agentEventTaskId = eventTaskId;
  }
  const preallocatedUserMessageId = resolvePreallocatedUserMessageId({
    isCompaction,
    parentMessageId,
    eventTaskId,
    overrideUserMessageId,
    overrideParentMessageId,
  });
  const overrideConversationId = rawOverrideConversationId
    ? rawOverrideConversationId.split(Constants.COMMON_DIVIDER)[0]
    : undefined;
  const effectiveConversationId = overrideConversationId ?? conversationId;
  let preallocatedResponseMessageId =
    eventTaskId == null
      ? (editedResponseMessageId ?? crypto.randomUUID())
      : `${eventTaskId}:assistant`;
  if (
    (editedContent != null && !isContinued) ||
    (isRegenerate && preallocatedResponseMessageId.endsWith('_'))
  ) {
    preallocatedResponseMessageId = crypto.randomUUID();
  }
  const mcpRequestBody = createMCPRuntimeRequestBody({
    messageId: preallocatedResponseMessageId,
    conversationId: effectiveConversationId,
    codeEnvironmentMode: req.body.codeEnvironmentMode,
    codeWorkspaces: resolveRunCodeWorkspaces({
      conversationId: effectiveConversationId,
      requestedSelections: req.body.codeWorkspaces,
      conversation: req.resolvedConversation,
    }),
    parentMessageId:
      editedContent != null ? preallocatedResponseMessageId : preallocatedUserMessageId,
  });

  let client = null;
  let verifiedInitialAgentId = null;
  let jobCreatedAt;
  let providerExecutionId;
  let releaseEventChildLease;
  let scheduleTerminalOutcomeRecorded = false;
  const settleScheduledRun = async ({ status, error, clearConversationId = false }) => {
    if (!scheduleId) {
      return true;
    }
    if (status !== 'requires_action' && scheduleTerminalOutcomeRecorded) {
      return true;
    }
    const recorded = await recordScheduleOutcome({
      scheduleId,
      scheduledFor,
      streamId,
      jobCreatedAt,
      status,
      conversationId,
      ...(status === 'requires_action' && client?.checkpointNamespace != null
        ? { checkpointNamespace: client.checkpointNamespace }
        : {}),
      clearConversationId,
      error,
    });
    if (recorded && status !== 'requires_action') {
      scheduleTerminalOutcomeRecorded = true;
    }
    return recorded;
  };
  /** The loopback trigger host binds this lifecycle identity to the same
   * idempotency key that owns generation admission. Ignore mismatched or
   * direct-chat metadata rather than letting callers relabel another run. */
  const rawAgentEventDelivery = req.body?.agentEventDelivery;
  const internalDetachedCompletion = parseAgentEventActorDetachedCompletion(
    rawAgentEventDelivery?.internalCompletion,
  );
  const isInternalDetachedCompletion =
    internalDetachedCompletion != null &&
    rawAgentEventDelivery?.deliveryKey === clientRequestId &&
    rawAgentEventDelivery?.event?.type === EVENT_ACTOR_DETACHED_COMPLETION_TYPE &&
    rawAgentEventDelivery?.event?.source?.type === 'internal' &&
    rawAgentEventDelivery?.event?.source?.id === EVENT_ACTOR_DETACHED_COMPLETION_SOURCE;
  const agentEventDelivery =
    isTriggerContinuation &&
    isBoundEventContinuation &&
    rawAgentEventDelivery != null &&
    typeof rawAgentEventDelivery === 'object' &&
    (rawAgentEventDelivery.deliveryKey === clientRequestId || isInternalDetachedCompletion)
      ? rawAgentEventDelivery
      : undefined;
  req._agentEventTriggerProjection = getAgentEventTriggerProjection(agentEventDelivery);

  try {
    logger.debug(`[ResumableAgentController] Creating job`, {
      streamId,
      conversationId,
      reqConversationId,
      userId,
    });

    const endpointIconURL = getEndpointIconURL(req, endpointOption);
    const responseModel = getAgentResponseModel(req, endpointOption);
    const preliminaryUserMessage = isCompaction
      ? projectCompactionAnchor({ messageId: parentMessageId, conversationId })
      : getPreliminaryUserMessage(
          { ...req.body, messageId: preallocatedUserMessageId },
          conversationId,
          req._agentEventTriggerProjection,
        );
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId, {
      startupTelemetry,
      ...(recoveredSteerId && { recoveredSteerId }),
      ...(recoveredSteerPayload && { recoveredSteerPayload }),
      ...(expectedPredecessorCreatedAt != null && { expectedPredecessorCreatedAt }),
      ...(isTriggerContinuation && { rejectActivePredecessor: true }),
      ...(ownedIdempotencyClaim?.claimToken && {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: ownedIdempotencyClaim.claimToken,
      }),
      initialMetadata: {
        conversationId,
        generationProtocolVersion,
        endpoint: endpointOption.endpoint,
        iconURL: endpointIconURL,
        model: responseModel,
        // Recorded HERE because this process owns the generation: the steer
        // route may land on a different replica whose own SDK probe would
        // answer for the wrong process during a rolling deploy.
        preemptCapable: isSteerPreemptSupported(),
        // Same owner-recorded pattern: this build's drain merges queued steer
        // quotes into the injected turn. Admission on another replica must
        // not store/acknowledge quotes an older owner would drop.
        steerQuotesCapable: true,
        // Persist the originating agent so a HITL resume can refuse to rebuild this
        // paused run on a different agent (see resume.js).
        agent_id: endpointOption.agent_id ?? req.body?.agent_id,
        // Persist temporary-chat state so a HITL resume keeps the resumed response
        // non-persisted instead of trusting the resume request to re-send the flag.
        isTemporary:
          req._agentEventBindingRetention?.isTemporary ??
          req.resolvedConversation?.isTemporary ??
          req.body?.isTemporary,
        ...((req._agentEventBindingRetention?.expiredAt ?? req.resolvedConversation?.expiredAt) !=
          null && {
          retentionExpiresAt: new Date(
            req._agentEventBindingRetention?.expiredAt ?? req.resolvedConversation.expiredAt,
          ).toISOString(),
        }),
        ...((req._agentEventBindingRetention?.expiredAt ?? req.resolvedConversation?.expiredAt) ==
          null &&
          req.config?.interfaceConfig?.retentionMode === 'all' && {
            retentionExpiresAt: createChatExpirationDate(
              req.config.interfaceConfig,
              req.resolvedConversation?.isTemporary ?? req.body?.isTemporary,
            ).toISOString(),
          }),
        ...(agentEventDelivery != null && {
          agentEventDeliveryKey: agentEventDelivery.deliveryKey,
          ...(internalDetachedCompletion == null
            ? {}
            : {
                agentEventInvocationKey: internalDetachedCompletion.invocationId,
                agentEventInvocationGenerationCreatedAt:
                  internalDetachedCompletion.generationCreatedAt,
              }),
          agentEventBindingId: boundEventBindingId,
          ...(agentEventDelivery.expectedAction != null && {
            agentEventExpectedAction: agentEventDelivery.expectedAction,
            ...(GenerationJobManager.isRedis && {
              agentEventDetachedActionProducerRequired: true,
            }),
          }),
        }),
        /** A compaction is regenerate-shaped for every consumer of the job:
         *  no user message of its own, the response parented onto an
         *  existing message. A reconnecting client rebuilds it that way. */
        ...((isRegenerate || isCompaction) && { isRegenerate: true }),
        ...(scheduleId
          ? {
              scheduleId,
              scheduledFor,
              preserveForScheduleReconcile: true,
              ...(Number.isSafeInteger(scheduleConfigRevision) && {
                scheduleConfigRevision,
              }),
              ...(req._isManualScheduledFire === true && { scheduleManual: true }),
            }
          : {}),
        responseMessageId: preallocatedResponseMessageId,
        mcpRequestBody,
        userMessage: preliminaryUserMessage,
      },
    });
    startupTelemetry?.mark('job_created');
    generationProtocolVersion = negotiateExistingGenerationProtocol(req, job);
    jobCreatedAt = job.createdAt; // Capture creation time to detect job replacement
    req.turnStartedAt = jobCreatedAt;
    providerExecutionId = job.metadata?.providerExecutionId;

    /** Authentication can precede a slow admission path. Recheck the durable
     * account-deletion fence after the job is committed but before execution
     * starts. This ordering closes both sides of the race for ordinary and
     * trigger-scoped sessions: a fence that wins first rejects this run; a
     * fence that starts after this read must observe the already-created job
     * in account deletion's active-generation drain. */
    if (!(await isAgentTriggerPrincipalActive(userId))) {
      throw Object.assign(new Error('Account deletion is in progress'), {
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
        status: 409,
      });
    }
    if (req._agentEventBindingParentConversationId != null) {
      /** The generation job is the durable marker that a deletion on another replica
       * can abort. Recheck only after that marker exists: either the deletion fence
       * wins and this run stops here, or the deletion observes and drains this job. */
      releaseEventChildLease = await acquireEventChildGenerationLease({
        userId,
        tenantId: req._agentEventBindingTenantId,
        conversationId,
        streamId,
        taskId: eventTaskId,
        jobCreatedAt,
        retentionExpiresAt: req._agentEventBindingRetention?.expiredAt,
      });
      if (releaseEventChildLease == null) {
        const bindingActive = isAgentEventRetentionActive(
          req._agentEventBindingRetention?.expiredAt,
        );
        throw Object.assign(
          new Error(
            bindingActive
              ? 'The event actor is already handling another turn'
              : 'The event binding parent is no longer available',
          ),
          {
            code: bindingActive ? 'EVENT_ACTOR_NOT_READY' : 'EVENT_BINDING_PARENT_ENDED',
            status: 409,
          },
        );
      }
      const [eventParent, ownerAdmissible] = await Promise.all([
        getConvo(userId, req._agentEventBindingParentConversationId),
        isSubagentOwnerAdmissible(userId),
      ]);
      if (!ownerAdmissible) {
        throw Object.assign(new Error('The event actor is temporarily unavailable'), {
          code: 'EVENT_ACTOR_NOT_READY',
          status: 409,
        });
      }
      if (
        eventParent == null ||
        eventParent.subagentThread != null ||
        eventParent.agent_id !== req._agentEventBindingParentAgentId ||
        (eventParent.tenantId ?? undefined) !== req._agentEventBindingTenantId ||
        !isAgentEventRetentionActive(req._agentEventBindingRetention?.expiredAt) ||
        !isAgentEventRetentionActive(eventParent.expiredAt)
      ) {
        throw Object.assign(new Error('The event binding parent is no longer available'), {
          code: 'EVENT_BINDING_PARENT_ENDED',
          status: 409,
        });
      }
    }
    if (
      scheduleId &&
      !(await isScheduleLive(scheduleId, scheduleConfigRevision, {
        automatic: req._isManualScheduledFire !== true,
        policy: true,
        // The occurrence's OWN recorded scope, exactly as the resume path passes it.
        // The run row is reserved before this loopback request is dispatched, so a pin
        // introduced while the request sat queued must not be validated in place of the
        // destination this occurrence's envelope was already built with.
        scheduledFor,
      }))
    ) {
      throw Object.assign(new Error('This scheduled occurrence is no longer active'), {
        code: 'SCHEDULE_NO_LONGER_ACTIVE',
        status: 409,
      });
    }
    if (
      providerExecutionId &&
      !(await GenerationJobManager.beginProviderExecution(
        streamId,
        jobCreatedAt,
        providerExecutionId,
      ))
    ) {
      throw Object.assign(new Error('Generation stopped before provider startup'), {
        code: 'RUN_REPLACED',
        status: 409,
      });
    }
    acceptAgentStartupTelemetry(req, streamId);
    startupTelemetry?.mark('metadata_persisted');
    req._resumableStreamId = streamId;
    getMCPRequestContext(req, undefined, { cleanupOnResponse: false });
    let recoveredSteerCommitted = false;
    const commitRecoveredSteer = async () => {
      if (!recoveredSteerId || recoveredSteerCommitted) {
        return;
      }
      if (client?.skipSaveUserMessage) {
        throw new Error('Recovered steer cannot skip user message persistence');
      }
      const committed = await GenerationJobManager.steering.consumeRecovered(
        streamId,
        recoveredSteerId,
        { userId, tenantId: req.user?.tenantId },
        jobCreatedAt,
      );
      if (!committed) {
        throw new Error('Recovered steer could not be committed after message persistence');
      }
      recoveredSteerCommitted = true;
    };

    // Ordinary clients receive the stream id immediately so they can attach
    // before tool loading emits events. Source-owned loopback work delays only
    // until its provider invocation and Mongo receipt exist.
    let generationStartResponseSent = false;
    const sendGenerationStarted = () => {
      if (generationStartResponseSent || res.headersSent) {
        return;
      }
      generationStartResponseSent = true;
      sendGenerationJson(
        res,
        200,
        { streamId, conversationId, generationCreatedAt: jobCreatedAt, status: 'started' },
        generationProtocolVersion,
      );
    };
    /** Ordinary clients need the stream id before tool discovery. A queued
     * source instead keeps its local loopback response open until the provider
     * invocation exists, so an accepted HTTP result can never retire text that
     * died between job creation and provider startup. */
    if (!hasQueuedTurnAdmissionSource) {
      sendGenerationStarted();
    }

    await attachConversationCreatedAt(req, conversationId, conversationAnchorPromise).then(() =>
      startupTelemetry?.mark('conversation_resolved'),
    );

    // Note: We no longer use res.on('close') to abort since we send JSON immediately.
    // The response closes normally after res.json(), which is not an abort condition.
    // Abort handling is done through GenerationJobManager via the SSE stream connection.

    // Track if partial response was already saved to avoid duplicates
    let partialResponseSaved = false;

    /**
     * Listen for all subscribers leaving to save partial response.
     * This ensures the response is saved to DB even if all clients disconnect
     * while generation continues.
     *
     * Note: The messageId used here falls back to `${userMessage.messageId}_` if the
     * actual response messageId isn't available yet. The final response save will
     * overwrite this with the complete response using the same messageId pattern.
     */
    job.emitter.on('allSubscribersLeft', async (aggregatedContent) => {
      if (partialResponseSaved || !aggregatedContent || aggregatedContent.length === 0) {
        return;
      }

      const persistableContent = filterPersistableAbortContent(aggregatedContent);
      if (persistableContent.length === 0) {
        logger.debug('[ResumableAgentController] No persistable content to save partial response');
        return;
      }

      const [resumeState, jobRecord] = await Promise.all([
        GenerationJobManager.getResumeState(streamId, jobCreatedAt),
        GenerationJobManager.getJobStore().getJob(streamId),
      ]);
      if (!resumeState?.userMessage) {
        logger.debug('[ResumableAgentController] No user message to save partial response for');
        return;
      }

      partialResponseSaved = true;
      const responseConversationId = resumeState.conversationId || conversationId;
      /** The run publishes its calibration and fading tiers onto the job; a
       * partial response saved on disconnect must carry them like the Stop and
       * pause paths do, or a turn continued from it re-derives its provider
       * projection of history and loses the cached prefix. The same-epoch job
       * record is the source, since the client-facing resume snapshot never
       * carries server-private state. */
      const contextMeta = jobRecord?.createdAt === jobCreatedAt ? jobRecord.contextMeta : undefined;

      try {
        const partialMessage = {
          messageId: resumeState.responseMessageId || `${resumeState.userMessage.messageId}_`,
          conversationId: responseConversationId,
          parentMessageId: resumeState.userMessage.messageId,
          sender: client?.sender ?? 'AI',
          content: persistableContent,
          unfinished: true,
          error: false,
          isCreatedByUser: false,
          user: userId,
          endpoint: endpointOption.endpoint,
          iconURL: resumeState.iconURL || endpointIconURL,
          model: resumeState.model || responseModel,
          ...(contextMeta != null && { contextMeta }),
        };

        if (req.body?.agent_id) {
          partialMessage.agent_id = req.body.agent_id;
        }

        const savePartialMessage = () =>
          saveMessage(
            {
              userId,
              isTemporary:
                req?._agentEventBindingRetention?.isTemporary ??
                req?.resolvedConversation?.isTemporary ??
                req?.body?.isTemporary,
              expiredAt:
                req?._agentEventBindingRetention?.expiredAt ?? req?.resolvedConversation?.expiredAt,
              interfaceConfig: req?.config?.interfaceConfig,
            },
            partialMessage,
            {
              context: 'api/server/controllers/agents/request.js - partial response on disconnect',
            },
          );

        const savedPartialMessage = tenantId
          ? await tenantStorage.run({ tenantId, userId }, savePartialMessage)
          : await savePartialMessage();
        if (!savedPartialMessage) {
          throw new Error('Partial response could not be persisted after disconnect');
        }

        logger.debug(
          `[ResumableAgentController] Saved partial response for ${streamId}, content parts: ${persistableContent.length}`,
        );
      } catch (error) {
        logger.error('[ResumableAgentController] Error saving partial response:', error);
        // Reset flag so we can try again if subscribers reconnect and leave again
        partialResponseSaved = false;
      }
    });

    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      // Use the job's abort controller signal - allows abort via GenerationJobManager.abortJob()
      signal: job.abortController.signal,
      jobCreatedAt,
      checkpointNamespace: job.metadata?.checkpointNamespace,
      foregroundRunId: mcpRequestBody.messageId,
      requestBody: mcpRequestBody,
    });
    startupTelemetry?.mark('client_initialized');
    client = result.client;
    const normalizedMCPRequestBody = createMCPRuntimeRequestBody({
      messageId: mcpRequestBody.messageId,
      conversationId: mcpRequestBody.conversationId,
      codeEnvironmentMode: req.body.codeEnvironmentMode,
      codeWorkspaces: req.body.codeWorkspaces,
      ...(Object.prototype.hasOwnProperty.call(mcpRequestBody, 'parentMessageId') && {
        parentMessageId: mcpRequestBody.parentMessageId,
      }),
    });
    if (JSON.stringify(normalizedMCPRequestBody) !== JSON.stringify(mcpRequestBody)) {
      await GenerationJobManager.updateMetadata(
        streamId,
        { mcpRequestBody: normalizedMCPRequestBody },
        jobCreatedAt,
      );
    }
    if (
      typeof client?.options?.agent?.id === 'string' &&
      !isEphemeralAgentId(client.options.agent.id)
    ) {
      verifiedInitialAgentId = client.options.agent.id;
    }

    /** Request-shape validation rejects every known edit/regenerate path, but
     * the client owns the final persistence decision. Fail closed if a future
     * or provider-specific path still derives skip-save for a recovered turn;
     * consuming its parked source would otherwise erase the only durable copy
     * of the user's words. Re-checked inside commitRecoveredSteer in case a
     * client mutates the flag while sending. */
    if (recoveredSteerId && client?.skipSaveUserMessage) {
      throw new Error('Recovered steer cannot skip user message persistence');
    }

    if (job.abortController.signal.aborted) {
      await GenerationJobManager.completeJob(
        streamId,
        'Request aborted during initialization',
        jobCreatedAt,
      ).catch((completeErr) => {
        logger.warn(
          '[ResumableAgentController] completeJob failed after initialization abort',
          completeErr,
        );
      });
      await settleScheduledRun({
        status: 'interrupted',
        error: 'Request aborted during initialization',
        clearConversationId: job.createdEventEmitted !== true,
      });
      startupTelemetry?.end('aborted');
      try {
        await finishResumableRequest(req, userId);
      } finally {
        if (client) {
          disposeClient(client);
        }
        client = null;
        if (providerExecutionId) {
          await GenerationJobManager.markProviderExecutionDrained?.(
            streamId,
            jobCreatedAt,
            providerExecutionId,
          ).catch((drainError) => {
            logger.warn(
              '[ResumableAgentController] Failed to record initialization-abort provider drain',
              drainError,
            );
          });
        }
      }
      return;
    }

    // Tag the client with THIS generation's identity so HITL terminal side-effects
    // (pause CAS, checkpoint prune) can tell whether a newer request has since replaced
    // this job on the same conversationId before acting on it.
    client.jobCreatedAt = jobCreatedAt;

    const agentsConfig = req.config?.endpoints?.[EModelEndpoint.agents];
    const eventActorAgents = [
      client?.options?.agent,
      ...(client?.agentConfigs?.values?.() ?? []),
    ].filter(Boolean);
    const eventActorMayPause =
      isHITLEnabled(agentsConfig?.toolApproval) ||
      eventActorAgents.some(agentRequestsAskUserQuestion);
    const turnExecutionPlan = resolveAgentTurnExecutionPlan({
      conversationId,
      parentMessageId,
      isNewConversation: isNewConvo,
      isSchedule: scheduleId != null,
      isEvent: req._isAgentTrigger === true,
      event:
        agentEventDelivery?.event != null
          ? {
              type: agentEventDelivery.event.type,
              ...(typeof boundEventBindingId === 'string' &&
              boundEventBindingId.length > 0 &&
              req._agentEventBindingParentConversationId != null
                ? {
                    binding: {
                      bindingId: boundEventBindingId,
                      parentConversationId: req._agentEventBindingParentConversationId,
                    },
                  }
                : {}),
              ...(agentEventDelivery?.expectedAction == null
                ? {}
                : { expectedAction: agentEventDelivery.expectedAction }),
            }
          : undefined,
      canPause: eventActorMayPause,
      /** Old trusted producers can coexist during a direct rolling upgrade.
       * Their immutable v1 request keeps pause-capable turns on the history
       * adapter until every consumer understands durable suspensions. */
      durableEventActorSuspensions: generationProtocolVersion >= GENERATION_PROTOCOL_V2,
      checkpointerType: agentsConfig?.checkpointer?.type,
    });

    // Resolve title timing from the public agents endpoint first, then fall
    // back to the agent's actual backing provider/custom endpoint.
    titleTiming = resolveTitleTiming({
      appConfig: req.config,
      endpoint: [endpointOption?.endpoint, client?.options?.agent?.endpoint],
    });

    if (client?.sender) {
      void GenerationJobManager.updateMetadata(
        streamId,
        { sender: client.sender },
        jobCreatedAt,
      ).catch((err) => {
        logger.warn('[ResumableAgentController] Failed to persist response sender', err);
      });
    }

    // Store reference to client's contentParts - graph will be set when run is created
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts, jobCreatedAt);
    }

    let userMessage;
    let liveResponseMessageId = preallocatedResponseMessageId;

    /** What this turn's message writes reported about the conversation row: the
     *  gate an immediate-mode title waits on, and whether the user-message write
     *  ever recorded the row. Declared out here because that fact arrives through
     *  `getReqData`, which the client calls from inside `sendMessage`. */
    const convoSignal = createConvoPersistenceSignal();

    const getReqData = (data = {}) => {
      if (data.userMessage) {
        userMessage = data.userMessage;
      }
      if (data.responseMessageId) {
        liveResponseMessageId = data.responseMessageId;
      }
      /** The user-message write upserts the conversation, so its result is the
       *  earliest proof the title's row exists. Waiting for the turn to end
       *  instead leaves the database on "New Chat" for the whole run, and every
       *  reader without the live stream reads that. */
      convoSignal.observeMessageWrite(data.userMessagePromise);
      // conversationId is pre-generated, no need to update from callback
    };

    let immediateTitlePromise = null;
    let trailingWritePromise = null;
    let backgroundClientCleanupScheduled = false;
    let terminalClaim = null;
    let terminalClaimFinished = false;
    let terminalPersistenceChecked = false;
    let terminalWasAborted = false;
    let preemptIncomplete = false;
    /** The graph exhausted its per-turn step budget. Like `preemptIncomplete`, an
     *  honest `unfinished` outcome rather than an error: the partial turn is real
     *  work and the user is offered a way to carry on. */
    let stepLimitReached = false;
    /** A pause-row write failure is terminalized through the exact action/epoch
     * barrier. Once that path starts, neither generic background error handler
     * may call completeJob: the pause may already have been replaced by a newer
     * action or generation by the time the persistence failure is observed. */
    let pausePersistenceFailed = false;
    let pausePersistenceFailureFinalized = false;
    const finishOwnedTerminalClaim = async () => {
      if (!terminalClaim || terminalClaimFinished) {
        return;
      }
      try {
        await GenerationJobManager.finishTerminalJob(terminalClaim);
      } finally {
        terminalClaimFinished = true;
      }
    };
    /** Runs inside BaseClient immediately before it can start the completed
     * response write. A lost claim returns false, and BaseClient skips that
     * stale `unfinished:false` write entirely. The fallback invocation below
     * supports test/custom clients that do not derive from BaseClient. */
    const claimBeforeResponsePersistence = async () => {
      if (terminalPersistenceChecked) {
        return terminalClaim != null;
      }
      terminalPersistenceChecked = true;
      if (client?.pendingApproval) {
        // AgentClient installed a durable pause-persistence barrier in the
        // running→requires_action CAS. BaseClient must not start its ordinary
        // `unfinished:false` response write; the HITL branch persists the
        // partial row as unfinished before releasing that barrier.
        return false;
      }
      terminalWasAborted = job.abortController.signal.aborted;
      const preemptStats = client?.run?.getPreemptStats?.();
      preemptIncomplete =
        (preemptStats?.emptyBoundaries ?? 0) > 0 ||
        client?.run?.getHaltReason?.() === 'preempt_incomplete';
      stepLimitReached = client?.stepLimitReached === true;
      terminalClaim = await GenerationJobManager.claimTerminalJob(
        streamId,
        terminalWasAborted ? 'aborted' : 'complete',
        undefined,
        jobCreatedAt,
        { persistencePending: true },
      );
      return terminalClaim != null;
    };
    const disposeBackgroundClient = () => {
      if (backgroundClientCleanupScheduled) {
        return;
      }
      backgroundClientCleanupScheduled = true;

      if (immediateTitlePromise) {
        immediateTitlePromise.finally(() => {
          if (client) {
            disposeClient(client);
          }
        });
      } else if (client) {
        disposeClient(client);
      }
    };

    // Start background generation immediately. The stream layer buffers and persists events
    // until an SSE subscriber attaches, so generation no longer waits on subscriber readiness.
    const startGeneration = async () => {
      /** Immediate-mode title generation runs in parallel with the response, so
       *  the conversation row may not exist when the title resolves. `convoReady`
       *  resolves once that row is known to exist — normally the user-message
       *  write reporting it, and otherwise the success tail or the catch block,
       *  which also gate `disposeClient` on the title. */
      let titleEventPromise = null;
      let acceptsTitleEvents = true;
      const convoReady = convoSignal.ready;
      const resolveConvoReady = () => convoSignal.open();
      /** A row this turn restored with a bare `saveMessage`, which writes the message and
       *  never tells the conversation about it. Every such retry hands its result here. */
      const recoverMessageReference = (savedMessage, context) =>
        recoverTurnMessageReference(
          { appendConvoMessageReference },
          {
            userId,
            conversationId,
            messageId: savedMessage?._id == null ? undefined : String(savedMessage._id),
            alreadyRecorded: convoSignal.recordedMessageReference(savedMessage?._id),
            managesConversation: !client?.skipSaveConvo,
            context,
          },
        );
      /** Dedicated controller so a user Stop (or a replaced stream) cancels the
       *  in-flight title — kept separate from `job.abortController`, which
       *  `completeJob` also aborts on *successful* completion and would otherwise
       *  cancel a title that is merely slower than a short response. */
      const titleAbortController = new AbortController();
      /** Separate from `titleAbortController`: a user Stop cancels the in-flight
       *  title model call but keeps a title that already finished generating.
       *  Only a superseded/failed stream aborts this to discard such a title so it
       *  cannot clobber the conversation now owned by the newer run. */
      const titleDiscardController = new AbortController();
      const abortTitleOnJobAbort = () => titleAbortController.abort();
      if (job.abortController.signal.aborted) {
        titleAbortController.abort();
      } else {
        job.abortController.signal.addEventListener('abort', abortTitleOnJobAbort, { once: true });
      }
      const titleEligible =
        addTitle && parentMessageId === Constants.NO_PARENT && isNewConvo && !req.body?.isTemporary;
      const emitTitleEvent = ({ conversationId: titleConversationId, title }) => {
        titleEventPromise = (async () => {
          if (!acceptsTitleEvents || titleAbortController.signal.aborted) {
            return;
          }
          const currentJob = await GenerationJobManager.getJob(streamId);
          if (!currentJob || currentJob.createdAt !== jobCreatedAt) {
            return;
          }
          if (titleAbortController.signal.aborted) {
            return;
          }
          await GenerationJobManager.emitChunk(
            streamId,
            {
              event: 'title',
              data: {
                conversationId: titleConversationId,
                title,
              },
            },
            { expectedCreatedAt: jobCreatedAt },
          );
        })().catch((err) => {
          logger.error('[ResumableAgentController] Error emitting title event', err);
        });
        return titleEventPromise;
      };
      const eventActorTenantId = req._agentEventBindingTenantId;
      let appliedEventActor;
      let eventActorPersistenceComplete = false;
      let eventActorTurn;
      const recordEventActorPersistenceFailure = async (error) => {
        if (appliedEventActor == null || eventActorPersistenceComplete) {
          return;
        }
        const recorded = await recordAgentEventActorReconciliation({
          user: userId,
          conversationId,
          ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
          reconciliation: {
            invocationId: appliedEventActor.invocationId,
            ...(appliedEventActor.actionAdmitted === true && { actionAdmitted: true }),
            status: 'persistence_failed',
            checkpoint: appliedEventActor.checkpoint,
            action: appliedEventActor.action,
            error: String(error?.message ?? error).slice(0, 1024),
            observedAt: new Date(),
          },
        });
        if (!recorded) {
          throw new Error('Failed to preserve applied event actor persistence reconciliation');
        }
      };

      try {
        const onStart = (userMsg, respMsgId, _isNewConvo) => {
          userMessage = userMsg;
          liveResponseMessageId = respMsgId;

          // Store userMessage and responseMessageId upfront for resume capability
          GenerationJobManager.updateMetadata(
            streamId,
            {
              responseMessageId: respMsgId,
              userMessage: {
                messageId: userMsg.messageId,
                parentMessageId: userMsg.parentMessageId,
                conversationId: userMsg.conversationId,
                text: userMsg.text,
                quotes: userMsg.quotes,
                reasoningOverride: userMsg.reasoningOverride,
                // Persist the turn's uploaded files here (authoritative job metadata) so a
                // HITL resume sources them from the job, not the user DB row — which the
                // approval prompt can race (the row save may still be in flight when a fast
                // /resume reads it). Without this an approved tool run can rebuild without the
                // paused turn's files.
                ...(Array.isArray(req.body?.files) &&
                  req.body.files.length > 0 && { files: req.body.files }),
                // Skill selections aren't on `userMsg` yet at onStart (BaseClient adds them
                // later), so source them from the request — otherwise this update overwrites
                // the preliminary metadata and a HITL-resumed turn loses its skill pills.
                ...(Array.isArray(req.body?.manualSkills) &&
                  req.body.manualSkills.length > 0 && { manualSkills: req.body.manualSkills }),
                ...(Array.isArray(req.body?.alwaysAppliedSkills) &&
                  req.body.alwaysAppliedSkills.length > 0 && {
                    alwaysAppliedSkills: req.body.alwaysAppliedSkills,
                  }),
              },
            },
            jobCreatedAt,
          ).catch((err) => {
            logger.error('[ResumableAgentController] Failed to persist start metadata', err);
          });

          GenerationJobManager.emitChunk(
            streamId,
            {
              created: true,
              // Skill selections aren't on `userMessage` yet at onStart (BaseClient adds
              // them later), so attach them from the request — this is the message
              // `trackUserMessage` persists as the authoritative job.metadata.userMessage,
              // and it's what the live client renders the user bubble from.
              message: {
                ...userMessage,
                // Carry files so trackUserMessage (the authoritative writer) persists them on
                // job.metadata.userMessage for a HITL resume (see the updateMetadata above).
                ...(Array.isArray(req.body?.files) &&
                  req.body.files.length > 0 && { files: req.body.files }),
                ...(Array.isArray(req.body?.manualSkills) &&
                  req.body.manualSkills.length > 0 && { manualSkills: req.body.manualSkills }),
                ...(Array.isArray(req.body?.alwaysAppliedSkills) &&
                  req.body.alwaysAppliedSkills.length > 0 && {
                    alwaysAppliedSkills: req.body.alwaysAppliedSkills,
                  }),
              },
              streamId,
            },
            { expectedCreatedAt: jobCreatedAt },
          ).catch((err) => {
            logger.error('[ResumableAgentController] Failed to queue created event', err);
          });
        };

        const messageOptions = {
          user: userId,
          onStart,
          getReqData,
          isContinued,
          isRegenerate,
          isCompaction,
          editedContent,
          conversationId,
          parentMessageId,
          abortController: job.abortController,
          overrideParentMessageId,
          isEdited: !!editedContent,
          beforeResponsePersistence: claimBeforeResponsePersistence,
          userMCPAuthMap: result.userMCPAuthMap,
          responseMessageId: editedResponseMessageId,
          preallocatedUserMessageId,
          preallocatedResponseMessageId,
          progressOptions: {
            res: {
              write: () => true,
              end: () => {},
              headersSent: false,
              writableEnded: false,
            },
          },
        };

        const usesCheckpointStrategy = turnExecutionPlan.strategy === 'checkpoint';
        /** Authoritative action proof is captured in graph context the moment
         * the expected tool executes (see the observer tee in initialize.js);
         * run-step inspection stays only as a fallback, because the run-step
         * collection is populated asynchronously and can still be empty the
         * instant sendMessage resolves — misreading an applied invocation as
         * actionless would discard its fork and strand the actor cold. */
        const eventActorActionRecorder = usesCheckpointStrategy
          ? createAgentEventActionRecorder(turnExecutionPlan.expectedAction)
          : undefined;
        const actorInvocationId = internalDetachedCompletion?.invocationId ?? eventTaskId;
        const eventActorDetachedAction =
          usesCheckpointStrategy &&
          turnExecutionPlan.expectedAction != null &&
          turnExecutionPlan.binding != null
            ? createAgentEventActorDetachedActionLifecycle(
                {
                  user: userId,
                  ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
                  bindingId: turnExecutionPlan.binding.bindingId,
                  conversationId,
                  generationCreatedAt:
                    internalDetachedCompletion?.generationCreatedAt ?? jobCreatedAt,
                  turnCreatedAt: jobCreatedAt,
                  invocationId: actorInvocationId,
                  expectedAction: turnExecutionPlan.expectedAction,
                },
                {
                  reserveAgentEventActorDetachedAction,
                  markAgentEventActorDetachedActionRunning,
                  settleAgentEventActorDetachedAction,
                  storeMode: () => GenerationJobManager.detachedAgentEventActionStoreMode,
                  persistTerminalEvidence: async (evidence) => {
                    const persisted =
                      await GenerationJobManager.persistAgentEventDetachedTerminalEvidence(
                        streamId,
                        jobCreatedAt,
                        evidence,
                      );
                    if (!persisted) {
                      throw new Error(
                        'Detached Event Actor terminal retry evidence could not be staged',
                      );
                    }
                  },
                  /** Retry immediately when the generation already reached its
                   * terminal host-action fence. The same durable marker is
                   * recovered across replicas and restarts by the existing
                   * GenerationJobManager sweep. */
                  onTerminal: async () => {
                    await GenerationJobManager.retryTerminalHostAction(streamId, jobCreatedAt);
                  },
                },
              )
            : undefined;
        req._agentEventDetachedActionLifecycle = eventActorDetachedAction;
        if (eventActorActionRecorder != null) {
          req._agentEventActionObserver = eventActorActionRecorder.observeToolEnd;
        }
        let internalDetachedAction;
        let internalDetachedSuspension;
        if (usesCheckpointStrategy && isInternalDetachedCompletion) {
          const snapshot = await getAgentEventActorSnapshot({
            user: userId,
            conversationId,
            ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
          });
          internalDetachedSuspension = snapshot?.suspension;
          internalDetachedAction = await getAgentEventActorDetachedAction({
            deliveryKey: internalDetachedCompletion.invocationId,
            user: userId,
            ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
            bindingId: turnExecutionPlan.binding.bindingId,
            conversationId,
            generationCreatedAt: internalDetachedCompletion.generationCreatedAt,
          });
          if (
            internalDetachedSuspension?.kind !== 'internal_completion' ||
            internalDetachedSuspension.status !== 'pending' ||
            internalDetachedSuspension.actionId !== internalDetachedCompletion.taskId ||
            internalDetachedSuspension.suspension.invocation.invocationId !==
              internalDetachedCompletion.invocationId ||
            internalDetachedAction == null ||
            internalDetachedAction.taskId !== internalDetachedCompletion.taskId ||
            internalDetachedAction.idempotencyKey !== internalDetachedCompletion.idempotencyKey ||
            !['succeeded', 'failed', 'cancelled'].includes(internalDetachedAction.status)
          ) {
            throw Object.assign(
              new Error('The detached Event Actor completion is no longer current'),
              { code: 'EVENT_ACTOR_NOT_READY', status: 409 },
            );
          }
        }
        const readAppliedEventAction = () =>
          eventActorActionRecorder.read() ??
          (internalDetachedAction?.status === 'succeeded'
            ? {
                toolName: internalDetachedAction.toolName,
                toolCallId: internalDetachedAction.toolCallId,
              }
            : undefined) ??
          findAgentEventAppliedAction(
            turnExecutionPlan.expectedAction,
            client?.run?.getRunSteps?.() ?? [],
            client?.contentParts ?? [],
          );
        const actorDependencies = {
          getSnapshot: getAgentEventActorSnapshot,
          commitState: commitAgentEventActorState,
          storeSuspension: storeAgentEventActorSuspension,
          claimSuspension: claimAgentEventActorSuspension,
          settleSuspension: settleAgentEventActorSuspension,
          recordReconciliation: recordAgentEventActorReconciliation,
          resolveReconciliation: resolveAgentEventActorReconciliation,
          admitAction: admitAgentEventActorAction,
          releaseAction: releaseAgentEventActorAction,
          hasActionAdmission: hasAgentEventActorActionAdmission,
          getReceipt: getAgentEventActorReceipt,
          clearReconciliation: clearAgentEventActorReconciliation,
        };
        let checkpointTurn;
        if (usesCheckpointStrategy && isInternalDetachedCompletion) {
          checkpointTurn = {
            kind: 'resume',
            input: {
              user: userId,
              ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
              conversationId,
              bindingId: turnExecutionPlan.binding.bindingId,
              suspension: internalDetachedSuspension.suspension,
              resumeAttemptId: clientRequestId,
              resumeValue: {
                type: EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
                taskId: internalDetachedAction.taskId,
                status: internalDetachedAction.status,
                ...(internalDetachedAction.result == null
                  ? {}
                  : { result: internalDetachedAction.result }),
                ...(internalDetachedAction.error == null
                  ? {}
                  : { error: internalDetachedAction.error }),
              },
              signal: job.abortController.signal,
              checkpointer: req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
              expectedAction: turnExecutionPlan.expectedAction,
              resume: async (actorContext) => {
                client.checkpointNamespace = actorContext.checkpointNamespace;
                client.eventActorCheckpointId = actorContext.checkpointId;
                client.eventActorInvocationId = actorContext.invocationId;
                client.eventActorContinuation = actorContext.continuation;
                return client.sendMessage(text, messageOptions);
              },
              readAppliedAction: readAppliedEventAction,
              readSuspension: () =>
                eventActorDetachedAction?.readSuspension() ?? client.readEventActorSuspension(),
              readResultContext: () => client.getEventActorContext(),
            },
          };
        } else if (usesCheckpointStrategy) {
          checkpointTurn = {
            kind: 'execute',
            input: {
              user: userId,
              ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
              conversationId,
              bindingId: turnExecutionPlan.binding.bindingId,
              invocationId: actorInvocationId,
              event: agentEventDelivery.event,
              expectedAction: turnExecutionPlan.expectedAction,
              signal: job.abortController.signal,
              checkpointer: req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
              resolveContext: (state) => client.prepareEventActorContext(state),
              readResultContext: () => client.getEventActorContext(),
              invoke: async (actorContext) => {
                client.checkpointNamespace = actorContext.checkpointNamespace;
                client.eventActorCheckpointId = actorContext.checkpointId;
                client.eventActorInvocationId = actorContext.invocationId;
                client.eventActorContinuation = actorContext.continuation;
                return client.sendMessage(text, messageOptions);
              },
              readAppliedAction: readAppliedEventAction,
              readSuspension: () =>
                eventActorDetachedAction?.readSuspension() ?? client.readEventActorSuspension(),
            },
          };
        }
        const isBoundEventActor =
          agentEventDelivery?.event != null && req._agentEventBindingParentConversationId != null;
        eventActorTurn = isBoundEventActor
          ? createAgentEventActorTurn(
              {
                strategy: turnExecutionPlan.strategy,
                ...(checkpointTurn == null ? {} : { checkpoint: checkpointTurn }),
                history: {
                  owner: {
                    user: userId,
                    conversationId,
                    ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
                  },
                  persistToken: (token) =>
                    GenerationJobManager.updateMetadata(
                      streamId,
                      { agentEventLegacyTurnToken: token },
                      jobCreatedAt,
                    ),
                  invoke: () => client.sendMessage(text, messageOptions),
                },
              },
              {
                actor: actorDependencies,
                history: {
                  begin: beginAgentEventActorLegacyTurn,
                  complete: completeAgentEventActorLegacyTurn,
                },
              },
            )
          : undefined;
        const sendPromise = eventActorTurn
          ? eventActorTurn.run().then(async ({ adapter, value, execution }) => {
              if (adapter !== 'checkpoint') {
                return value;
              }
              if (execution.status === 'applied') {
                appliedEventActor = {
                  invocationId: actorInvocationId,
                  actionAdmitted: typeof admitAgentEventActorAction === 'function',
                  checkpoint: execution.head.checkpoint,
                  action: execution.result.action,
                };
              } else if (execution.status === 'suspended') {
                const suspensionKind = eventActorDetachedAction?.readSuspension()?.kind;
                if (suspensionKind === 'internal_completion') {
                  await GenerationJobManager.updateMetadata(
                    streamId,
                    {
                      agentEventSuspension: {
                        version: execution.suspension.version,
                        suspensionId: execution.suspension.suspensionId,
                        attempt: execution.suspension.attempt,
                      },
                    },
                    jobCreatedAt,
                  );
                } else if (!(await client.publishStagedApproval(execution.suspension))) {
                  throw new Error('Event actor suspension could not be projected to its job');
                }
              }
              logger.info('[event-actor] Bound child event completed', {
                conversationId,
                invocationId: actorInvocationId,
                status: execution.status,
                continuation: execution.continuation,
              });
              return value;
            })
          : client.sendMessage(text, messageOptions);

        if (hasQueuedTurnAdmissionSource) {
          const {
            settleAgentQueuedTurnExecutionAdmission,
          } = require('~/server/services/Agents/triggers');
          await settleAgentQueuedTurnExecutionAdmission(queuedTurnAdmissionSource, {
            userId,
            ...(tenantId != null && { tenantId }),
            conversationId,
            clientRequestId,
            generationId: streamId,
            generationCreatedAt: jobCreatedAt,
          });
          sendGenerationStarted();
        }

        if (titleEligible && titleTiming === 'immediate') {
          immediateTitlePromise = addTitle(req, {
            text: text || getAttachmentTitleText(req.body.files),
            conversationId,
            client,
            immediate: true,
            convoReady,
            signal: titleAbortController.signal,
            discardSignal: titleDiscardController.signal,
            onTitleGenerated: emitTitleEvent,
          }).catch((err) => {
            logger.error('[ResumableAgentController] Error in immediate title generation', err);
          });
        }

        const response = await sendPromise;

        // HITL: the turn paused for human review (see AgentClient.handleRunInterrupt).
        // The job is already `requires_action` with the pending action persisted and
        // emitted to the client; the resume route owns finishing this turn. Settle and
        // verify the required unfinished history, then tear down without publishing a
        // terminal event or completing a successfully persisted paused job.
        if (client?.pendingApproval) {
          if (response?.databasePromise) {
            try {
              await response.databasePromise;
            } catch (dbErr) {
              logger.error(
                '[ResumableAgentController] Error settling databasePromise on HITL pause',
                dbErr,
              );
            }
            delete response.databasePromise;
          }
          const pauseActionId = client.pendingApproval.actionId;
          const pauseCreatedAt = client.jobCreatedAt ?? jobCreatedAt;
          const ownsPausePersistence = await GenerationJobManager.approvals.ownsPausePersistence(
            streamId,
            pauseActionId,
            pauseCreatedAt,
          );
          if (ownsPausePersistence) {
            try {
              /** BaseClient awaits its first user/conversation write before the
               * pause hook, but deliberately swallows a failed/falsy user save
               * and may still record the id locally. Re-save idempotently for
               * every ordinary user turn before exposing the approval. */
              if (!client?.skipSaveUserMessage) {
                if (!userMessage) {
                  throw new Error('User message was unavailable before HITL pause');
                }
                if (
                  typeof client.saveMessageToDatabase === 'function' &&
                  typeof client.getSaveOptions === 'function'
                ) {
                  /** Retry through BaseClient so a failure before its original
                   * saveConvo is repaired along with the message row. Direct
                   * saveMessage alone cannot recreate that conversation. */
                  const savedUserTurn = await client.saveMessageToDatabase(
                    userMessage,
                    client.getSaveOptions(),
                    userId,
                  );
                  if (!savedUserTurn?.message) {
                    throw new Error('User message could not be persisted before HITL pause');
                  }
                  if (!client.skipSaveConvo && !savedUserTurn.conversation) {
                    throw new Error('Conversation could not be persisted before HITL pause');
                  }
                  /** This re-save reports its own conversation write, which the signal has
                   * not seen: it does not run through `getReqData`. */
                  convoSignal.observeMessageWrite(Promise.resolve(savedUserTurn));
                } else {
                  // Custom clients used by integrations/tests may not inherit BaseClient.
                  const savedUserMessage = await saveMessage(
                    {
                      userId,
                      isTemporary:
                        req?._agentEventBindingRetention?.isTemporary ??
                        req?.resolvedConversation?.isTemporary ??
                        req?.body?.isTemporary,
                      expiredAt:
                        req?._agentEventBindingRetention?.expiredAt ??
                        req?.resolvedConversation?.expiredAt,
                      interfaceConfig: req?.config?.interfaceConfig,
                    },
                    userMessage,
                    {
                      context:
                        'api/server/controllers/agents/request.js - user message before HITL pause',
                    },
                  );
                  if (!savedUserMessage) {
                    throw new Error('User message could not be persisted before HITL pause');
                  }
                  /** A custom client's bare save leaves the same gap as the retries below. */
                  await recoverMessageReference(
                    savedUserMessage,
                    'api/server/controllers/agents/request.js - recovered paused user reference',
                  );
                }
              }
              if (!response?.messageId) {
                throw new Error('Response message was unavailable before HITL pause');
              }
              const savedResponseMessage = await saveMessage(
                {
                  userId,
                  isTemporary:
                    req?._agentEventBindingRetention?.isTemporary ??
                    req?.resolvedConversation?.isTemporary ??
                    req?.body?.isTemporary,
                  expiredAt:
                    req?._agentEventBindingRetention?.expiredAt ??
                    req?.resolvedConversation?.expiredAt,
                  interfaceConfig: req?.config?.interfaceConfig,
                },
                {
                  ...response,
                  endpoint: endpointOption.endpoint,
                  unfinished: true,
                  user: userId,
                },
                {
                  context:
                    'api/server/controllers/agents/request.js - HITL pause (persist unfinished)',
                },
              );
              if (!savedResponseMessage) {
                throw new Error('Paused response could not be persisted as unfinished');
              }
              /** A paused turn may never be resumed, so this row's reference cannot wait for
               * a terminal that might not come. The save above is bare, and the title write
               * that used to rebuild the array in passing no longer does. */
              await recoverMessageReference(
                savedResponseMessage,
                'api/server/controllers/agents/request.js - recovered paused response reference',
              );
              await commitRecoveredSteer();
            } catch (pausePersistenceError) {
              pausePersistenceFailed = true;
              try {
                pausePersistenceFailureFinalized =
                  (await GenerationJobManager.failPausePersistence(
                    streamId,
                    pauseActionId,
                    pausePersistenceError?.message ?? 'Pause persistence failed',
                    pauseCreatedAt,
                  )) === true;
              } catch (failError) {
                logger.error(
                  `[ResumableAgentController] Failed to terminalize pause persistence error for ${streamId}`,
                  failError,
                );
              }
              if (pausePersistenceFailureFinalized) {
                /** Namespaced checkpoints belong exclusively to this epoch,
                 * so the exact pause-failure CAS winner can safely remove the
                 * now-unresumable graph state. Legacy shared namespaces are
                 * left to their guarded/TTL cleanup path. */
                const checkpointNamespace = job.metadata?.checkpointNamespace;
                if (typeof checkpointNamespace === 'string' && checkpointNamespace !== '') {
                  try {
                    await deleteAgentCheckpoint(
                      conversationId,
                      req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
                      undefined,
                      { checkpointNamespace },
                    );
                  } catch (checkpointError) {
                    logger.error(
                      `[ResumableAgentController] Failed to prune checkpoint after pause persistence error for ${streamId}`,
                      checkpointError,
                    );
                  }
                }
              } else if (pausePersistenceFailureFinalized === false) {
                logger.warn(
                  `[ResumableAgentController] Skipping stale pause persistence failure — ${streamId} no longer owns its barrier`,
                );
              }
              throw pausePersistenceError;
            }
            await client.exposePendingApproval?.();
            const released = await GenerationJobManager.approvals.finishPausePersistence(
              streamId,
              pauseActionId,
              pauseCreatedAt,
            );
            if (!released) {
              logger.warn(
                `[ResumableAgentController] Pause persistence barrier changed before release: ${streamId}`,
              );
            }
            // The pause projection is what moves the run row off `started` and frees its
            // GLOBAL capacity slot. recordScheduleOutcome already retried it; a `false`
            // here means every attempt failed, leaving the row `started` while the job
            // sits `requires_action`. Surface it — the armed engine's reconciler replays
            // this state, and the clustered sweep now converges it too, but a silent drop
            // gave neither a reason to look.
            if (!(await settleScheduledRun({ status: 'requires_action' }))) {
              logger.error(
                `[ResumableAgentController] Failed to project the scheduled pause for ${streamId}; run stays active until reconciliation replays it`,
              );
            }
          } else {
            logger.debug(
              `[ResumableAgentController] Skipping stale pause persistence — ${streamId} no longer owns its barrier`,
            );
          }
          titleAbortController.abort();
          acceptsTitleEvents = false;
          resolveConvoReady();
          // handleRunInterrupt already released the concurrency slot the moment it paused
          // (so a fast /resume isn't 429'd); only release here if that didn't happen.
          // Always run the MCP request-context cleanup.
          await cleanupMCPRequestContextForReq(req);
          if (!client?.pendingRequestReleased && req._scheduleConcurrencyExempt !== true) {
            await decrementPendingRequest(userId);
          }
          if (client) {
            disposeClient(client);
          }
          logger.debug(
            `[ResumableAgentController] Turn paused for approval; awaiting resume: ${streamId}`,
          );
          startupTelemetry?.end('paused');
          return;
        }

        // BaseClient invokes this before starting its response write. Custom
        // clients/tests may return a database promise directly, so keep the
        // controller-side fallback before awaiting that promise.
        await claimBeforeResponsePersistence();

        const endpoint = endpointOption.endpoint;
        response.endpoint = endpoint;

        const databasePromise = response.databasePromise;
        delete response.databasePromise;

        /** Records which row this write appended, for the same reason the user
         *  message's write is observed: the retry below cannot tell on its own
         *  whether the conversation already references what it just re-saved. */
        convoSignal.observeMessageWrite(databasePromise);
        const databaseResult = await databasePromise;
        const { conversation: convoData = {}, persistenceSkipped = false } = databaseResult;
        const responsePersistenceWasSkipped = persistenceSkipped === true;
        let conversation = { ...convoData };
        conversation.title =
          conversation && !conversation.title ? null : conversation?.title || 'New Chat';
        if (!terminalClaim) {
          /** Stop/replacement won before the response persistence hook. The
           * BaseClient contract skipped its completed response write; cancel
           * title work and leave terminal publication/persistence to the
           * actual winner. */
          titleAbortController.abort();
          titleDiscardController.abort();
          job.abortController.signal.removeEventListener('abort', abortTitleOnJobAbort);
          acceptsTitleEvents = false;
          resolveConvoReady();
          try {
            await recordEventActorPersistenceFailure(
              new Error('Event actor terminal persistence claim was replaced'),
            );
          } catch (reconciliationError) {
            /** The committing CAS already left a non-settled row that blocks
             * later actor turns, so a failed status upgrade costs provenance,
             * not safety. Never divert this clean exit past its cleanup. */
            logger.error(
              '[event-actor] Failed to preserve replaced-claim reconciliation',
              reconciliationError,
            );
          }
          /** This controller lost terminal persistence ownership, so it cannot
           * prove the winning Stop/replacement has written the unfinished
           * response yet. Keep the conversation fence closed; a HITL resume
           * carries the exact token, while every other orphan is handled by
           * bounded stale reclaim. */
          await finishResumableRequest(req, userId);
          disposeBackgroundClient();
          startupTelemetry?.end(job.abortController.signal.aborted ? 'aborted' : 'replaced');
          return;
        }

        if (req.body.files && Array.isArray(client.options.attachments)) {
          const files = buildMessageFiles(req.body.files, client.options.attachments);
          if (files.length > 0) {
            userMessage.files = files;
          }
          delete userMessage.image_urls;
        }

        const shouldGenerateTitle =
          addTitle &&
          parentMessageId === Constants.NO_PARENT &&
          isNewConvo &&
          !terminalWasAborted &&
          !preemptIncomplete;

        // Save user message BEFORE sending final event to avoid race condition
        // where client refetch happens before database is updated
        const reqCtx = {
          userId: req?.user?.id,
          isTemporary:
            req?._agentEventBindingRetention?.isTemporary ??
            req?.resolvedConversation?.isTemporary ??
            req?.body?.isTemporary,
          expiredAt:
            req?._agentEventBindingRetention?.expiredAt ?? req?.resolvedConversation?.expiredAt,
          interfaceConfig: req?.config?.interfaceConfig,
        };
        const terminalMemoryContext = {
          ...(client?.attachmentMemoryContext ?? {}),
          req,
          conversationId: conversation?.conversationId,
          messageId: response?.messageId,
          attachments:
            client?.attachmentMemoryContext?.attachments ??
            client?.modelBoundCurrentFiles ??
            req.body.files,
        };
        logAgentMemorySnapshot('before_terminal_save', terminalMemoryContext);

        if (!client.skipSaveUserMessage) {
          if (!userMessage) {
            throw new Error('User message was unavailable before terminal persistence');
          }
          const savedUserMessage = await saveMessage(reqCtx, userMessage, {
            context: 'api/server/controllers/agents/request.js - resumable user message',
          });
          if (!savedUserMessage) {
            throw new Error('User message could not be persisted before terminal publication');
          }
          /** The retry above restored only the Message row, so the conversation may
           * still not reference this turn. */
          await recoverMessageReference(
            savedUserMessage,
            'api/server/controllers/agents/request.js - recovered user message reference',
          );
        }
        // Only consume the parked recovery source after the explicit user-row
        // write above succeeds. `response.databasePromise` alone is insufficient:
        // BaseClient intentionally swallows a failed first user-message save.
        await commitRecoveredSteer();

        // CRITICAL: Save response message BEFORE emitting final event.
        // This prevents race conditions where the client sends a follow-up message
        // before the response is saved to the database, causing orphaned parentMessageIds.
        /** BaseClient can add the id to savedMessageIds even when its model-layer
         * save resolved falsy. Re-save the terminal row idempotently and require
         * the returned durable row before publishing the normal FINAL. */
        const responseIsUnfinished = terminalWasAborted || preemptIncomplete || stepLimitReached;
        const savedResponseMessage = await saveMessage(
          reqCtx,
          {
            ...response,
            /** A neutral finish unsets what a disconnect snapshot may have stored. */
            contextMeta: response.contextMeta ?? null,
            user: userId,
            unfinished: responseIsUnfinished,
            /** Distinguishes "ran out of steps" from a user stop, so the client can
             *  render the actionable tool-call-limit notice rather than the generic
             *  incomplete-response warning. */
            ...(stepLimitReached && {
              finish_reason: Constants.TOOL_CALL_LIMIT_FINISH_REASON,
            }),
          },
          {
            context: responseIsUnfinished
              ? 'api/server/controllers/agents/request.js - terminal response unfinished'
              : 'api/server/controllers/agents/request.js - resumable response end',
          },
        );
        if (!savedResponseMessage) {
          throw new Error(
            responseIsUnfinished
              ? 'Terminal response could not be persisted as unfinished'
              : 'Response message could not be persisted before terminal publication',
          );
        }
        /** As for the user message above: a bare `saveMessage` restores the row
         * without telling the conversation about it. */
        await recoverMessageReference(
          savedResponseMessage,
          'api/server/controllers/agents/request.js - recovered response message reference',
        );
        logAgentMemorySnapshot('after_terminal_save', terminalMemoryContext);
        if (appliedEventActor != null) {
          const recorded = await recordAgentEventActorReconciliation({
            user: userId,
            conversationId,
            ...(eventActorTenantId == null ? {} : { tenantId: eventActorTenantId }),
            reconciliation: {
              invocationId: appliedEventActor.invocationId,
              ...(appliedEventActor.actionAdmitted === true && { actionAdmitted: true }),
              status: 'history_persisted',
              checkpoint: appliedEventActor.checkpoint,
              action: appliedEventActor.action,
              observedAt: new Date(),
            },
          });
          if (!recorded) {
            throw new Error('Applied event actor history barrier could not be durably recorded');
          }
        }
        await eventActorTurn?.historyPersisted();
        eventActorPersistenceComplete = true;

        /** A persisted BaseClient response already advanced lastResponseAt. Re-stamp only
         * when its terminal persistence was explicitly skipped, then refresh the payload's
         * conversation snapshot so it acknowledges the durable timestamp. */
        if (responseIsUnfinished && responsePersistenceWasSkipped) {
          const announced = await announceReply(
            { stampConvoLastResponse },
            {
              userId: reqCtx.userId,
              conversationId: response.conversationId,
              reply: {
                messageId: savedResponseMessage.messageId,
                content: response.content,
                text: response.text,
                attachments: response.attachments,
                isTemporary: reqCtx.isTemporary,
              },
              context: 'AgentController - skipped terminal persistence',
            },
          );
          if (announced) {
            try {
              const stampedConversation = await getConvo(reqCtx.userId, response.conversationId);
              if (stampedConversation) {
                conversation = { ...conversation, ...stampedConversation };
              }
            } catch (error) {
              logger.warn('[AgentController] Failed to read back the stamped conversation', error);
            }
          }
        }

        // If the user stopped this turn — or an empty preempt boundary truncated
        // it, which persists under the same honest `unfinished` contract — cancel
        // the title still being generated, which never reaches its save. A title
        // that finished generating is kept, and is normally already persisted: the
        // gate opened when the user-message write created its row.
        if (terminalWasAborted || preemptIncomplete) {
          titleAbortController.abort();
        } else {
          job.abortController.signal.removeEventListener('abort', abortTitleOnJobAbort);
        }

        // Backstop for a turn whose user-message write never reported a conversation
        // (a deferred or skipped write): the row exists by now, so let any title
        // waiting on it persist (saveConvo uses noUpsert).
        resolveConvoReady();
        acceptsTitleEvents = false;

        if (titleEventPromise) {
          await titleEventPromise;
        }

        let scheduleCompletionError;
        if (terminalWasAborted) {
          scheduleCompletionError = 'Scheduled run was stopped';
        } else if (preemptIncomplete) {
          scheduleCompletionError = 'Scheduled run was interrupted before completion';
        } else if (stepLimitReached) {
          scheduleCompletionError = 'Scheduled run reached its tool call limit before completion';
        }
        await settleScheduledRun({
          status: responseIsUnfinished ? 'interrupted' : 'success',
          ...(scheduleCompletionError != null && { error: scheduleCompletionError }),
        });

        let terminalPublicationStarted = false;
        try {
          const pendingSteers = terminalClaim.drainedSteers.map(toPendingSteer);
          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: {
              ...response,
              ...(responseIsUnfinished && { unfinished: true }),
              ...(stepLimitReached && {
                finish_reason: Constants.TOOL_CALL_LIMIT_FINISH_REASON,
              }),
            },
            ...(pendingSteers.length > 0 && { pendingSteers }),
          };

          logger.debug(
            terminalWasAborted
              ? `[ResumableAgentController] Emitting ABORTED FINAL event`
              : `[ResumableAgentController] Emitting FINAL event`,
            {
              streamId,
              wasAbortedBeforeComplete: terminalWasAborted,
              userMessageId: userMessage?.messageId,
              responseMessageId: response?.messageId,
              conversationId: conversation?.conversationId,
            },
          );

          terminalPublicationStarted = true;
          logAgentMemorySnapshot('before_final_publish', terminalMemoryContext);
          const publication = await GenerationJobManager.publishTerminalClaim(
            terminalClaim,
            finalEvent,
          );
          logAgentMemorySnapshot('after_final_publish', terminalMemoryContext);
          let terminalOutcome = 'completed_without_delta';
          if (publication.persistenceFailed) {
            terminalOutcome = 'error';
          } else if (terminalWasAborted) {
            terminalOutcome = 'aborted';
          }
          startupTelemetry?.end(terminalOutcome);
        } catch (terminalError) {
          /** A failure while constructing the payload happened after this
           * controller's terminal CAS but before the manager could durably
           * settle it. Publish conservative reconciliation immediately. Once
           * publication starts, the manager either stores the payload or owns
           * its bounded recovery marker, so retrying with a different payload
           * here would only risk duplicate delivery. */
          if (!terminalPublicationStarted) {
            try {
              await GenerationJobManager.publishTerminalClaim(terminalClaim, null);
            } catch (reconcileError) {
              logger.warn(
                '[ResumableAgentController] Failed to publish terminal persistence reconciliation',
                reconcileError,
              );
            }
          }
          throw terminalError;
        } finally {
          // Pair every successful claim even when final-event construction or
          // transport publication throws. Cleanup is epoch/runtime guarded.
          await finishOwnedTerminalClaim();
        }
        await finishResumableRequest(req, userId);

        if (titleTiming === 'immediate') {
          // Title was fired in parallel above (if eligible); a stopped turn already
          // aborted it before `resolveConvoReady`. Defer disposal until it settles
          // so the run/req aren't torn down mid-generation.
          if (immediateTitlePromise) {
            immediateTitlePromise.finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
          } else if (client) {
            disposeClient(client);
          }
        } else if (shouldGenerateTitle) {
          trailingWritePromise = addTitle(req, {
            text: text || getAttachmentTitleText(req.body.files),
            response: { ...response },
            client,
          })
            .catch((err) => {
              logger.error('[ResumableAgentController] Error in title generation', err);
            })
            .finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
        } else {
          if (client) {
            disposeClient(client);
          }
        }
      } catch (error) {
        // Any failure (user Stop, or a preflight/quota failure before the run is
        // even created) must cancel the title and unblock its waits: the title's
        // `_waitForRun` would otherwise never resolve, deferring client disposal
        // until the 45s title timeout, and no title should persist for a failed turn.
        titleAbortController.abort();
        titleDiscardController.abort();
        job.abortController.signal.removeEventListener('abort', abortTitleOnJobAbort);
        acceptsTitleEvents = false;
        resolveConvoReady();
        if (!res.headersSent) {
          sendGenerationJson(
            res,
            500,
            { error: error.message || 'Failed to start generation' },
            generationProtocolVersion,
          );
        }
        try {
          await recordEventActorPersistenceFailure(error);
        } catch (reconciliationError) {
          logger.error(
            '[event-actor] Failed to preserve terminal persistence reconciliation',
            reconciliationError,
          );
        }

        // Once this controller owns terminal persistence, no competing error
        // transition can win. Settle its pending marker with conservative
        // reconciliation on any required-write/final-construction failure,
        // then release exactly that claim.
        let ownsScheduledFailure = false;
        let legacyEventActorErrorHistoryDurable = false;
        if (terminalClaim && !terminalClaimFinished) {
          ownsScheduledFailure = true;
          try {
            await GenerationJobManager.publishTerminalClaim(terminalClaim, null);
          } catch (publishError) {
            logger.warn(
              '[ResumableAgentController] Failed to publish terminal persistence reconciliation',
              publishError,
            );
          } finally {
            await finishOwnedTerminalClaim().catch((finishError) => {
              logger.warn(
                '[ResumableAgentController] Failed to finish terminal persistence claim',
                finishError,
              );
            });
          }
          logger.error(
            `[ResumableAgentController] Terminal persistence failed for ${streamId}:`,
            error,
          );
          startupTelemetry?.end('error', error);
        } else if (pausePersistenceFailed) {
          ownsScheduledFailure = pausePersistenceFailureFinalized;
          // failPausePersistence owns the only legal requires_action -> error
          // transition for this exact action/epoch. Never fall through to
          // completeJob, which could race a newer action or replacement job.
          logger.error(
            `[ResumableAgentController] Pause persistence failed for ${streamId}:`,
            error,
          );
          startupTelemetry?.end('error', error);
        } else if (job.abortController.signal.aborted || error.message?.includes('abort')) {
          ownsScheduledFailure = true;
          logger.debug(`[ResumableAgentController] Generation aborted for ${streamId}`);
          startupTelemetry?.end('aborted');
          // abortJob already handled emitDone and completeJob
        } else {
          logger.error(`[ResumableAgentController] Generation error for ${streamId}:`, error);
          const generationError = error.message || 'Generation failed';
          try {
            // completeJob first wins running -> error and atomically parks
            // steers, then publishes. A competing abort/pause emits nothing.
            ownsScheduledFailure =
              (await GenerationJobManager.completeJob(streamId, generationError, jobCreatedAt, {
                beforeErrorPublication: () =>
                  saveErrorTurn(req, {
                    conversationId,
                    endpointOption,
                    isNewConvo,
                    errorText: generationError,
                    liveUserMessage: userMessage,
                    liveResponseMessageId,
                    runCreated: client?.run != null,
                    sender: client?.sender,
                    initialAgentId: verifiedInitialAgentId,
                  }),
              })) === true;
            /** A true completion means this owner won the terminal CAS and
             * the beforeErrorPublication barrier above finished. Only that
             * combination proves the failed-turn rows are durable enough to
             * let a checkpoint fork rebuild past this legacy turn. */
            legacyEventActorErrorHistoryDurable = ownsScheduledFailure;
          } catch (completeErr) {
            logger.warn(
              '[ResumableAgentController] completeJob failed during generation-error cleanup',
              completeErr,
            );
          } finally {
            startupTelemetry?.end('error', error);
          }
        }

        /** Leave the fence set when terminal persistence loses ownership or
         * fails. Time cannot prove whether an external action occurred, so an
         * ambiguous fence remains fail-closed pending explicit reconciliation. */
        if (legacyEventActorErrorHistoryDurable) {
          await eventActorTurn?.historyPersisted();
        }

        if (ownsScheduledFailure && !scheduleTerminalOutcomeRecorded) {
          const scheduledFailure = classifyScheduledFailure(
            error,
            job.abortController.signal.aborted,
          );
          await settleScheduledRun(scheduledFailure);
        }

        try {
          await finishResumableRequest(req, userId);
        } finally {
          disposeBackgroundClient();
        }

        // Don't continue to title generation after error/abort
        return;
      }
    };

    // Start generation and handle any unhandled errors
    void startGeneration()
      .catch(async (err) => {
        logger.error(
          `[ResumableAgentController] Unhandled error in background generation: ${err.message}`,
        );
        startupTelemetry?.end('error', err);
        if (!res.headersSent) {
          sendGenerationJson(
            res,
            500,
            { error: err.message || 'Failed to start generation' },
            generationProtocolVersion,
          );
        }
        let errorFinalized = false;
        if (!pausePersistenceFailed) {
          errorFinalized =
            (await GenerationJobManager.completeJob(streamId, err.message, jobCreatedAt).catch(
              (completeErr) => {
                logger.warn(
                  '[ResumableAgentController] completeJob failed during background-error cleanup',
                  completeErr,
                );
                return false;
              },
            )) === true;
        }
        if (
          (errorFinalized || (pausePersistenceFailed && pausePersistenceFailureFinalized)) &&
          !scheduleTerminalOutcomeRecorded
        ) {
          await settleScheduledRun(classifyScheduledFailure(err));
        }
        try {
          await finishResumableRequest(req, userId);
        } finally {
          disposeBackgroundClient();
        }
      })
      .finally(async () => {
        await Promise.allSettled([immediateTitlePromise, trailingWritePromise].filter(Boolean));
        if (providerExecutionId) {
          await GenerationJobManager.markProviderExecutionDrained?.(
            streamId,
            jobCreatedAt,
            providerExecutionId,
          );
        }
        await releaseEventChildLease?.();
      })
      .catch((drainError) => {
        logger.warn(
          '[ResumableAgentController] Failed to record completed provider drain',
          drainError,
        );
      });
  } catch (error) {
    logger.error(`[ResumableAgentController] Initialization error: ${getSafeErrorText(error)}`);
    const initializationFailure = getInitializationFailure(error);
    const streamStarted = res.headersSent;
    try {
      if (!res.headersSent) {
        if (error?.code === 'GENERATION_PREDECESSOR_MISMATCH') {
          const currentJob = error.currentJob;
          const currentStatus = currentJob?.status;
          if (isTriggerContinuation && currentJob?.active === true) {
            res.set('Retry-After', '1');
            sendGenerationJson(
              res,
              409,
              {
                code: 'PARENT_NOT_READY',
                error: 'Another generation became active before the continuation could start.',
              },
              generationProtocolVersion,
            );
          } else {
            const predecessorVerified =
              currentJob != null &&
              Number.isSafeInteger(currentJob.createdAt) &&
              currentJob.createdAt >= 0 &&
              currentJob.verified !== false;
            sendGenerationJson(
              res,
              409,
              {
                status: 'predecessor_mismatch',
                code: 'GENERATION_PREDECESSOR_MISMATCH',
                error: predecessorVerified
                  ? 'A newer generation became current before this request could start.'
                  : 'The prior generation could not be verified. Please retry.',
                streamId,
                conversationId: currentJob?.conversationId ?? conversationId,
                generationCreatedAt: currentJob?.createdAt,
                predecessorVerified,
                active:
                  typeof currentJob?.active === 'boolean'
                    ? currentJob.active
                    : currentStatus === 'running' || currentStatus === 'requires_action',
              },
              generationProtocolVersion,
            );
          }
        } else if (error?.code === 'RECOVERY_PAYLOAD_MISMATCH') {
          sendGenerationJson(
            res,
            409,
            {
              code: 'RECOVERY_PAYLOAD_MISMATCH',
              error: 'The queued message changed before it could be recovered. Please retry.',
            },
            generationProtocolVersion,
          );
        } else if (initializationFailure) {
          sendGenerationJson(
            res,
            initializationFailure.status,
            initializationFailure,
            generationProtocolVersion,
          );
        } else {
          sendGenerationJson(
            res,
            500,
            { error: error.message || 'Failed to start generation' },
            generationProtocolVersion,
          );
        }
      }
    } catch (notificationError) {
      logger.warn(
        '[ResumableAgentController] Failed to send initialization error response',
        notificationError,
      );
    } finally {
      startupTelemetry?.end(
        error?.code === 'GENERATION_PREDECESSOR_MISMATCH' ? 'deduplicated' : 'error',
        error,
      );
    }
    // Finalize THIS failed job before releasing the idempotency claim. Releasing first would
    // let the client's retry win the same key and createJob() the same streamId while we are
    // still here. The generation guard is defense-in-depth around that ordering. A
    // completeJob() rejection (store hiccup) must NOT skip the
    // release + pending-request decrement below, or the retry stays wedged behind the claim
    // and the concurrency slot leaks — so swallow its error. (A failed completeJob did not
    // finalize anything, so releasing afterward can't let it abort a later replacement.)
    let initializationFinalized = jobCreatedAt == null;
    if (jobCreatedAt != null) {
      const initializationError = initializationFailure
        ? JSON.stringify(initializationFailure)
        : error.message || 'Failed to start generation';
      const persistInitializationError = shouldPersistCodeWorkspaceInitializationError({
        streamStarted,
        isNewConversation: isNewConvo,
        failureCode: initializationFailure?.code,
        hasValidatedDecision: req._codeEnvironmentDecision != null,
      });
      const completionPromise = persistInitializationError
        ? GenerationJobManager.completeJob(streamId, initializationError, jobCreatedAt, {
            beforeErrorPublication: () =>
              saveErrorTurn(req, {
                conversationId,
                endpointOption,
                isNewConvo,
                errorText: initializationError,
                initialAgentId: verifiedInitialAgentId,
              }),
          })
        : GenerationJobManager.completeJob(streamId, initializationError, jobCreatedAt);
      initializationFinalized =
        (await completionPromise.catch((completeErr) => {
          logger.warn(
            '[ResumableAgentController] completeJob failed during init-error cleanup',
            completeErr,
          );
          return false;
        })) === true;
    }
    if (initializationFinalized && !scheduleTerminalOutcomeRecorded) {
      await settleScheduledRun(classifyScheduledFailure(error));
    }
    if (ownedIdempotencyClaim) {
      await GenerationJobManager.releaseGeneration(
        userId,
        clientRequestId,
        streamId,
        ownedIdempotencyClaim,
      ).catch(() => {});
    }
    await finishResumableRequest(req, userId);
    if (client) {
      disposeClient(client);
    }
    if (jobCreatedAt != null && providerExecutionId) {
      await GenerationJobManager.markProviderExecutionDrained?.(
        streamId,
        jobCreatedAt,
        providerExecutionId,
      ).catch((drainError) => {
        logger.warn(
          '[ResumableAgentController] Failed to record initialization-error provider drain',
          drainError,
        );
      });
    }
    await releaseEventChildLease?.();
  }
};

module.exports = ResumableAgentController;
