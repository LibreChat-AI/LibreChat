const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { logger } = require('@librechat/data-schemas');
const {
  Constants,
  ResourceType,
  EModelEndpoint,
  ViolationTypes,
  PermissionBits,
} = require('librechat-data-provider');
const {
  checkAccess,
  GenerationJobManager,
  GENERATION_RECOVERY_FAILED_ERROR,
  isPendingActionStale,
  resolveToolApprovalResume,
  resolveAskUserQuestionResume,
  buildResolvedAskUserQuestion,
  appendResolvedAskUserQuestion,
  attachAskUserQuestionAnswers,
  findAskUserQuestionContentIndex,
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
  captureAgentCheckpointGeneration,
  deleteAgentCheckpoint,
  buildAbortedResponseMetadata,
  sanitizeMessageForTransmit,
  filterMalformedContentParts,
  getAgentCheckpointer,
  isContentFilterError,
  preflightResumeContent,
  reportLocatorTraversalFailure,
  getResumeProvenance,
  getUserFacingResumeError,
  decrementPendingRequest,
  checkAndIncrementPendingRequest,
  isSteerPreemptSupported,
  isStopConfirmed,
  toPendingSteer,
  createMCPRuntimeRequestBody,
  getSafeErrorMetadata,
  isAgentEventRetentionActive,
  resumeAgentEventActor,
  settleAgentEventActorHistoryTurn,
  createAgentEventActionRecorder,
  createAgentEventActorDetachedActionLifecycle,
  findAgentEventAppliedAction,
  assertCodeExecutionApprovalBinding,
  collectReachableAgents,
  restoreScheduledTokenContext,
  recoverTurnMessageReference,
} = require('@librechat/api');
const { disposeClient } = require('~/server/cleanup');
const { decryptMetadata } = require('~/server/services/ActionService');
const { checkPermission } = require('~/server/services/PermissionService');
const {
  getMCPRequestContext,
  cleanupMCPRequestContextForReq,
} = require('~/server/services/MCPRequestContext');
const {
  saveMessage,
  getConvo,
  getMessages,
  getFiles,
  getAgent,
  getActions,
  getUserMemories,
  getRoleByName,
  getAgentTriggerDelivery,
  isSubagentOwnerAdmissible,
  getAgentEventActorSnapshot,
  commitAgentEventActorState,
  storeAgentEventActorSuspension,
  claimAgentEventActorSuspension,
  settleAgentEventActorSuspension,
  recordAgentEventActorReconciliation,
  completeAgentEventActorLegacyTurn,
  reserveAgentEventActorDetachedAction,
  markAgentEventActorDetachedActionRunning,
  settleAgentEventActorDetachedAction,
  appendConvoMessageReference,
} = require('~/models');
const {
  acquireEventChildGenerationLease,
} = require('~/server/services/Endpoints/agents/eventChildLease');
const {
  recordScheduleOutcome,
  claimScheduleResume,
  releaseScheduleResumeClaim,
  finalizeScheduleResumeClaim,
  releaseScheduleResumeFence,
  isScheduleLive,
} = require('~/server/services/Schedules');
const {
  GENERATION_PROTOCOL_HEADER,
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

/**
 * How long a resume waits on best-effort steering bookkeeping before answering
 * anyway. The approval is already consumed by that point, so a stalled Redis
 * must not strand the client behind a chip label and an arm.
 */
const STEER_RESUME_SETUP_TIMEOUT_MS = 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function getSuspendedEventActorExpectedAction(suspension) {
  const payload = suspension?.interrupt?.payload;
  const expectedAction =
    payload != null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload._librechatEventActor?.expectedAction
      : undefined;
  return expectedAction != null && typeof expectedAction === 'object' ? expectedAction : undefined;
}

/**
 * New jobs are physically isolated by an immutable saver namespace, so a
 * terminal owner deletes the whole namespace and catches writes that landed
 * after an earlier read. Pre-isolation jobs share the root namespace and must
 * retain captured-id cleanup to avoid pruning a replacement.
 */
function deleteResumedGenerationCheckpoint({
  conversationId,
  checkpointerCfg,
  job,
  checkpointGeneration,
}) {
  const checkpointNamespace =
    typeof job?.metadata?.checkpointNamespace === 'string' ? job.metadata.checkpointNamespace : '';
  if (checkpointNamespace !== '') {
    return deleteAgentCheckpoint(conversationId, checkpointerCfg, undefined, {
      checkpointNamespace,
    });
  }
  return deleteAgentCheckpoint(conversationId, checkpointerCfg, checkpointGeneration);
}

async function sealResumedLegacyEventActorTurn({ userId, conversationId, metadata }) {
  const token = metadata?.agentEventLegacyTurnToken;
  if (typeof token !== 'string' || token === '') {
    return;
  }
  try {
    const sealed = await settleAgentEventActorHistoryTurn(
      {
        user: userId,
        conversationId,
        ...(metadata?.tenantId == null ? {} : { tenantId: metadata.tenantId }),
        token,
      },
      completeAgentEventActorLegacyTurn,
    );
    if (!sealed) {
      logger.error(
        `[event-actor] Resumed legacy turn fence ${token} was not sealed; forks stay blocked until bounded reclaim`,
      );
    }
  } catch (error) {
    logger.error(
      `[event-actor] Failed to seal resumed legacy turn fence ${token}; forks stay blocked until bounded reclaim`,
      getSafeErrorMetadata(error),
    );
  }
}

/** Error-path checkpoint cleanup runs after the HTTP ACK. A storage failure
 * must be observable, but must not escape the controller catch and bypass the
 * remaining request-context/concurrency/client cleanup in `finally`. */
async function deleteFailedResumeCheckpoint(args, context) {
  try {
    await deleteResumedGenerationCheckpoint(args);
  } catch (error) {
    logger.error(
      `[ResumeAgentController] Failed to prune checkpoint after ${context}`,
      getSafeErrorMetadata(error),
    );
  }
}

const GENERIC_RESUME_ERROR = 'Resume failed';

const resumeContentProtectionDependencies = {
  onTraversalFailure: reportLocatorTraversalFailure,
  getAgentCheckpointer,
  checkAccess,
  getMessages,
  getFiles,
  getAgent,
  getActions,
  getUserMemories,
  getRoleByName,
  decryptMetadata,
  canAccessAgent: (agent, user) =>
    checkPermission({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: PermissionBits.VIEW,
    }),
};

/** De-duplicate a merged attachment list by a stable artifact identity. */
function mergeAttachments(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const attachment of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!attachment) {
      continue;
    }
    const key =
      attachment.file_id ??
      attachment.filepath ??
      attachment.filename ??
      JSON.stringify(attachment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(attachment);
  }
  return out;
}

/**
 * Resolve the current segment's tool artifacts and merge them with any already
 * persisted on the response row. A resumed turn can span multiple pause segments;
 * each rebuilt client has its own `artifactPromises`, and the final finalize would
 * otherwise OVERWRITE the row's attachments with only the last segment's. Reading
 * the persisted row and merging keeps every segment's artifacts on the saved message.
 */
async function resolveAccumulatedAttachments({ client, conversationId, responseMessageId }) {
  const promises = Array.isArray(client?.artifactPromises) ? client.artifactPromises : [];
  const resolved = promises.length > 0 ? (await Promise.all(promises)).filter(Boolean) : [];
  let existing = [];
  if (responseMessageId) {
    try {
      const [row] = await getMessages(
        { conversationId, messageId: responseMessageId },
        'attachments',
      );
      existing = Array.isArray(row?.attachments) ? row.attachments : [];
    } catch (err) {
      logger.warn(
        '[ResumeAgentController] Failed to read prior attachments for merge',
        getSafeErrorMetadata(err),
      );
    }
  }
  return mergeAttachments(existing, resolved);
}

/**
 * A resumed turn persists its response with a bare `saveMessage`, which writes the row and
 * never tells the conversation about it. The title write used to rebuild that array in
 * passing; it no longer does, so each resumed save carries its own reference. Nothing else
 * in a resumed turn could have appended it, so there is no prior write to consult.
 */
const recoverResumedResponseReference = (
  { userId, conversationId, client, savedResponseMessage },
  context,
) =>
  recoverTurnMessageReference(
    { appendConvoMessageReference },
    {
      userId,
      conversationId,
      messageId: savedResponseMessage?._id == null ? undefined : String(savedResponseMessage._id),
      alreadyRecorded: false,
      managesConversation: !client?.skipSaveConvo,
      context,
    },
  );

/** Resolve the segment's content for an unfinished save (mirrors finalize's source). */
async function resolveSegmentContent(client, streamId, expectedCreatedAt) {
  const liveContent = Array.isArray(client?.contentParts) ? client.contentParts : [];
  const rawContent =
    liveContent.length > 0
      ? liveContent
      : ((await GenerationJobManager.getResumeState(streamId, expectedCreatedAt))
          ?.aggregatedContent ?? []);
  return filterMalformedContentParts(rawContent);
}

/**
 * A resumed segment that streamed content / produced artifacts and then paused AGAIN
 * must persist that progress before returning. The next resume rebuilds a fresh client
 * (empty `contentParts`/`artifactPromises`), so without this an approval that later
 * expires or is reaped would leave only the EARLIER pause's content on the saved row —
 * the user loses everything streamed during this segment. Saved as a partial (`$set`,
 * still `unfinished`) so a subsequent successful resume overwrites it on finalize.
 */
