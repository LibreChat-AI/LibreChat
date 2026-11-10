import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { ContentTypes, isAgentsEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type {
  TPendingSteer,
  TPromotedSteer,
  TAgentQueuedTurnFileRef,
} from 'librechat-data-provider';
import type { AgentQueuedTurnMethods, AgentQueuedTurnRecord } from '@librechat/data-schemas';
import type { SteerQueueItem, SteerPromotionOutcome } from '~/stream/interfaces/IJobStore';
import type { SteeringLifecycle, SteerContentView } from '~/stream/SteeringLifecycle';
import type { AgentQueuedTurnLifecycle, PromotedSteerHandoff } from '../queuedTurns';
import { getPromotedSteerRequestId, toSteerFileRef } from './refs';
import { toPendingSteer } from '~/stream/SteeringLifecycle';
import { toQueuedTurnReceipt } from '../queuedTurnHttp';

interface PromotionConversation {
  agent_id?: string;
  endpoint?: string;
  tenantId?: string;
}

export interface SteerPromotionDeps {
  methods: Pick<AgentQueuedTurnMethods, 'enqueueAgentQueuedTurn' | 'listActiveAgentQueuedTurns'> & {
    getConvo: (userId: string, conversationId: string) => Promise<PromotionConversation | null>;
  };
  lifecycle: Pick<AgentQueuedTurnLifecycle, 'schedule' | 'cancel'>;
  steering: Pick<SteeringLifecycle, 'promoteLeftover'>;
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

/** Resolves where promoted turns attach. A queued turn's lineage is keyed by
 * its root parent and predecessor epoch, so a turn already queued against this
 * same generation keeps its parent and the promoted steers chain behind it
 * instead of opening a second lineage that would race it for the epoch. */
async function resolveTarget(
  input: SteerPromotionInput,
  deps: SteerPromotionDeps,
): Promise<PromotionTarget | null> {
  const { user, conversationId } = input;
  if (!Types.ObjectId.isValid(user.id)) {
    return null;
  }
  const conversation = await deps.methods.getConvo(user.id, conversationId);
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
  const scope = {
    user: new Types.ObjectId(user.id),
    ...(user.tenantId != null && { tenantId: user.tenantId }),
    conversationId,
  };
  const active = await deps.methods.listActiveAgentQueuedTurns(scope);
  const sameEpoch = active.find(
    (turn) => turn.expectedPredecessorCreatedAt === input.claim.createdAt,
  );
  return {
    scope,
    agentId,
    parentMessageId: sameEpoch?.parentMessageId ?? input.responseMessageId,
  };
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
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** `legacy`: no durable row owns the steer, hand it back as before.
 * `withheld`: a row exists that could not be retired; its admission repeats
 * the hand-off and settles it, so the client must not queue the words too. */
type PromotionAttempt =
  | { kind: 'promoted'; promoted: TPromotedSteer }
  | { kind: 'legacy' | 'withheld' };

async function promoteOne(
  item: SteerQueueItem & { clientSteerId: string },
  input: SteerPromotionInput,
  target: PromotionTarget,
  deps: SteerPromotionDeps,
): Promise<PromotionAttempt> {
  const files = toFileRefs(item.files);
  const { turn } = await deps.methods.enqueueAgentQueuedTurn({
    ...target.scope,
    agentId: target.agentId,
    parentMessageId: target.parentMessageId,
    clientRequestId: getPromotedSteerRequestId(item.steerId),
    text: item.text,
    ...(files != null && { files }),
    ...(item.quotes != null && item.quotes.length > 0 && { quotes: item.quotes }),
    priority: false,
    expectedPredecessorCreatedAt: input.claim.createdAt,
  });
  /** The row is the durable copy from here on; the parked copy goes second so
   * a crash in between can at worst leave both, never neither. The row's own
   * admission repeats this hand-off, which settles that window. */
  let outcome: SteerPromotionOutcome | null = null;
  try {
    outcome = await deps.steering.promoteLeftover(
      input.claim.streamId,
      item.steerId,
      { userId: input.user.id, tenantId: input.user.tenantId },
      input.claim.createdAt,
      turn.queuedTurnId,
    );
  } catch (error) {
    logger.warn('[SteerPromotion] Job store hand-off failed', {
      conversationId: turn.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (outcome !== 'promoted') {
    return { kind: (await retireUnownedTurn(turn, target, deps)) ? 'legacy' : 'withheld' };
  }
  try {
    await deps.lifecycle.schedule(turn);
  } catch (error) {
    /** Record-first outbox: the recovery loop publishes a pending row. */
    logger.warn('[SteerPromotion] Promoted turn scheduling deferred to recovery', {
      conversationId: turn.conversationId,
      queuedTurnId: turn.queuedTurnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    kind: 'promoted',
    promoted: {
      steerId: item.steerId,
      clientSteerId: item.clientSteerId,
      receipt: toQueuedTurnReceipt(turn),
    },
  };
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
      if (attempt.kind === 'legacy') {
        pendingSteers.push(toPendingSteer(item));
      }
    }
  } catch (error) {
    logger.warn('[SteerPromotion] Leaving unapplied steers on the client path', {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
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
