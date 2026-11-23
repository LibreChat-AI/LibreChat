import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import {
  ContentTypes,
  isAgentsEndpoint,
  isEphemeralAgentId,
  getPromotedSteerRequestId,
} from 'librechat-data-provider';
import type {
  TPendingSteer,
  TPromotedSteer,
  TAgentQueuedTurnFileRef,
} from 'librechat-data-provider';
import type { AgentQueuedTurnMethods, AgentQueuedTurnRecord } from '@librechat/data-schemas';
import type { SteerQueueItem, SteerPromotionOutcome } from '~/stream/interfaces/IJobStore';
import type { SteeringLifecycle, SteerContentView } from '~/stream/SteeringLifecycle';
import type { AgentQueuedTurnLifecycle, PromotedSteerHandoff } from '../queuedTurns';
import { createQueuedTurnDeliveryReservation } from '../queuedTurns';
import { toPendingSteer } from '~/stream/SteeringLifecycle';
import { toQueuedTurnReceipt } from '../queuedTurnHttp';
import { getSafeErrorMetadata } from '~/utils';
import { toSteerFileRef } from './refs';

interface PromotionConversation {
  agent_id?: string;
  endpoint?: string;
  tenantId?: string;
}

export interface SteerPromotionDeps {
  methods: Pick<
    AgentQueuedTurnMethods,
    | 'enqueueAgentQueuedTurn'
    | 'getAgentQueuedTurnGenerationLineage'
    | 'confirmAgentQueuedTurnSourceHandoff'
  > & {
    getConvo: (userId: string, conversationId: string) => Promise<PromotionConversation | null>;
  };
  lifecycle: Pick<AgentQueuedTurnLifecycle, 'schedule' | 'cancel'>;
  steering: Pick<SteeringLifecycle, 'promoteLeftover' | 'getReceipt'>;
}

export interface SteerPromotionInput {
  /** The terminal claim whose CAS drained, parked and receipted these steers. */
  claim: {
    streamId: string;
    createdAt: number;
    status: 'complete' | 'error' | 'aborted';
    drainedSteers: readonly SteerQueueItem[];
  };
  conversationId: string;
  user: { id: string; tenantId?: string };
  /** The ended generation's persisted response, the queued turn's parent. */
  responseMessageId: string;
  /** That response's content: a steer it already applied is never promoted. */
  responseContent?: SteerContentView;
  /** Only a normally completed run promotes. The queued-turn resolver
   * dead-letters a successor of an aborted or truncated response for review,
   * which the tab-local path already models without a durable failure. */
  completed: boolean;
}

export interface SteerPromotionResult {
  /** Leftovers handed back for client-side conversion, exactly as before. */
  pendingSteers: TPendingSteer[];
  promotedSteers: TPromotedSteer[];
}

type PromotionTarget = {
  scope: { user: Types.ObjectId; tenantId?: string; conversationId: string };
  agentId: string;
  parentMessageId: string;
  /** Absent only when the lineage joined was opened by a root admission. */
  expectedPredecessorCreatedAt?: number;
};

function appliedSteerIds(content: SteerContentView): Set<string> {
  const ids = new Set<string>();
  for (const part of content) {
    if (part?.type !== ContentTypes.STEER) {
      continue;
    }
    if (part.steerId != null) {
      ids.add(part.steerId);
    }
    if (part.clientSteerId != null) {
      ids.add(part.clientSteerId);
    }
  }
  return ids;
}

function toFileRefs(files: SteerQueueItem['files']): TAgentQueuedTurnFileRef[] | undefined {
  const refs = (files ?? []).flatMap((file): TAgentQueuedTurnFileRef[] => {
    const ref = toSteerFileRef(file);
    return ref?.file_id == null ? [] : [{ ...ref, file_id: ref.file_id }];
  });
  return refs.length > 0 ? refs : undefined;
}

