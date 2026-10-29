import { isDeepStrictEqual } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { responseReviewDecisionSchema } from 'librechat-data-provider';
import type {
  Agents,
  ResponseReviewDecision,
  ResponseReviewDecisionReceipt,
} from 'librechat-data-provider';
import type { ResponseOwner, ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { GenerationJob } from '~/types/stream';
import { resolveAskUserQuestionResume, resolveToolApprovalResume } from '../hitl/resume';
import { canonicalResponseJSON } from './background';

type DecisionResolution = Extract<
  ReturnType<typeof resolveAskUserQuestionResume> | ReturnType<typeof resolveToolApprovalResume>,
  { resumeValue: object }
>['resumeValue'];

export interface ResponseDecisionDependencies {
  storage: ResponseStorage;
  jobs: Pick<GenerationJobManagerClass, 'getJob'>;
  authorize: (record: StoredResponseRecord) => Promise<boolean>;
  /** Mandatory current source/content/project/checkpoint preflight, including equivalent retries. */
  validate: (input: {
    record: StoredResponseRecord;
    job: GenerationJob;
    action: Agents.PendingAction;
    decision: ResponseReviewDecision;
    resolution: DecisionResolution;
  }) => Promise<boolean>;
  /** Only publish the immutable saved intent through the existing resume queue; never execute inline. */
  enqueue: (record: StoredResponseRecord) => Promise<void>;
  now?: () => number;
}

export type ResponseDecisionResult =
  | { ok: true; receipt: ResponseReviewDecisionReceipt }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string };

export type ResponseDecisionSubmission = (
  owner: ResponseOwner,
  responseId: string,
  input: unknown,
) => Promise<ResponseDecisionResult>;

function terminal(record: StoredResponseRecord): boolean {
  return ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status);
}

