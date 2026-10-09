import { createHash } from 'node:crypto';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type {
  AgentMethods,
  ConversationMethods,
  IAgent,
  IAgentEventBindingRecord,
  IConversation,
  MessageMethods,
} from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import { isAgentEventRetentionActive } from '../eventRetention';
import { createSubagentThreadId } from '../subagentThreadIds';

const BINDING_ID_PATTERN = /^evtbind_[a-f0-9]{48}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+=-]+$/;
const MAX_ACTOR_ID_LENGTH = 128;
const MAX_REGISTRATION_KEY_LENGTH = 256;

interface EventBindingUser {
  id?: string;
  role?: string;
  tenantId?: string;
}

interface EventBindingRequest extends Request {
  apiKeyId?: { toString(): string } | string;
  user?: EventBindingUser;
  _agentEventBindingResolved?: boolean;
}

interface RegisterBindingBody {
  actorId?: unknown;
  parentConversationId?: unknown;
  parentMessageId?: unknown;
  target?: { agentId?: unknown };
}

export interface AgentEventBindingDependencies {
  getAgent: AgentMethods['getAgent'];
  getConvo: ConversationMethods['getConvo'];
  getBinding: ConversationMethods['getAgentEventBinding'];
  getMessage: MessageMethods['getMessage'];
  deleteConvos: ConversationMethods['deleteConvos'];
  reserveThread: ConversationMethods['reserveSubagentThread'];
}

class AgentEventBindingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'invalid_event_binding',
  ) {
    super(message);
    this.name = 'AgentEventBindingError';
  }
}

function requireString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AgentEventBindingError(`${name} must be a non-empty string of at most ${max} bytes`);
  }
  return value;
}

function requirePrincipal(req: EventBindingRequest): {
  userId: string;
  tenantId?: string;
  sourceKeyId: string;
} {
  const userId = requireString(req.user?.id, 'Authenticated user ID');
  const sourceKeyId = requireString(req.apiKeyId?.toString(), 'Authenticated API key ID');
  return {
    userId,
    sourceKeyId,
    ...(typeof req.user?.tenantId === 'string' && req.user.tenantId !== ''
      ? { tenantId: req.user.tenantId }
      : {}),
  };
}

function tenantMatches(actual: string | undefined, expected: string | undefined): boolean {
  return actual == null ? expected == null : actual === expected;
}

function configuredChild(parentAgent: IAgent, targetAgentId: string): boolean {
  const parentId = typeof parentAgent.id === 'string' ? parentAgent.id : undefined;
  const subagents = parentAgent.subagents as
    | { enabled?: boolean; allowSelf?: boolean; agent_ids?: unknown[] }
    | undefined;
  if (subagents?.enabled !== true) {
    return false;
  }
  if (targetAgentId === parentId && subagents.allowSelf !== false) {
    return true;
  }
  return subagents.agent_ids?.includes(targetAgentId) === true;
}

function bindingId(
  userId: string,
  tenantId: string | undefined,
  sourceKeyId: string,
  registrationKey: string,
): string {
  const digest = createHash('sha256')
    .update(
      `librechat:agent-event-binding:v1\u0000${userId}\u0000${tenantId ?? ''}\u0000${sourceKeyId}\u0000${registrationKey}`,
    )
    .digest('hex');
  return `evtbind_${digest.slice(0, 48)}`;
}

function registrationKey(req: Request): string {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'idempotency-key') {
      values.push(req.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length !== 1) {
    throw new AgentEventBindingError('Exactly one Idempotency-Key header is required');
  }
  const value = requireString(values[0].trim(), 'Idempotency-Key', MAX_REGISTRATION_KEY_LENGTH);
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AgentEventBindingError('Idempotency-Key contains invalid characters');
  }
  return value;
}

function publicBinding(record: IAgentEventBindingRecord) {
  return {
    id: record.binding.bindingId,
    actorId: record.binding.actorId,
    agentId: record.agentId,
    threadId: record.conversationId,
  };
}

function assertReplay(
  record: IAgentEventBindingRecord,
  expected: {
    bindingId: string;
    sourceKeyId: string;
    actorId: string;
    parentConversationId: string;
    parentMessageId: string;
    parentAgentId: string;
    targetAgentId: string;
  },
): void {
  const binding = record.binding;
  const lineage = record.lineage;
  if (
    binding?.bindingId !== expected.bindingId ||
    binding.sourceKeyId !== expected.sourceKeyId ||
    binding.actorId !== expected.actorId ||
    record.agentId !== expected.targetAgentId ||
    lineage?.parentConversationId !== expected.parentConversationId ||
    lineage.parentMessageId !== expected.parentMessageId ||
    lineage.parentAgentId !== expected.parentAgentId ||
    lineage.subagentType !== expected.targetAgentId ||
    lineage.subagentKind !== 'agent' ||
    lineage.depth !== 1
  ) {
    throw new AgentEventBindingError(
      'Idempotency-Key was already used for a different event binding',
      409,
      'idempotency_conflict',
    );
  }
}

