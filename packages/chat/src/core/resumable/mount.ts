import { Constants } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { ResumableHost, MountContext } from './host';
import type { StartGenerationResult } from './start';
import type { ResumeSubmission } from './resume';
import type { ResumableRun } from './run';
import { resolvePredecessorMismatch, handoffStartToReplacement } from './outcomes';
import { isInitialNewConversation } from './messages';
import { attachResumableStream } from './attach';
import { startGeneration } from './launch';
import { settleStart } from './settled';

/**
 * The pane no longer serves a submission: close the connection without dispatching a cancel
 * (navigation must not abort the generation) and drop the pending re-attach.
 */
export function releaseSubmission(run: ResumableRun, host: ResumableHost): void {
  host.logger.log('ResumableSSE', 'No submission, cleaning up');
  // Clear reconnect timeout if submission is cleared
  run.clearReconnectTimeout();
  run.stopForegroundReattach?.();
  run.stopForegroundReattach = null;
  // Close SSE but do NOT dispatch cancel - navigation should not abort
  run.stream?.abort();
  run.stream = null;
  host.pane.setStreamId(null);
  run.reconnectAttempt = 0;
  run.submission = null;
}

/** Attaches the stream a start named, creating the new chat's optimistic records first. */
function attachStartedStream(
  { run, host, submission, signal }: MountContext,
  startResult: Extract<StartGenerationResult, { status: 'stream' }>,
): void {
  const {
    streamId: newStreamId,
    resumed,
    generationCreatedAt,
    generationProtocolVersion,
  } = startResult;
  host.pane.setStreamId(newStreamId);
  // Optimistically add to active jobs
  host.cache.addActiveJob(newStreamId);
  // Queue title generation if this is a new conversation (first message).
  // Skip temporary conversations: the server never generates titles for
  // them, so polling would 404 indefinitely.
  const isNewConvo = isInitialNewConversation(submission);
  if (isNewConvo && !submission.isTemporary) {
    host.cache.queueTitleGeneration(newStreamId);
  }
  // The host adopts the composer before the address bar leaves its source route.
  const streamSubmission = host.cache.addOptimisticConversation(newStreamId, submission);
  if (isNewConvo) {
    run.optimisticStreamIds.add(newStreamId);
    host.pane.replaceNewConversationUrl(newStreamId);
  }
  run.submission = streamSubmission;
  // A deduped retry (status: 'resumed') attaches to an already-running stream, so
  // subscribe with resume=true to replay its state instead of only live events.
  attachResumableStream(run, host, {
    streamId: newStreamId,
    submission: streamSubmission,
    isResume: resumed,
    generationCreatedAt,
    generationProtocolVersion,
    signal,
  });
}

/** Acts on what the generation start reported. */
async function settleStartResult(
  mount: MountContext,
  startResult: StartGenerationResult,
): Promise<void> {
  let replacementStart = startResult.status === 'replaced' ? startResult : null;
  let knownReplacementStatus = null;

  if (startResult.status === 'predecessor_mismatch') {
    const resolved = await resolvePredecessorMismatch(mount, startResult);
    if (resolved == null) {
      return;
    }
    ({ replacementStart, knownReplacementStatus } = resolved);
  }

  if (replacementStart != null) {
    await handoffStartToReplacement(mount, replacementStart, knownReplacementStatus);
    return;
  }
  if (startResult.status === 'predecessor_mismatch') {
    // Every mismatch path above either hands off or reconciles.
    return;
  }
  if (startResult.status === 'settled') {
    await settleStart(mount, startResult);
    return;
  }
  if (startResult.status !== 'stream') {
    return;
  }
  attachStartedStream(mount, startResult);
}

/** Starts the submission's generation, or re-attaches to the one it resumes. */
async function initStream(
  mount: MountContext,
  resume: Partial<Pick<ResumeSubmission, 'resumeStreamId' | 'resumeGenerationCreatedAt'>> &
    Pick<ResumeSubmission, 'resumeGenerationProtocolVersion'>,
): Promise<void> {
  const { run, host, submission, signal, isCurrent } = mount;
  const { resumeStreamId, resumeGenerationCreatedAt, resumeGenerationProtocolVersion } = resume;
  if (!isCurrent()) {
    return;
  }

  host.usage.bindResponse(submission);
  host.pane.setIsSubmitting(true);
  /** Starting a new generation is the one interval where `isSubmitting`
   *  is true but no generation epoch exists yet. Clear any prior epoch and
   *  withhold live Stop/steer controls; the composer can still queue input.
   *  The attach exposes controls once the POST/resume installs the
   *  server-provided epoch. */
  const submissionConversationId = submission.conversation?.conversationId ?? Constants.NEW_CONVO;
  if (!resumeStreamId || resumeGenerationCreatedAt == null) {
    host.pane.setGenerationEpoch(resumeStreamId ?? submissionConversationId, null);
  }
  host.pane.setShowStopButton(false);

  if (resumeStreamId) {
    if (!isCurrent()) {
      return;
    }
    // Resume: just subscribe to existing stream, don't start new generation
    host.logger.log('ResumableSSE', 'Resuming existing stream:', resumeStreamId);
    host.pane.setStreamId(resumeStreamId);
    // Optimistically add to active jobs (in case it's not already there)
    host.cache.addActiveJob(resumeStreamId);
    attachResumableStream(run, host, {
      streamId: resumeStreamId,
      submission,
      isResume: true,
      generationCreatedAt: resumeGenerationCreatedAt,
      generationProtocolVersion: resumeGenerationProtocolVersion,
      signal,
    });
    return;
  }
  // New generation: start and then subscribe
  host.logger.log('ResumableSSE', 'Starting NEW generation');
  const startResult = await startGeneration(run, host, submission, signal);
  if (!isCurrent()) {
    return;
  }
  if (startResult) {
    await settleStartResult(mount, startResult);
  } else {
    host.logger.error('ResumableSSE', 'Failed to get streamId from startGeneration');
  }
}

