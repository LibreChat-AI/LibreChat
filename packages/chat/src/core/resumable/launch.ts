import { createPayload, removeNullishValues } from 'librechat-data-provider';
import type { TPayload, TSubmission } from 'librechat-data-provider';
import type { StartGenerationResult } from './start';
import type { ResumableHost } from './host';
import type { ResumableRun } from './run';
import {
  getRecoverySteerId,
  getRetryAfterDelay,
  waitForRetryDelay,
  isServerNotReadyError,
  isResumedStartResponse,
  isSettledStartResponse,
  toStartGenerationError,
  isRetryableNetworkError,
  isReplacedStartResponse,
  getStartGenerationStreamId,
  getStartGenerationCreatedAt,
  isUnnegotiatedV2StartControl,
  START_GENERATION_NETWORK_RETRIES,
  getStartGenerationConversationId,
  getPredecessorMismatchStartResponse,
  START_GENERATION_READINESS_TIMEOUT_MS,
} from './start';
import {
  GENERATION_PROTOCOL_VERSION,
  getGenerationProtocolVersion,
  supportsGenerationProtocolV2,
} from '../protocol';

/**
 * Starts a generation (the POST that returns the stream to attach to) through the host
 * transport, which owns auth refresh. Retries transient network failures and startup
 * readiness responses; readiness retries honor Retry-After until `signal` aborts or the
 * readiness window expires. Resolves to null when the start failed (its error card written)
 * or was abandoned.
 */
