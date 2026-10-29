import { createHash } from 'node:crypto';
import { responseReviewDecisionSchema } from 'librechat-data-provider';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { ResponseReviewView } from 'librechat-data-provider';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { Response } from './types';
import { buildPendingBackgroundResponse } from './background';
import { toClientPendingAction } from '../hitl/policy';

export interface ResponseReviewDependencies {
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'getResumeState'>;
  /** Trusted deployment URL, never derived from request Host/forwarded headers. */
  publicBaseURL?: string;
  now?: () => number;
}

function safeURL(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Project durable OAuth and approval state without exposing owner-only details through Responses. */
export function createResponseReview(deps: ResponseReviewDependencies) {
  const now = deps.now ?? Date.now;
  const baseURL = deps.publicBaseURL ? safeURL(deps.publicBaseURL) : undefined;

  async function privateView(record: StoredResponseRecord): Promise<ResponseReviewView> {
    const view: ResponseReviewView = {
      responseId: record.responseId,
      status: record.status === 'requires_action' ? 'in_progress' : record.status,
      oauth: [],
    };
    if (
      !baseURL ||
      record.generationCreatedAt == null ||
      record.cancellationRequestedAt != null ||
      !['in_progress', 'requires_action'].includes(record.status)
    )
      return view;
    const job = await deps.jobs.getJob(record.responseId);
    if (
      !job ||
      !['running', 'requires_action'].includes(job.status) ||
      job.createdAt !== record.generationCreatedAt ||
      job.metadata.userId !== record.userId ||
      job.metadata.tenantId !== record.tenantId ||
      job.metadata.agent_id !== record.agentId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.responseMessageId !== record.responseId ||
      job.metadata.conversationId !== record.conversationId
    )
      return { ...view, recovery: 'execution_state_unavailable' };
    if (job.status === 'requires_action') {
      const pending = job.metadata.pendingAction;
      const review = record.review;
      if (
        record.status !== 'requires_action' ||
        !review ||
        !pending ||
        job.metadata.providerDrained !== true ||
        job.metadata.terminalPersistencePending === true ||
        job.metadata.providerExecutionId !== review.providerExecutionId ||
        pending.actionId !== review.actionId ||
        pending.streamId !== record.responseId ||
        pending.responseMessageId !== record.responseId ||
        pending.conversationId !== record.conversationId ||
        pending.threadId !== record.conversationId ||
        pending.expiresAt !== review.expiresAt ||
        !Number.isSafeInteger(review.expiresAt) ||
        review.expiresAt <= now()
      )
        return view;
      if (record.resume) {
        if (
          record.resume.state !== 'reserved' ||
          record.resume.actionId !== review.actionId ||
          record.resume.previousProviderExecutionId !== review.providerExecutionId ||
          !record.resume.decisionJSON
        )
          return view;
        let decision: ReturnType<typeof responseReviewDecisionSchema.safeParse>;
        try {
          decision = responseReviewDecisionSchema.safeParse(JSON.parse(record.resume.decisionJSON));
        } catch {
          return view;
        }
        if (!decision.success || decision.data.actionId !== review.actionId) return view;
        view.pendingDecision = { intentId: record.resume.intentId, decision: decision.data };
      }
      const action = toClientPendingAction(pending);
      if (action)
        view.pendingAction = {
          actionId: action.actionId,
          payload: action.payload,
          expiresAt: action.expiresAt,
        };
      return view;
    }
    const state = await deps.jobs.getResumeState(record.responseId, record.generationCreatedAt, {
      durableOnly: true,
    });
    if (!state || state.conversationId !== record.conversationId) return view;
    for (const prompt of state.pendingOAuthPrompts ?? []) {
      if (
        prompt.expiresAt == null ||
        !Number.isSafeInteger(prompt.expiresAt) ||
        prompt.expiresAt <= now() ||
        !safeURL(prompt.authURL)
      )
        continue;
      const actionId = `oauth-${createHash('sha256')
        .update(JSON.stringify([job.createdAt, prompt.stepId, prompt.toolCallId, prompt.expiresAt]))
        .digest('hex')}`;
      view.oauth.push({
        actionId,
        toolName: prompt.toolName,
        authURL: prompt.authURL,
        expiresAt: prompt.expiresAt,
      });
    }
    return view;
  }

  return {
    privateView,
    async observe(record: StoredResponseRecord) {
      if (!baseURL) return null;
      const view = await privateView(record);
      const response: Response = record.responseJSON
        ? JSON.parse(record.responseJSON)
        : buildPendingBackgroundResponse(record);
      const prompt = view.oauth[0];
      const pending = view.pendingAction;
      let selected:
        | Pick<NonNullable<Response['required_action']>, 'kind' | 'action_id' | 'expires_at'>
        | undefined;
      if (pending && pending.expiresAt != null)
        selected = {
          kind: pending.payload.type === 'tool_approval' ? 'tool_approval' : 'question',
          action_id: pending.actionId,
          expires_at: Math.floor(pending.expiresAt / 1000),
        };
      else if (prompt)
        selected = {
          kind: 'oauth',
          action_id: prompt.actionId,
          expires_at: Math.floor(prompt.expiresAt / 1000),
        };
      const action: Response['required_action'] = selected
        ? {
            type: 'librechat_review',
            ...selected,
            review_url: new URL(
              `responses/${encodeURIComponent(record.responseId)}/review`,
              `${baseURL.href.replace(/\/$/, '')}/`,
            ).href,
          }
        : undefined;
      if (
        JSON.stringify(action) === JSON.stringify(response.required_action) &&
        response.status === view.status &&
        response.recovery === view.recovery
      )
        return null;
      const { required_action: _previous, recovery: _previousRecovery, ...rest } = response;
      return {
        response: {
          ...rest,
          status: view.status,
          ...(action ? { required_action: action } : {}),
          ...(view.recovery ? { recovery: view.recovery } : {}),
        },
      };
    },
  };
}
