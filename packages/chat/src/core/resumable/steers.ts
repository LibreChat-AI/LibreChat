import type {
  TMessage,
  TSubmission,
  TPendingSteer,
  TPromotedSteer,
  ChatFinalFrame,
} from 'librechat-data-provider';
import type { ResumableSteers, StreamStatusResponse } from './host';
import type { GenerationProtocolVersion } from '../protocol';
import type { StartGenerationError } from './start';
import { supportsGenerationProtocolV2, getGenerationProtocolVersion } from '../protocol';
import { dedupeSteersById } from '../steer/steer';
import { getRecoverySteerId } from './start';

/** The steer bookkeeping a run's ordinary final frame reaches. */
export type FinalSteers = Pick<
  ResumableSteers,
  'appliedIds' | 'settleApplied' | 'adoptPromoted' | 'convertToQueued' | 'convertLocalToQueued'
>;

/**
 * Settles the reader's steers against the final frame of the run they were sent to, before the
 * run's end is published and lets the next queued turn go: main chat's stream session and a core
 * `Chat`'s event applier both end a run through here, so a steer is left the same way by both.
 */
export function settleFinalSteers(
  steers: FinalSteers,
  conversationId: string,
  data: ChatFinalFrame,
  generationProtocolVersion?: GenerationProtocolVersion,
): void {
  // A steer-applied event may still be waiting for its next-frame
  // message target when FINAL arrives. Reconcile directly from the
  // authoritative final message before converting leftovers so a
  // late 202 ACK cannot resurrect (or queue) an already-applied steer.
  const finalAppliedSteerIds = new Set(
    steers.appliedIds(data.responseMessage ? [data.responseMessage] : []),
  );
  steers.settleApplied(conversationId, data.responseMessage ? [data.responseMessage] : undefined);
  // Leftovers the server already made durable queued turns are adopted as
  // server-owned rows first, so neither conversion below can re-queue them.
  const promotedSteerIds = new Set(
    steers.adoptPromoted(
      conversationId,
      Array.isArray(data.promotedSteers) ? data.promotedSteers : [],
    ),
  );
  const settledSteerIds = new Set([...finalAppliedSteerIds, ...promotedSteerIds]);
  // Steers the run never injected ride the final event; convert them
  // to queued follow-ups before the run-end signal fires the drain
  // (also resets the applied-id set for the finished run).
  // `claimParked` reconciles the replayable parked copy of the same
  // steers; explicit dismissal or a persisted recovery removes it.
  steers.convertToQueued(
    conversationId,
    (generationProtocolVersion === 1 || supportsGenerationProtocolV2(data)) &&
      Array.isArray(data.pendingSteers)
      ? (data.pendingSteers as TPendingSteer[]).filter(
          (steer) =>
            !settledSteerIds.has(steer.steerId) &&
            (steer.clientSteerId == null || !settledSteerIds.has(steer.clientSteerId)),
        )
      : [],
    {
      claimParked: true,
      generationProtocolVersion,
    },
  );
  // A `failed` chip never reached the server, so it never rides
  // `data.pendingSteers` above; without this it survives a NORMAL
  // completion and renders (with a live Retry) under the NEXT run's
  // reply. Idempotent alongside the call above: both dedupe by id.
  steers.convertLocalToQueued(conversationId);
}

/**
 * Settles the reader's steers for a run that ended with no payload to settle them against: a
 * control frame that only says the run is over, or a stream that was gone. The stored rows and
 * the run's last status are then the authority. A steer they hold as applied is settled, one
 * the server made a queued turn is adopted, one it parked is restored as a queued follow-up,
 * and only then are the chips still left swept into the queue, so a steer the run took is not
 * sent again as a new turn. Without the stored rows nothing is swept: their absence proves
 * nothing about what the run took.
 */
export function settleStoredSteers(
  steers: FinalSteers,
  conversationId: string,
  {
    messages,
    status,
    promoted,
    recoverySteerId,
    generationProtocolVersion,
    sweep = true,
  }: {
    /** The conversation's stored rows, when they could be read. */
    messages: TMessage[] | undefined;
    /**
     * Whether the chips still left may be swept into the queue. Not when nothing has proved
     * the run over to a client of its protocol: a chip still waiting may yet be taken.
     */
    sweep?: boolean;
    status?: Pick<StreamStatusResponse, 'resumeState' | 'aggregatedContent' | 'unrecoveredSteers'>;
    promoted?: TPromotedSteer[];
    /** The parked steer the ended turn was itself a recovery of. */
    recoverySteerId?: string | null;
    generationProtocolVersion?: GenerationProtocolVersion;
  },
): void {
  const authoritativeValues = [
    ...(messages ?? []),
    ...(status?.resumeState?.aggregatedContent ?? status?.aggregatedContent ?? []),
  ];
  const reconciledIds = new Set(steers.appliedIds(authoritativeValues));
  steers.settleApplied(conversationId, authoritativeValues);
  for (const id of steers.adoptPromoted(conversationId, Array.isArray(promoted) ? promoted : [])) {
    reconciledIds.add(id);
  }
  const unrecovered = status?.unrecoveredSteers ?? [];
  if (unrecovered.length > 0) {
    steers.convertToQueued(conversationId, unrecovered, {
      ...(recoverySteerId != null && {
        allowPreviouslyConvertedIds: [recoverySteerId],
      }),
    });
    for (const steer of unrecovered) {
      reconciledIds.add(steer.steerId);
      if (steer.clientSteerId) {
        reconciledIds.add(steer.clientSteerId);
      }
    }
  }
  if (messages && sweep) {
    steers.convertLocalToQueued(conversationId, {
      excludeSteerIds: reconciledIds,
      generationProtocolVersion,
    });
  }
}