export async function startGeneration(
  run: ResumableRun,
  host: ResumableHost,
  currentSubmission: TSubmission,
  signal?: AbortSignal,
): Promise<StartGenerationResult | null> {
  const payloadData = createPayload(currentSubmission);
  let { payload } = payloadData;
  payload = removeNullishValues(payload) as TPayload;

  host.events.clearStepMaps();

  const url = payloadData.server;

  let lastError: unknown = null;
  let requestAttempts = 0;
  let networkAttempts = 0;
  let readinessAttempts = 0;
  const readinessDeadline = run.scheduler.now() + START_GENERATION_READINESS_TIMEOUT_MS;

  while (!signal?.aborted) {
    const recoverySteerId = getRecoverySteerId(currentSubmission);
    const conversationId = currentSubmission.conversation?.conversationId;
    if (
      recoverySteerId != null &&
      conversationId &&
      host.steers.isRecoveryHeld(conversationId, recoverySteerId)
    ) {
      host.steers.restoreQueued(currentSubmission);
      host.events.showStartFailure(currentSubmission, undefined, 'recovery_held');
      host.pane.setShowStopButton(false);
      host.pane.setIsSubmitting(false);
      host.pane.setSubmission(null);
      return null;
    }
    requestAttempts += 1;
    try {
      const data = await host.start({ server: url, payload }, { signal });
      if (signal?.aborted) {
        return null;
      }
      if (isSettledStartResponse(data)) {
        const conversationId = getStartGenerationConversationId(data);
        if (conversationId) {
          host.logger.log('ResumableSSE', 'Generation already settled:', { conversationId });
          return {
            status: 'settled',
            conversationId,
            generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
          };
        }
        lastError = { response: { data } };
        break;
      }
      if (isReplacedStartResponse(data)) {
        const streamId = getStartGenerationStreamId(data);
        const conversationId = getStartGenerationConversationId(data);
        const generationCreatedAt = getStartGenerationCreatedAt(data);
        if (streamId && conversationId && generationCreatedAt != null) {
          return {
            status: 'replaced',
            streamId,
            conversationId,
            generationCreatedAt,
            generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
          };
        }
        lastError = { response: { data } };
        break;
      }
      if (isUnnegotiatedV2StartControl(data)) {
        /** Never reinterpret a v2-only control word as a legacy stream
         * response merely because it also carries a stream id. */
        lastError = { response: { data } };
        break;
      }
      const streamId = getStartGenerationStreamId(data);
      if (streamId) {
        const resumed = isResumedStartResponse(data);
        const generationCreatedAt = getStartGenerationCreatedAt(data);
        const generationProtocolVersion = getGenerationProtocolVersion(data);
        host.logger.log('ResumableSSE', 'Generation started:', {
          streamId,
          resumed,
          generationCreatedAt,
          generationProtocolVersion,
        });
        return {
          status: 'stream',
          streamId,
          resumed,
          generationProtocolVersion,
          ...(generationCreatedAt != null && { generationCreatedAt }),
        };
      }

      lastError = { response: { data } };
      break;
    } catch (error) {
      if (signal?.aborted) {
        return null;
      }

      const predecessorMismatch = getPredecessorMismatchStartResponse(error);
      if (predecessorMismatch != null) {
        /** Admission was atomically rejected before this queued turn
         * created anything. Put the exact row back immediately and let
         * the caller reconcile or hand off to the generation that won. */
        host.steers.restoreQueued(currentSubmission);
        host.logger.log('ResumableSSE', 'Queued generation lost predecessor fence', {
          expectedPredecessorCreatedAt: currentSubmission.expectedPredecessorCreatedAt,
          ...predecessorMismatch,
        });
        return {
          status: 'predecessor_mismatch',
          ...predecessorMismatch,
          generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
        };
      }

      lastError = error;
      const isNetworkError = isRetryableNetworkError(error);
      const isServerNotReady = isServerNotReadyError(error);
      const remainingReadinessMs = readinessDeadline - run.scheduler.now();
      const shouldRetryNetwork =
        isNetworkError && networkAttempts < START_GENERATION_NETWORK_RETRIES - 1;
      const shouldRetryServerNotReady = isServerNotReady && remainingReadinessMs > 0;

      if (shouldRetryNetwork || shouldRetryServerNotReady) {
        networkAttempts += isNetworkError ? 1 : 0;
        readinessAttempts += isServerNotReady ? 1 : 0;
        const fallbackDelay = Math.min(1000 * Math.pow(2, requestAttempts - 1), 8000);
        const retryDelay = isServerNotReady
          ? Math.min(getRetryAfterDelay(error, fallbackDelay), remainingReadinessMs)
          : fallbackDelay;
        const reason = isServerNotReady ? 'Server not ready' : 'Network error';
        const attempt = isServerNotReady ? readinessAttempts : networkAttempts;
        const limit = isServerNotReady
          ? `${Math.ceil(START_GENERATION_READINESS_TIMEOUT_MS / 1000)}s readiness window`
          : `${START_GENERATION_NETWORK_RETRIES}`;
        host.logger.log(
          'ResumableSSE',
          `${reason} starting generation, retrying in ${retryDelay}ms (attempt ${attempt}/${limit})`,
        );
        const shouldContinue = await waitForRetryDelay(retryDelay, signal);
        if (!shouldContinue) {
          return null;
        }
        continue;
      }

      // Don't retry: either not a network error or max retries reached
      break;
    }
  }

  if (signal?.aborted) {
    return null;
  }

  host.logger.error('ResumableSSE', 'Error starting generation:', lastError);

  const startError = toStartGenerationError(lastError);
  const errorData = startError?.response?.data;
  const responseStatus = startError?.response?.status;
  if (responseStatus != null && responseStatus >= 400 && responseStatus < 500) {
    const recoverySteerId = getRecoverySteerId(currentSubmission);
    const conversationId = currentSubmission.conversation?.conversationId;
    const recoveryRejected =
      errorData != null &&
      typeof errorData === 'object' &&
      'code' in errorData &&
      (errorData.code === 'RECOVERY_PAYLOAD_MISMATCH' ||
        errorData.code === 'INVALID_RECOVERY_REQUEST');
    if (recoveryRejected && recoverySteerId != null && conversationId) {
      host.steers.blockRecovery(conversationId, recoverySteerId);
    }
    // The server rejected admission before exposing a generation. Restore
    // the exact queue row/position; ambiguous transport/5xx outcomes must
    // first reconcile durable state instead of risking a duplicate start.
    host.steers.restoreQueued(currentSubmission);
  } else {
    const recoverySteerId = getRecoverySteerId(currentSubmission);
    const recoveryConvoId = currentSubmission.conversation?.conversationId;
    if (recoverySteerId != null && recoveryConvoId) {
      try {
        const status = await host.fetchStatus(recoveryConvoId);
        if (signal?.aborted) {
          return null;
        }
        const releasedSource = status.unrecoveredSteers?.find(
          (steer) => steer.steerId === recoverySteerId,
        );
        if (
          status.active === false &&
          supportsGenerationProtocolV2(status) &&
          releasedSource != null
        ) {
          host.steers.convertToQueued(recoveryConvoId, [releasedSource], {
            generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
            allowPreviouslyConvertedIds: [recoverySteerId],
          });
        }
      } catch (error) {
        if (signal?.aborted) {
          return null;
        }
        host.logger.warn('ResumableSSE', 'Could not recover source after start failure', {
          conversationId: recoveryConvoId,
          error,
        });
      }
    }
  }
  if (signal?.aborted) {
    return null;
  }
  host.events.showStartFailure(currentSubmission, errorData);
  host.pane.setShowStopButton(false);
  host.pane.setIsSubmitting(false);
  host.pane.setSubmission(null);
  return null;
}
