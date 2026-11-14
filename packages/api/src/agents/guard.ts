import { Constants } from 'librechat-data-provider';
import type { ConversationMethods, IConversation } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { SubagentThreadTaskStore } from './subagentThreads';
import { PARTIAL_RESOLVED_CONVERSATION } from './conversationSymbols';
import { isReservedSubagentThreadId } from './subagentThreadIds';
import { isAgentEventRetentionActive } from './eventRetention';

export const CHILD_THREAD_READ_ONLY_ERROR =
  'This subagent thread is view-only. Continue it from its parent agent or create a separate chat.';

export const CHILD_THREAD_READ_ONLY_CODE = 'CHILD_THREAD_READ_ONLY';

export type BackgroundChildJobRefusal = {
  status: 409;
  body: { code: typeof CHILD_THREAD_READ_ONLY_CODE; error: string };
};

/**
 * The answer for a chat route asked to end or steer a background child's job. The subagent
 * task store owns that run: it stops and steers the child through its own control endpoint
 * and writes the child's rows itself, so a chat route acting on the job would write a second,
 * chat-shaped history into a view-only thread. Null for every other job.
 */
type AbortGuardJob = {
  metadata?: { userId?: string; tenantId?: string; subagentTaskId?: string };
};

const MAX_ABORT_TARGET_LENGTH = 512;

/** The concrete stream id an abort request names, in the route's own order. The `new`
 *  placeholder names none: its fallback reads the active chat list, which holds no child. */
function abortTargetId(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null;
  const { streamId, conversationId, abortKey } = body as Record<string, unknown>;
  const prefix = typeof abortKey === 'string' ? abortKey.split(':')[0] : undefined;
  for (const value of [streamId, conversationId, prefix]) {
    if (
      typeof value === 'string' &&
      value !== '' &&
      value !== 'new' &&
      value.length <= MAX_ABORT_TARGET_LENGTH
    ) {
      return value;
    }
  }
  return null;
}

/**
 * Runs ahead of the chat abort route and answers for a background child's job, so the
 * route's chat-shaped abort never reaches it. Every other request falls through untouched,
 * including one for a job the caller does not own, which the route refuses itself.
 */
export function createBackgroundChildAbortGuard(deps: {
  getJob: (streamId: string) => Promise<AbortGuardJob | null | undefined>;
}): RequestHandler {
  return async (req, res, next) => {
    const streamId = abortTargetId(req.body);
    const user = (req as Request & { user?: { id?: string; tenantId?: string } }).user;
    if (streamId == null || user?.id == null) {
      next();
      return;
    }
    let job: AbortGuardJob | null | undefined;
    try {
      job = await deps.getJob(streamId);
    } catch {
      /** The route reads the same job and owns the answer for a store failure. */
      next();
      return;
    }
    const metadata = job?.metadata;
    const owned =
      metadata?.userId === user.id &&
      (metadata.tenantId == null || metadata.tenantId === user.tenantId);
    const refusal = owned ? backgroundChildJobRefusal(job) : null;
    if (refusal == null) {
      next();
      return;
    }
    res.status(refusal.status).json(refusal.body);
  };
}

export function backgroundChildJobRefusal(
  job: { metadata?: { subagentTaskId?: string } } | null | undefined,
): BackgroundChildJobRefusal | null {
  const taskId = job?.metadata?.subagentTaskId;
  if (taskId == null || taskId === '') return null;
  return {
    status: 409,
    body: { code: CHILD_THREAD_READ_ONLY_CODE, error: CHILD_THREAD_READ_ONLY_ERROR },
  };
}

interface SubagentTurnBody {
  conversationId?: unknown;
  arg?: { conversationId?: unknown };
}

interface SubagentTurnUser {
  id?: string;
  _id?: string | { toString(): string };
  tenantId?: string;
}