/**
 * The pane is moving off a run that is still generating (another chat, a new chat, or an
 * unmount): the server keeps going with no subscriber and deletes the job when done, so no
 * terminal event will reach the queue drain. Remember the run; on return its end is read from
 * history. Only a run whose identity the server confirmed (its epoch, and the user message
 * `created` or a resume's sync named) is remembered, and not a regeneration, a run that
 * already published its end, or one the user stopped.
 */
function rememberDetachedRun(run: ResumableRun, host: ResumableHost): void {
  const closing = run.submission;
  const closingConvoId = closing?.conversation?.conversationId;
  const closingUserMessageId = closing?.userMessage?.messageId;
  const generationCreatedAt = run.subscribedEpoch;
  if (
    run.stream != null &&
    run.identityConfirmed &&
    !run.runEndPublished &&
    closing?.isRegenerate !== true &&
    closingConvoId != null &&
    closingConvoId !== Constants.NEW_CONVO &&
    closingUserMessageId != null &&
    generationCreatedAt != null &&
    !host.queue.isStopped(closingConvoId, generationCreatedAt)
  ) {
    host.queue.rememberDetachedRun(closingConvoId, {
      userMessageId: closingUserMessageId,
      responseMessageId: closing?.initialResponse?.messageId,
      generationCreatedAt,
    });
  }
}

/**
 * Serves `submission` in the pane: starts its generation (or resumes the one it names) and
 * attaches to the stream. Returns the cleanup that closes the connection without aborting the
 * generation server-side and resets the pane's controls.
 */
export function mountSubmission(
  run: ResumableRun,
  host: ResumableHost,
  submission: TSubmission,
): () => void {
  const { resumeStreamId, resumeGenerationCreatedAt, resumeGenerationProtocolVersion } =
    submission as Partial<ResumeSubmission>;
  host.logger.log('ResumableSSE', 'Effect triggered', {
    conversationId: submission.conversation?.conversationId,
    hasResumeStreamId: !!resumeStreamId,
    resumeStreamId,
    userMessageId: submission.userMessage?.messageId,
  });

  run.submission = submission;
  run.runEndPublished = false;
  run.identityConfirmed = false;
  run.subscribedEpoch = null;
  if (submission.conversation?.conversationId != null) {
    /** A different run starting here owns the conversation's end from now on: an earlier run
     *  this pane left is superseded, and a Stop belonged to that earlier run. Reattaching to
     *  the same generation keeps both, since that run's end is still owed and it was stopped. */
    host.queue.clearSupersededMarkers(
      submission.conversation.conversationId,
      (generationCreatedAt) =>
        resumeStreamId != null &&
        resumeGenerationCreatedAt != null &&
        generationCreatedAt === resumeGenerationCreatedAt,
    );
  }
  const startController = new AbortController();
  const { signal } = startController;
  const mount: MountContext = {
    run,
    host,
    submission,
    signal,
    isCurrent: () => !signal.aborted && run.submission === submission,
  };

  /* Fire-and-forget, but not silent: this sets the submitting flags before
     it does any work, so a throw would leave the composer generating with no
     stream, no final event and no way back but a reload. */
  initStream(mount, {
    resumeStreamId,
    resumeGenerationCreatedAt,
    resumeGenerationProtocolVersion: resumeGenerationProtocolVersion ?? 1,
  }).catch((error: unknown) => {
    host.logger.error('[useResumableSSE] Failed to start the stream', error);
    host.pane.setIsSubmitting(false);
    host.pane.setShowStopButton(false);
    host.pane.setSubmission(null);
  });

  return () => {
    host.logger.log('ResumableSSE', 'Cleanup - closing SSE, resetting UI state');
    startController.abort();
    // Cleanup on unmount/navigation - close connection but DO NOT abort backend
    // Reset UI state so it doesn't leak to other conversations
    // If user returns to this conversation, useResumeOnLoad will restore the state
    run.clearReconnectTimeout();
    run.cancelRetryFrames();
    run.stopForegroundReattach?.();
    run.stopForegroundReattach = null;
    // Reset reconnect counter before closing (so abort handler doesn't think we're reconnecting)
    run.reconnectAttempt = 0;
    rememberDetachedRun(run, host);
    run.stream?.abort();
    run.stream = null;
    // Clear handler maps to prevent memory leaks and stale state
    host.events.clearStepMaps();
    // Reset UI state on ordinary cleanup. A generation handoff already
    // cached the replacement and must remain non-idle until resume-on-load
    // installs its epoch-fenced submission.
    if (!run.replacementHandoff) {
      host.pane.setIsSubmitting(false);
      host.pane.setShowStopButton(false);
    }
    run.replacementHandoff = false;
  };
}
