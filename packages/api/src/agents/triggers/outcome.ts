import type {
  AgentEventActorDetachedAction,
  AgentTriggerDeliveryMethods,
  ConversationMethods,
  IAgentEventActorSuspension,
  MessageMethods,
} from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type { AgentEventActorDetachedResumeInput } from './detachedAction';
import type { CompletedToolEvidence } from './expectedAction';
import type { AgentTriggerExpectedAction } from './envelope';
import type { AgentEventAppliedAction } from './types';
import type { SerializableJobData } from '~/stream';
import { matchesExpectedAction, parseAgentExpectedActionArguments } from './expectedAction';
import { cancelAgentEventActor, createAgentEventActorActionAdmissionId } from './actor';
import { parseAgentEventDetachedTerminalEvidence } from './detachedAction';

export type { AgentEventAppliedAction } from './types';
export { matchesExpectedAction } from './expectedAction';
export type { CompletedToolEvidence } from './expectedAction';

interface SettleAgentTriggerHandlingOutcomeInput {
  deliveryKey: string;
  conversationId: string;
  generationCreatedAt: number;
  status: 'applied' | 'completed_no_action' | 'failed' | 'cancelled';
  settledAt: Date;
  error?: string;
  action?: { toolName: string; toolCallId?: string };
}

export interface AgentEventRunOutcome {
  status: 'applied' | 'completed_no_action' | 'failed' | 'cancelled';
  action?: { toolName: string; toolCallId?: string };
}

const MAX_RECEIPT_ID_LENGTH = 256;

async function hasDurableAgentEventHistory(input: {
  getMessage: MessageMethods['getMessage'];
  user: string;
  conversationId: string;
  deliveryKey: string;
}): Promise<boolean> {
  const [userMessage, responseMessage] = await Promise.all([
    input.getMessage({ user: input.user, messageId: `${input.deliveryKey}:user` }),
    input.getMessage({ user: input.user, messageId: `${input.deliveryKey}:assistant` }),
  ]);
  return (
    userMessage?.conversationId === input.conversationId &&
    userMessage.isCreatedByUser === true &&
    responseMessage?.conversationId === input.conversationId &&
    responseMessage.isCreatedByUser === false &&
    responseMessage.parentMessageId === userMessage.messageId
  );
}

function isBackgroundNonExecutionReceipt(value: unknown, argumentsValue: unknown): boolean {
  const parsedArguments = parseAgentExpectedActionArguments(argumentsValue);
  if (
    parsedArguments == null ||
    typeof parsedArguments !== 'object' ||
    Array.isArray(parsedArguments) ||
    (parsedArguments as Record<string, unknown>).run_in_background !== true
  ) {
    return false;
  }
  const parsed = parseAgentExpectedActionArguments(value);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const receipt = parsed as Record<string, unknown>;
  return (
    (receipt.status === 'running' && typeof receipt.background_task_id === 'string') ||
    receipt.status === 'rejected'
  );
}

function toolEvidence(
  step: Agents.RunStep,
  nonExecutedToolCallIds: ReadonlySet<string>,
): CompletedToolEvidence[] {
  if (step.status === 'in_progress' || step.stepDetails?.type !== 'tool_calls') {
    return [];
  }
  return (step.stepDetails.tool_calls ?? []).flatMap((call) => {
    const executionStatus = (
      call as Agents.AgentToolCall & {
        executionStatus?: 'success' | 'error' | 'cancelled';
      }
    ).executionStatus;
    if (
      executionStatus === 'error' ||
      executionStatus === 'cancelled' ||
      (step.status !== 'completed' && executionStatus !== 'success')
    ) {
      return [];
    }
    if ('inputValidationError' in call && call.inputValidationError === true) {
      return [];
    }
    if (call.id != null && nonExecutedToolCallIds.has(call.id)) {
      return [];
    }
    if ('function' in call) {
      if (
        call.function.output == null ||
        isBackgroundNonExecutionReceipt(call.function.output, call.function.arguments)
      ) {
        return [];
      }
      return [
        {
          toolName: call.function.name,
          toolCallId: call.id,
          arguments: call.function.arguments,
        },
      ];
    }
    if (call.output == null || isBackgroundNonExecutionReceipt(call.output, call.args)) {
      return [];
    }
    return [
      {
        toolName: call.name,
        ...(call.id != null && { toolCallId: call.id }),
        arguments: call.args,
      },
    ];
  });
}

function nonExecutedHITLToolCallIds(
  job: Pick<SerializableJobData, 'userSubmittedMessageFieldPaths'>,
  content: Agents.MessageContentComplex[],
): Set<string> {
  const ids = new Set<string>();
  for (const provenance of job.userSubmittedMessageFieldPaths ?? []) {
    if (provenance.field !== 'decision_response' && provenance.field !== 'decision_reason') {
      continue;
    }
    const match = /^\/content\/(\d+)\/tool_call\/output$/.exec(provenance.path);
    const index = match == null ? Number.NaN : Number(match[1]);
    const part = Number.isSafeInteger(index) ? content[index] : undefined;
    if (part == null || typeof part !== 'object' || !('tool_call' in part)) {
      continue;
    }
    const toolCall = part.tool_call;
    if (toolCall?.id != null && toolCall.id.length > 0) {
      ids.add(toolCall.id);
    }
  }
  return ids;
}