async function persistRePauseProgress({ req, client, job, streamId, conversationId }) {
  const userId = req.user.id;
  const meta = job.metadata ?? {};
  const responseMessageId = meta.responseMessageId ?? client.responseMessageId;
  if (!responseMessageId) {
    return;
  }
  const content = await resolveSegmentContent(client, streamId, job.createdAt);
  const { userSubmittedPaths, userSubmittedMessageFieldPaths } = getResumeProvenance({
    content,
    pendingAction: meta.pendingAction,
    body: req.body,
    existingPaths: meta.userSubmittedPaths,
    existingMessageFieldPaths: meta.userSubmittedMessageFieldPaths,
  });
  const attachments = await resolveAccumulatedAttachments({
    client,
    conversationId,
    responseMessageId,
  });
  if (content.length === 0 && attachments.length === 0) {
    return;
  }
  const savedResponseMessage = await saveMessage(
    {
      userId,
      isTemporary: meta.isTemporary ?? req.body?.isTemporary,
      expiredAt:
        req._agentEventBindingRetention?.expiredAt ??
        (meta.retentionExpiresAt ? new Date(meta.retentionExpiresAt) : undefined),
      interfaceConfig: req?.config?.interfaceConfig,
    },
    {
      messageId: responseMessageId,
      conversationId,
      ...(content.length > 0 && { content }),
      ...(attachments.length > 0 && { attachments }),
      ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
      ...(userSubmittedMessageFieldPaths.length > 0 && { userSubmittedMessageFieldPaths }),
      unfinished: true,
      user: userId,
    },
    { context: 'api/server/controllers/agents/resume.js - re-pause progress persist' },
  );
  if (!savedResponseMessage) {
    throw new Error('Re-pause response progress could not be persisted');
  }
  await recoverResumedResponseReference(
    { userId, conversationId, client, savedResponseMessage },
    'api/server/controllers/agents/resume.js - recovered re-paused response reference',
  );
}

/** Untenanted jobs (pre-multi-tenancy) remain accessible if the userId check passes. */
function hasTenantMismatch(job, user) {
  return job.metadata?.tenantId != null && job.metadata.tenantId !== user.tenantId;
}

/**
 * Build the SDK resume value from the wire decision payload, validating against the
 * pending action. Returns `{ resumeValue }` on success or `{ error }` with an HTTP
 * status for the route to surface.
 */
function resolveResumeValue(pendingAction, body) {
  const payload = pendingAction.payload;
  if (payload?.type === 'tool_approval') {
    const resolutions = Array.isArray(body.decisions) ? body.decisions : [];
    return resolveToolApprovalResume(payload, resolutions);
  }
  if (payload?.type === 'ask_user_question') {
    return resolveAskUserQuestionResume(payload, body);
  }
  return { status: 400, error: 'Unsupported pending action type' };
}

/**
 * Finalize a resumed turn that ran to completion: persist the (now complete)
 * response message, emit the terminal event over the existing SSE, complete the
 * job, and prune the checkpoint. Mirrors the abort route's save shape but for a
 * successful finish. Best-effort title generation for a first-turn pause.
 */
async function finalizeResumedTurn({
  req,
  client,
  job,
  streamId,
  conversationId,
  addTitle,
  checkpointGeneration,
  appliedEventActor,
}) {
  const userId = req.user.id;
  const checkpointerCfg = req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
  const meta = job.metadata ?? {};
  const userMessage = meta.userMessage;
  // The response hangs off the user message; the *user* message's own parent decides
  // whether this is the first turn of the conversation (title eligibility).
  const parentMessageId = userMessage?.messageId ?? Constants.NO_PARENT;
  const isFirstTurn = (userMessage?.parentMessageId ?? Constants.NO_PARENT) === Constants.NO_PARENT;
  const responseMessageId = meta.responseMessageId ?? `${userMessage?.messageId ?? 'resumed'}_`;
  // Sourced from the paused job (persisted at creation), not the resume body — a
  // temporary chat must stay temporary on resume so its messages aren't persisted.
  const isTemporary = meta.isTemporary ?? req.body?.isTemporary;

  // Read the raw job data BEFORE completeJob deletes it — its tracked token/context
  // usage backs the response message's cost rollup (parity with normal completion).
  const jobData = await GenerationJobManager.getJobStore().getJob(streamId);

  // Job-replacement guard (mirrors the normal request path): jobs are keyed by streamId
  // (== conversationId), so a new/concurrent request reusing this conversation overwrites
  // the record with a fresh createdAt. If that happened while we were resuming, finalizing
  // now would emit `done` to / complete / delete the NEWER turn's job. Skip all terminal
  // side effects when the job we paused is no longer the live one; the caller's `finally`
  // still disposes the client + releases the slot.
  if (!jobData || jobData.createdAt !== job.createdAt) {
    logger.warn(
      `[ResumeAgentController] Skipping resumed finalization — job ${streamId} was replaced`,
    );
    return;
  }
  // Prefer the resumed run's live content: it's complete (seeded with the pre-pause
  // content) and avoids a Redis re-read that can race appendChunk writes still in
  // flight. Fall back to the aggregated store content only when the live array is empty.
  const liveContent = Array.isArray(client?.contentParts) ? client.contentParts : [];
  const rawContent =
    liveContent.length > 0
      ? liveContent
      : ((await GenerationJobManager.getResumeState(streamId, job.createdAt))?.aggregatedContent ??
        []);
  // Parity with the normal agents path (AgentClient strips these before saving):
  // drop empty/malformed tool_call parts so a resumed turn can't persist an invalid
  // part that breaks reload/rendering.
  const content = filterMalformedContentParts(rawContent);
  const { userSubmittedPaths, userSubmittedMessageFieldPaths } = getResumeProvenance({
    content,
    pendingAction: meta.pendingAction,
    body: req.body,
    existingPaths: meta.userSubmittedPaths,
    existingMessageFieldPaths: meta.userSubmittedMessageFieldPaths,
  });

  /**
   * A resumed segment can end on an empty preempt boundary just as a fresh
   * one can — the boundary hook is re-registered by `buildSteerWiring` on
   * resume. Persisting that as complete would contradict the honest contract
   * the normal request path now keeps.
   */
  const preemptStats = client?.run?.getPreemptStats?.();
  const preemptIncomplete =
    (preemptStats?.emptyBoundaries ?? 0) > 0 ||
    client?.run?.getHaltReason?.() === 'preempt_incomplete';
  /** Same honest-incomplete contract for a resumed turn that runs out of steps. */
  const stepLimitReached = client?.stepLimitReached === true;

  const responseMessage = {
    messageId: responseMessageId,
    parentMessageId,
    conversationId,
    content,
    sender: meta.sender ?? client?.sender ?? 'AI',
    endpoint: meta.endpoint,
    iconURL: meta.iconURL,
    model: meta.model,
    unfinished: preemptIncomplete || stepLimitReached,
    ...(stepLimitReached && { finish_reason: Constants.TOOL_CALL_LIMIT_FINISH_REASON }),
    error: false,
    isCreatedByUser: false,
    user: userId,
    ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
    ...(userSubmittedMessageFieldPaths.length > 0 && { userSubmittedMessageFieldPaths }),
  };
  if (meta.agent_id ?? req.body?.agent_id) {
    responseMessage.agent_id = meta.agent_id ?? req.body.agent_id;
  }
  // Persist tool artifacts (code files, images, UI resources) the resumed continuation
  // produced — BaseClient.sendMessage awaits these before saving, but the lean resume
  // path bypasses it, so do it here or they vanish on reload / for late subscribers.
  // MERGE with any already on the row (earlier pause segments) rather than overwrite —
  // the final segment's client only holds its own segment's artifacts.
  const attachments = await resolveAccumulatedAttachments({
    client,
    conversationId,
    responseMessageId,
  });
  if (attachments.length > 0) {
    responseMessage.attachments = attachments;
  }

  // Response metadata: the resume client only sees POST-resume usage, while the job's
  // tracked tokenUsage is cumulative across the pause. Take the cumulative usage (+
  // summary marker) from the job, and contextUsage / thoughtSignatures from the client
  // (which the abort-only helper drops). Cumulative usage wins so cost isn't underreported.
  const clientMeta = client?.buildResponseMetadata?.() ?? null;
  const cumulativeMeta = jobData ? buildAbortedResponseMetadata(jobData) : null;
  const responseMetadata = {
    ...(clientMeta ?? {}),
    ...(cumulativeMeta?.usage ? { usage: cumulativeMeta.usage } : {}),
    ...(cumulativeMeta?.summaryUsedTokens != null
      ? { summaryUsedTokens: cumulativeMeta.summaryUsedTokens }
      : {}),
  };
  if (Object.keys(responseMetadata).length > 0) {
    responseMessage.metadata = responseMetadata;
  }
  // Carry the resumed run's compact context meta (calibration and fading tiers), as
  // BaseClient.sendMessage persists it on the response. Without it, the NEXT turn can't
  // seed its pruner from this run. A neutral finish unsets what the paused segment
  // stored on this row, since an omitted field would otherwise survive the save.
  if (client != null) {
    responseMessage.contextMeta = client.contextMeta ?? null;
  }

  // Win terminal ownership BEFORE the outcome-defining response write. Stop
  // and completion both write the same Mongo row; a later liveness read cannot
  // fence that external write, while this CAS gives exactly one side authority.
  // The durable pending marker keeps status/subscribers on the readiness path
  // until the winner has persisted and published its FINAL.
  const terminalClaim = await GenerationJobManager.claimTerminalJob(
    streamId,
    'complete',
    undefined,
    job.createdAt,
    { persistencePending: true },
  );
  if (!terminalClaim) {
    logger.warn(
      `[ResumeAgentController] Skipping resumed FINAL — another terminal/pause transition won for ${streamId}`,
    );
    return;
  }
  let terminalPublicationStarted = false;
  try {
    const savedResponseMessage = await saveMessage(
      {
        userId,
        isTemporary,
        expiredAt:
          req._agentEventBindingRetention?.expiredAt ??
          (meta.retentionExpiresAt ? new Date(meta.retentionExpiresAt) : undefined),
        interfaceConfig: req?.config?.interfaceConfig,
      },
      responseMessage,
      { context: 'api/server/controllers/agents/resume.js - resumed response end' },
    );
    if (!savedResponseMessage) {
      throw new Error('Resumed response could not be persisted before terminal publication');
    }
    await recoverResumedResponseReference(
      { userId, conversationId, client, savedResponseMessage },
      'api/server/controllers/agents/resume.js - recovered resumed response reference',
    );
    if (appliedEventActor != null) {
      const recorded = await recordAgentEventActorReconciliation({
        user: userId,
        conversationId,
        ...(req._agentEventBindingTenantId == null
          ? {}
          : { tenantId: req._agentEventBindingTenantId }),
        reconciliation: {
          invocationId: appliedEventActor.invocationId,
          actionAdmitted: true,
          status: 'history_persisted',
          checkpoint: appliedEventActor.checkpoint,
          action: appliedEventActor.action,
          observedAt: new Date(),
        },
      });
      if (!recorded) {
        throw new Error('Resumed event actor history barrier could not be durably recorded');
      }
    }
    /** The response row is now the durable history barrier for the resumed
     * legacy turn. Seal its exact pre-pause token before publishing FINAL; a
     * failed seal remains fail-closed and is recovered by the bounded path. */
    await sealResumedLegacyEventActorTurn({
      userId,
      conversationId,
      metadata: meta,
    });

    const convo = await getConvo(userId, conversationId);
    const conversation = { ...(convo ?? {}), conversationId };

    // First-turn pause: the title was deferred when the turn paused. Generate it BEFORE
    // completing the stream so the `title` event still reaches the live client (emitChunk
    // no-ops once completeJob tears down the runtime) and the final event carries the real
    // title instead of "New Chat". Best-effort — a failure must not fail the resumed turn.
    if (
      addTitle &&
      isFirstTurn &&
      !isTemporary &&
      userMessage?.text &&
      (!convo || !convo.title || convo.title === 'New Chat')
    ) {
      try {
        await addTitle(req, {
          text: userMessage.text,
          conversationId,
          client,
          onTitleGenerated: ({ conversationId: titleConvoId, title }) => {
            conversation.title = title;
            return GenerationJobManager.emitChunk(
              streamId,
              {
                event: 'title',
                data: { conversationId: titleConvoId, title },
              },
              { expectedCreatedAt: job.createdAt },
            );
          },
        });
      } catch (err) {
        logger.error(
          '[ResumeAgentController] Title generation failed after resume',
          getSafeErrorMetadata(err),
        );
      }
    }
    conversation.title = conversation.title || 'New Chat';

    if (meta.scheduleId) {
      await recordScheduleOutcome({
        scheduleId: meta.scheduleId,
        scheduledFor: meta.scheduledFor,
        streamId,
        jobCreatedAt: job.createdAt,
        status: preemptIncomplete || stepLimitReached ? 'interrupted' : 'success',
        conversationId,
        ...(preemptIncomplete && {
          error: 'Scheduled run was interrupted before completion',
        }),
        ...(stepLimitReached &&
          !preemptIncomplete && {
            error: 'Scheduled run reached its tool call limit before completion',
          }),
      });
    }

    const pendingSteers = terminalClaim.drainedSteers.map(toPendingSteer);
    const finalEvent = {
      final: true,
      conversation,
      title: conversation.title,
      requestMessage: userMessage
        ? sanitizeMessageForTransmit({
            ...userMessage,
            conversationId,
            isCreatedByUser: true,
            // job.metadata.userMessage is persisted without files; carry the restored
            // uploads (seeded onto req.body.files before reconstruction) so the final SSE
            // doesn't blank the user bubble's attachments — matching the normal path.
            ...(Array.isArray(req.body?.files) && req.body.files.length > 0
              ? { files: req.body.files }
              : {}),
          })
        : null,
      responseMessage: { ...responseMessage },
      ...(pendingSteers.length > 0 && { pendingSteers }),
    };

    terminalPublicationStarted = true;
    await GenerationJobManager.publishTerminalClaim(terminalClaim, finalEvent);
  } catch (error) {
    if (!terminalPublicationStarted) {
      try {
        await GenerationJobManager.publishTerminalClaim(terminalClaim, null);
      } catch (publishError) {
        logger.error(
          '[ResumeAgentController] Failed to publish terminal persistence reconciliation',
          getSafeErrorMetadata(publishError),
        );
      }
    }
    throw error;
  } finally {
    try {
      // Cleanup must run even if persistence/publication fails. The claim
      // carries the exact generation/runtime identity, so this cannot tear
      // down a later run.
      await GenerationJobManager.finishTerminalJob(terminalClaim);
    } finally {
      await deleteResumedGenerationCheckpoint({
        conversationId,
        checkpointerCfg,
        job,
        checkpointGeneration,
      });
    }
  }
}