/** Resolves where promoted turns attach. A queued turn's lineage is its root
 * parent and root epoch, and a turn is only admitted behind the tail of its own
 * lineage. The ended generation may already belong to one: it was admitted
 * from the queue, or turns were queued directly against it. Promoted steers
 * join that lineage, so they run behind whatever is still queued in it instead
 * of opening a second lineage that the first one would strand. */
async function resolveTarget(
  input: SteerPromotionInput,
  deps: SteerPromotionDeps,
): Promise<PromotionTarget | null> {
  const { user, conversationId } = input;
  if (!Types.ObjectId.isValid(user.id)) {
    return null;
  }
  const scope = {
    user: new Types.ObjectId(user.id),
    ...(user.tenantId != null && { tenantId: user.tenantId }),
    conversationId,
  };
  const [conversation, lineage] = await Promise.all([
    deps.methods.getConvo(user.id, conversationId),
    deps.methods.getAgentQueuedTurnGenerationLineage({
      ...scope,
      generationCreatedAt: input.claim.createdAt,
    }),
  ]);
  const agentId = conversation?.agent_id;
  if (
    conversation == null ||
    (user.tenantId == null
      ? conversation.tenantId != null
      : conversation.tenantId !== user.tenantId) ||
    !isAgentsEndpoint(conversation.endpoint) ||
    typeof agentId !== 'string' ||
    isEphemeralAgentId(agentId)
  ) {
    return null;
  }
  if (lineage == null) {
    return {
      scope,
      agentId,
      parentMessageId: input.responseMessageId,
      expectedPredecessorCreatedAt: input.claim.createdAt,
    };
  }
  /** The lineage's own pair, exactly: a root lineage has no epoch, and giving
   * the promoted turn one would put it in a lineage of its own again. */
  return { scope, agentId, ...lineage };
}

/** Retires a row whose steer the job store did not hand over. Nothing was
 * scheduled yet. Returns whether the row is confirmed retired. */
async function retireUnownedTurn(
  turn: AgentQueuedTurnRecord,
  target: PromotionTarget,
  deps: SteerPromotionDeps,
): Promise<boolean> {
  try {
    const cancelled = await deps.lifecycle.cancel({
      user: target.scope.user,
      ...(target.scope.tenantId != null && { tenantId: target.scope.tenantId }),
      conversationId: turn.conversationId,
      queuedTurnId: turn.queuedTurnId,
      settledAt: new Date(),
    });
    return cancelled.outcome === 'cancelled' || cancelled.outcome === 'already_cancelled';
  } catch (error) {
    logger.error('[SteerPromotion] Failed to retire an unowned promoted turn', {
      conversationId: turn.conversationId,
      queuedTurnId: turn.queuedTurnId,
      ...getSafeErrorMetadata(error),
    });
    return false;
  }
}

/** Whether a settled promoted row held its steer's words when it settled: it
 * ran, it was proven their sole owner, or its admission is indeterminate and
 * may still settle as admitted. The client applies the same rule to receipts
 * (`ownedPromotedSteerIds`). */
function heldSteerWords(turn: AgentQueuedTurnRecord): boolean {
  if (turn.status === 'admitted') {
    return true;
  }
  return (
    turn.status === 'dead' &&
    (turn.steerSource?.handoffAt != null ||
      turn.terminalReceipt?.failure?.code === 'ADMISSION_INDETERMINATE')
  );
}

/** `promoted`: a durable row carries the steer from here on, and the client
 * adopts its receipt. `legacy`: no row does; hand the steer back as before. */
type PromotionAttempt = { kind: 'promoted'; promoted: TPromotedSteer } | { kind: 'legacy' };