/** Owner submission is a validated immutable intent, not an execution or approval-claim endpoint. */
export function createResponseDecisionSubmission(
  deps: ResponseDecisionDependencies,
): ResponseDecisionSubmission {
  return async (
    owner: ResponseOwner,
    responseId: string,
    input: unknown,
  ): Promise<ResponseDecisionResult> => {
    const invalid = { ok: false, status: 400, code: 'invalid_response_decision' } as const;
    const unavailable = { ok: false, status: 409, code: 'response_action_unavailable' } as const;
    const missing = { ok: false, status: 404, code: 'response_not_found' } as const;
    const parsed = responseReviewDecisionSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const decision = {
      ...parsed.data,
      ...(parsed.data.decisions
        ? {
            decisions: [...parsed.data.decisions].sort((a, b) =>
              a.tool_call_id < b.tool_call_id ? -1 : Number(a.tool_call_id !== b.tool_call_id),
            ),
          }
        : {}),
    };
    let record = await deps.storage.read(owner, responseId);
    if (!record || !(await deps.authorize(record))) return missing;
    const review = record.review;
    if (
      !review?.pendingActionJSON ||
      review.actionId !== decision.actionId ||
      record.generationCreatedAt == null ||
      record.pendingTerminal ||
      record.cancellationRequestedAt != null
    )
      return unavailable;
    const epoch = record.generationCreatedAt;
    const identity = {
      userId: record.userId,
      tenantId: record.tenantId,
      agentId: record.agentId,
      conversationId: record.conversationId,
      sourceKeyId: record.sourceKeyId,
      requestJSON: record.requestJSON,
    };
    let action: Agents.PendingAction;
    try {
      action = JSON.parse(review.pendingActionJSON);
    } catch {
      throw new Error('Response decision action is unavailable');
    }
    if (
      !action ||
      action.actionId !== review.actionId ||
      action.streamId !== responseId ||
      action.responseMessageId !== responseId ||
      action.conversationId !== record.conversationId ||
      action.threadId !== record.conversationId ||
      action.expiresAt !== review.expiresAt
    )
      return unavailable;
    if (
      (action.payload?.type === 'ask_user_question' && decision.decisions != null) ||
      (action.payload?.type === 'tool_approval' &&
        (decision.answer != null || decision.answers != null)) ||
      (decision.answer != null && decision.answers != null)
    )
      return invalid;
    let mapped:
      | ReturnType<typeof resolveAskUserQuestionResume>
      | ReturnType<typeof resolveToolApprovalResume>
      | undefined;
    if (action.payload?.type === 'ask_user_question')
      mapped = resolveAskUserQuestionResume(action.payload, decision);
    else if (action.payload?.type === 'tool_approval')
      mapped = resolveToolApprovalResume(action.payload, decision.decisions ?? []);
    if (!mapped || !('resumeValue' in mapped)) {
      if (mapped?.status === 403)
        return { ok: false, status: 403, code: 'response_decision_rejected' };
      return invalid;
    }
    const decisionJSON = canonicalResponseJSON(decision);
    const resolutionJSON = canonicalResponseJSON(mapped.resumeValue);
    const fingerprint = createHash('sha256').update(decisionJSON).digest('hex');
    const sameIntent = (value: StoredResponseRecord) =>
      value.generationCreatedAt === epoch &&
      value.userId === identity.userId &&
      value.tenantId === identity.tenantId &&
      value.agentId === identity.agentId &&
      value.conversationId === identity.conversationId &&
      value.sourceKeyId === identity.sourceKeyId &&
      value.requestJSON === identity.requestJSON &&
      value.resume?.actionId === decision.actionId &&
      value.resume.previousProviderExecutionId === review.providerExecutionId &&
      value.resume.fingerprint === fingerprint &&
      value.resume.resolutionJSON === resolutionJSON &&
      value.resume.decisionJSON === decisionJSON;
    if (record.resume && !sameIntent(record)) return unavailable;
    const receipt = (value: StoredResponseRecord): ResponseDecisionResult => {
      if (!value.resume) throw new Error('Response decision receipt is unavailable');
      return {
        ok: true,
        receipt: {
          responseId,
          actionId: decision.actionId,
          intentId: value.resume.intentId,
          status: terminal(value) ? 'settled' : 'queued',
        },
      };
    };
    if (terminal(record)) return record.resume ? receipt(record) : unavailable;
    const now = (deps.now ?? Date.now)();
    const admitted = record.resume?.state === 'admitted';
    if (
      (!admitted && review.expiresAt <= now) ||
      !['requires_action', 'in_progress'].includes(record.status)
    )
      return unavailable;
    const job = await deps.jobs.getJob(responseId);
    if (
      !job ||
      job.createdAt !== record.generationCreatedAt ||
      job.metadata.userId !== record.userId ||
      job.metadata.tenantId !== record.tenantId ||
      job.metadata.agent_id !== record.agentId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.conversationId !== record.conversationId ||
      job.metadata.responseMessageId !== responseId ||
      job.metadata.providerExecutionId !==
        (admitted ? record.resume!.providerExecutionId : review.providerExecutionId)
    )
      return unavailable;
    if (
      admitted
        ? job.status !== 'running'
        : job.status !== 'requires_action' ||
          job.metadata.providerDrained !== true ||
          job.metadata.terminalPersistencePending === true ||
          !isDeepStrictEqual(JSON.parse(JSON.stringify(job.metadata.pendingAction ?? null)), action)
    )
      return unavailable;
    if (!(await deps.validate({ record, job, action, decision, resolution: mapped.resumeValue })))
      return { ok: false, status: 403, code: 'response_decision_rejected' };
    if (!record.resume) {
      try {
        const saved = await deps.storage.reserveResume(
          owner,
          responseId,
          {
            generationCreatedAt: epoch,
            intentId: randomUUID(),
            actionId: decision.actionId,
            previousProviderExecutionId: review.providerExecutionId,
            providerExecutionId: randomUUID(),
            fingerprint,
            decisionJSON,
            resolutionJSON,
          },
          now,
        );
        if (!saved.ok) return unavailable;
        record = saved.record;
      } catch (error) {
        const current = await deps.storage.read(owner, responseId);
        if (!current || !sameIntent(current)) throw error;
        record = current;
      }
    }
    const current = await deps.storage.read(owner, responseId);
    if (!current || !(await deps.authorize(current))) return missing;
    if (!sameIntent(current) || current.pendingTerminal || current.cancellationRequestedAt != null)
      return unavailable;
    if (!terminal(current)) await deps.enqueue(current);
    return receipt(current);
  };
}