/**
 * Resume a generation that paused for human-in-the-loop review.
 *
 * The original run lives in a detached background task that exits when the run
 * pauses, so this REBUILDS the run from the durable checkpoint (same `thread_id`)
 * and continues it with the user's decision. The continuation streams over the
 * client's existing SSE (events flow through the same `streamId`).
 *
 * Flow: authorize → map decisions → atomically claim the resume (single-winner) →
 * ACK → reconstruct the client → `resumeCompletion` → finalize (or re-pause).
 *
 * Shares chat.js's middleware (auth, agent access, `buildEndpointOption`) so the
 * agent/endpoint are reconstructed from the request exactly like a normal turn.
 *
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 * @param {Function} initializeClient
 * @param {Function} addTitle
 */
const ResumeAgentController = async (req, res, next, initializeClient, addTitle) => {
  const userId = req.user.id;
  let generationProtocolVersion = negotiateNewGenerationProtocol(req);
  const { conversationId, actionId, generationCreatedAt } = req.body;
  const streamId = conversationId;

  if (!streamId || streamId === 'new') {
    return sendGenerationJson(
      res,
      400,
      { error: 'conversationId is required to resume' },
      generationProtocolVersion,
    );
  }
  if (
    generationCreatedAt != null &&
    (!Number.isSafeInteger(generationCreatedAt) || generationCreatedAt < 0)
  ) {
    return sendGenerationJson(
      res,
      400,
      { code: 'INVALID_GENERATION_IDENTITY' },
      generationProtocolVersion,
    );
  }

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return sendGenerationJson(
      res,
      404,
      { error: 'No paused generation for this conversation' },
      generationProtocolVersion,
    );
  }
  // Every persisted generation is owner-scoped. A missing/corrupt owner is
  // not a legacy wildcard: fail closed before reading or resolving its action.
  if (job.metadata?.userId !== userId) {
    return sendGenerationJson(res, 403, { error: 'Unauthorized' }, generationProtocolVersion);
  }
  if (hasTenantMismatch(job, req.user)) {
    return sendGenerationJson(res, 403, { error: 'Unauthorized' }, generationProtocolVersion);
  }
  generationProtocolVersion = negotiateExistingGenerationProtocol(req, job);
  if (generationCreatedAt != null && job.createdAt !== generationCreatedAt) {
    return sendGenerationJson(res, 409, { code: 'RUN_REPLACED' }, generationProtocolVersion);
  }

  // The resume must rebuild the SAME agent/endpoint that paused. Require an EXACT
  // agent_id match when the paused job had one — a request that omits agent_id (or
  // claims an ephemeral / non-agents endpoint) must not rebuild the claimed checkpoint
  // on a different graph. The conversation's agent is stable, so a correct client always
  // sends the right one.
  const originalAgentId = job.metadata?.agent_id;
  if (originalAgentId && req.body.agent_id !== originalAgentId) {
    return sendGenerationJson(
      res,
      403,
      { error: 'Cannot resume with a different agent' },
      generationProtocolVersion,
    );
  }
  // Require an EXACT endpoint match (like agent_id): a request that OMITS endpoint must
  // not fall through — the shared chat middleware treats a missing/non-agents endpoint
  // as the ephemeral agent, so omitting it could rebuild the claimed checkpoint on a
  // different graph. A correct client always echoes the paused endpoint.
  const originalEndpoint = job.metadata?.endpoint;
  if (originalEndpoint && req.body.endpoint !== originalEndpoint) {
    return sendGenerationJson(
      res,
      403,
      { error: 'Cannot resume on a different endpoint' },
      generationProtocolVersion,
    );
  }

  const scheduleId = job.metadata?.scheduleId;
  const scheduledFor = job.metadata?.scheduledFor;
  // A resumed schedule is still an unattended scheduled run. Preserve that
  // provenance on the rebuilt client so every later pause (a second approval
  // or follow-up question) must prove its durable checkpoint before the job is
  // exposed as `requires_action` again.
  if (scheduleId) {
    req._isScheduledFire = true;
  }
  if (
    scheduleId &&
    !(await isScheduleLive(scheduleId, job.metadata?.scheduleConfigRevision, {
      automatic: job.metadata?.scheduleManual !== true,
      policy: true,
      // Re-validate the destination THIS occurrence recorded, not the schedule's
      // current one: a later fire can have redirected the schedule while this run sat
      // paused, and its conversation stays where it was filed.
      scheduledFor,
    }))
  ) {
    let stopped = false;
    try {
      const abortResult = await GenerationJobManager.abortJob(streamId, {
        expectedCreatedAt: job.createdAt,
        awaitProviderDrain: true,
      });
      // `success` is the authoritative signal, exactly as the abort route gates. A
      // `success: false` result WITHOUT a failure reason no longer exists — an
      // unreached job, a replacement, or a lost CAS all report one — so the old
      // `failureReason == null` test settled the occurrence and pruned the
      // checkpoint on aborts that were never confirmed.
      stopped = isStopConfirmed(abortResult);
    } catch (error) {
      logger.warn('[ResumeAgentController] Failed to stop inactive scheduled run', error);
    }
    if (!stopped) {
      res.set('Retry-After', '1');
      return sendGenerationJson(
        res,
        503,
        {
          code: 'SCHEDULE_STOP_UNCONFIRMED',
          error: 'The inactive scheduled run could not be confirmed stopped. Please retry.',
        },
        generationProtocolVersion,
      );
    }
    await recordScheduleOutcome({
      scheduleId,
      scheduledFor,
      streamId,
      jobCreatedAt: job.createdAt,
      status: 'interrupted',
      conversationId,
      error: 'Schedule was disabled, changed, or deleted before approval',
    });
    const checkpointNamespace = job.metadata?.checkpointNamespace;
    if (typeof checkpointNamespace === 'string' && checkpointNamespace !== '') {
      await deleteAgentCheckpoint(
        conversationId,
        req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
        undefined,
        { checkpointNamespace },
      ).catch((error) => {
        logger.warn('[ResumeAgentController] Failed to prune inactive schedule checkpoint', error);
      });
    }
    return sendGenerationJson(
      res,
      409,
      { code: 'SCHEDULE_NO_LONGER_ACTIVE', error: 'This schedule can no longer be resumed' },
      generationProtocolVersion,
    );
  }

  const pendingAction = job.metadata?.pendingAction;
  if (job.status !== 'requires_action') {
    return sendGenerationJson(
      res,
      409,
      { error: 'No live pending action to resume' },
      generationProtocolVersion,
    );
  }
  if (isPendingActionStale({ pendingAction })) {
    // The action expired between the pending-action SSE and this submit. Drive the expiry
    // NOW (expire CAS + terminal SSE) instead of waiting for the periodic sweeper —
    // otherwise the job sits `requires_action` with a dead action and any attached SSE
    // client never gets a terminal event, so the stream appears to hang even though the
    // UI already reported the action as expired.
    try {
      await GenerationJobManager.expireApproval(streamId, pendingAction?.actionId, job.createdAt);
    } catch (err) {
      logger.warn(
        '[ResumeAgentController] Failed to expire stale action on submit',
        getSafeErrorMetadata(err),
      );
    }
    return sendGenerationJson(
      res,
      409,
      { error: 'No live pending action to resume' },
      generationProtocolVersion,
    );
  }
  // Require the actionId the UI sends: without it, a stale/malformed client could
  // resolve whatever action is currently pending (e.g. answer a different question).
  if (!actionId) {
    return sendGenerationJson(
      res,
      400,
      { error: 'actionId is required to resume' },
      generationProtocolVersion,
    );
  }
  if (pendingAction.actionId !== actionId) {
    return sendGenerationJson(
      res,
      409,
      { error: 'This decision targets a stale action' },
      generationProtocolVersion,
    );
  }

  // Pin the graph identity: the resume must rebuild the SAME agent/graph + tool set the
  // run paused on. The agent_id + endpoint guards above cover saved agents; the
  // fingerprint additionally catches an ephemeral-agent config swap (its agent_id is
  // undefined, so the id guard can't tell two ephemeral configs apart). Enforced only
  // when the paused action carries a fingerprint (in-flight pauses from before this
  // change won't), and recomputed from the resume body's graph-determining fields.
  const pinnedFingerprint = pendingAction.requestFingerprint;
  const pinnedFingerprintV2 = pendingAction.requestFingerprintV2;
  const legacyFingerprint = computeLegacyAgentRequestFingerprint(req.body ?? {});
  const currentFingerprint = computeAgentRequestFingerprint(req.body ?? {});
  if (
    (pinnedFingerprint && pinnedFingerprint !== legacyFingerprint) ||
    (pinnedFingerprintV2 && pinnedFingerprintV2 !== currentFingerprint)
  ) {
    return sendGenerationJson(
      res,
      403,
      { error: 'Cannot resume with a different agent configuration' },
      generationProtocolVersion,
    );
  }

  const mapped = resolveResumeValue(pendingAction, req.body);
  if (mapped.error) {
    return sendGenerationJson(
      res,
      mapped.status,
      {
        error: mapped.error,
        ...(mapped.undecided && { undecided: mapped.undecided }),
        ...(mapped.disallowed && { disallowed: mapped.disallowed }),
        ...(mapped.incomplete && { incomplete: mapped.incomplete }),
      },
      generationProtocolVersion,
    );
  }
  let resolvedAskContentIndex;
  let resolvedAskContentMissing = false;
  if (pendingAction.payload.type === 'ask_user_question' && !pendingAction.payload.tool_call_id) {
    const answerSnapshot = await GenerationJobManager.getResumeState(streamId, job.createdAt);
    if (answerSnapshot == null) {
      return sendGenerationJson(res, 409, { code: 'RUN_REPLACED' }, generationProtocolVersion);
    }
    const askRequest = Array.isArray(pendingAction.payload.questions)
      ? { questions: pendingAction.payload.questions }
      : pendingAction.payload.question;
    const answerContent = answerSnapshot.aggregatedContent ?? [];
    if (answerContent.length > 0) {
      resolvedAskContentIndex = findAskUserQuestionContentIndex(
        answerContent,
        undefined,
        askRequest,
      );
      if (resolvedAskContentIndex < 0) {
        resolvedAskContentIndex = undefined;
        resolvedAskContentMissing = true;
      }
    } else {
      resolvedAskContentMissing = true;
    }
  }
  const resolvedAskUserQuestion = buildResolvedAskUserQuestion(
    pendingAction,
    req.body,
    resolvedAskContentIndex,
    resolvedAskContentMissing,
  );
  const resolvedAskUserQuestions = appendResolvedAskUserQuestion(
    job.metadata?.resolvedAskUserQuestions,
    resolvedAskUserQuestion,
  );

  // A legacy job has no saver-level generation namespace, so snapshot its exact
  // durable ids before the atomic resume claim. New jobs can skip this indexed
  // read: terminal cleanup deletes their whole immutable namespace, including
  // writes that land while the continuation is running.
  //
  // Start the indexed read alongside the independent concurrency check so the
  // generation guard adds minimal time to the resume ACK path.
  const checkpointerCfg = req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
  const checkpointNamespace =
    typeof job.metadata?.checkpointNamespace === 'string' ? job.metadata.checkpointNamespace : '';
  const checkpointGenerationPromise =
    checkpointNamespace !== ''
      ? Promise.resolve(undefined)
      : captureAgentCheckpointGeneration(conversationId, checkpointerCfg).catch((err) => {
          logger.warn(
            '[ResumeAgentController] Failed to capture checkpoint generation',
            getSafeErrorMetadata(err),
          );
          return {
            threadId: conversationId,
            checkpointIds: [],
          };
        });

  // Reconstruct and inspect the exact paused input before acquiring a slot,
  // consuming the pending action, seeding MCP state, or acknowledging success.
  // A rejected answer/checkpoint therefore leaves the approval live and
  // retryable, with no resource initialization or externally visible side
  // effect beyond owner-scoped reads.
  req.body.parentMessageId = job.metadata.userMessage?.parentMessageId ?? Constants.NO_PARENT;
  // Rebuild the same persistence/retention mode as the paused turn. The resume body
  // is not authoritative: tools inspect this field during client initialization.
  req.body.isTemporary = job.metadata.isTemporary === true;
  const metaFiles = job.metadata.userMessage?.files;
  if (Array.isArray(metaFiles) && metaFiles.length > 0) {
    req.body.files = metaFiles;
  } else {
    let restoredFiles = false;
    const pausedUserMessageId = job.metadata.userMessage?.messageId;
    if (pausedUserMessageId) {
      try {
        const [row] = await getMessages(
          { conversationId, messageId: pausedUserMessageId },
          'files',
        );
        if (Array.isArray(row?.files) && row.files.length > 0) {
          req.body.files = row.files;
          restoredFiles = true;
        }
      } catch (err) {
        logger.warn(
          '[ResumeAgentController] Failed to restore paused user message files',
          getSafeErrorMetadata(err),
        );
      }
    }
    if (!restoredFiles) {
      req.body.files = [];
    }
  }

  let resumeState;
  let preparedContent;
  try {
    resumeState = await GenerationJobManager.getResumeState(streamId, job.createdAt, {
      validateEarlyBufferRecovery: true,
    });
    const batchedAnswer =
      mapped.resumeValue?.answers != null &&
      typeof mapped.resumeValue.answers === 'object' &&
      !Array.isArray(mapped.resumeValue.answers)
        ? JSON.stringify({ answers: mapped.resumeValue.answers })
        : undefined;
    const provenanceBody =
      batchedAnswer === undefined ? req.body : { ...req.body, answer: batchedAnswer };
    const resumeValueForInspection =
      batchedAnswer === undefined
        ? mapped.resumeValue
        : { ...mapped.resumeValue, answer: batchedAnswer };
    const retainedAskAnswers = job.metadata.resolvedAskUserQuestions;
    const initialSeedContent = resumeState?.aggregatedContent ?? [];
    const preflightResumeState =
      Array.isArray(retainedAskAnswers) && retainedAskAnswers.length > 0
        ? {
            ...(resumeState ?? {}),
            aggregatedContent: attachAskUserQuestionAnswers(initialSeedContent, retainedAskAnswers),
          }
        : resumeState;
    const preflightPendingAction =
      batchedAnswer !== undefined && Array.isArray(pendingAction.payload.questions)
        ? {
            ...pendingAction,
            payload: {
              ...pendingAction.payload,
              question: { questions: pendingAction.payload.questions },
            },
          }
        : pendingAction;
    preparedContent = await preflightResumeContent(
      {
        appConfig: req.config,
        endpointOption: req.body.endpointOption,
        conversationId,
        user: req.user,
        jobMetadata: job.metadata,
        pendingAction: preflightPendingAction,
        body: provenanceBody,
        resumeValue: resumeValueForInspection,
        resumeState: preflightResumeState,
        liveFiles: Array.isArray(req.body.files) ? req.body.files : [],
        isTemporary: job.metadata.isTemporary === true,
        checkpointNamespace,
        resolvedAddedAgent: req.resolvedAddedAgent,
      },
      resumeContentProtectionDependencies,
    );
  } catch (err) {
    logger.warn(
      '[ResumeAgentController] Resume content preflight failed',
      getSafeErrorMetadata(err),
    );
    if (scheduleId) {
      const terminalJob = await GenerationJobManager.getJob(streamId).catch(() => null);
      if (
        terminalJob?.createdAt === job.createdAt &&
        terminalJob.status === 'error' &&
        terminalJob.error === GENERATION_RECOVERY_FAILED_ERROR
      ) {
        try {
          await recordScheduleOutcome({
            scheduleId,
            scheduledFor,
            streamId,
            jobCreatedAt: job.createdAt,
            status: 'error',
            conversationId,
            error: GENERATION_RECOVERY_FAILED_ERROR,
          });
        } catch (scheduleError) {
          logger.error(
            '[ResumeAgentController] Failed to settle scheduled recovery failure',
            getSafeErrorMetadata(scheduleError),
          );
        }
        await deleteFailedResumeCheckpoint(
          {
            conversationId,
            checkpointerCfg,
            job,
            checkpointGeneration: await checkpointGenerationPromise,
          },
          'scheduled recovery validation failure',
        );
      }
    }
    if (isContentFilterError(err)) {
      return sendGenerationJson(res, err.statusCode, err.body, generationProtocolVersion);
    }
    return sendGenerationJson(res, 500, { error: GENERIC_RESUME_ERROR }, generationProtocolVersion);
  }
  const { seedContent, storedMessages, userSubmittedPaths, userSubmittedMessageFieldPaths } =
    preparedContent;

  // Count the resume against the concurrency limit. The original turn released its slot
  // when it paused, so resuming must re-acquire one — otherwise pausing several turns
  // and resuming them at once would bypass LIMIT_CONCURRENT_MESSAGES.
  const { allowed } = await checkAndIncrementPendingRequest(userId);
  if (!allowed) {
    return sendGenerationJson(
      res,
      429,
      { error: 'Too many concurrent requests' },
      generationProtocolVersion,
    );
  }

  // Finish the legacy checkpoint snapshot before claiming scheduled capacity.
  // It is independent of the approval claim, and holding a deployment-wide slot
  // while an indexed saver read stalls would unnecessarily block other schedules
  // and lengthen the Mongo-claim -> approval-CAS hand-off window below.
  const checkpointGeneration = await checkpointGenerationPromise;

  // A pause frees its scheduled-run capacity slot. Before consuming the approval,
  // atomically promote the run row back to `started` and claim a fresh global slot.
  // The database's partial unique indexes arbitrate both deployment capacity and a
  // concurrent active occurrence of the same schedule.
  let scheduleCapacitySlot;
  let scheduleResumeClaimToken;
  let scheduleResumeLeaseBy;
  const scheduleResumeOptions = {
    expectedConfigRevision: job.metadata?.scheduleConfigRevision,
    automatic: job.metadata?.scheduleManual !== true,
  };
  if (scheduleId) {
    let scheduleClaim;
    try {
      scheduleClaim = await claimScheduleResume(scheduleId, scheduledFor, scheduleResumeOptions);
    } catch (err) {
      await decrementPendingRequest(userId);
      logger.error('[ResumeAgentController] Failed to claim scheduled resume capacity', err);
      return sendGenerationJson(
        res,
        500,
        { error: 'Failed to reserve scheduled-run capacity' },
        generationProtocolVersion,
      );
    }
    if ('conflict' in scheduleClaim) {
      await decrementPendingRequest(userId);
      if (scheduleClaim.conflict === 'capacity' || scheduleClaim.conflict === 'overlap') {
        res.set('Retry-After', '1');
        return sendGenerationJson(
          res,
          429,
          {
            code:
              scheduleClaim.conflict === 'capacity'
                ? 'SCHEDULE_CAPACITY'
                : 'SCHEDULE_OCCURRENCE_ACTIVE',
            error:
              scheduleClaim.conflict === 'capacity'
                ? 'Scheduled-run capacity is currently full. Please retry.'
                : 'Another occurrence of this schedule is still running. Please retry.',
          },
          generationProtocolVersion,
        );
      }
      return sendGenerationJson(
        res,
        409,
        {
          code:
            scheduleClaim.conflict === 'inactive'
              ? 'SCHEDULE_NO_LONGER_ACTIVE'
              : 'SCHEDULE_RUN_NOT_PAUSED',
          error: 'This scheduled run can no longer be resumed',
        },
        generationProtocolVersion,
      );
    }
    scheduleCapacitySlot = scheduleClaim.capacitySlot;
    scheduleResumeClaimToken = scheduleClaim.claimToken;
    scheduleResumeLeaseBy = scheduleClaim.leaseBy;
  }

  const releaseScheduleFence = async () => {
    if (scheduleId == null || scheduleResumeLeaseBy == null) {
      return;
    }
    try {
      await releaseScheduleResumeFence(scheduleId, scheduleResumeLeaseBy);
    } catch (releaseError) {
      logger.warn('[ResumeAgentController] Failed to release scheduled resume fence', releaseError);
    }
  };

  /** Release only when the exact generation demonstrably remains paused. If the
   * approval CAS reply is ambiguous and the job cannot be read, retaining the slot
   * until reconciliation is the safe direction: releasing it could exceed the cap
   * while a committed continuation is already running. */
  const rollbackUnconsumedScheduleClaim = async (currentJob) => {
    if (
      scheduleId == null ||
      scheduleCapacitySlot == null ||
      currentJob?.createdAt !== job.createdAt ||
      currentJob?.status !== 'requires_action'
    ) {
      return;
    }
    try {
      await releaseScheduleResumeClaim(scheduleId, scheduledFor, scheduleCapacitySlot);
    } catch (rollbackError) {
      logger.warn(
        '[ResumeAgentController] Failed to release unconsumed scheduled resume capacity',
        rollbackError,
      );
    }
  };

  let releaseEventChildLease;
  let eventLeaseTransferredToRun = false;
  let durableEventActorSuspension;
  let durableEventActorHandlingGenerationCreatedAt;
  let durableEventActorRequiresDetachedProducer = false;
  let eventActorResumePromise;
  let eventActorStartGate;
  let eventActorContinuationStarted = false;
  let eventActorActionRecorder;
  let appliedEventActor;
  const providerExecutionId = randomUUID();
  try {
    if (req._agentEventBindingParentConversationId != null) {
      req._agentEventTaskId = job.metadata.idempotencyClientRequestId;
      try {
        releaseEventChildLease = await acquireEventChildGenerationLease({
          userId,
          tenantId: req._agentEventBindingTenantId,
          conversationId,
          streamId,
          taskId: job.metadata.idempotencyClientRequestId,
          jobCreatedAt: job.createdAt,
          retentionExpiresAt: req._agentEventBindingRetention?.expiredAt,
        });
      } catch (error) {
        logger.warn('[ResumeAgentController] Event actor resume lease is unavailable', error);
        const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
        await rollbackUnconsumedScheduleClaim(currentJob);
        await releaseScheduleFence();
        await decrementPendingRequest(userId);
        res.set('Retry-After', '1');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'EVENT_ACTOR_LEASE_UNAVAILABLE',
            error: 'The event actor lease is temporarily unavailable',
          },
          generationProtocolVersion,
        );
      }
      if (releaseEventChildLease == null) {
        const bindingActive = isAgentEventRetentionActive(
          req._agentEventBindingRetention?.expiredAt,
        );
        const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
        await rollbackUnconsumedScheduleClaim(currentJob);
        await releaseScheduleFence();
        await decrementPendingRequest(userId);
        if (bindingActive) {
          res.set('Retry-After', '1');
        }
        return sendGenerationJson(
          res,
          409,
          {
            code: bindingActive ? 'EVENT_ACTOR_NOT_READY' : 'EVENT_BINDING_PARENT_ENDED',
            error: bindingActive
              ? 'The event actor is still finishing its previous segment'
              : 'The event binding parent is no longer available',
          },
          generationProtocolVersion,
        );
      }

      /** Validate the durable parent/owner fence before consuming the HITL action.
       * Once `approvals.resolve` wins its CAS, the action is irreversibly spent; a
       * retryable fence rejection after that point could never replay the user's
       * decision. A deletion that starts after this check observes the generation
       * job plus the event-child lease and owns the corresponding abort. */
      let eventActorRejection;
      try {
        const [eventParent, ownerAdmissible] = await Promise.all([
          getConvo(userId, req._agentEventBindingParentConversationId),
          isSubagentOwnerAdmissible(userId),
        ]);
        if (!ownerAdmissible) {
          eventActorRejection = {
            code: 'EVENT_ACTOR_NOT_READY',
            error: 'The event actor owner is temporarily unavailable',
          };
        } else if (
          eventParent == null ||
          eventParent.subagentThread != null ||
          eventParent.agent_id !== req._agentEventBindingParentAgentId ||
          (eventParent.tenantId ?? undefined) !== req._agentEventBindingTenantId ||
          !isAgentEventRetentionActive(req._agentEventBindingRetention?.expiredAt) ||
          !isAgentEventRetentionActive(eventParent.expiredAt)
        ) {
          eventActorRejection = {
            code: 'EVENT_BINDING_PARENT_ENDED',
            error: 'The event binding parent is no longer available',
          };
        }
      } catch (error) {
        logger.warn('[ResumeAgentController] Event actor fence recheck failed', error);
        eventActorRejection = {
          code: 'EVENT_ACTOR_NOT_READY',
          error: 'The event actor owner is temporarily unavailable',
        };
      }
      if (eventActorRejection != null) {
        const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
        await rollbackUnconsumedScheduleClaim(currentJob);
        await releaseScheduleFence();
        await decrementPendingRequest(userId);
        return sendGenerationJson(res, 409, eventActorRejection, generationProtocolVersion);
      }
      /** Missing means this pause was produced by a pre-durable-suspension
       * replica and must retain the legacy resume path during rolling deploys.
       * Presence opts the job into the fail-closed, Conversation-authoritative
       * protocol; malformed or stale markers never downgrade to legacy. */
      const suspensionProjection = job.metadata?.agentEventSuspension;
      if (suspensionProjection != null) {
        const projectionValid =
          suspensionProjection.version === 1 &&
          typeof suspensionProjection.suspensionId === 'string' &&
          suspensionProjection.suspensionId.length > 0 &&
          Number.isSafeInteger(suspensionProjection.attempt) &&
          suspensionProjection.attempt >= 0;
        const actorSnapshot = projectionValid
          ? await getAgentEventActorSnapshot({
              user: userId,
              conversationId,
              ...(req._agentEventBindingTenantId == null
                ? {}
                : { tenantId: req._agentEventBindingTenantId }),
            })
          : undefined;
        const suspensionRecord = actorSnapshot?.suspension;
        if (
          projectionValid &&
          suspensionRecord?.status === 'pending' &&
          suspensionRecord.actionId === pendingAction.actionId &&
          suspensionRecord.jobCreatedAt === job.createdAt &&
          suspensionRecord.suspension.suspensionId === suspensionProjection.suspensionId &&
          suspensionRecord.suspension.attempt === suspensionProjection.attempt
        ) {
          durableEventActorSuspension = suspensionRecord.suspension;
          durableEventActorHandlingGenerationCreatedAt =
            suspensionRecord.handlingGenerationCreatedAt;
          durableEventActorRequiresDetachedProducer =
            job.metadata.agentEventDetachedActionProducerRequired === true ||
            (suspensionRecord.handlingGenerationCreatedAt != null &&
              job.metadata.agentEventExpectedAction != null) ||
            job.metadata.agentEventInvocationKey != null ||
            suspensionRecord.kind === 'internal_completion';
          const signedExpectedAction = getSuspendedEventActorExpectedAction(
            durableEventActorSuspension,
          );
          if (
            job.metadata.agentEventExpectedAction != null &&
            !isDeepStrictEqual(signedExpectedAction, job.metadata.agentEventExpectedAction)
          ) {
            const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
            await rollbackUnconsumedScheduleClaim(currentJob);
            await releaseScheduleFence();
            await decrementPendingRequest(userId);
            return sendGenerationJson(
              res,
              409,
              {
                code: 'EVENT_ACTOR_SUSPENSION_STALE',
                error: 'This event actor action is no longer current',
              },
              generationProtocolVersion,
            );
          }
        } else {
          const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
          await rollbackUnconsumedScheduleClaim(currentJob);
          await releaseScheduleFence();
          await decrementPendingRequest(userId);
          return sendGenerationJson(
            res,
            409,
            {
              code: 'EVENT_ACTOR_SUSPENSION_STALE',
              error: 'This event actor action is no longer current',
            },
            generationProtocolVersion,
          );
        }
      }
      if (
        durableEventActorSuspension != null &&
        durableEventActorRequiresDetachedProducer &&
        !GenerationJobManager.supportsDetachedAgentEventActions
      ) {
        const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
        await rollbackUnconsumedScheduleClaim(currentJob);
        await releaseScheduleFence();
        await decrementPendingRequest(userId);
        res.set('Retry-After', '1');
        return sendGenerationJson(
          res,
          503,
          {
            code: 'EVENT_ACTOR_RESUME_CAPABILITY_UNAVAILABLE',
            error: 'A compatible Event Actor resume worker is temporarily unavailable',
          },
          generationProtocolVersion,
        );
      }
    }

    // Atomically claim the resume. The single winner drives the run; a racing second
    // submit (double-click, two tabs) gets false and must not re-drive — that would
    // re-execute tools and double-bill.
    //
    // The claim runs AFTER the slot increment above but BEFORE the run's own try/finally
    // that releases it, so a store/Redis error here (unlike the clean `!claimed` branch)
    // would leak the concurrency slot until the counter TTL expires — spuriously 429'ing
    // the user when they retry the still-paused approval. Release the slot on that path too.
    const claimJobApproval = () =>
      GenerationJobManager.approvals.resolve(
        streamId,
        pendingAction.actionId,
        {
          preemptCapable: isSteerPreemptSupported(),
          steerQuotesCapable: true,
          providerExecutionId,
          providerDrained: true,
          ...(resolvedAskUserQuestion && { resolvedAskUserQuestions }),
        },
        job.createdAt,
      );
    let claimed;
    try {
      /** The CAS that reopens steering must also publish THIS owner's seal
       *  capability. A separate write after status=`running` leaves a window in
       *  which steer/arm requests read the previous replica's capability. */
      if (durableEventActorSuspension == null) {
        claimed = await claimJobApproval();
      } else {
        const claimGate = deferred();
        eventActorStartGate = deferred();
        const expectedAction = getSuspendedEventActorExpectedAction(durableEventActorSuspension);
        const actorInvocationId =
          job.metadata.agentEventInvocationKey ?? job.metadata.agentEventDeliveryKey;
        let actorInvocationGenerationCreatedAt =
          job.metadata.agentEventInvocationGenerationCreatedAt ??
          durableEventActorHandlingGenerationCreatedAt ??
          (job.metadata.agentEventInvocationKey == null ? job.createdAt : undefined);
        if (
          actorInvocationGenerationCreatedAt == null &&
          job.metadata.agentEventInvocationKey != null
        ) {
          const originalDelivery = await getAgentTriggerDelivery(
            job.metadata.agentEventInvocationKey,
          );
          actorInvocationGenerationCreatedAt = originalDelivery?.handling?.generationCreatedAt;
        }
        if (
          durableEventActorRequiresDetachedProducer &&
          actorInvocationId != null &&
          Number.isSafeInteger(actorInvocationGenerationCreatedAt) &&
          req._agentEventBindingId != null
        ) {
          req._agentEventDetachedActionLifecycle = createAgentEventActorDetachedActionLifecycle(
            {
              user: userId,
              ...(req._agentEventBindingTenantId == null
                ? {}
                : { tenantId: req._agentEventBindingTenantId }),
              bindingId: req._agentEventBindingId,
              conversationId,
              generationCreatedAt: actorInvocationGenerationCreatedAt,
              turnCreatedAt: job.createdAt,
              invocationId: actorInvocationId,
              expectedAction,
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
                    job.createdAt,
                    evidence,
                  );
                if (!persisted) {
                  throw new Error(
                    'Detached Event Actor terminal retry evidence could not be staged',
                  );
                }
              },
              onTerminal: async () => {
                await GenerationJobManager.retryTerminalHostAction(streamId, job.createdAt);
              },
            },
          );
        }
        eventActorActionRecorder = createAgentEventActionRecorder(expectedAction);
        req._agentEventActionObserver = eventActorActionRecorder.observeToolEnd;
        eventActorResumePromise = resumeAgentEventActor(
          {
            user: userId,
            conversationId,
            ...(req._agentEventBindingTenantId == null
              ? {}
              : { tenantId: req._agentEventBindingTenantId }),
            bindingId: req._agentEventBindingId,
            suspension: durableEventActorSuspension,
            /** One identity spans the Conversation claim and the job's
             * provider-owner CAS. A terminal hook can therefore prove whether
             * an abort won before or after the resume projection. */
            resumeAttemptId: providerExecutionId,
            resumeValue: mapped.resumeValue,
            signal: job.abortController.signal,
            checkpointer: checkpointerCfg,
            expectedAction,
            claimProjection: async () => {
              try {
                const projected = await claimJobApproval();
                claimGate.resolve(projected);
                return projected;
              } catch (error) {
                /** Redis can commit its CAS and lose only the reply. Read back
                 * this exact resume capability before declaring the earlier
                 * Conversation claim orphaned. */
                const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
                if (
                  currentJob?.createdAt === job.createdAt &&
                  currentJob.status === 'running' &&
                  currentJob.metadata?.providerExecutionId === providerExecutionId
                ) {
                  claimGate.resolve(true);
                  return true;
                }
                claimGate.reject(error);
                throw error;
              }
            },
            resume: async (actorContext) => {
              const start = await eventActorStartGate.promise;
              return start(actorContext);
            },
            readAppliedAction: () =>
              eventActorActionRecorder.read() ??
              findAgentEventAppliedAction(
                expectedAction,
                client?.run?.getRunSteps?.() ?? [],
                client?.contentParts ?? [],
                { userSubmittedMessageFieldPaths },
              ),
            readSuspension: () =>
              req._agentEventDetachedActionLifecycle?.readSuspension() ??
              client?.readEventActorSuspension(),
            readResultContext: () => client?.getEventActorContext(),
          },
          {
            getSnapshot: getAgentEventActorSnapshot,
            commitState: commitAgentEventActorState,
            storeSuspension: storeAgentEventActorSuspension,
            claimSuspension: claimAgentEventActorSuspension,
            settleSuspension: settleAgentEventActorSuspension,
            recordReconciliation: recordAgentEventActorReconciliation,
          },
        );
        eventActorResumePromise.catch(() => {});
        claimed = await Promise.race([
          claimGate.promise,
          eventActorResumePromise.then(() => {
            throw new Error('Event actor suspension completed before claiming its job projection');
          }),
        ]);
      }
    } catch (err) {
      const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
      await rollbackUnconsumedScheduleClaim(currentJob);
      await releaseScheduleFence();
      await decrementPendingRequest(userId);
      logger.error('[ResumeAgentController] Failed to claim resume', getSafeErrorMetadata(err));
      return sendGenerationJson(res, 500, { error: 'Failed to resume' }, generationProtocolVersion);
    }
    if (!claimed) {
      await decrementPendingRequest(userId);
      const currentJob = await GenerationJobManager.getJob(streamId).catch(() => null);
      await rollbackUnconsumedScheduleClaim(currentJob);
      await releaseScheduleFence();
      if (currentJob != null && currentJob.createdAt !== job.createdAt) {
        return sendGenerationJson(res, 409, { code: 'RUN_REPLACED' }, generationProtocolVersion);
      }
      return sendGenerationJson(
        res,
        409,
        { error: 'This action was already resolved or has expired' },
        generationProtocolVersion,
      );
    }

    // Linearize the consumed approval against the schedule's live config. The schedule
    // document fence was acquired only after all async policy reads, and this atomic
    // consume checks its token/revision/enabled state immediately after the approval CAS.
    // An edit/disable that won first makes this fail; one that lands afterward is ordered
    // after the continuation has started. Never begin provider execution on a stale claim.
    if (scheduleId) {
      let scheduleClaimCurrent = false;
      try {
        scheduleClaimCurrent = await finalizeScheduleResumeClaim(
          scheduleId,
          scheduleResumeClaimToken,
          scheduleResumeLeaseBy,
          scheduleResumeOptions,
        );
      } catch (error) {
        logger.error('[ResumeAgentController] Failed to finalize scheduled resume fence', error);
        await releaseScheduleFence();
      }
      if (!scheduleClaimCurrent) {
        await decrementPendingRequest(userId);
        let stopped = false;
        try {
          const abortResult = await GenerationJobManager.abortJob(streamId, {
            expectedCreatedAt: job.createdAt,
            awaitProviderDrain: true,
          });
          // Same authoritative gate as the inactive-schedule path above: only a landed
          // abort (or an already-terminal, drained generation) may settle this occurrence.
          stopped = isStopConfirmed(abortResult);
        } catch (error) {
          logger.warn('[ResumeAgentController] Failed to stop stale scheduled resume', error);
        }
        if (!stopped) {
          res.set('Retry-After', '1');
          return sendGenerationJson(
            res,
            503,
            {
              code: 'SCHEDULE_STOP_UNCONFIRMED',
              error: 'The stale scheduled resume could not be confirmed stopped.',
            },
            generationProtocolVersion,
          );
        }
        await recordScheduleOutcome({
          scheduleId,
          scheduledFor,
          streamId,
          jobCreatedAt: job.createdAt,
          status: 'interrupted',
          conversationId,
          error: 'Schedule was disabled, changed, or deleted before approval',
        });
        if (checkpointNamespace !== '') {
          await deleteAgentCheckpoint(conversationId, checkpointerCfg, undefined, {
            checkpointNamespace,
          }).catch((error) => {
            logger.warn('[ResumeAgentController] Failed to prune stale schedule checkpoint', error);
          });
        }
        return sendGenerationJson(
          res,
          409,
          { code: 'SCHEDULE_NO_LONGER_ACTIVE', error: 'This schedule can no longer be resumed' },
          generationProtocolVersion,
        );
      }
    }

    eventLeaseTransferredToRun = true;
  } finally {
    if (!eventLeaseTransferredToRun) {
      await releaseEventChildLease?.();
      releaseEventChildLease = undefined;
    }
  }

  /**
   * An interrupt steer enqueued just before the pause survives durably with
   * its `preempt` flag, but the ARM lived only in the previous owner's
   * runtime. Rebuild it from the queue so the resumed segment honours an
   * interrupt the user already had acknowledged.
   */
  const preemptRearm = GenerationJobManager.rearmQueuedPreempts(streamId, job.createdAt).catch(
    (error) => {
      logger.error(
        '[ResumeAgentController] Failed to re-arm queued preempts',
        getSafeErrorMetadata(error),
      );
    },
  );

  /**
   * BOUNDED, and the bound is the point. `.catch` only fires on rejection,
   * but ioredis queues commands while a connection is down instead of
   * rejecting, so either of these can simply never settle. That would block
   * here — after `approvals.resolve` has already consumed the action and
   * flipped the job to `running`, and before both `res.json` and the resume
   * lifecycle's own try/finally. The client times out, its retry gets a 409
   * because the action is spent, and neither the continuation nor the
   * failed-resume cleanup ever runs.
   *
   * Re-arming is steering bookkeeping that the next tool boundary would
   * honour anyway, so it finishes in the background rather than holding a
   * resume the user is waiting on. Capability is not in this best-effort path:
   * it was committed atomically by the resume claim above.
   */
  let steeringSetupTimer;
  await Promise.race([
    preemptRearm,
    new Promise((resolve) => {
      steeringSetupTimer = setTimeout(() => {
        logger.warn(
          `[ResumeAgentController] Steering setup for ${streamId} still pending after ` +
            `${STEER_RESUME_SETUP_TIMEOUT_MS}ms; continuing the resume without it`,
        );
        resolve();
      }, STEER_RESUME_SETUP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(steeringSetupTimer);

  // Seed the run-scoped MCP request-context store BEFORE the ACK: once `res.json`
  // finishes the response, a later `getMCPRequestContext(req, res)` (from tool loading)
  // sees `res` as ended and returns undefined, leaving the resumed run without its MCP
  // connection store — approved MCP / OAuth-overlay tools would then run without their
  // request-scoped connections. Pre-seeding with a null `res` + `cleanupOnResponse:false`
  // mirrors the normal stream path (request.js); torn down in the `finally` below.
  req._resumableStreamId = streamId;
  getMCPRequestContext(req, undefined, { cleanupOnResponse: false });

  // ACK immediately; the continuation streams over the client's existing SSE.
  sendGenerationJson(
    res,
    200,
    { streamId, conversationId, status: 'resuming' },
    generationProtocolVersion,
  );

  req.turnStartedAt = job.createdAt;

  let client = null;
  /** Re-pause progress failures use the action/epoch-scoped terminal CAS. The
   * generic resume catch must not subsequently call completeJob, because the
   * failed pause may have lost ownership to a newer action or generation. */
  let pausePersistenceFailed = false;
  let pausePersistenceFailureFinalized = false;
  try {
    if (userSubmittedPaths.length > 0) {
      job.metadata.userSubmittedPaths = userSubmittedPaths;
    }
    if (userSubmittedMessageFieldPaths.length > 0) {
      job.metadata.userSubmittedMessageFieldPaths = userSubmittedMessageFieldPaths;
    }
    if (userSubmittedPaths.length > 0 || userSubmittedMessageFieldPaths.length > 0) {
      await GenerationJobManager.getJobStore().updateJob(
        streamId,
        {
          ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
          ...(userSubmittedMessageFieldPaths.length > 0 && {
            userSubmittedMessageFieldPaths,
          }),
        },
        job.createdAt,
      );
    }

    const mcpRequestBody =
      job.metadata.mcpRequestBody ??
      createMCPRuntimeRequestBody({
        messageId: job.metadata.responseMessageId,
        conversationId: streamId,
        codeEnvironmentMode:
          req.body.codeEnvironmentMode ?? req.resolvedConversation?.codeEnvironmentMode,
        codeWorkspaces: req.body.codeWorkspaces ?? req.resolvedConversation?.codeWorkspaces,
        parentMessageId: job.metadata.userMessage?.messageId ?? Constants.NO_PARENT,
      });
    const result = await initializeClient({
      scheduledTokenContext: restoreScheduledTokenContext(req, job.metadata),
      req,
      res,
      endpointOption: req.body.endpointOption,
      signal: job.abortController.signal,
      jobCreatedAt: job.createdAt,
      checkpointNamespace,
      foregroundRunId: mcpRequestBody.messageId,
      requestBody: mcpRequestBody,
    });
    client = result.client;

    // The user approved the code action against the route/session selected at
    // pause time. Re-resolve it on this replica and fail before provider/tool
    // execution if the environment, worker, or workspace scope moved.
    assertCodeExecutionApprovalBinding(
      pendingAction.codeExecutionBinding,
      collectReachableAgents([client.options?.agent, ...(client.agentConfigs?.values() ?? [])]),
    );

    // Bind the rebuilt client to the in-flight turn's identity (no new user message).
    client.conversationId = streamId;
    // The resume operates on the SAME job (it moved it running again), so its identity is
    // the paused job's createdAt — used by the re-pause CAS pre-check + checkpoint prune to
    // avoid acting on a job a newer request has since replaced.
    client.jobCreatedAt = job.createdAt;
    client.checkpointNamespace = checkpointNamespace;
    client.responseMessageId = job.metadata.responseMessageId;
    client.parentMessageId = job.metadata.userMessage?.messageId ?? Constants.NO_PARENT;
    // Seed the rebuilt pruner from the tier and calibration captured at the pause, so the
    // resumed segment keeps historical tool results byte-identical to the paused one.
    client.seedContextMeta?.(job.metadata?.contextMeta);
    if (client.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts, job.createdAt);
    }

    const resumeClient = () =>
      client.resumeCompletion({
        resumeValue: mapped.resumeValue,
        seedContent,
        runSteps: resumeState?.runSteps ?? [],
        storedMessages,
        abortController: job.abortController,
        // Carry the user's MCP auth so approved MCP tools run with their credentials.
        userMCPAuthMap: result.userMCPAuthMap,
        // Replay deferred tools discovered before the pause (captured at pause). The rebuilt
        // graph passes `messages: []`, so without these the model would lose their schemas.
        discoveredToolNames: job.metadata?.discoveredTools,
        activityPhaseSnapshot: job.metadata?.activityPhaseSnapshot,
        compactionSemanticIndex: job.metadata?.compactionSemanticIndex,
      });
    if (
      !(await GenerationJobManager.beginProviderExecution(
        streamId,
        job.createdAt,
        providerExecutionId,
      ))
    ) {
      throw Object.assign(new Error('Generation stopped before provider resume'), {
        code: 'RUN_REPLACED',
      });
    }
    if (eventActorResumePromise == null) {
      await resumeClient();
    } else {
      eventActorContinuationStarted = true;
      eventActorStartGate.resolve(async (actorContext) => {
        client.checkpointNamespace = actorContext.checkpointNamespace;
        client.eventActorCheckpointId = actorContext.checkpointId;
        client.eventActorInvocationId = actorContext.invocationId;
        client.eventActorContinuation = actorContext.continuation;
        return resumeClient();
      });
      const actorResult = await eventActorResumePromise;
      if (actorResult.execution.status === 'suspended') {
        const suspensionKind = req._agentEventDetachedActionLifecycle?.readSuspension()?.kind;
        if (suspensionKind === 'internal_completion') {
          await GenerationJobManager.updateMetadata(
            streamId,
            {
              agentEventSuspension: {
                version: actorResult.execution.suspension.version,
                suspensionId: actorResult.execution.suspension.suspensionId,
                attempt: actorResult.execution.suspension.attempt,
              },
            },
            job.createdAt,
          );
        } else if (!(await client.publishStagedApproval(actorResult.execution.suspension))) {
          throw new Error('Re-paused event actor suspension could not be projected to its job');
        }
      } else if (actorResult.execution.status === 'applied') {
        appliedEventActor = {
          invocationId: durableEventActorSuspension.invocation.invocationId,
          checkpoint: actorResult.execution.head.checkpoint,
          action: actorResult.execution.result.action,
        };
      }
    }

    // The model may pause AGAIN (another tool, or a follow-up question). The pending
    // action is durably projected; persist progress before exposing it to clients.
    if (client.pendingApproval) {
      logger.debug(`[ResumeAgentController] Re-paused for approval: ${streamId}`);
      const pauseActionId = client.pendingApproval.actionId;
      const pauseCreatedAt = client.jobCreatedAt ?? job.createdAt;
      const ownsPausePersistence = await GenerationJobManager.approvals.ownsPausePersistence(
        streamId,
        pauseActionId,
        pauseCreatedAt,
      );
      if (ownsPausePersistence) {
        try {
          // Persist this segment's content + artifacts before the fresh client (next
          // resume) drops them, so an expiring re-pause doesn't lose them; finalize later
          // overwrites content and merges attachments onto the saved message. A failed
          // required write must reject into the error-finalization path rather than expose
          // the next action while its preceding segment is absent from durable history.
          await persistRePauseProgress({ req, client, job, streamId, conversationId });
        } catch (pausePersistenceError) {
          pausePersistenceFailed = true;
          try {
            pausePersistenceFailureFinalized =
              (await GenerationJobManager.failPausePersistence(
                streamId,
                pauseActionId,
                getUserFacingResumeError(pausePersistenceError, req.config),
                pauseCreatedAt,
              )) === true;
            if (!pausePersistenceFailureFinalized) {
              logger.warn(
                `[ResumeAgentController] Skipping stale re-pause persistence failure — ${streamId} no longer owns its barrier`,
              );
            }
          } catch (failError) {
            logger.error(
              `[ResumeAgentController] Failed to terminalize re-pause persistence error for ${streamId}`,
              getSafeErrorMetadata(failError),
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
            `[ResumeAgentController] Re-pause persistence barrier changed before release: ${streamId}`,
          );
        }
        if (scheduleId) {
          await recordScheduleOutcome({
            scheduleId,
            scheduledFor,
            streamId,
            jobCreatedAt: job.createdAt,
            status: 'requires_action',
            conversationId,
            checkpointNamespace: client.checkpointNamespace,
          });
        }
      } else {
        logger.debug(
          `[ResumeAgentController] Skipping stale re-pause persistence — ${streamId} no longer owns its barrier`,
        );
      }
      return;
    }

    // If the user aborted mid-resume, the abort route already emitted the terminal
    // event and finalized the job — don't double-save / double-finalize here. This
    // continuation is nevertheless the scheduled-run owner, so it must settle the
    // run row after observing its own abort; the generic Stop route deliberately
    // delegates a running generation's settlement to that generation owner.
    if (job.abortController.signal.aborted) {
      logger.debug(
        `[ResumeAgentController] Aborted during resume; abort route finalizes: ${streamId}`,
      );
      if (scheduleId) {
        await recordScheduleOutcome({
          scheduleId,
          scheduledFor,
          streamId,
          jobCreatedAt: job.createdAt,
          status: 'interrupted',
          conversationId,
          error: 'Scheduled run was stopped',
        });
      }
      return;
    }

    await finalizeResumedTurn({
      req,
      client,
      job,
      streamId,
      conversationId,
      addTitle,
      checkpointGeneration,
      appliedEventActor,
    });
  } catch (err) {
    if (
      eventActorResumePromise != null &&
      eventActorStartGate != null &&
      !eventActorContinuationStarted
    ) {
      eventActorStartGate.reject(err);
      await eventActorResumePromise.catch(() => {});
    }
    logger.error('[ResumeAgentController] Resume failed', getSafeErrorMetadata(err));
    if (pausePersistenceFailed) {
      // failPausePersistence already performed the exact requires_action ->
      // error transition. Only its CAS winner owns this generation's checkpoint
      // cleanup; a stale/mismatched failure must leave the live scope intact.
      if (pausePersistenceFailureFinalized) {
        await deleteFailedResumeCheckpoint(
          {
            conversationId,
            checkpointerCfg,
            job,
            checkpointGeneration,
          },
          're-pause persistence failure',
        );
      }
      if (scheduleId && pausePersistenceFailureFinalized) {
        await recordScheduleOutcome({
          scheduleId,
          scheduledFor,
          streamId,
          jobCreatedAt: job.createdAt,
          status: 'error',
          conversationId,
          error: err?.message ?? 'Re-pause persistence failed',
        });
      }
      return;
    }
    const errorMessage = getUserFacingResumeError(err, req.config);
    // Job-replacement guard (mirrors finalizeResumedTurn's success-path guard): if a
    // newer request reused this conversationId while the resume was failing, do NOT emit
    // the error to / complete / prune the NEWER turn's job. The finally still releases
    // the slot + disposes. Proceed with finalization if the replacement check itself fails.
    let stillLive = true;
    try {
      const liveJob = await GenerationJobManager.getJobStore().getJob(streamId);
      stillLive = !!liveJob && liveJob.createdAt === job.createdAt;
    } catch (readErr) {
      logger.warn(
        '[ResumeAgentController] Replacement check failed; finalizing anyway',
        getSafeErrorMetadata(readErr),
      );
    }
    if (!stillLive) {
      logger.warn(
        `[ResumeAgentController] Skipping failed-resume finalization — job ${streamId} was replaced`,
      );
    } else {
      // completeJob atomically claims running -> error and parks steers before
      // publishing. If abort or a re-pause won, it returns false; only the
      // terminal-CAS winner may delete this generation's checkpoint scope.
      let errorFinalized = false;
      try {
        errorFinalized =
          (await GenerationJobManager.completeJob(streamId, errorMessage, job.createdAt)) === true;
      } catch (completeErr) {
        logger.error(
          '[ResumeAgentController] Failed to finalize failed resume',
          getSafeErrorMetadata(completeErr),
        );
      }
      if (errorFinalized) {
        await deleteFailedResumeCheckpoint(
          {
            conversationId,
            checkpointerCfg,
            job,
            checkpointGeneration,
          },
          'failed resume finalization',
        );
      }
      if (scheduleId && errorFinalized) {
        const balanceRefusal = err?.message?.includes(ViolationTypes.TOKEN_BALANCE);
        await recordScheduleOutcome({
          scheduleId,
          scheduledFor,
          streamId,
          jobCreatedAt: job.createdAt,
          status: balanceRefusal ? 'skipped_balance' : 'error',
          conversationId,
          ...(!balanceRefusal && { error: err?.message ?? 'Resume failed' }),
        });
      }
    }
  } finally {
    try {
      // Tear down the MCP request-context store seeded before the ACK (parity with
      // request.js's finishResumableRequest). No-op if it was never seeded.
      await cleanupMCPRequestContextForReq(req);
      // Release the concurrency slot taken above — UNLESS handleRunInterrupt already
      // released it on a re-pause (so a fast /resume isn't 429'd). On a normal finish or
      // error it didn't, so release here. A re-pause re-acquires its own slot next resume.
      if (!client?.pendingRequestReleased) {
        await decrementPendingRequest(userId);
      }
      if (client) {
        disposeClient(client);
      }
    } finally {
      await GenerationJobManager.markProviderExecutionDrained?.(
        streamId,
        job.createdAt,
        providerExecutionId,
      ).catch((drainError) => {
        logger.warn('[ResumeAgentController] Failed to record provider drain', drainError);
      });
      await releaseEventChildLease?.();
    }
  }
};

module.exports = ResumeAgentController;