export interface SubagentThreadWriteGuardDeps {
  getConvo: ConversationMethods['getConvo'];
  getEventBinding?: ConversationMethods['getAgentEventBinding'];
  isHumanResumeAllowed?: (target: SubagentThreadWriteTarget) => Promise<boolean>;
  store: SubagentThreadTaskStore;
}

export interface SubagentThreadWriteTarget {
  userId: string;
  conversationId: string;
  tenantId?: string;
  /** Conversation already read earlier in the request (`null` = looked up, absent). */
  conversation?: IConversation | null;
}

interface SubagentThreadWriteResolution {
  blocked: boolean;
  conversation?: IConversation | null;
}

interface ResolvedConversationRequest extends Request {
  resolvedConversation?: IConversation | null;
  _isAgentTrigger?: boolean;
  _agentEventBindingRetention?: {
    isTemporary?: boolean;
    expiredAt?: Date;
  };
  _agentEventBindingId?: string;
  _agentEventBindingParentConversationId?: string;
  _agentEventBindingParentAgentId?: string;
  _agentEventBindingTenantId?: string;
}

function applyEventBindingContext(
  request: ResolvedConversationRequest,
  conversation: IConversation,
): void {
  request.resolvedConversation = conversation;
  request._agentEventBindingRetention = {
    ...(conversation.isTemporary == null ? {} : { isTemporary: conversation.isTemporary }),
    ...(conversation.expiredAt == null ? {} : { expiredAt: conversation.expiredAt }),
  };
  request._agentEventBindingId = conversation.agentEventBinding?.bindingId;
  request._agentEventBindingParentConversationId =
    conversation.subagentThread?.parentConversationId;
  request._agentEventBindingParentAgentId = conversation.subagentThread?.parentAgentId;
  request._agentEventBindingTenantId = conversation.tenantId;
}

async function isBoundEventContinuation(
  deps: SubagentThreadWriteGuardDeps,
  request: ResolvedConversationRequest,
  target: SubagentThreadWriteTarget,
): Promise<IConversation | null> {
  if (request._isAgentTrigger !== true || deps.getEventBinding == null) {
    return null;
  }
  const bindingId = request.get('x-lc-agent-event-binding');
  const sourceKeyId = request.get('x-lc-agent-event-source-key');
  if (bindingId == null || sourceKeyId == null) {
    return null;
  }
  const binding = await deps.getEventBinding({
    user: target.userId,
    bindingId,
    sourceKeyId,
    ...(target.tenantId == null ? {} : { tenantId: target.tenantId }),
  });
  if (
    binding?.conversationId !== target.conversationId ||
    !isAgentEventRetentionActive(binding?.expiredAt)
  ) {
    return null;
  }
  const parent = await deps.getConvo(target.userId, binding.lineage.parentConversationId);
  if (
    parent == null ||
    parent.subagentThread != null ||
    parent.agent_id !== binding.lineage.parentAgentId ||
    (parent.tenantId ?? undefined) !== target.tenantId ||
    !isAgentEventRetentionActive(parent.expiredAt)
  ) {
    return null;
  }
  return {
    [PARTIAL_RESOLVED_CONVERSATION]: true,
    user: target.userId,
    conversationId: binding.conversationId,
    agent_id: binding.agentId,
    ...(binding.tenantId == null ? {} : { tenantId: binding.tenantId }),
    ...(binding.isTemporary == null ? {} : { isTemporary: binding.isTemporary }),
    ...(binding.expiredAt == null ? {} : { expiredAt: binding.expiredAt }),
    agentEventBinding: binding.binding,
    subagentThread: binding.lineage,
  } as unknown as IConversation;
}