/** Classifies terminal run evidence once for both checkpoint commit and public receipt. */
export function classifyAgentEventRunOutcome(
  job: SerializableJobData,
  runSteps: Agents.RunStep[],
  content: Agents.MessageContentComplex[] = [],
): AgentEventRunOutcome {
  const action = findAgentEventAppliedAction(job.agentEventExpectedAction, runSteps, content, job);
  if (action != null) {
    return { status: 'applied', action };
  }
  if (job.status === 'error') {
    return { status: 'failed' };
  }
  if (job.status === 'aborted') {
    return { status: 'cancelled' };
  }
  return { status: 'completed_no_action' };
}

/** Finds qualifying action evidence without requiring the generation to be terminal yet. */
export function findAgentEventAppliedAction(
  expectedAction: AgentTriggerExpectedAction | undefined,
  runSteps: Agents.RunStep[],
  content: Agents.MessageContentComplex[] = [],
  provenance: Pick<SerializableJobData, 'userSubmittedMessageFieldPaths'> = {},
): AgentEventAppliedAction | undefined {
  if (expectedAction == null) {
    return undefined;
  }
  const nonExecutedToolCallIds = nonExecutedHITLToolCallIds(provenance, content);
  const action = runSteps
    .flatMap((step) => toolEvidence(step, nonExecutedToolCallIds))
    .find((item) => matchesExpectedAction(item, expectedAction));
  return action == null
    ? undefined
    : {
        toolName: action.toolName.slice(0, MAX_RECEIPT_ID_LENGTH),
        ...(action.toolCallId == null
          ? {}
          : { toolCallId: action.toolCallId.slice(0, MAX_RECEIPT_ID_LENGTH) }),
      };
}

export interface AgentEventActionRecorder {
  observeToolEnd(data: {
    input?: unknown;
    backgroundDelivery?: boolean;
    outputFiltered?: boolean;
    output?: unknown;
  }): void;
  read(): AgentEventAppliedAction | undefined;
}

/**
 * Captures qualifying applied-action evidence at tool-execution time, in graph
 * context, instead of trusting the asynchronously populated run-step
 * collection to be observable the instant `sendMessage` resolves. The recorder
 * applies the SAME fences as run-step evidence — exact tool name (with the MCP
 * suffix form), the declared argument subset, an error-free result, and the
 * background non-execution receipt exclusion. HITL never reaches the fork path
 * and non-executed approvals never emit a tool end, so the non-execution id
 * set has no equivalent here. Only the first qualifying execution is retained;
 * run-step evidence remains the fallback for paths that bypass the tool-end
 * chain (e.g. programmatic tool calling).
 */
export function createAgentEventActionRecorder(
  expectedAction: AgentTriggerExpectedAction | undefined,
): AgentEventActionRecorder {
  let receipt: AgentEventAppliedAction | undefined;
  return {
    observeToolEnd(data) {
      if (expectedAction == null || receipt != null || data == null) {
        return;
      }
      /** A background-task delivery reports the ORIGINAL tool's name on a
       * later poll turn — evidence of work some earlier turn dispatched,
       * never proof that THIS invocation performed its action. */
      if (data.backgroundDelivery === true) {
        return;
      }
      /** Policy-withheld output is still proof of a successful foreground
       * execution — but with the content blank, a background launch handle
       * would be indistinguishable from a real result, so a call the model
       * detached can never qualify through this shape. */
      if (data.outputFiltered === true) {
        const parsedInput = parseAgentExpectedActionArguments(data.input);
        if (
          parsedInput != null &&
          typeof parsedInput === 'object' &&
          !Array.isArray(parsedInput) &&
          (parsedInput as Record<string, unknown>).run_in_background === true
        ) {
          return;
        }
      }
      const output = data.output as
        | { name?: unknown; tool_call_id?: unknown; content?: unknown; status?: unknown }
        | null
        | undefined;
      if (
        output == null ||
        typeof output !== 'object' ||
        typeof output.name !== 'string' ||
        output.name.length === 0 ||
        output.content == null ||
        output.status === 'error'
      ) {
        return;
      }
      if (
        typeof output.content === 'string' &&
        isBackgroundNonExecutionReceipt(output.content, data.input)
      ) {
        return;
      }
      const toolCallId =
        typeof output.tool_call_id === 'string' && output.tool_call_id.length > 0
          ? output.tool_call_id
          : undefined;
      const evidence: CompletedToolEvidence = {
        toolName: output.name,
        ...(toolCallId == null ? {} : { toolCallId }),
        arguments: data.input,
      };
      if (!matchesExpectedAction(evidence, expectedAction)) {
        return;
      }
      receipt = {
        toolName: evidence.toolName.slice(0, MAX_RECEIPT_ID_LENGTH),
        ...(toolCallId == null ? {} : { toolCallId: toolCallId.slice(0, MAX_RECEIPT_ID_LENGTH) }),
      };
    },
    read: () => receipt,
  };
}

