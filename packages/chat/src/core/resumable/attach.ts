import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ResumableHost, SubscriptionTarget } from './host';
import type { StreamContext } from './terminal';
import type { ResumableRun } from './run';
import { handleOpen, handleClose, handleFrame } from './frames';
import { ResumableSubscription } from './subscription';
import { handleTransportFailure } from './failure';
import { ResponsePatcher } from './patches';

/**
 * Attaches the pane to a generation: installs its epoch on the controls, binds the response
 * the stream writes to, and opens the connection with every frame, failure and close routed
 * through core. A target whose pane lifecycle ended or whose submission the pane no longer
 * serves attaches nothing.
 */
export function attachResumableStream(
  run: ResumableRun,
  host: ResumableHost,
  target: SubscriptionTarget,
): void {
  /** See `ResumableSubscription.isCurrent` for the fences every callback below checks. */
  if (target.signal?.aborted || run.submission !== target.submission) {
    return;
  }
  const sub = new ResumableSubscription(run, host, target);
  const { streamId, isResume, generationCreatedAt, generationProtocolVersion } = sub;
  run.subscribedEpoch = generationCreatedAt ?? null;
  if (generationCreatedAt != null) {
    host.pane.setGenerationEpoch(
      streamId,
      generationCreatedAt,
      undefined,
      generationProtocolVersion,
    );
    /** Until CREATED moves the conversation context off `/c/new`, Stop and
     *  approval controls still read the placeholder key. Mirror the exact
     *  epoch there briefly; the server's user-wide fallback plus this fence
     *  can safely resolve the just-started job. */
    if (sub.startedAsNewConversation) {
      host.pane.setGenerationEpoch(
        Constants.NEW_CONVO,
        generationCreatedAt,
        undefined,
        generationProtocolVersion,
      );
    }
    host.pane.setShowStopButton(true);
  } else {
    /** Generation-scoped mutations are unsafe until the server supplies
     *  the epoch they must fence against. Keep Stop hidden if an old or
     *  malformed response omitted it. */
    host.pane.setShowStopButton(false);
  }
  /**
   * A NEW generation starts with its retained prefix intact, so the
   * cleared-prefix state from a previous one must not carry over: the
   * run outlives any single submission, and a later edited resubmission
   * would otherwise dispatch with no offset and overwrite the content it
   * kept.
   *
   * Keyed on `clientRequestId`, the per-submission uuid. Each of the
   * narrower keys tried before it crossed a real boundary:
   *   - `isResume`: a submission whose POST succeeded but lost its
   *     response retries and returns `resumed: true`, so a NEW generation
   *     arrives in resume mode and skipped the reset.
   *   - the stream id: `request.js` sets `streamId = conversationId`, so
   *     every generation in a conversation shares it.
   *   - the response message id: editing an assistant response reuses
   *     that same id (`editedMessageId`), so re-editing one response
   *     produced the same key twice.
   * `clientRequestId` is minted per submission and forwarded unchanged on
   * retries, which is exactly "new per edit attempt, stable across
   * reconnects".
   */
  const generationId =
    sub.submission.clientRequestId ??
    (sub.submission.initialResponse as TMessage | undefined)?.messageId ??
    streamId;
  run.bindPrefixState(generationId);
  host.usage.bindResponse(sub.submission);
  const patcher = new ResponsePatcher(sub, host);
  const ctx: StreamContext = {
    sub,
    host,
    patcher,
    applyPendingAction: (action) => patcher.applyPendingAction(action),
  };

  host.logger.log('ResumableSSE', 'Subscribing to stream:', sub.url(), { isResume });
  sub.claim();
  sub.watchForeground();

  sub.connect(host.stream, {
    onOpen: () => handleOpen(ctx),
    onFrame: (event) => void handleFrame(ctx, event),
    onFailure: (event) => void handleTransportFailure(ctx, event),
    onClose: () => handleClose(ctx),
  });

  host.exposeDebugControls?.({
    /** Simulate network drop - triggers error event → reconnection */
    killNetwork: () => {
      host.logger.log('Debug', 'Simulating network drop...');
      void handleTransportFailure(ctx, {});
    },
    /** Simulate clean close (navigation away) - triggers abort event → no reconnection */
    closeClean: () => {
      host.logger.log('Debug', 'Simulating clean close (navigation away)...');
      sub.retired = true;
      sub.close();
    },
  });
}
