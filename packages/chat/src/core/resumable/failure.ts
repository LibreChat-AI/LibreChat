import { ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { ChatEvent, ChatErrorData } from 'librechat-data-provider';
import type { TerminalContext } from './terminal';
import {
  handoffToReplacement,
  authorizeTerminalTeardown,
  clearPendingApprovalForTerminal,
  clearAttachedGenerationCreatedAt,
} from './terminal';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';
import { MAX_RETRIES, getReconnectDelay, getRecoverySteerId } from './start';
import { settleAfterRetryCeiling } from './ceiling';
import { recoverMissingStream } from './missing';

/**
 * Server-sent error event (event: error with data) - no responseCode.
 * These are known errors (ErrorTypes, ViolationTypes) that should be displayed to user.
 */
async function handleServedError(
  ctx: TerminalContext,
  data: ChatErrorData | string,
): Promise<void> {
  const { sub, host } = ctx;
  const { run, generationCreatedAt, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
  sub.finalReceived = true;
  const recoveryConvoId = sub.submission.conversation?.conversationId ?? currentStreamId;
  if (!(await authorizeTerminalTeardown(ctx, recoveryConvoId, 'error')) || !sub.isCurrent()) {
    return;
  }
  host.logger.log('ResumableSSE', 'Server-sent error event received:', data);
  run.cancelSteerRetryFrames();
  sub.close();
  /** FLUSH (not cancel): the error card below is built from the cache
   * tail, so queued tokens must land first, and a stale trailing
   * frame must never overwrite the error write. */
  host.events.flushPendingDeltas();
  host.cache.removeActiveJob(currentStreamId);
  clearAttachedGenerationCreatedAt(ctx);
  clearPendingApprovalForTerminal(ctx, recoveryConvoId);
  host.events.resetLive(sub.liveSubmission());
  if (!run.createdStreamIds.has(currentStreamId) && run.optimisticStreamIds.has(currentStreamId)) {
    host.cache.removeConversation(currentStreamId);
  }

  const errorSupportsV2 = supportsGenerationProtocolV2(data);
  const errorString =
    typeof data === 'string' ? data : (data.error ?? data.message ?? JSON.stringify(data));

  // Check if it's a known error type (ViolationTypes or ErrorTypes)
  let isKnownError = false;
  try {
    const parsed = typeof errorString === 'string' ? JSON.parse(errorString) : errorString;
    const errorType = parsed?.type ?? parsed?.code;
    if (errorType) {
      const violationValues = Object.values(ViolationTypes) as string[];
      const errorTypeValues = Object.values(ErrorTypes) as string[];
      isKnownError = violationValues.includes(errorType) || errorTypeValues.includes(errorType);
    }
  } catch {
    // Not JSON or parsing failed - treat as generic error
  }

  host.logger.log('ResumableSSE', 'Error type check:', { isKnownError, errorString });

  // Display the error to user via errorHandler
  host.events.showError(errorString, sub.submission);

  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);
  const recoverySteerId = getRecoverySteerId(sub.submission);
  if (
    recoverySteerId != null &&
    generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
    errorSupportsV2
  ) {
    try {
      /** The error was received on the exact generation-fenced stream.
       * Read status only now, after terminal was observed: a claim
       * started before this recovery could return a stale parked copy
       * after a successful commit and must never authorize redelivery. */
      const terminalStatus = await host.fetchStatus(recoveryConvoId);
      if (!sub.isCurrent()) {
        return;
      }
      const releasedSource = terminalStatus.unrecoveredSteers?.find(
        (steer) => steer.steerId === recoverySteerId,
      );
      if (
        terminalStatus.active === false &&
        supportsGenerationProtocolV2(terminalStatus) &&
        releasedSource != null
      ) {
        host.steers.convertToQueued(recoveryConvoId, [releasedSource], {
          generationProtocolVersion,
          allowPreviouslyConvertedIds: [recoverySteerId],
        });
      }
    } catch (error) {
      if (!sub.isCurrent()) {
        return;
      }
      host.logger.warn('ResumableSSE', 'Could not recover source after generation error', {
        conversationId: recoveryConvoId,
        error,
      });
    }
  }
  // The error terminal's backstop parks acked leftovers server-side;
  // claim it now so a reload can't resurrect the chips converted here.
  if (generationProtocolVersion === 1 || errorSupportsV2) {
    host.steers.convertLocalToQueued(recoveryConvoId, {
      claimParked: true,
      generationProtocolVersion,
    });
  }
  host.pane.publishRunEnd({
    conversationId: recoveryConvoId,
    outcome: 'error',
    endedAt: run.scheduler.now(),
    generationCreatedAt,
  });
  host.pane.setStreamId(null);
  run.releaseStream(currentStreamId);
  run.reconnectAttempt = 0;
}

/**
 * Error event handler - handles BOTH:
 * 1. HTTP-level errors (status present) - 404, 409, network failures (0)
 * 2. Server-sent error events (event: error with data) - known errors like ViolationTypes/ErrorTypes
 *
 * Order matters: check the status first since HTTP errors may also include data.
 * The transport has already retried a 401 with a refreshed token.
 */
export async function handleTransportFailure(
  ctx: TerminalContext,
  { status: responseCode, data }: Pick<Extract<ChatEvent, { type: 'error' }>, 'status' | 'data'>,
): Promise<void> {
  const { sub, host } = ctx;
  const { run, generationCreatedAt } = sub;
  if (!sub.isCurrent()) {
    return;
  }

  if (sub.finalReceived) {
    host.logger.log('ResumableSSE', 'Ignoring error after FINAL event', {
      responseCode,
      hasData: data != null,
    });
    return;
  }

  host.pane.refreshBalance();

  if (responseCode === 409) {
    const handedOff = await handoffToReplacement(ctx, sub.conversationId());
    if (!sub.isCurrent()) {
      return;
    }
    if (handedOff) {
      return;
    }
  }

  // 404 → job completed & was cleaned up; messages are persisted in DB.
  if (responseCode === 404) {
    await recoverMissingStream(ctx);
    return;
  }

  /**
   * Only check the data if there's no HTTP status, since HTTP errors may also have body data.
   * Note: responseCode === 0 means transport failure (connection dropped) - treat as network error,
   * not a server-sent error payload. Use `== null` to only match undefined/null (no HTTP status).
   */
  if (responseCode == null && data != null) {
    await handleServedError(ctx, data);
    return;
  }

  // Network failure or unknown HTTP error - attempt reconnection with backoff
  host.logger.log('ResumableSSE', 'Stream error (network failure) - will attempt reconnect', {
    responseCode,
    hasData: data != null,
  });

  if (run.reconnectAttempt < MAX_RETRIES) {
    // Increment counter BEFORE close() so abort handler knows we're reconnecting
    run.reconnectAttempt++;
    const delay = getReconnectDelay(run.reconnectAttempt);

    host.logger.log(
      'ResumableSSE',
      `Reconnecting in ${delay}ms (attempt ${run.reconnectAttempt}/${MAX_RETRIES})`,
    );

    sub.close();

    sub.scheduleReattach(delay);

    // Keep UI in "submitting" state during reconnection attempts
    // so user knows we're still trying (abort handler may have reset these)
    host.pane.setIsSubmitting(true);
    host.pane.setShowStopButton(generationCreatedAt != null);
  } else {
    await settleAfterRetryCeiling(ctx);
  }
}