export function createAgentEventTerminalHandler(
  methods: {
    settleAgentTriggerHandlingOutcome: (
      input: SettleAgentTriggerHandlingOutcomeInput,
    ) => Promise<boolean>;
    getAgentEventActorSnapshot: ConversationMethods['getAgentEventActorSnapshot'];
    recordAgentEventActorReconciliation: ConversationMethods['recordAgentEventActorReconciliation'];
    resolveAgentEventActorReconciliation: ConversationMethods['resolveAgentEventActorReconciliation'];
    clearAgentEventActorReconciliation: ConversationMethods['clearAgentEventActorReconciliation'];
    settleAgentEventActorReceipt: AgentTriggerDeliveryMethods['settleAgentEventActorReceipt'];
    getAgentEventActorReceipt: AgentTriggerDeliveryMethods['getAgentEventActorReceipt'];
    backfillAgentEventActorReceipt: AgentTriggerDeliveryMethods['backfillAgentEventActorReceipt'];
    completeAgentEventActorLegacyTurn: ConversationMethods['completeAgentEventActorLegacyTurn'];
    cancelAgentEventActorSuspension: ConversationMethods['cancelAgentEventActorSuspension'];
    releaseAgentEventActorAction: AgentTriggerDeliveryMethods['releaseAgentEventActorAction'];
    getAgentEventActorActionAdmission: AgentTriggerDeliveryMethods['getAgentEventActorActionAdmission'];
    hasAgentEventActorActionAdmission: AgentTriggerDeliveryMethods['hasAgentEventActorActionAdmission'];
    getAgentEventActorDetachedAction: AgentTriggerDeliveryMethods['getAgentEventActorDetachedAction'];
    settleAgentEventActorDetachedAction: AgentTriggerDeliveryMethods['settleAgentEventActorDetachedAction'];
    markAgentEventActorDetachedActionLaunchIndeterminate: AgentTriggerDeliveryMethods['markAgentEventActorDetachedActionLaunchIndeterminate'];
    getMessage: MessageMethods['getMessage'];
  },
  options: {
    resumeDetachedAction?(input: AgentEventActorDetachedResumeInput): Promise<void>;
  } = {},
): (
  streamId: string,
  job: SerializableJobData,
  runSteps: Agents.RunStep[],
  content?: Agents.MessageContentComplex[],
) => Promise<void> {
  return async (
    streamId: string,
    receivedJob: SerializableJobData,
    runSteps: Agents.RunStep[],
    content: Agents.MessageContentComplex[] = [],
  ) => {
    if (receivedJob.agentEventDeliveryKey == null) {
      return;
    }
    const completionDeliveryKey =
      receivedJob.agentEventInvocationKey == null ? undefined : receivedJob.agentEventDeliveryKey;
    /** Actor state remains owned by the original invocation. The internal
     * completion delivery separately owns this generation's mailbox lane. */
    const job: SerializableJobData & { agentEventDeliveryKey: string } =
      receivedJob.agentEventInvocationKey == null
        ? { ...receivedJob, agentEventDeliveryKey: receivedJob.agentEventDeliveryKey }
        : {
            ...receivedJob,
            agentEventDeliveryKey: receivedJob.agentEventInvocationKey,
          };
    const conversationId = job.conversationId ?? streamId;
    const outcome = classifyAgentEventRunOutcome(job, runSteps, content);
    const settledAt = new Date(job.completedAt ?? Date.now());
    const settleCompletionDelivery = async (
      completionOutcome: AgentEventRunOutcome,
      failureError = receivedJob.error ?? 'Generation failed',
    ): Promise<void> => {
      if (completionDeliveryKey == null) {
        return;
      }
      const completionSettled = await methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: completionDeliveryKey,
        conversationId,
        generationCreatedAt: receivedJob.createdAt,
        status: completionOutcome.status,
        settledAt,
        ...(completionOutcome.status === 'failed' && { error: failureError }),
        ...(completionOutcome.action != null && { action: completionOutcome.action }),
      });
      if (!completionSettled) {
        throw new Error(`Failed to settle internal completion delivery ${completionDeliveryKey}`);
      }
    };
    let committedAction: AgentEventAppliedAction | undefined;
    let detachedTerminalFailure: string | undefined;
    let detachedTerminalRetiredWithoutSuspension = false;
    let compensated = false;
    let actorReceiptSettled = false;
    const owner = {
      user: job.userId,
      conversationId,
      ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
    };
    let snapshot = await methods.getAgentEventActorSnapshot(owner);
    let retiredWithoutAction: IAgentEventActorSuspension | undefined;
    const isIrrecoverablyTerminal = job.status === 'aborted' || job.status === 'error';
    const unprojectedSuspension = snapshot?.suspension;
    const handlingGenerationCreatedAt =
      unprojectedSuspension?.suspension.invocation.invocationId === job.agentEventDeliveryKey
        ? (unprojectedSuspension.handlingGenerationCreatedAt ?? job.createdAt)
        : job.createdAt;
    let detachedSuspensionAction: AgentEventActorDetachedAction | null = null;
    if (job.agentEventBindingId != null) {
      const detachedActionOwner = {
        deliveryKey: job.agentEventDeliveryKey,
        user: job.userId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
        bindingId: job.agentEventBindingId,
        conversationId,
        generationCreatedAt: handlingGenerationCreatedAt,
      };
      const retainedTerminalEvidence = parseAgentEventDetachedTerminalEvidence(
        job.agentEventDetachedTerminalEvidence,
      );
      if (job.agentEventDetachedTerminalEvidence != null && retainedTerminalEvidence == null) {
        throw new Error('Detached Event Actor terminal retry evidence is invalid');
      }
      if (retainedTerminalEvidence != null) {
        if (
          retainedTerminalEvidence.deliveryKey !== job.agentEventDeliveryKey ||
          retainedTerminalEvidence.generationCreatedAt !== handlingGenerationCreatedAt
        ) {
          throw new Error('Detached Event Actor terminal retry evidence is stale');
        }
        const replayed = await methods.settleAgentEventActorDetachedAction({
          ...detachedActionOwner,
          taskId: retainedTerminalEvidence.taskId,
          idempotencyKey: retainedTerminalEvidence.idempotencyKey,
          status: retainedTerminalEvidence.status,
          ...(retainedTerminalEvidence.result == null
            ? {}
            : { result: retainedTerminalEvidence.result }),
          ...(retainedTerminalEvidence.error == null
            ? {}
            : { error: retainedTerminalEvidence.error }),
          observedAt: new Date(retainedTerminalEvidence.observedAt),
        });
        if (replayed.status === 'conflict') {
          throw new Error('Detached Event Actor terminal retry evidence conflicts with action');
        }
      }
      detachedSuspensionAction =
        await methods.getAgentEventActorDetachedAction(detachedActionOwner);
      const recoveryObservedAt = new Date();
      if (
        detachedSuspensionAction != null &&
        ['reserved', 'running'].includes(detachedSuspensionAction.status) &&
        detachedSuspensionAction.recoveryAfter <= recoveryObservedAt
      ) {
        await methods.markAgentEventActorDetachedActionLaunchIndeterminate({
          ...detachedActionOwner,
          taskId: detachedSuspensionAction.taskId,
          idempotencyKey: detachedSuspensionAction.idempotencyKey,
          observedAt: recoveryObservedAt,
        });
        /** Re-read after the CAS so a concurrent exact terminal callback wins
         * over recovery and can immediately continue the suspended actor. */
        detachedSuspensionAction =
          await methods.getAgentEventActorDetachedAction(detachedActionOwner);
      }
      if (
        detachedSuspensionAction?.status === 'failed' ||
        detachedSuspensionAction?.status === 'cancelled' ||
        detachedSuspensionAction?.status === 'launch_indeterminate'
      ) {
        detachedTerminalFailure =
          detachedSuspensionAction.error ??
          (detachedSuspensionAction.status === 'launch_indeterminate'
            ? 'Detached expected action launch is indeterminate'
            : `Detached expected action ${detachedSuspensionAction.status}`);
      }
      if (
        job.agentEventSuspension == null &&
        completionDeliveryKey != null &&
        (detachedSuspensionAction?.status === 'failed' ||
          detachedSuspensionAction?.status === 'cancelled') &&
        unprojectedSuspension?.status === 'claimed' &&
        unprojectedSuspension.resumeAttemptId === completionDeliveryKey &&
        unprojectedSuspension.suspension.invocation.invocationId === job.agentEventDeliveryKey
      ) {
        /** A resumed hop can persist exact negative terminal evidence before
         * replacing its claimed predecessor with the successor suspension.
         * The completion delivery key is also the resume-attempt fence, so it
         * authorizes retiring only this generation's claimed predecessor. */
        retiredWithoutAction = unprojectedSuspension;
        const cancellation = await cancelAgentEventActor(
          {
            ...owner,
            suspension: unprojectedSuspension.suspension,
            cancelAttemptId: `terminal:${job.createdAt}`,
            reason: 'cancelled',
            claimedResumeAttemptId: completionDeliveryKey,
          },
          { cancelSuspension: methods.cancelAgentEventActorSuspension },
        );
        if (cancellation.status !== 'cancelled') {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} detached predecessor cancellation is indeterminate`,
          );
        }
        snapshot = await methods.getAgentEventActorSnapshot(owner);
      }
      /** An aborted/error generation does not prove its detached side effect
       * stopped. Retain the original delivery and suspension until exact
       * terminal evidence arrives or the recovery fence records uncertainty. */
      if (
        isIrrecoverablyTerminal &&
        detachedSuspensionAction != null &&
        ['reserved', 'running'].includes(detachedSuspensionAction.status)
      ) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} detached action is still in flight`,
        );
      }
      if (detachedSuspensionAction?.status === 'launch_indeterminate') {
        /** Quarantine is action truth, not a generation failure. Keep the
         * original delivery open so a late exact callback remains admissible;
         * no generic retry or ordinary cancellation may erase the uncertainty. */
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} detached action launch is indeterminate`,
        );
      }
      if (isIrrecoverablyTerminal && detachedSuspensionAction?.status === 'succeeded') {
        /** The side effect is authoritative but this aborted generation owns
         * no committed actor checkpoint. Persist the existing reconciliation
         * contract and wait for explicit compensation/repair instead of
         * falsely reporting either cancellation or an applied actor turn. */
        const marker = snapshot?.reconciliations.find(
          (item) => item.invocationId === job.agentEventDeliveryKey,
        );
        if (marker?.status === 'settled' && marker.resolution === 'action_compensated') {
          detachedTerminalFailure = 'Detached action was explicitly compensated';
        } else {
          if (marker?.status === 'invocation_pending') {
            const recorded = await methods.recordAgentEventActorReconciliation({
              ...owner,
              reconciliation: {
                invocationId: job.agentEventDeliveryKey,
                actionAdmitted: marker.actionAdmitted,
                status: 'commit_indeterminate',
                checkpoint: marker.checkpoint,
                action: {
                  toolName: detachedSuspensionAction.toolName,
                  toolCallId: detachedSuspensionAction.toolCallId,
                },
                error: 'Detached action succeeded after its generation terminated',
                observedAt:
                  detachedSuspensionAction.settledAt ?? detachedSuspensionAction.observedAt,
              },
            });
            if (!recorded) {
              throw new Error(
                `Agent event actor ${job.agentEventDeliveryKey} detached reconciliation could not be recorded`,
              );
            }
          } else if (marker?.status !== 'commit_indeterminate') {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} detached reconciliation owner is unavailable`,
            );
          }
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} detached success requires commit_indeterminate reconciliation`,
          );
        }
      }
      if (
        unprojectedSuspension == null &&
        (detachedSuspensionAction?.status === 'failed' ||
          detachedSuspensionAction?.status === 'cancelled')
      ) {
        /** Exact negative terminal evidence proves the detached side effect no
         * longer owns a future actor resume. Retire the pre-suspension
         * invocation fence before releasing delivery-side admission; replay
         * can repair either half independently. */
        const marker = snapshot?.reconciliations.find(
          (item) => item.invocationId === job.agentEventDeliveryKey,
        );
        if (marker?.status === 'invocation_pending') {
          const abandoned = await methods.resolveAgentEventActorReconciliation({
            ...owner,
            invocationId: job.agentEventDeliveryKey,
            checkpoint: marker.checkpoint,
            expectedActionAdmitted: true,
            resolution: 'invocation_abandoned',
          });
          snapshot = await methods.getAgentEventActorSnapshot(owner);
          const remaining = snapshot?.reconciliations.find(
            (item) => item.invocationId === job.agentEventDeliveryKey,
          );
          if (!abandoned && remaining?.status === 'invocation_pending') {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} detached terminal lifecycle could not be retired`,
            );
          }
          detachedTerminalRetiredWithoutSuspension = remaining == null;
        } else if (marker == null) {
          /** Re-entry after the conversation-side retirement committed but
           * before delivery admission was released. */
          detachedTerminalRetiredWithoutSuspension = true;
        }
      }
    }
    if (
      unprojectedSuspension?.kind === 'internal_completion' &&
      unprojectedSuspension.status === 'pending' &&
      unprojectedSuspension.suspension.invocation.invocationId === job.agentEventDeliveryKey &&
      !isIrrecoverablyTerminal
    ) {
      const projection = job.agentEventSuspension;
      if (
        projection == null ||
        projection.suspensionId !== unprojectedSuspension.suspension.suspensionId ||
        projection.attempt !== unprojectedSuspension.suspension.attempt ||
        job.agentEventBindingId == null
      ) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} internal suspension projection is stale`,
        );
      }
      const action = detachedSuspensionAction;
      if (action?.status === 'launch_indeterminate') {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} detached action launch is indeterminate`,
        );
      }
      if (action == null || !['succeeded', 'failed', 'cancelled'].includes(action.status)) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} detached action is not terminal`,
        );
      }
      if (options.resumeDetachedAction == null) {
        throw new Error('Detached Event Actor resume adapter is unavailable');
      }
      await options.resumeDetachedAction({
        streamId,
        job,
        handlingGenerationCreatedAt,
        suspension: unprojectedSuspension.suspension,
        action,
      });
      /** The successor is durable before its predecessor lane is retired. A
       * crash between these writes leaves the successor safely blocked until
       * idempotent terminal replay settles this completion delivery. */
      await settleCompletionDelivery(outcome);
      return;
    }
    if (
      job.agentEventSuspension == null &&
      isIrrecoverablyTerminal &&
      unprojectedSuspension?.status === 'pending' &&
      unprojectedSuspension.jobCreatedAt === job.createdAt &&
      unprojectedSuspension.suspension.invocation.invocationId === job.agentEventDeliveryKey
    ) {
      /** Recovery for a crash after the canonical suspension write but before
       * its version marker reached the job store, including a re-pause after
       * the predecessor marker was cleared by resume. A terminal exact
       * generation proves the unpublished pause can no longer be exposed. */
      retiredWithoutAction = unprojectedSuspension;
      const cancellation = await cancelAgentEventActor(
        {
          ...owner,
          suspension: unprojectedSuspension.suspension,
          cancelAttemptId: `terminal:${job.createdAt}`,
          reason:
            job.error === 'Approval expired before a decision was made' ? 'expired' : 'cancelled',
        },
        { cancelSuspension: methods.cancelAgentEventActorSuspension },
      );
      if (cancellation.status !== 'cancelled') {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} unpublished suspension cancellation is indeterminate`,
        );
      }
      snapshot = await methods.getAgentEventActorSnapshot(owner);
    }
    /** A retention/deletion winner may remove the private child before its
     * already-aborted job hook replays. With no canonical owner or checkpoint
     * left, cancellation is already physically complete; only the public
     * delivery outcome remains. A successful generation still requires its
     * actor proof and therefore fails closed here. */
    if (job.agentEventSuspension != null && snapshot == null && !isIrrecoverablyTerminal) {
      throw new Error(
        `Agent event actor ${job.agentEventDeliveryKey} terminal suspension owner is unavailable`,
      );
    }
    if (job.agentEventSuspension != null && snapshot != null) {
      const current = snapshot?.suspension;
      const currentMatches =
        job.agentEventSuspension.version === 1 &&
        current != null &&
        current.suspension.suspensionId === job.agentEventSuspension.suspensionId &&
        current.suspension.attempt === job.agentEventSuspension.attempt;
      if (!currentMatches || current == null) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} terminal suspension is stale`,
        );
      }
      if (current.status === 'pending') {
        if (!isIrrecoverablyTerminal) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} terminated while its suspension remained pending`,
          );
        }
        retiredWithoutAction = current;
        const cancellation = await cancelAgentEventActor(
          {
            ...owner,
            suspension: current.suspension,
            cancelAttemptId: `terminal:${job.createdAt}`,
            reason:
              job.error === 'Approval expired before a decision was made' ? 'expired' : 'cancelled',
          },
          { cancelSuspension: methods.cancelAgentEventActorSuspension },
        );
        if (cancellation.status !== 'cancelled') {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} suspension cancellation is indeterminate`,
          );
        }
        snapshot = await methods.getAgentEventActorSnapshot(owner);
      } else if (current.status === 'claimed') {
        /** The provider-start CAS retains its exact execution identity after
         * drain. A missing/different identity proves this claimed resume never
         * crossed provider start (including schedule invalidation after claim
         * projection); equality means execution began and must fail closed. */
        const projectionNeverStarted =
          isIrrecoverablyTerminal &&
          current.resumeAttemptId != null &&
          current.resumeAttemptId !== job.providerExecutionStartedId;
        if (!projectionNeverStarted) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} terminal suspension claim is still in flight`,
          );
        }
        retiredWithoutAction = current;
        const cancellation = await cancelAgentEventActor(
          {
            ...owner,
            suspension: current.suspension,
            cancelAttemptId: `terminal:${job.createdAt}`,
            reason:
              job.error === 'Approval expired before a decision was made' ? 'expired' : 'cancelled',
            claimedResumeAttemptId: current.resumeAttemptId,
          },
          { cancelSuspension: methods.cancelAgentEventActorSuspension },
        );
        if (cancellation.status !== 'cancelled') {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} orphaned suspension claim is indeterminate`,
          );
        }
        snapshot = await methods.getAgentEventActorSnapshot(owner);
      }
    }
    /** Replay recovery after the Conversation CAS succeeded but the delivery
     * admission was not yet released. Only exact closed no-action evidence is
     * eligible; a committed suspension represents an applied action. */
    const closed = snapshot?.suspension;
    const closedDetachedPredecessor =
      job.agentEventSuspension == null &&
      completionDeliveryKey != null &&
      closed?.status === 'closed' &&
      (closed.outcome === 'settled' ||
        (closed.outcome === 'cancelled' &&
          (detachedSuspensionAction?.status === 'failed' ||
            detachedSuspensionAction?.status === 'cancelled'))) &&
      closed.resumeAttemptId === completionDeliveryKey &&
      closed.suspension.invocation.invocationId === job.agentEventDeliveryKey;
    if (
      retiredWithoutAction == null &&
      closed?.status === 'closed' &&
      (closed.outcome === 'settled' || closed.outcome === 'cancelled') &&
      closed.suspension.invocation.invocationId === job.agentEventDeliveryKey &&
      (closedDetachedPredecessor ||
        (closed.jobCreatedAt === job.createdAt &&
          (closed.outcome === 'settled'
            ? closed.resumeAttemptId != null && closed.resumeAttemptId === job.providerExecutionId
            : isIrrecoverablyTerminal &&
              (closed.resumeAttemptId == null ||
                closed.resumeAttemptId !== job.providerExecutionStartedId))))
    ) {
      retiredWithoutAction = closed;
    }
    let retiredAdmissionId =
      retiredWithoutAction == null
        ? null
        : createAgentEventActorActionAdmissionId(
            retiredWithoutAction.suspension.invocation.invocationId,
            retiredWithoutAction.suspension.invocation.fork,
          );
    if (
      retiredAdmissionId == null &&
      ((snapshot == null && isIrrecoverablyTerminal) || detachedTerminalRetiredWithoutSuspension) &&
      job.agentEventBindingId != null
    ) {
      retiredAdmissionId = await methods.getAgentEventActorActionAdmission({
        deliveryKey: job.agentEventDeliveryKey,
        user: job.userId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
        bindingId: job.agentEventBindingId,
        conversationId,
      });
    }
    if (retiredAdmissionId != null) {
      if (job.agentEventBindingId == null) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} retired without binding identity`,
        );
      }
      const admission = {
        deliveryKey: job.agentEventDeliveryKey,
        user: job.userId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
        bindingId: job.agentEventBindingId,
        conversationId,
        admissionId: retiredAdmissionId,
      };
      const released = await methods.releaseAgentEventActorAction(admission);
      if (!released && (await methods.hasAgentEventActorActionAdmission(admission))) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} action admission could not be released`,
        );
      }
    }
    const lifecycle = snapshot?.reconciliations.find(
      (item) => item.invocationId === job.agentEventDeliveryKey,
    );
    let durableReceipt =
      job.agentEventBindingId == null
        ? null
        : await methods.getAgentEventActorReceipt({
            deliveryKey: job.agentEventDeliveryKey,
            user: job.userId,
            ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
            bindingId: job.agentEventBindingId,
            conversationId,
          });
    if (durableReceipt != null) {
      actorReceiptSettled = true;
      /** Settlement owns public batch propagation and lane cleanup as well as
       * the private receipt. Replaying the exact settlement repairs a crash
       * after the atomic root write but before either idempotent side effect. */
      const finalized = await methods.settleAgentEventActorReceipt({
        deliveryKey: job.agentEventDeliveryKey,
        user: job.userId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
        bindingId: durableReceipt.bindingId,
        conversationId,
        generationCreatedAt: handlingGenerationCreatedAt,
        status: durableReceipt.resolution === 'action_compensated' ? 'failed' : 'applied',
        settledAt: durableReceipt.settledAt,
        ...(durableReceipt.resolution === 'action_compensated' && {
          error: 'Applied event actor action was explicitly compensated',
        }),
        receipt: {
          resolution: durableReceipt.resolution,
          checkpoint: durableReceipt.checkpoint,
          action: durableReceipt.action,
        },
      });
      if (!finalized) {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} terminal receipt could not be finalized`,
        );
      }
      if (durableReceipt.resolution === 'action_compensated') {
        compensated = true;
      } else {
        committedAction = durableReceipt.action;
      }
      if (lifecycle != null) {
        const cleared = await methods.clearAgentEventActorReconciliation({
          user: job.userId,
          conversationId,
          ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
          invocationId: job.agentEventDeliveryKey,
          checkpoint: durableReceipt.checkpoint,
          resolution: durableReceipt.resolution,
        });
        if (!cleared) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} terminal marker could not be cleared`,
          );
        }
      }
    } else if (lifecycle != null) {
      if (lifecycle.status === 'settled') {
        /** Compatibility for receipts written by the pre-delivery-ledger build:
         * copy the exact terminal proof only when the already-public handling
         * outcome agrees, then remove the embedded representation. */
        if (job.agentEventBindingId != null && lifecycle.resolution != null) {
          const legacyCompensated = lifecycle.resolution === 'action_compensated';
          /** A pre-ledger owner can settle the embedded lifecycle and crash
           * before publishing the matching delivery outcome. Terminalize that
           * exact started generation first; replay is idempotent when an older
           * owner already completed the public write. The resulting terminal
           * handling is then the delivery-side proof required by migration. */
          const legacyStatus = legacyCompensated ? 'failed' : 'applied';
          const legacyError = legacyCompensated
            ? 'Applied event actor action was explicitly compensated'
            : undefined;
          const terminalized = await methods.settleAgentTriggerHandlingOutcome({
            deliveryKey: job.agentEventDeliveryKey,
            conversationId,
            generationCreatedAt: handlingGenerationCreatedAt,
            status: legacyStatus,
            settledAt: lifecycle.observedAt,
            ...(legacyError == null ? {} : { error: legacyError }),
            ...(!legacyCompensated && { action: lifecycle.action }),
          });
          if (!terminalized) {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} legacy public outcome could not be recovered`,
            );
          }
          const migrated = await methods.backfillAgentEventActorReceipt({
            deliveryKey: job.agentEventDeliveryKey,
            user: job.userId,
            ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
            bindingId: job.agentEventBindingId,
            conversationId,
            generationCreatedAt: handlingGenerationCreatedAt,
            status: legacyStatus,
            settledAt: lifecycle.observedAt,
            ...(legacyError == null ? {} : { error: legacyError }),
            receipt: {
              resolution: lifecycle.resolution,
              checkpoint: lifecycle.checkpoint,
              action: lifecycle.action,
            },
          });
          if (!migrated) {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} legacy receipt could not be migrated`,
            );
          }
          const cleared = await methods.clearAgentEventActorReconciliation({
            user: job.userId,
            conversationId,
            ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
            invocationId: job.agentEventDeliveryKey,
            checkpoint: lifecycle.checkpoint,
            resolution: lifecycle.resolution,
          });
          if (!cleared) {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} migrated marker could not be cleared`,
            );
          }
          actorReceiptSettled = true;
        }
        /** A compensated receipt still tombstones its invocation id, but its
         * external effect was explicitly undone — replaying it as applied
         * would tell the source the operation stands and suppress the
         * new-invocation retry that compensation requires. */
        if (lifecycle.resolution === 'action_compensated') {
          compensated = true;
        } else {
          committedAction = lifecycle.action;
        }
      } else if (lifecycle.status !== 'history_persisted') {
        throw new Error(
          `Agent event actor ${job.agentEventDeliveryKey} requires ${lifecycle.status} reconciliation`,
        );
      } else if (job.agentEventBindingId != null) {
        const historyIsDurable = await hasDurableAgentEventHistory({
          getMessage: methods.getMessage,
          user: job.userId,
          conversationId,
          deliveryKey: job.agentEventDeliveryKey,
        });
        if (!historyIsDurable) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} has invalid durable message history`,
          );
        }
        const stored = await methods.settleAgentEventActorReceipt({
          deliveryKey: job.agentEventDeliveryKey,
          user: job.userId,
          ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
          bindingId: job.agentEventBindingId,
          conversationId,
          generationCreatedAt: handlingGenerationCreatedAt,
          status: 'applied',
          settledAt,
          ...(lifecycle.actionAdmitted === true && { requiresActionAdmission: true }),
          receipt: {
            resolution: 'checkpoint_verified',
            checkpoint: lifecycle.checkpoint,
            action: lifecycle.action,
          },
        });
        if (!stored) {
          durableReceipt = await methods.getAgentEventActorReceipt({
            deliveryKey: job.agentEventDeliveryKey,
            user: job.userId,
            ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
            bindingId: job.agentEventBindingId,
            conversationId,
          });
          if (durableReceipt == null) {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} terminal receipt was not retained`,
            );
          }
        }
        durableReceipt ??= {
          bindingId: job.agentEventBindingId,
          resolution: 'checkpoint_verified',
          checkpoint: lifecycle.checkpoint,
          action: lifecycle.action,
          settledAt,
        };
        actorReceiptSettled = true;
        if (durableReceipt.resolution === 'action_compensated') {
          compensated = true;
        } else {
          committedAction = durableReceipt.action;
        }
        const cleared = await methods.clearAgentEventActorReconciliation({
          user: job.userId,
          conversationId,
          ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
          invocationId: job.agentEventDeliveryKey,
          checkpoint: durableReceipt.checkpoint,
          resolution: durableReceipt.resolution,
        });
        if (!cleared) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} terminal marker could not be cleared`,
          );
        }
      } else {
        /** A generation created before binding identity was added must finish
         * through the old receipt path; inventing binding scope here would be
         * less safe than retaining the already-deployed mixed-version logic. */
        const historyIsDurable = await hasDurableAgentEventHistory({
          getMessage: methods.getMessage,
          user: job.userId,
          conversationId,
          deliveryKey: job.agentEventDeliveryKey,
        });
        if (!historyIsDurable) {
          throw new Error(
            `Agent event actor ${job.agentEventDeliveryKey} has invalid durable message history`,
          );
        }
        const resolved = await methods.resolveAgentEventActorReconciliation({
          user: job.userId,
          conversationId,
          ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
          invocationId: lifecycle.invocationId,
          checkpoint: lifecycle.checkpoint,
          resolution: 'checkpoint_verified',
        });
        if (!resolved) {
          const reread = await methods.getAgentEventActorSnapshot({
            user: job.userId,
            conversationId,
            ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
          });
          const raced = reread?.reconciliations.find(
            (item) => item.invocationId === job.agentEventDeliveryKey,
          );
          if (raced?.status === 'settled' && raced.resolution === 'action_compensated') {
            compensated = true;
          } else {
            throw new Error(
              `Agent event actor ${job.agentEventDeliveryKey} settlement receipt was not retained`,
            );
          }
        } else {
          committedAction = lifecycle.action;
        }
      }
    }
    let settlementOutcome: AgentEventRunOutcome = outcome;
    if (compensated) {
      settlementOutcome = { status: 'failed' };
    } else if (committedAction != null) {
      settlementOutcome = { status: 'applied', action: committedAction };
    } else if (detachedTerminalFailure != null) {
      settlementOutcome = { status: 'failed' };
    }
    if (job.agentEventLegacyTurnToken != null && snapshot?.legacyTurn != null) {
      if (snapshot.legacyTurn.token !== job.agentEventLegacyTurnToken) {
        throw new Error(
          `Legacy event actor turn ${job.agentEventLegacyTurnToken} lost token ownership`,
        );
      }
      const historyIsDurable = await hasDurableAgentEventHistory({
        getMessage: methods.getMessage,
        user: job.userId,
        conversationId,
        deliveryKey: job.agentEventDeliveryKey,
      });
      if (!historyIsDurable) {
        throw new Error(
          `Legacy event actor ${job.agentEventDeliveryKey} has invalid durable message history`,
        );
      }
      const sealed = await methods.completeAgentEventActorLegacyTurn({
        user: job.userId,
        conversationId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
        token: job.agentEventLegacyTurnToken,
      });
      if (!sealed) {
        throw new Error(`Failed to seal legacy event actor turn ${job.agentEventLegacyTurnToken}`);
      }
    }
    if (actorReceiptSettled) {
      await settleCompletionDelivery(
        settlementOutcome,
        compensated
          ? 'Applied event actor action was explicitly compensated'
          : (detachedTerminalFailure ?? receivedJob.error ?? 'Generation failed'),
      );
      return;
    }
    const settled = await methods.settleAgentTriggerHandlingOutcome({
      deliveryKey: job.agentEventDeliveryKey,
      conversationId,
      generationCreatedAt: handlingGenerationCreatedAt,
      status: settlementOutcome.status,
      settledAt,
      ...(settlementOutcome.status === 'failed' && {
        error: compensated
          ? 'Applied event actor action was explicitly compensated'
          : (detachedTerminalFailure ?? job.error ?? 'Generation failed'),
      }),
      ...(settlementOutcome.action != null && { action: settlementOutcome.action }),
    });
    if (!settled) {
      throw new Error(`Failed to settle agent event delivery ${job.agentEventDeliveryKey}`);
    }
    await settleCompletionDelivery(
      settlementOutcome,
      compensated
        ? 'Applied event actor action was explicitly compensated'
        : (detachedTerminalFailure ?? receivedJob.error ?? 'Generation failed'),
    );
  };
}