async function resolveSubagentThreadWrite(
  { getConvo, store }: SubagentThreadWriteGuardDeps,
  target: SubagentThreadWriteTarget,
): Promise<SubagentThreadWriteResolution> {
  const { userId, conversationId, tenantId } = target;
  const readConversation = (): Promise<IConversation | null> =>
    target.conversation !== undefined
      ? Promise.resolve(target.conversation)
      : getConvo(userId, conversationId);
  /** New child IDs are returned synchronously by the SDK before Mongo creation can
   * finish. Their reserved UUID namespace closes that brief window on every replica. */
  if (isReservedSubagentThreadId(conversationId)) {
    const conversation = await readConversation();
    return { blocked: true, conversation };
  }
  if (store.isThreadActiveForOwner(userId, conversationId, tenantId)) {
    return { blocked: true };
  }
  const conversation = await readConversation();
  return { blocked: conversation?.subagentThread != null, conversation };
}

/** Applies the same immutable-child policy to every server write adapter. */
export async function isSubagentThreadWriteBlocked(
  deps: SubagentThreadWriteGuardDeps,
  target: SubagentThreadWriteTarget,
): Promise<boolean> {
  return (await resolveSubagentThreadWrite(deps, target)).blocked;
}

/** Rejects model-bound turns for durable or provisionally-created child threads. */
export function createSubagentThreadTurnGuard(deps: SubagentThreadWriteGuardDeps): RequestHandler {
  return async (request: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = request.body as SubagentTurnBody | undefined;
    const user = request.user as SubagentTurnUser | undefined;
    const candidateConversationId = body?.conversationId ?? body?.arg?.conversationId;
    if (
      typeof candidateConversationId !== 'string' ||
      candidateConversationId === '' ||
      candidateConversationId === Constants.NEW_CONVO
    ) {
      next();
      return;
    }
    const rawUserId = user?.id ?? user?._id;
    if (rawUserId == null) {
      next();
      return;
    }
    const userId = String(rawUserId);
    const tenantId =
      typeof user?.tenantId === 'string' && user.tenantId !== '' ? user.tenantId : undefined;

    try {
      const resolvedRequest = request as ResolvedConversationRequest;
      const resolved = await resolveSubagentThreadWrite(deps, {
        userId,
        conversationId: candidateConversationId,
        ...(tenantId == null ? {} : { tenantId }),
        ...(Object.prototype.hasOwnProperty.call(request, 'resolvedConversation')
          ? { conversation: resolvedRequest.resolvedConversation }
          : {}),
      });
      if (resolved.conversation !== undefined) {
        (request as ResolvedConversationRequest).resolvedConversation = resolved.conversation;
      }
      if (!resolved.blocked) {
        next();
        return;
      }
      const resolvedConversation = resolved.conversation;
      const lineage = resolvedConversation?.subagentThread;
      const humanResume = deps.isHumanResumeAllowed;
      if (
        request.path === '/resume' &&
        resolvedConversation?.agentEventBinding != null &&
        lineage != null &&
        isAgentEventRetentionActive(resolvedConversation.expiredAt) &&
        humanResume != null &&
        (await humanResume({
          userId,
          conversationId: candidateConversationId,
          ...(tenantId == null ? {} : { tenantId }),
        }))
      ) {
        const parent = await deps.getConvo(userId, lineage.parentConversationId);
        if (
          parent != null &&
          parent.subagentThread == null &&
          parent.agent_id === lineage.parentAgentId &&
          (parent.tenantId ?? undefined) === tenantId &&
          isAgentEventRetentionActive(parent.expiredAt)
        ) {
          applyEventBindingContext(resolvedRequest, resolvedConversation);
          next();
          return;
        }
      }
      const boundConversation = await isBoundEventContinuation(
        deps,
        request as ResolvedConversationRequest,
        {
          userId,
          conversationId: candidateConversationId,
          ...(tenantId == null ? {} : { tenantId }),
        },
      );
      if (boundConversation != null) {
        if (resolvedConversation?.conversationId === boundConversation.conversationId) {
          boundConversation.spec = resolvedConversation.spec;
        }
        applyEventBindingContext(resolvedRequest, boundConversation);
        next();
        return;
      }
      res.status(409).json({ error: CHILD_THREAD_READ_ONLY_ERROR });
    } catch (error) {
      next(error);
    }
  };
}