/**
 * What a start the server refused leaves of the queued turn it was for. The server rejected
 * admission before exposing a generation, so the exact queue row goes back in its position; a
 * recovery it rejected as such is first barred from being restored again. Only for a response
 * that is a refusal (4xx): a transport failure or a 5xx may have started the turn, and putting
 * the row back then risks sending it twice.
 */
export function restoreRefusedStart(
  steers: Pick<ResumableSteers, 'blockRecovery' | 'restoreQueued'>,
  submission: TSubmission,
  error: StartGenerationError | undefined,
): boolean {
  const responseStatus = error?.response?.status;
  if (responseStatus == null || responseStatus < 400 || responseStatus >= 500) {
    return false;
  }
  const errorData = error?.response?.data;
  const recoverySteerId = getRecoverySteerId(submission);
  const conversationId = submission.conversation?.conversationId;
  const recoveryRejected =
    errorData != null &&
    typeof errorData === 'object' &&
    'code' in errorData &&
    (errorData.code === 'RECOVERY_PAYLOAD_MISMATCH' ||
      errorData.code === 'INVALID_RECOVERY_REQUEST');
  if (recoveryRejected && recoverySteerId != null && conversationId) {
    steers.blockRecovery(conversationId, recoverySteerId);
  }
  steers.restoreQueued(submission);
  return true;
}

/**
 * A turn that replays a parked steer ended without the server keeping it. If the server has
 * let go of that steer again (it is back among the ones it parked, and nothing is running),
 * the steer returns to the queue as the reader's to send. Read from a status taken after the
 * end was observed: one taken earlier could name a parked copy the turn went on to commit, and
 * would then authorize sending it twice.
 */
export function restoreReleasedSource(
  steers: Pick<ResumableSteers, 'convertToQueued'>,
  conversationId: string,
  recoverySteerId: string,
  status: Pick<StreamStatusResponse, 'active' | 'unrecoveredSteers' | 'generationProtocolVersion'>,
  generationProtocolVersion: GenerationProtocolVersion,
): boolean {
  const releasedSource = status.unrecoveredSteers?.find(
    (steer) => steer.steerId === recoverySteerId,
  );
  if (status.active !== false || !supportsGenerationProtocolV2(status) || releasedSource == null) {
    return false;
  }
  steers.convertToQueued(conversationId, [releasedSource], {
    generationProtocolVersion,
    allowPreviouslyConvertedIds: [recoverySteerId],
  });
  return true;
}

/**
 * Settles the reader's steers for a conversation found with nothing running: the run they were
 * sent to ended while no one was following it.
 *
 * A terminal drain may have parked acknowledged steers no subscriber received (tab closed, or
 * a reload racing the final event); they are restored as queued follow-ups. A pause that
 * expired can report the run inactive before the sweeper parks its steers, which then still
 * ride `resumeState.pendingSteers`, so both lists are converted, deduplicated by id. They are
 * converted under the protocol the status itself speaks: no stream is open to have named one,
 * and a parked steer restored without it would never consume its source.
 *
 * The run is terminal, so any chip still shown as waiting is stale: its steer either applied
 * (an inline part in the stored reply) or rode the lists above.
 */
export function settleFinishedSteers(
  steers: Pick<ResumableSteers, 'convertToQueued' | 'settleApplied' | 'seed'>,
  conversationId: string,
  status: Pick<
    StreamStatusResponse,
    'resumeState' | 'unrecoveredSteers' | 'generationProtocolVersion'
  >,
  messages: TMessage[] | undefined,
): void {
  const leftoverSteers = dedupeSteersById(
    status.unrecoveredSteers,
    status.resumeState?.pendingSteers,
  );
  if (conversationId && leftoverSteers.length > 0) {
    steers.convertToQueued(conversationId, leftoverSteers, {
      generationProtocolVersion: getGenerationProtocolVersion(status),
    });
  }
  steers.settleApplied(conversationId, messages);
  steers.seed(conversationId, []);
}