function bindingRecord(conversation: IConversation): IAgentEventBindingRecord {
  if (
    conversation.agentEventBinding == null ||
    conversation.subagentThread == null ||
    typeof conversation.agent_id !== 'string'
  ) {
    throw new AgentEventBindingError('Reserved event binding is incomplete', 500);
  }
  return {
    conversationId: conversation.conversationId,
    agentId: conversation.agent_id,
    ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
    ...(conversation.isTemporary == null ? {} : { isTemporary: conversation.isTemporary }),
    ...(conversation.expiredAt == null ? {} : { expiredAt: conversation.expiredAt }),
    binding: conversation.agentEventBinding,
    lineage: conversation.subagentThread,
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof AgentEventBindingError) {
    res.status(error.status).json({
      error: { message: error.message, type: 'invalid_request_error', code: error.code },
    });
    return;
  }
  throw error;
}

export function createAgentEventBindingHandlers(deps: AgentEventBindingDependencies): {
  register: RequestHandler;
  resolve: RequestHandler;
} {
  const register: RequestHandler = async (baseReq, res, next) => {
    const req = baseReq as EventBindingRequest;
    try {
      const principal = requirePrincipal(req);
      const body = (req.body ?? {}) as RegisterBindingBody;
      const actorId = requireString(body.actorId, 'actorId', MAX_ACTOR_ID_LENGTH);
      const parentConversationId = requireString(body.parentConversationId, 'parentConversationId');
      const parentMessageId = requireString(body.parentMessageId, 'parentMessageId');
      const targetAgentId = requireString(body.target?.agentId, 'target.agentId');
      const id = bindingId(
        principal.userId,
        principal.tenantId,
        principal.sourceKeyId,
        registrationKey(req),
      );
      const bindingQuery = {
        user: principal.userId,
        bindingId: id,
        sourceKeyId: principal.sourceKeyId,
        ...(principal.tenantId == null ? {} : { tenantId: principal.tenantId }),
      };
      const cleanupBinding = async (conversationId: string): Promise<void> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await deps.deleteConvos(principal.userId, { conversationId });
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw new AgentEventBindingError(
          `Reserved event binding cleanup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          503,
          'event_binding_cleanup_failed',
        );
      };
      const expectedBinding = (parentAgentId: string) => ({
        bindingId: id,
        sourceKeyId: principal.sourceKeyId,
        actorId,
        parentConversationId,
        parentMessageId,
        parentAgentId,
        targetAgentId,
      });
      const [parent, parentMessage] = await Promise.all([
        deps.getConvo(principal.userId, parentConversationId),
        deps.getMessage({ user: principal.userId, messageId: parentMessageId }),
      ]);
      if (
        parent == null ||
        parent.subagentThread != null ||
        !tenantMatches(parent.tenantId, principal.tenantId) ||
        typeof parent.agent_id !== 'string' ||
        !isAgentEventRetentionActive(parent.expiredAt)
      ) {
        const orphan = await deps.getBinding(bindingQuery);
        if (orphan != null) {
          const orphanParentAgentId = orphan.lineage.parentAgentId;
          if (typeof orphanParentAgentId !== 'string' || orphanParentAgentId === '') {
            await cleanupBinding(orphan.conversationId);
            throw new AgentEventBindingError(
              'Parent agent conversation ended during binding registration',
              409,
              'event_binding_parent_ended',
            );
          }
          assertReplay(orphan, expectedBinding(orphanParentAgentId));
          await cleanupBinding(orphan.conversationId);
          throw new AgentEventBindingError(
            'Parent agent conversation ended during binding registration',
            409,
            'event_binding_parent_ended',
          );
        }
        throw new AgentEventBindingError('Parent agent conversation was not found', 404);
      }
      if (parentMessage?.conversationId !== parentConversationId) {
        throw new AgentEventBindingError('Parent agent message was not found', 404);
      }
      const resolvedParentAgent = await deps.getAgent({ id: parent.agent_id });
      if (resolvedParentAgent == null || !configuredChild(resolvedParentAgent, targetAgentId)) {
        throw new AgentEventBindingError(
          'Target agent is not configured as a direct child of the parent agent',
          403,
          'event_binding_forbidden',
        );
      }

      const scopeId = JSON.stringify({
        userId: principal.userId,
        parentConversationId,
        ...(principal.tenantId == null ? {} : { tenantId: principal.tenantId }),
      });
      const threadId = createSubagentThreadId(scopeId, id);
      const expected = expectedBinding(parent.agent_id);
      const assertCurrentParent = async (): Promise<void> => {
        const currentParent = await deps.getConvo(principal.userId, parentConversationId);
        if (
          currentParent == null ||
          currentParent.subagentThread != null ||
          currentParent.agent_id !== parent.agent_id ||
          !tenantMatches(currentParent.tenantId, principal.tenantId) ||
          !isAgentEventRetentionActive(currentParent.expiredAt)
        ) {
          throw new AgentEventBindingError(
            'Parent agent conversation ended during binding registration',
            409,
            'event_binding_parent_ended',
          );
        }
      };
      const assertCurrentParentOrCleanup = async (
        record: IAgentEventBindingRecord,
      ): Promise<void> => {
        try {
          await assertCurrentParent();
        } catch (error) {
          if (
            !(error instanceof AgentEventBindingError) ||
            error.code !== 'event_binding_parent_ended'
          ) {
            throw error;
          }
          await cleanupBinding(record.conversationId);
          throw error;
        }
      };
      const replay = await deps.getBinding(bindingQuery);
      if (replay != null) {
        assertReplay(replay, expected);
        await assertCurrentParentOrCleanup(replay);
        res.status(200).json(publicBinding(replay));
        return;
      }
      let reserved;
      try {
        reserved = await deps.reserveThread({
          user: principal.userId,
          conversationId: threadId,
          ...(principal.tenantId == null ? {} : { tenantId: principal.tenantId }),
          conversation: {
            conversationId: threadId,
            endpoint: EModelEndpoint.agents,
            title: `Agent actor: ${actorId}`.slice(0, 120),
            agent_id: targetAgentId,
            ...(parent.isTemporary == null ? {} : { isTemporary: parent.isTemporary }),
            ...(parent.expiredAt == null ? {} : { expiredAt: parent.expiredAt }),
            ...(principal.tenantId == null ? {} : { tenantId: principal.tenantId }),
            agentEventBinding: { bindingId: id, sourceKeyId: principal.sourceKeyId, actorId },
            subagentThread: {
              rootConversationId: parentConversationId,
              parentConversationId,
              parentMessageId,
              parentToolCallId: `event-binding:${id}`,
              parentAgentId: parent.agent_id,
              subagentType: targetAgentId,
              subagentKind: 'agent',
              depth: 1,
            },
          },
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) {
          throw error;
        }
        const winner = await deps.getBinding(bindingQuery);
        if (winner == null) {
          throw error;
        }
        assertReplay(winner, expected);
        await assertCurrentParentOrCleanup(winner);
        res.status(200).json(publicBinding(winner));
        return;
      }
      const record = bindingRecord(reserved.conversation);
      assertReplay(record, expected);
      await assertCurrentParentOrCleanup(record);
      res.status(reserved.created ? 201 : 200).json(publicBinding(record));
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  };

  const resolve: RequestHandler = async (baseReq, res, next) => {
    const req = baseReq as EventBindingRequest;
    try {
      const principal = requirePrincipal(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.mode !== 'continue') {
        if (body.bindingId != null) {
          throw new AgentEventBindingError('bindingId is valid only for continue events');
        }
        next();
        return;
      }
      const id = requireString(body.bindingId, 'bindingId');
      if (!BINDING_ID_PATTERN.test(id)) {
        throw new AgentEventBindingError('bindingId is invalid');
      }
      const binding = await deps.getBinding({
        user: principal.userId,
        bindingId: id,
        sourceKeyId: principal.sourceKeyId,
        ...(principal.tenantId == null ? {} : { tenantId: principal.tenantId }),
      });
      if (binding == null) {
        throw new AgentEventBindingError(
          'Event binding was not found',
          404,
          'event_binding_not_found',
        );
      }
      req.body = {
        ...body,
        orderingKey: id,
        mode: 'continue',
        target: {
          agentId: binding.agentId,
          conversationId: binding.conversationId,
          parentMessageId: Constants.NO_PARENT,
          bindingId: id,
          sourceKeyId: principal.sourceKeyId,
        },
      };
      req._agentEventBindingResolved = true;
      next();
    } catch (error) {
      try {
        sendError(res, error);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  };

  return { register, resolve };
}