async function promoteOne(
  item: SteerQueueItem & { clientSteerId: string },
  input: SteerPromotionInput,
  target: PromotionTarget,
  deps: SteerPromotionDeps,
): Promise<PromotionAttempt> {
  /** An owner that cannot take quotes stores the words without them, while the
   * sender's chip keeps the excerpts for its own conversion. Promoting would
   * then retire the only copy of the user's selected context. */
  if ((item.quotes?.length ?? 0) === 0) {
    const receipt = await deps.steering.getReceipt(input.claim.streamId, item.clientSteerId);
    if (receipt?.requestedQuotesFingerprint != null) {
      return { kind: 'legacy' };
    }
  }
  const files = toFileRefs(item.files);
  const enqueueInput = {
    ...target.scope,
    agentId: target.agentId,
    parentMessageId: target.parentMessageId,
    clientRequestId: getPromotedSteerRequestId(item.clientSteerId),
    text: item.text,
    ...(files != null && { files }),
    ...(item.quotes != null && item.quotes.length > 0 && { quotes: item.quotes }),
    ...(item.codeApprovalMode != null && { codeApprovalMode: item.codeApprovalMode }),
    priority: false,
    ...(target.expectedPredecessorCreatedAt != null && {
      expectedPredecessorCreatedAt: target.expectedPredecessorCreatedAt,
    }),
    steerSource: {
      steerId: item.steerId,
      clientSteerId: item.clientSteerId,
      generationCreatedAt: input.claim.createdAt,
    },
  };
  const { turn } = await deps.methods.enqueueAgentQueuedTurn({
    ...enqueueInput,
    /** Reserved before insertion under the promoted delivery version, so a
     * replica that predates the ownership check can neither publish this row
     * nor run it, even if this process dies before scheduling it. */
    deliveryReservation: createQueuedTurnDeliveryReservation(enqueueInput),
  });
  const promoted = (): PromotionAttempt => ({
    kind: 'promoted',
    promoted: {
      steerId: item.steerId,
      clientSteerId: item.clientSteerId,
      receipt: toQueuedTurnReceipt(turn),
    },
  });
  /** A replay finds the row an earlier promotion wrote. One that can no longer
   * be handed the words must not take the parked source with it. It stays the
   * steer's record only if it ever held the words; otherwise the steer goes
   * back to the client. */
  if (turn.status !== 'queued' && turn.status !== 'claimed') {
    return heldSteerWords(turn) ? promoted() : { kind: 'legacy' };
  }
  /** The row is the durable copy from here on; the parked copy goes second so
   * a crash in between can at worst leave both, never neither. */
  let outcome: SteerPromotionOutcome | 'unknown' = 'unknown';
  try {
    outcome = await deps.steering.promoteLeftover(
      input.claim.streamId,
      item.steerId,
      { userId: input.user.id, tenantId: input.user.tenantId },
      input.claim.createdAt,
      turn.queuedTurnId,
    );
  } catch (error) {
    logger.warn('[SteerPromotion] Job store hand-off is unconfirmed; left to admission', {
      conversationId: turn.conversationId,
      queuedTurnId: turn.queuedTurnId,
      ...getSafeErrorMetadata(error),
    });
  }
  if (
    outcome !== 'promoted' &&
    outcome !== 'unknown' &&
    (await retireUnownedTurn(turn, target, deps))
  ) {
    return { kind: 'legacy' };
  }
  /** From here the row stays, so it is the client's handle on the steer. It
   * either owns the words (recorded on the row, which outlives the job store's
   * receipt), or its ownership is unsettled: the hand-off may have committed
   * and lost its reply, or it was refused and the row could not be retired. An
   * unsettled row never runs on trust. Its admission repeats the hand-off and
   * then runs it, cancels it, or holds it for review. Handing the steer back
   * as well would let the client queue words a row may already own. */
  if (outcome === 'promoted') {
    await deps.methods
      .confirmAgentQueuedTurnSourceHandoff({ ...target.scope, queuedTurnId: turn.queuedTurnId })
      .catch((error: unknown) => {
        logger.warn('[SteerPromotion] Promoted turn ownership left to admission', {
          conversationId: turn.conversationId,
          queuedTurnId: turn.queuedTurnId,
          ...getSafeErrorMetadata(error),
        });
      });
  }
  try {
    await deps.lifecycle.schedule(turn);
  } catch (error) {
    /** Record-first outbox: the recovery loop publishes a pending row. */
    logger.warn('[SteerPromotion] Promoted turn scheduling deferred to recovery', {
      conversationId: turn.conversationId,
      queuedTurnId: turn.queuedTurnId,
      ...getSafeErrorMetadata(error),
    });
  }
  return promoted();
}

