import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import {
  createEventActorExecutor,
  type EventActorEvent,
  type EventActorExecutionResult,
  type EventActorHead,
  type EventActorHostAdapter,
  type EventActorInterrupt,
  type EventActorSuspension,
  type EventActorCancelSuspensionResult,
} from '@librechat/agents';
import type {
  AgentTriggerDeliveryMethods,
  ConversationMethods,
  IAgentEventActorState,
  IAgentEventActorSkillIdentity,
  IAgentEventActorSuspensionEvidence,
} from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { AgentEventCheckpointMessageOverlay } from '../checkpointer';
import type { AgentContextFingerprint } from '../compatibility';
import type { AgentTriggerExpectedAction } from './envelope';
import type { AgentEventAppliedAction } from './types';
import { getAgentCheckpointer, getApprovalTtlMs } from '../checkpointer';
import { createOwnedActorCheckpoints } from '../checkpoints/actor';
import { agentContextFingerprintsMatch } from '../compatibility';

interface EventActorResult extends Record<string, EventActorEvent> {
  action: AgentEventAppliedAction & EventActorEvent;
  checkpointCaptureError: string | null;
}

export interface AgentEventActorInvocationContext {
  checkpointNamespace: string;
  checkpointId?: string;
  invocationId: string;
  continuation: 'warm' | 'cold';
  signal: AbortSignal;
}

export interface ExecuteAgentEventActorInput<T> {
  user: string;
  tenantId?: string;
  conversationId: string;
  /** Authenticated binding that owns the delivery receipt. */
  bindingId?: string;
  invocationId: string;
  event: EventActorEvent;
  expectedAction?: AgentTriggerExpectedAction;
  signal: AbortSignal;
  checkpointer?: TCheckpointerConfig;
  contextFingerprint?: AgentContextFingerprint;
  resolveContext?(state: IAgentEventActorState): Promise<AgentEventActorContext | undefined>;
  readResultContext?(): Promise<AgentEventActorContext | undefined>;
  /** Deprecated compatibility input. Elapsed time never proves replay safety. */
  legacyTurnStaleMs?: number;
  invoke(context: AgentEventActorInvocationContext): Promise<T>;
  readAppliedAction(): AgentEventAppliedAction | undefined;
  readSuspension?():
    | {
        kind?: 'human_decision' | 'internal_completion';
        actionId: string;
        jobCreatedAt: number;
        interrupt: EventActorInterrupt;
      }
    | undefined;
}

export interface AgentEventActorContext {
  fingerprint: AgentContextFingerprint;
  skillManifest: IAgentEventActorSkillIdentity[];
  discoveredToolNames?: string[];
  summary?: IAgentEventActorState['summary'];
  contextMeta?: IAgentEventActorState['contextMeta'];
  compactionSemanticIndex?: IAgentEventActorState['compactionSemanticIndex'];
  checkpointMessageOverlay?: AgentEventCheckpointMessageOverlay;
}

export interface ExecuteAgentEventActorResult<T> {
  value: T;
  execution: EventActorExecutionResult<EventActorResult>;
}

export interface AgentEventActorDependencies {
  getSnapshot: ConversationMethods['getAgentEventActorSnapshot'];
  commitState: ConversationMethods['commitAgentEventActorState'];
  storeSuspension?: ConversationMethods['storeAgentEventActorSuspension'];
  claimSuspension?: ConversationMethods['claimAgentEventActorSuspension'];
  settleSuspension?: ConversationMethods['settleAgentEventActorSuspension'];
  cancelSuspension?: ConversationMethods['cancelAgentEventActorSuspension'];
  recordReconciliation: ConversationMethods['recordAgentEventActorReconciliation'];
  resolveReconciliation: ConversationMethods['resolveAgentEventActorReconciliation'];
  admitAction?: AgentTriggerDeliveryMethods['admitAgentEventActorAction'];
  releaseAction?: AgentTriggerDeliveryMethods['releaseAgentEventActorAction'];
  hasActionAdmission?: AgentTriggerDeliveryMethods['hasAgentEventActorActionAdmission'];
  getReceipt?: AgentTriggerDeliveryMethods['getAgentEventActorReceipt'];
  clearReconciliation?: ConversationMethods['clearAgentEventActorReconciliation'];
}

export interface ResumeAgentEventActorInput<T> {
  user: string;
  tenantId?: string;
  conversationId: string;
  bindingId?: string;
  suspension: EventActorSuspension;
  resumeAttemptId: string;
  resumeValue: EventActorEvent;
  signal: AbortSignal;
  checkpointer?: TCheckpointerConfig;
  expectedAction?: AgentTriggerExpectedAction;
  /** Projects the claimed Conversation fence into the exact job/action CAS. */
  claimProjection?(): Promise<boolean>;
  resume(context: AgentEventActorInvocationContext): Promise<T>;
  readAppliedAction(): AgentEventAppliedAction | undefined;
  readSuspension?():
    | {
        kind?: 'human_decision' | 'internal_completion';
        actionId: string;
        jobCreatedAt: number;
        interrupt: EventActorInterrupt;
      }
    | undefined;
  readResultContext?(): Promise<AgentEventActorContext | undefined>;
}

export interface CancelAgentEventActorInput {
  user: string;
  tenantId?: string;
  conversationId: string;
  suspension: EventActorSuspension;
  cancelAttemptId: string;
  reason: 'cancelled' | 'expired';
  signal?: AbortSignal;
  checkpointer?: TCheckpointerConfig;
  /** Exact orphaned resume claim whose job never entered provider execution. */
  claimedResumeAttemptId?: string;
}

function bindInterruptToExpectedAction(
  interrupt: EventActorInterrupt,
  expectedAction: AgentTriggerExpectedAction | undefined,
): EventActorInterrupt {
  if (
    expectedAction == null ||
    interrupt.payload == null ||
    typeof interrupt.payload !== 'object' ||
    Array.isArray(interrupt.payload)
  ) {
    return interrupt;
  }
  return {
    ...interrupt,
    payload: {
      ...interrupt.payload,
      _librechatEventActor: { expectedAction: expectedAction as unknown as EventActorEvent },
    },
  };
}