function isPromotable(
  item: SteerQueueItem,
  userId: string,
): item is SteerQueueItem & { clientSteerId: string } {
  return item.promoteLeftover === true && item.clientSteerId != null && item.userId === userId;
}

/**
 * Turns the steers a completed run accepted but never applied into durable
 * server-owned queued turns, so they survive reloads and closed tabs instead
 * of living only in the browser queue. Promotion is opt-in per steer (the
 * sending client declares it adopts the receipt) and stops at the first steer
 * it cannot promote, so FIFO order between promoted turns and the leftovers
 * still handed back to the client is preserved. Never throws: a failure
 * before a durable row exists leaves the remaining steers on the legacy
 * `pendingSteers` path.
 */
export async function promoteDrainedSteers(
  input: SteerPromotionInput,
  deps: SteerPromotionDeps,
): Promise<SteerPromotionResult> {
  const drained = input.claim.drainedSteers;
  const legacy = (): SteerPromotionResult => ({
    pendingSteers: drained.map(toPendingSteer),
    promotedSteers: [],
  });
  if (
    !input.completed ||
    input.claim.status !== 'complete' ||
    !drained.some((item) => isPromotable(item, input.user.id))
  ) {
    return legacy();
  }
  const applied = appliedSteerIds(input.responseContent ?? []);
  const pendingSteers: TPendingSteer[] = [];
  const promotedSteers: TPromotedSteer[] = [];
  let target: PromotionTarget | null | undefined;
  const settled = new Set<string>();
  let halted = false;
  try {
    for (const item of drained) {
      const alreadyApplied =
        applied.has(item.steerId) ||
        (item.clientSteerId != null && applied.has(item.clientSteerId));
      const candidate = isPromotable(item, input.user.id) ? item : null;
      halted ||= !alreadyApplied && candidate == null;
      if (halted || alreadyApplied || candidate == null) {
        settled.add(item.steerId);
        pendingSteers.push(toPendingSteer(item));
        continue;
      }
      target ??= await resolveTarget(input, deps);
      const attempt: PromotionAttempt =
        target == null ? { kind: 'legacy' } : await promoteOne(candidate, input, target, deps);
      settled.add(item.steerId);
      if (attempt.kind === 'promoted') {
        promotedSteers.push(attempt.promoted);
        continue;
      }
      halted = true;
      pendingSteers.push(toPendingSteer(item));
    }
  } catch (error) {
    logger.warn('[SteerPromotion] Leaving unapplied steers on the client path', {
      conversationId: input.conversationId,
      ...getSafeErrorMetadata(error),
    });
    return {
      pendingSteers: [
        ...pendingSteers,
        ...drained.filter((item) => !settled.has(item.steerId)).map(toPendingSteer),
      ],
      promotedSteers,
    };
  }
  return { pendingSteers, promotedSteers };
}

/** The job-store side of a promoted turn's admission-time hand-off. */
export function completePromotedSteerHandoff(
  steering: Pick<SteeringLifecycle, 'promoteLeftover'>,
  input: PromotedSteerHandoff,
): Promise<SteerPromotionOutcome> {
  return steering.promoteLeftover(
    input.conversationId,
    input.steerId,
    { userId: input.userId, tenantId: input.tenantId },
    input.generationCreatedAt,
    input.queuedTurnId,
  );
}