function getEventActorSigningKey(): Buffer {
  const credentialsKey = process.env.CREDS_KEY;
  if (typeof credentialsKey !== 'string' || credentialsKey.length === 0) {
    throw new Error('CREDS_KEY is required for durable event actor execution');
  }
  return createHash('sha256')
    .update('librechat:event-actor:suspension:v1')
    .update('\0')
    .update(credentialsKey)
    .digest();
}

function toHead(actorThreadId: string, state: IAgentEventActorState | null): EventActorHead {
  return state == null
    ? { actorThreadId, generation: 0 }
    : { actorThreadId, generation: state.generation, checkpoint: state.checkpoint };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The host action receipt contains strings only, so this copy is also a
 * valid SDK event value without weakening the application-facing type. */
function toEventActorAppliedAction(
  action: AgentEventAppliedAction,
): AgentEventAppliedAction & EventActorEvent {
  return {
    toolName: action.toolName,
    ...(action.toolCallId == null ? {} : { toolCallId: action.toolCallId }),
  };
}

function checkpointMatches(
  state: IAgentEventActorState,
  checkpoint: { threadId: string; checkpointId?: string; checkpointNs: string },
): boolean {
  return (
    typeof checkpoint.checkpointId === 'string' &&
    state.checkpoint.threadId === checkpoint.threadId &&
    state.checkpoint.checkpointId === checkpoint.checkpointId &&
    state.checkpoint.checkpointNs === checkpoint.checkpointNs
  );
}

export function createAgentEventActorActionAdmissionId(
  invocationId: string,
  checkpoint: { threadId: string; checkpointId?: string; checkpointNs: string },
): string {
  return createHash('sha256')
    .update(invocationId)
    .update('\0')
    .update(checkpoint.threadId)
    .update('\0')
    .update(checkpoint.checkpointNs)
    .update('\0')
    .update(checkpoint.checkpointId ?? '')
    .digest('hex');
}

/**
 * Executes one authenticated bound-child event through the SDK's checkpoint-fork lifecycle.
 * The request controller still owns generation admission and terminal receipts; this adapter owns
 * only checkpoint preparation, invocation isolation, CAS commit, and bounded cleanup.
 */
export async function executeAgentEventActor<T>(
  input: ExecuteAgentEventActorInput<T>,
  deps: AgentEventActorDependencies,
): Promise<ExecuteAgentEventActorResult<T>> {
  const checkpoints = createOwnedActorCheckpoints(input.user, input.tenantId);
  let value: T | undefined;
  let invocationError: unknown;
  let ownedActionAdmissionId: string | undefined;
  let observedState: IAgentEventActorState | null | undefined;
  let observedEpoch: number | undefined;
  let preparedContext: AgentEventActorContext | undefined;
  let resultContext: AgentEventActorContext | undefined;
  let pendingSuspension:
    | {
        kind?: 'human_decision' | 'internal_completion';
        appliedAction?: AgentEventAppliedAction;
        handlingGenerationCreatedAt?: number;
        actionId: string;
        jobCreatedAt: number;
        interrupt: EventActorInterrupt;
      }
    | undefined;
  let actionAppliedBeforePause = false;
  const adapter: EventActorHostAdapter<EventActorEvent, EventActorResult> = {
    async prepare(request, context) {
      if (context.signal.aborted) {
        throw context.signal.reason;
      }
      const [snapshot] = await Promise.all([
        deps.getSnapshot({
          user: input.user,
          conversationId: input.conversationId,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        }),
        checkpoints.drain(input.conversationId, input.checkpointer),
      ]);
      if (snapshot === undefined) {
        throw new Error('Event actor binding is no longer active');
      }
      if (
        snapshot.suspension?.status === 'closed' &&
        snapshot.suspension.suspension.invocation.invocationId === input.invocationId
      ) {
        throw new Error('Event actor invocation already has terminal suspension proof');
      }
      if (input.bindingId != null && deps.getReceipt != null) {
        const receipt = await deps.getReceipt({
          deliveryKey: input.invocationId,
          user: input.user,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
          bindingId: input.bindingId,
          conversationId: input.conversationId,
        });
        if (receipt != null) {
          const marker = snapshot.reconciliations.find(
            (item) => item.invocationId === input.invocationId,
          );
          if (marker != null && deps.clearReconciliation != null) {
            const cleared = await deps.clearReconciliation({
              user: input.user,
              conversationId: input.conversationId,
              ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
              invocationId: input.invocationId,
              checkpoint: receipt.checkpoint,
              resolution: receipt.resolution,
            });
            if (!cleared) {
              throw new Error('Event actor terminal marker could not be recovered');
            }
          }
          throw new Error('Event actor invocation already has a terminal receipt');
        }
      }
      if (
        snapshot.reconciliations.some(
          (item) => item.invocationId === input.invocationId && item.status === 'settled',
        )
      ) {
        /** Mixed-version proof must be migrated by the terminal handler before
         * the same delivery identity can execute again. Delivery admission
         * alone cannot distinguish that proof from a pre-invoke orphan. */
        throw new Error('Event actor invocation has legacy terminal proof awaiting migration');
      }
      let recoveredInvocationId: string | undefined;
      const pendingInvocation = snapshot.reconciliations.find(
        (item) => item.invocationId === input.invocationId && item.status === 'invocation_pending',
      );
      if (pendingInvocation != null && input.bindingId != null && deps.hasActionAdmission != null) {
        const pendingAdmissionId = createAgentEventActorActionAdmissionId(
          input.invocationId,
          pendingInvocation.checkpoint,
        );
        const actionAdmitted = await deps.hasActionAdmission({
          deliveryKey: input.invocationId,
          user: input.user,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
          bindingId: input.bindingId,
          conversationId: input.conversationId,
          admissionId: pendingAdmissionId,
        });
        if (pendingInvocation.actionAdmitted !== true || !actionAdmitted) {
          /** Abandoning the conversation marker fences a paused pre-admission
           * owner: it must confirm this exact marker after winning delivery
           * admission and therefore cannot invoke after takeover. */
          const abandoned = await deps.resolveReconciliation({
            user: input.user,
            conversationId: input.conversationId,
            ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
            invocationId: input.invocationId,
            checkpoint: pendingInvocation.checkpoint,
            expectedActionAdmitted: pendingInvocation.actionAdmitted === true,
            resolution: 'invocation_abandoned',
          });
          if (!abandoned) {
            throw new Error('Event actor orphaned no-action lifecycle could not be recovered');
          }
          if (actionAdmitted) {
            const released = await deps.releaseAction?.({
              deliveryKey: input.invocationId,
              user: input.user,
              ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
              bindingId: input.bindingId,
              conversationId: input.conversationId,
              admissionId: pendingAdmissionId,
            });
            if (!released) {
              throw new Error('Event actor orphaned action admission could not be released');
            }
          }
          recoveredInvocationId = input.invocationId;
        }
      }
      const unresolved = snapshot.reconciliations.filter(
        (item) => item.status !== 'settled' && item.invocationId !== recoveredInvocationId,
      );
      if (unresolved.length > 0) {
        throw new Error(
          `Event actor is blocked on ${unresolved.map((item) => item.status).join(', ')} reconciliation`,
        );
      }
      /** A legacy turn is or may have been mid-flight: its external action and
       * durable-history outcome are unknown, so no amount of elapsed time can
       * prove that replay is safe. Keep the fence closed until a terminal owner
       * proves persistence and seals its exact token, or an operator performs
       * an explicit reconciliation. */
      const legacyTurn = snapshot.legacyTurn;
      if (legacyTurn != null) {
        throw new Error('Event actor is blocked on an in-flight legacy turn');
      }
      const state = snapshot.state;
      observedState = state;
      observedEpoch = snapshot.epoch;
      const head = toHead(input.conversationId, state);
      if (state == null || state.requiresColdStart === true) {
        return { status: 'checkpoint_unavailable', head };
      }
      const validatesContext = input.resolveContext != null || input.contextFingerprint != null;
      if (validatesContext) {
        preparedContext = input.resolveContext
          ? await input.resolveContext(state)
          : { fingerprint: input.contextFingerprint!, skillManifest: [], discoveredToolNames: [] };
        if (
          preparedContext == null ||
          !agentContextFingerprintsMatch(state.contextFingerprint, preparedContext.fingerprint)
        ) {
          return { status: 'checkpoint_unavailable', head };
        }
      }
      const fork = await checkpoints.fork(
        state.checkpoint,
        request.checkpointNs,
        request.invocationId,
        input.checkpointer,
        preparedContext?.checkpointMessageOverlay,
      );
      if (fork == null) {
        return { status: 'checkpoint_unavailable', head };
      }
      return {
        status: 'ready',
        invocation: {
          ...request,
          continuation: 'warm',
          base: head,
          fork: { ...fork, invocationId: request.invocationId },
        },
      };
    },
    async coldContinue(request, head, context) {
      if (context.signal.aborted) {
        throw context.signal.reason;
      }
      if (!(await getAgentCheckpointer(input.checkpointer))) {
        throw new Error('Event actor checkpoint forks require a durable Mongo checkpointer');
      }
      return {
        ...request,
        continuation: 'cold',
        base: head,
        fork: {
          threadId: input.conversationId,
          checkpointNs: request.checkpointNs,
          ...(head.checkpoint == null ? {} : { checkpointId: head.checkpoint.checkpointId }),
          invocationId: request.invocationId,
        },
      };
    },
    async invoke(invocation, context) {
      const fenced = await deps.recordReconciliation({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        reconciliation: {
          invocationId: invocation.invocationId,
          status: 'invocation_pending',
          checkpoint: {
            threadId: invocation.fork.threadId,
            checkpointNs: invocation.fork.checkpointNs,
            ...(invocation.fork.checkpointId == null
              ? {}
              : { checkpointId: invocation.fork.checkpointId }),
          },
          action: { toolName: input.expectedAction?.toolName ?? 'expected_action' },
          observedAt: new Date(),
        },
      });
      if (!fenced) {
        throw new Error('Event actor invocation could not acquire its durable lifecycle fence');
      }
      /** The delivery row is the serialization point between action admission
       * and terminal settlement. A plain receipt read cannot close the final
       * read-before-invoke race across two Mongo documents. */
      if (input.bindingId != null && deps.admitAction != null) {
        const admissionId = createAgentEventActorActionAdmissionId(
          input.invocationId,
          invocation.fork,
        );
        const admitted = await deps.admitAction({
          deliveryKey: input.invocationId,
          user: input.user,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
          bindingId: input.bindingId,
          conversationId: input.conversationId,
          admittedAt: new Date(),
          admissionId,
        });
        if (!admitted) {
          const abandoned = await deps.resolveReconciliation({
            user: input.user,
            conversationId: input.conversationId,
            ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
            invocationId: invocation.invocationId,
            checkpoint: {
              threadId: invocation.fork.threadId,
              checkpointNs: invocation.fork.checkpointNs,
              ...(invocation.fork.checkpointId == null
                ? {}
                : { checkpointId: invocation.fork.checkpointId }),
            },
            expectedActionAdmitted: false,
            resolution: 'invocation_abandoned',
          });
          if (!abandoned) {
            throw new Error('Event actor duplicate lifecycle fence could not be abandoned');
          }
          throw new Error('Event actor action admission was already consumed or settled');
        }
        const confirmed = await deps.recordReconciliation({
          user: input.user,
          conversationId: input.conversationId,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
          reconciliation: {
            invocationId: invocation.invocationId,
            actionAdmitted: true,
            status: 'invocation_pending',
            checkpoint: {
              threadId: invocation.fork.threadId,
              checkpointNs: invocation.fork.checkpointNs,
              ...(invocation.fork.checkpointId == null
                ? {}
                : { checkpointId: invocation.fork.checkpointId }),
            },
            action: { toolName: input.expectedAction?.toolName ?? 'expected_action' },
            observedAt: new Date(),
          },
        });
        if (!confirmed) {
          const released = await deps.releaseAction?.({
            deliveryKey: input.invocationId,
            user: input.user,
            ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
            bindingId: input.bindingId,
            conversationId: input.conversationId,
            admissionId,
          });
          if (!released) {
            throw new Error(
              'Event actor lost admission lifecycle and could not release its action',
            );
          }
          throw new Error('Event actor action admission lifecycle was superseded before invoke');
        }
        ownedActionAdmissionId = admissionId;
      }
      try {
        value = await input.invoke({
          checkpointNamespace: invocation.fork.checkpointNs,
          ...(invocation.fork.checkpointId == null
            ? {}
            : { checkpointId: invocation.fork.checkpointId }),
          invocationId: invocation.invocationId,
          continuation: invocation.continuation,
          signal: context.signal,
        });
      } catch (error) {
        invocationError = error;
      }
      /** A graph can execute the expected action and then pause again in the
       * same segment. The pause is nonterminal authority: committing its
       * checkpoint as an applied terminal head would strand the staged HITL
       * action. Preserve the suspension first; the expected-action evidence
       * remains in the checkpoint and is classified after the pause resumes. */
      pendingSuspension = input.readSuspension?.();
      if (pendingSuspension != null) {
        actionAppliedBeforePause = input.readAppliedAction() != null;
        const checkpoint = await checkpoints.capture(
          input.conversationId,
          invocation.fork.checkpointNs,
          invocation.invocationId,
          input.checkpointer,
        );
        if (checkpoint?.checkpointId == null) {
          throw new Error('Paused event actor has no observable interrupt checkpoint');
        }
        return {
          status: 'suspended',
          checkpoint: { ...checkpoint, invocationId: invocation.invocationId },
          interrupt: bindInterruptToExpectedAction(
            pendingSuspension.interrupt,
            input.expectedAction,
          ),
        };
      }
      const observedAction = input.readAppliedAction();
      const action = observedAction == null ? undefined : toEventActorAppliedAction(observedAction);
      if (action == null) {
        if (invocationError != null) {
          throw invocationError;
        }
        return { status: 'completed_no_action' };
      }
      try {
        resultContext = input.readResultContext ? await input.readResultContext() : preparedContext;
      } catch (error) {
        return {
          status: 'applied',
          result: {
            action,
            checkpointCaptureError: `Applied turn context could not be captured: ${asError(error).message}`,
          },
          checkpoint: invocation.fork,
        };
      }
      let checkpoint: Awaited<ReturnType<typeof checkpoints.capture>>;
      try {
        checkpoint = await checkpoints.capture(
          input.conversationId,
          invocation.fork.checkpointNs,
          invocation.invocationId,
          input.checkpointer,
        );
      } catch (error) {
        return {
          status: 'applied',
          result: { action, checkpointCaptureError: asError(error).message },
          checkpoint: invocation.fork,
        };
      }
      if (checkpoint == null) {
        return {
          status: 'applied',
          result: {
            action,
            checkpointCaptureError: 'Applied turn has no observable terminal checkpoint',
          },
          checkpoint: invocation.fork,
        };
      }
      return {
        status: 'applied',
        result: { action, checkpointCaptureError: null },
        checkpoint: { ...checkpoint, invocationId: invocation.invocationId },
      };
    },
    async suspend(request) {
      if (pendingSuspension == null || deps.storeSuspension == null) {
        throw new Error('Event actor suspension storage is unavailable');
      }
      return deps.storeSuspension({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        suspension: request.suspension as IAgentEventActorSuspensionEvidence,
        ...(pendingSuspension.kind == null ? {} : { kind: pendingSuspension.kind }),
        ...(pendingSuspension.handlingGenerationCreatedAt == null
          ? {}
          : { handlingGenerationCreatedAt: pendingSuspension.handlingGenerationCreatedAt }),
        actionId: pendingSuspension.actionId,
        jobCreatedAt: pendingSuspension.jobCreatedAt,
        ...(actionAppliedBeforePause ? { invalidateHead: true } : {}),
        ...(request.previous == null ? {} : { previous: request.previous }),
      });
    },
    async commit(request) {
      if (request.result.checkpointCaptureError != null) {
        throw new Error(request.result.checkpointCaptureError);
      }
      const expectedCheckpointId = request.expectedHead.checkpoint?.checkpointId;
      if (
        request.expectedHead.checkpoint != null &&
        (typeof expectedCheckpointId !== 'string' || expectedCheckpointId.length === 0)
      ) {
        throw new Error('Event actor head is missing its checkpoint id');
      }
      const appliedCheckpointId = request.checkpoint.checkpointId;
      if (typeof appliedCheckpointId !== 'string' || appliedCheckpointId.length === 0) {
        throw new Error('Applied event actor checkpoint is missing its id');
      }
      if (observedState === undefined || observedEpoch === undefined) {
        throw new Error('Event actor commit is missing its prepared host state');
      }
      const expectedHeadCheckpoint = request.expectedHead.checkpoint;
      if (observedState != null && expectedHeadCheckpoint == null) {
        throw new Error('Event actor commit lost its prepared checkpoint head');
      }
      /** The SDK head intentionally contains only portable checkpoint identity.
       * Retain the host-private cold-start observation from prepare so the CAS
       * cannot clear a legacy-path invalidation that races before acquisition. */
      const expected =
        observedState == null
          ? undefined
          : {
              generation: request.expectedHead.generation,
              ...(observedState.previousCheckpoint == null
                ? {}
                : { previousCheckpoint: observedState.previousCheckpoint }),
              checkpoint: {
                threadId: expectedHeadCheckpoint!.threadId,
                checkpointId: expectedCheckpointId!,
                checkpointNs: expectedHeadCheckpoint!.checkpointNs,
              },
              ...(observedState.requiresColdStart === true ? { requiresColdStart: true } : {}),
              ...(observedState.contextFingerprint == null
                ? {}
                : { contextFingerprint: observedState.contextFingerprint }),
              ...(observedState.skillManifest == null
                ? {}
                : { skillManifest: observedState.skillManifest }),
              ...(observedState.discoveredToolNames == null
                ? {}
                : { discoveredToolNames: observedState.discoveredToolNames }),
              ...(observedState.summary == null ? {} : { summary: observedState.summary }),
              ...(observedState.contextMeta == null
                ? {}
                : { contextMeta: observedState.contextMeta }),
              ...(observedState.compactionSemanticIndex == null
                ? {}
                : { compactionSemanticIndex: observedState.compactionSemanticIndex }),
            };
      const committed = await deps.commitState({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        invocationId: request.invocation.invocationId,
        action: request.result.action,
        ...(expected == null ? {} : { expected }),
        /** Legacy-path invalidations against headless or already cold-marked
         * actors are visible ONLY through the epoch; the CAS must require the
         * exact epoch observed at preparation. */
        expectedEpoch: observedEpoch,
        checkpoint: {
          threadId: request.checkpoint.threadId,
          checkpointId: appliedCheckpointId,
          checkpointNs: request.checkpoint.checkpointNs,
        },
        ...(resultContext == null
          ? {}
          : {
              contextFingerprint: resultContext.fingerprint,
              skillManifest: resultContext.skillManifest,
              discoveredToolNames: resultContext.discoveredToolNames ?? [],
              ...(resultContext.summary == null ? {} : { summary: resultContext.summary }),
              ...(resultContext.contextMeta == null
                ? {}
                : { contextMeta: resultContext.contextMeta }),
              ...(resultContext.compactionSemanticIndex == null
                ? {}
                : { compactionSemanticIndex: resultContext.compactionSemanticIndex }),
            }),
      });
      if (committed.status === 'stale') {
        /** A host-private cold marker can invalidate the CAS without advancing
         * the portable SDK head. Omit that non-advanced head so the SDK reports
         * an ordinary conflict instead of misclassifying it as indeterminate. */
        const advanced =
          committed.state != null && committed.state.generation > request.expectedHead.generation;
        return {
          status: 'stale',
          ...(advanced ? { head: toHead(input.conversationId, committed.state!) } : {}),
        };
      }
      if (committed.prunableCheckpoint != null) {
        await checkpoints.remove(committed.prunableCheckpoint, input.checkpointer);
        await checkpoints.acknowledgePruning(committed.prunableCheckpoint);
      }
      return { status: 'committed', head: toHead(input.conversationId, committed.state) };
    },
    async discard(request) {
      /** Release the delivery-owned action admission before deleting either
       * the fork or its conversation-side lifecycle evidence. A crash after
       * this release is retryable; the inverse order can orphan admission
       * forever with no durable marker left to recover it from. */
      if (ownedActionAdmissionId != null && input.bindingId != null && deps.releaseAction != null) {
        const releasedAction = await deps.releaseAction({
          deliveryKey: input.invocationId,
          user: input.user,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
          bindingId: input.bindingId,
          conversationId: input.conversationId,
          admissionId: ownedActionAdmissionId,
        });
        if (!releasedAction) {
          const receipt = await deps.getReceipt?.({
            deliveryKey: input.invocationId,
            user: input.user,
            ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
            bindingId: input.bindingId,
            conversationId: input.conversationId,
          });
          if (receipt == null) {
            throw new Error('Event actor action admission could not be released');
          }
        }
        ownedActionAdmissionId = undefined;
      }
      await checkpoints.removeOwned(request.invocation.fork, input.checkpointer);
      const released = await deps.resolveReconciliation({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        invocationId: request.invocation.invocationId,
        checkpoint: {
          threadId: request.invocation.fork.threadId,
          checkpointNs: request.invocation.fork.checkpointNs,
          ...(request.invocation.fork.checkpointId == null
            ? {}
            : { checkpointId: request.invocation.fork.checkpointId }),
        },
        ...(input.bindingId != null && deps.admitAction != null
          ? { expectedActionAdmitted: true }
          : {}),
        resolution: 'invocation_abandoned',
      });
      if (!released) {
        const snapshot = await deps.getSnapshot({
          user: input.user,
          conversationId: input.conversationId,
          ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        });
        if (
          snapshot?.reconciliations.some(
            (item) => item.invocationId === request.invocation.invocationId,
          ) === true
        ) {
          throw new Error('Event actor invocation lifecycle fence could not be released');
        }
      }
    },
  };

  const executor = createEventActorExecutor(adapter, {
    maxDepth: 1,
    dormantCheckpointTtlMs: getApprovalTtlMs(input.checkpointer),
    preparationSigningKey: getEventActorSigningKey(),
  });
  let execution: EventActorExecutionResult<EventActorResult> = await executor.execute({
    actorThreadId: input.conversationId,
    invocationId: input.invocationId,
    event: input.event,
    depth: 1,
    signal: input.signal,
  });
  if (execution.status === 'failed') {
    throw execution.error;
  }
  if (execution.status === 'cancelled') {
    throw asError(input.signal.reason ?? 'Event actor invocation cancelled');
  }
  if (
    execution.status === 'commit_indeterminate' &&
    typeof execution.checkpoint.checkpointId === 'string'
  ) {
    let snapshot: Awaited<ReturnType<AgentEventActorDependencies['getSnapshot']>>;
    try {
      snapshot = await deps.getSnapshot({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
      });
    } catch (error) {
      logger.warn('[event-actor] Could not verify an indeterminate checkpoint commit', {
        conversationId: input.conversationId,
        invocationId: input.invocationId,
        error: asError(error).message,
      });
    }
    if (
      snapshot?.reconciliations.some(
        (item) => item.invocationId === input.invocationId && item.status === 'persistence_pending',
      ) === true &&
      snapshot?.state != null &&
      checkpointMatches(snapshot.state, execution.checkpoint) &&
      execution.result != null
    ) {
      execution = {
        status: 'applied',
        result: execution.result,
        head: toHead(input.conversationId, snapshot.state),
        continuation: execution.continuation,
      };
    }
  }
  if (execution.status === 'commit_conflict' || execution.status === 'commit_indeterminate') {
    const action = execution.result?.action ?? input.readAppliedAction();
    if (action == null) {
      throw new Error(`Event actor ${execution.status} did not retain applied-action evidence`);
    }
    const error =
      execution.status === 'commit_indeterminate'
        ? execution.error.message
        : 'A competing checkpoint advanced the actor head';
    const recorded = await deps.recordReconciliation({
      user: input.user,
      conversationId: input.conversationId,
      ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
      reconciliation: {
        invocationId: input.invocationId,
        ...(input.bindingId != null && deps.admitAction != null ? { actionAdmitted: true } : {}),
        status: execution.status,
        checkpoint: {
          threadId: execution.checkpoint.threadId,
          checkpointNs: execution.checkpoint.checkpointNs,
          ...(execution.checkpoint.checkpointId == null
            ? {}
            : { checkpointId: execution.checkpoint.checkpointId }),
        },
        action,
        error: error.slice(0, 1024),
        observedAt: new Date(),
      },
    });
    if (!recorded) {
      throw new Error(`Failed to persist event actor ${execution.status} reconciliation`);
    }
    logger.error('[event-actor] Applied action blocked the actor pending reconciliation', {
      conversationId: input.conversationId,
      invocationId: input.invocationId,
      status: execution.status,
      error,
    });
    throw new Error(`Event actor action requires ${execution.status} reconciliation`);
  }
  if (invocationError != null) {
    throw invocationError;
  }
  return { value: value as T, execution };
}

/** Resumes one signed suspended fork on any replica using the Conversation as authority. */
export async function resumeAgentEventActor<T>(
  input: ResumeAgentEventActorInput<T>,
  deps: AgentEventActorDependencies,
): Promise<ExecuteAgentEventActorResult<T>> {
  const checkpoints = createOwnedActorCheckpoints(input.user, input.tenantId);
  let checkpointStorageNamespace: string | null = null;
  let value: T | undefined;
  let invocationError: unknown;
  let observedState: IAgentEventActorState | null | undefined;
  let observedEpoch: number | undefined;
  let resultContext: AgentEventActorContext | undefined;
  let pendingSuspension:
    | {
        kind?: 'human_decision' | 'internal_completion';
        appliedAction?: AgentEventAppliedAction;
        handlingGenerationCreatedAt?: number;
        actionId: string;
        jobCreatedAt: number;
        interrupt: EventActorInterrupt;
      }
    | undefined;
  let actionAppliedBeforePause = false;

  const owner = {
    user: input.user,
    conversationId: input.conversationId,
    ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
  };
  const adapter: EventActorHostAdapter<EventActorEvent, EventActorResult> = {
    async prepare() {
      throw new Error('A suspended event actor cannot prepare a fresh invocation');
    },
    async coldContinue() {
      throw new Error('A suspended event actor cannot cold-start during resume');
    },
    async invoke() {
      throw new Error('A suspended event actor must enter through resume');
    },
    async resume(request, context) {
      if (deps.claimSuspension == null) {
        throw new Error('Event actor suspension claim storage is unavailable');
      }
      const [snapshot] = await Promise.all([
        deps.getSnapshot(owner),
        checkpoints.drain(input.conversationId, input.checkpointer),
      ]);
      const hostSuspension = snapshot?.suspension;
      if (
        snapshot == null ||
        hostSuspension == null ||
        hostSuspension.status !== 'pending' ||
        hostSuspension.suspension.suspensionId !== request.suspension.suspensionId ||
        hostSuspension.suspension.attempt !== request.suspension.attempt ||
        hostSuspension.suspension.suspensionDigest !== request.suspension.suspensionDigest
      ) {
        return { status: 'stale' };
      }
      observedState = snapshot.state;
      observedEpoch = snapshot.epoch;
      const base = request.suspension.invocation.base;
      if (
        (observedState == null && base.generation !== 0) ||
        (observedState != null &&
          (observedState.generation !== base.generation ||
            observedState.checkpoint.threadId !== base.checkpoint?.threadId ||
            observedState.checkpoint.checkpointId !== base.checkpoint?.checkpointId ||
            observedState.checkpoint.checkpointNs !== base.checkpoint?.checkpointNs))
      ) {
        return { status: 'stale' };
      }
      const claimed = await deps.claimSuspension({
        ...owner,
        suspensionId: request.suspension.suspensionId,
        attempt: request.suspension.attempt,
        actionId: hostSuspension.actionId,
        jobCreatedAt: hostSuspension.jobCreatedAt,
        resumeAttemptId: request.resumeAttemptId,
      });
      if (claimed.status !== 'claimed') {
        return { status: 'stale' };
      }
      if (input.claimProjection != null && !(await input.claimProjection())) {
        throw new Error('Event actor suspension claim could not be projected to its job');
      }
      try {
        checkpointStorageNamespace =
          (await checkpoints.resolveNamespace(request.suspension.checkpoint, input.checkpointer)) ??
          null;
        if (checkpointStorageNamespace == null) {
          throw new Error('Signed event actor checkpoint is no longer available');
        }
        value = await input.resume({
          checkpointNamespace: checkpointStorageNamespace,
          ...(request.suspension.checkpoint.checkpointId == null
            ? {}
            : { checkpointId: request.suspension.checkpoint.checkpointId }),
          invocationId: request.suspension.invocation.invocationId,
          continuation: request.suspension.invocation.continuation,
          signal: context.signal,
        });
      } catch (error) {
        invocationError = error;
      }
      /** A resumed segment may both satisfy the delivery and reach its next
       * human boundary. Publish the successor suspension before considering
       * the segment terminal; otherwise the successor checkpoint is committed
       * without any resumable host action. */
      const observedAction = input.readAppliedAction() ?? hostSuspension.appliedAction;
      const action = observedAction == null ? undefined : toEventActorAppliedAction(observedAction);
      const observedSuspension = input.readSuspension?.();
      if (observedSuspension != null) {
        pendingSuspension = {
          ...observedSuspension,
          ...(observedAction == null ? {} : { appliedAction: observedAction }),
          handlingGenerationCreatedAt:
            hostSuspension.handlingGenerationCreatedAt ?? hostSuspension.jobCreatedAt,
        };
        actionAppliedBeforePause = observedAction != null;
        const checkpoint = await checkpoints.capture(
          input.conversationId,
          request.suspension.checkpoint.checkpointNs,
          request.suspension.invocation.invocationId,
          input.checkpointer,
          checkpointStorageNamespace,
          request.suspension.checkpoint.checkpointId,
        );
        if (checkpoint?.checkpointId == null) {
          throw new Error('Re-paused event actor has no observable interrupt checkpoint');
        }
        return {
          status: 'claimed',
          result: {
            status: 'suspended',
            checkpoint: {
              ...checkpoint,
              invocationId: request.suspension.invocation.invocationId,
            },
            interrupt: bindInterruptToExpectedAction(
              pendingSuspension.interrupt,
              input.expectedAction,
            ),
          },
        };
      }
      if (action == null) {
        if (invocationError != null) {
          return { status: 'claimed_failed', error: asError(invocationError) };
        }
        return { status: 'claimed', result: { status: 'completed_no_action' } };
      }
      try {
        resultContext = input.readResultContext ? await input.readResultContext() : undefined;
      } catch (error) {
        return {
          status: 'claimed',
          result: {
            status: 'applied',
            result: {
              action,
              checkpointCaptureError: `Applied resumed context could not be captured: ${asError(error).message}`,
            },
            checkpoint: request.suspension.checkpoint,
          },
        };
      }
      let checkpoint: Awaited<ReturnType<typeof checkpoints.capture>>;
      try {
        checkpoint = await checkpoints.capture(
          input.conversationId,
          request.suspension.checkpoint.checkpointNs,
          request.suspension.invocation.invocationId,
          input.checkpointer,
          checkpointStorageNamespace,
          request.suspension.checkpoint.checkpointId,
        );
      } catch (error) {
        return {
          status: 'claimed',
          result: {
            status: 'applied',
            result: { action, checkpointCaptureError: asError(error).message },
            checkpoint: request.suspension.checkpoint,
          },
        };
      }
      if (checkpoint?.checkpointId == null) {
        return {
          status: 'claimed',
          result: {
            status: 'applied',
            result: {
              action,
              checkpointCaptureError: 'Applied resumed turn has no observable terminal checkpoint',
            },
            checkpoint: request.suspension.checkpoint,
          },
        };
      }
      return {
        status: 'claimed',
        result: {
          status: 'applied',
          result: { action, checkpointCaptureError: null },
          checkpoint: {
            ...checkpoint,
            invocationId: request.suspension.invocation.invocationId,
          },
        },
      };
    },
    async suspend(request) {
      if (pendingSuspension == null || deps.storeSuspension == null) {
        throw new Error('Event actor re-pause storage is unavailable');
      }
      return deps.storeSuspension({
        ...owner,
        suspension: request.suspension as IAgentEventActorSuspensionEvidence,
        ...(pendingSuspension.kind == null ? {} : { kind: pendingSuspension.kind }),
        ...(pendingSuspension.appliedAction == null
          ? {}
          : { appliedAction: pendingSuspension.appliedAction }),
        ...(pendingSuspension.handlingGenerationCreatedAt == null
          ? {}
          : { handlingGenerationCreatedAt: pendingSuspension.handlingGenerationCreatedAt }),
        actionId: pendingSuspension.actionId,
        jobCreatedAt: pendingSuspension.jobCreatedAt,
        ...(actionAppliedBeforePause ? { invalidateHead: true } : {}),
        ...(request.previous == null ? {} : { previous: request.previous }),
      });
    },
    async settleSuspension(request) {
      if (deps.settleSuspension == null) {
        throw new Error('Event actor suspension settlement storage is unavailable');
      }
      const settled = await deps.settleSuspension({
        ...owner,
        ...request,
        invocationId: input.suspension.invocation.invocationId,
        checkpoint: input.suspension.invocation.fork,
      });
      if (settled.status !== 'settled') {
        return settled;
      }
      await checkpoints.remove(input.suspension.checkpoint, input.checkpointer);
      return settled;
    },
    async commit(request) {
      if (request.result.checkpointCaptureError != null) {
        throw new Error(request.result.checkpointCaptureError);
      }
      if (observedState === undefined || observedEpoch === undefined) {
        throw new Error('Resumed event actor commit is missing its claimed host state');
      }
      const checkpointId = request.checkpoint.checkpointId;
      if (checkpointId == null) {
        throw new Error('Applied resumed event actor checkpoint is missing its id');
      }
      const expected =
        observedState == null
          ? undefined
          : {
              generation: observedState.generation,
              ...(observedState.previousCheckpoint == null
                ? {}
                : { previousCheckpoint: observedState.previousCheckpoint }),
              checkpoint: observedState.checkpoint,
              ...(observedState.contextFingerprint == null
                ? {}
                : { contextFingerprint: observedState.contextFingerprint }),
              ...(observedState.skillManifest == null
                ? {}
                : { skillManifest: observedState.skillManifest }),
              ...(observedState.discoveredToolNames == null
                ? {}
                : { discoveredToolNames: observedState.discoveredToolNames }),
              ...(observedState.summary == null ? {} : { summary: observedState.summary }),
              ...(observedState.contextMeta == null
                ? {}
                : { contextMeta: observedState.contextMeta }),
              ...(observedState.compactionSemanticIndex == null
                ? {}
                : { compactionSemanticIndex: observedState.compactionSemanticIndex }),
              ...(observedState.requiresColdStart === true ? { requiresColdStart: true } : {}),
            };
      const committed = await deps.commitState({
        ...owner,
        invocationId: request.invocation.invocationId,
        action: request.result.action,
        ...(expected == null ? {} : { expected }),
        expectedEpoch: observedEpoch,
        checkpoint: {
          threadId: request.checkpoint.threadId,
          checkpointId,
          checkpointNs: request.checkpoint.checkpointNs,
        },
        settlementAuthority: request.settlementAuthority!,
        ...(resultContext == null
          ? {}
          : {
              contextFingerprint: resultContext.fingerprint,
              skillManifest: resultContext.skillManifest,
              discoveredToolNames: resultContext.discoveredToolNames ?? [],
              ...(resultContext.summary == null ? {} : { summary: resultContext.summary }),
              ...(resultContext.contextMeta == null
                ? {}
                : { contextMeta: resultContext.contextMeta }),
              ...(resultContext.compactionSemanticIndex == null
                ? {}
                : { compactionSemanticIndex: resultContext.compactionSemanticIndex }),
            }),
      });
      if (committed.status === 'stale') {
        return {
          status: 'stale',
          ...(committed.state == null
            ? {}
            : { head: toHead(input.conversationId, committed.state) }),
        };
      }
      if (committed.prunableCheckpoint != null) {
        await checkpoints.remove(committed.prunableCheckpoint, input.checkpointer);
        await checkpoints.acknowledgePruning(committed.prunableCheckpoint);
      }
      return { status: 'committed', head: toHead(input.conversationId, committed.state) };
    },
    async discard() {
      throw new Error('Resumed event actor cleanup must use suspension settlement');
    },
  };

  const executor = createEventActorExecutor(adapter, {
    maxDepth: 1,
    dormantCheckpointTtlMs: getApprovalTtlMs(input.checkpointer),
    preparationSigningKey: getEventActorSigningKey(),
  });
  const resumed = await executor.resume({
    suspension: input.suspension,
    resumeAttemptId: input.resumeAttemptId,
    value: input.resumeValue,
    signal: input.signal,
  });
  const continuation = input.suspension.invocation.continuation;
  if (resumed.status === 'suspended') {
    return { value: value as T, execution: { ...resumed, continuation } };
  }
  if (resumed.status === 'completed_no_action') {
    if (invocationError != null) {
      throw invocationError;
    }
    return { value: value as T, execution: { ...resumed, continuation } };
  }
  if (resumed.status === 'commit_indeterminate') {
    throw new Error('Event actor resumed action requires commit_indeterminate reconciliation');
  }
  const settlement = await executor.commit(resumed);
  if (settlement.status === 'commit_indeterminate') {
    const recorded = await deps.recordReconciliation({
      ...owner,
      reconciliation: {
        invocationId: input.suspension.invocation.invocationId,
        ...(input.bindingId == null ? {} : { actionAdmitted: true }),
        status: 'commit_indeterminate',
        checkpoint: resumed.checkpoint,
        action: resumed.result.action,
        error: settlement.error.message.slice(0, 1024),
        observedAt: new Date(),
      },
    });
    if (!recorded) {
      throw new Error('Resumed event actor indeterminate commit could not be reconciled');
    }
    throw new Error('Event actor resumed action requires commit_indeterminate reconciliation');
  }
  if (settlement.status === 'stale') {
    const recorded = await deps.recordReconciliation({
      ...owner,
      reconciliation: {
        invocationId: input.suspension.invocation.invocationId,
        ...(input.bindingId == null ? {} : { actionAdmitted: true }),
        status: 'commit_conflict',
        checkpoint: resumed.checkpoint,
        action: resumed.result.action,
        error: 'A competing checkpoint advanced the actor head',
        observedAt: new Date(),
      },
    });
    if (!recorded) {
      throw new Error('Resumed event actor checkpoint conflict could not be reconciled');
    }
    throw new Error('Event actor resumed action requires commit_conflict reconciliation');
  }
  if (invocationError != null) {
    throw invocationError;
  }
  return {
    value: value as T,
    execution: {
      status: 'applied',
      result: resumed.result,
      head: settlement.head,
      continuation,
    },
  };
}

/** Cancels one exact current suspension through the SDK evidence validator.
 * The Conversation CAS is the logical winner; checkpoint deletion follows
 * idempotently so an ambiguous cleanup can safely retry the same proof. */
export async function cancelAgentEventActor(
  input: CancelAgentEventActorInput,
  deps: Pick<AgentEventActorDependencies, 'cancelSuspension'>,
): Promise<EventActorCancelSuspensionResult> {
  const checkpoints = createOwnedActorCheckpoints(input.user, input.tenantId);
  if (deps.cancelSuspension == null) {
    throw new Error('Event actor suspension cancellation storage is unavailable');
  }
  const adapter: EventActorHostAdapter<EventActorEvent, EventActorResult> = {
    async prepare() {
      throw new Error('A suspended event actor cannot prepare during cancellation');
    },
    async coldContinue() {
      throw new Error('A suspended event actor cannot cold-start during cancellation');
    },
    async invoke() {
      throw new Error('A suspended event actor cannot invoke during cancellation');
    },
    async cancelSuspension(request) {
      const cancelled = await deps.cancelSuspension!({
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
        suspensionId: request.suspension.suspensionId,
        attempt: request.suspension.attempt,
        invocationId: request.suspension.invocation.invocationId,
        checkpoint: request.suspension.invocation.fork,
        ...(input.claimedResumeAttemptId == null
          ? {}
          : { claimedResumeAttemptId: input.claimedResumeAttemptId }),
      });
      if (cancelled.status !== 'cancelled') {
        return cancelled;
      }
      await checkpoints.remove(request.suspension.checkpoint, input.checkpointer);
      return cancelled;
    },
    async commit() {
      throw new Error('A cancelled event actor cannot commit');
    },
    async discard() {
      throw new Error('A cancelled event actor cleanup must use suspension cancellation');
    },
  };
  const executor = createEventActorExecutor(adapter, {
    maxDepth: 1,
    dormantCheckpointTtlMs: getApprovalTtlMs(input.checkpointer),
    preparationSigningKey: getEventActorSigningKey(),
  });
  return executor.cancelSuspension({
    suspension: input.suspension,
    cancelAttemptId: input.cancelAttemptId,
    reason: input.reason,
    signal: input.signal,
  });
}
