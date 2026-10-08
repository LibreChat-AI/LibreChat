import type {
  SubagentControlAction,
  SubagentControlReceipt,
  SubagentControlRequest,
  SubagentControlResponse,
} from 'librechat-data-provider';
import type {
  ConversationMethods,
  ISubagentTaskControlReceipt,
  MessageMethods,
} from '@librechat/data-schemas';
import type { SubagentTaskControlCommand, SubagentTaskControlResult } from '@librechat/agents';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { controlFingerprint, SubagentTaskOwnerUnavailableError } from './subagentTaskRouting';
import { createSubagentThreadScopeId } from './subagentThreads';

const MAX_THREAD_ID_BYTES = 256;
const MAX_TASK_ID_BYTES = 256;
const MAX_INVOCATION_ID_BYTES = 128;
const MAX_CONTROL_MESSAGE_CHARS = 4 * 1024;

type ControlStore = {
  controlTask(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult>;
};

type Dependencies = Pick<ConversationMethods, 'getConvoOwnership' | 'getSubagentThreadForParent'> &
  Pick<MessageMethods, 'getMessages' | 'getSubagentTaskControlReceipt'> & {
    store: ControlStore;
  };

type Params = {
  parentConversationId?: string;
  threadId?: string;
};

const validId = (value: unknown, byteLimit = MAX_THREAD_ID_BYTES): value is string =>
  typeof value === 'string' && value.trim() !== '' && Buffer.byteLength(value, 'utf8') <= byteLimit;

const validAction = (value: unknown): value is SubagentControlAction =>
  value === 'steer' ||
  value === 'queue' ||
  value === 'interrupt' ||
  value === 'cancel' ||
  value === 'cancel_message';

const requestKeysForAction = (action: SubagentControlAction): Set<string> => {
  const keys = new Set(['taskId', 'invocationId', 'action']);
  if (action === 'cancel_message') keys.add('controlId');
  else if (action !== 'cancel') keys.add('message');
  return keys;
};

const commandFromRequest = (
  body: SubagentControlRequest,
): SubagentTaskControlCommand | undefined => {
  if (!validAction(body.action)) return undefined;
  if (body.action === 'cancel') return { action: 'cancel' };
  if (body.action === 'cancel_message') {
    return validId(body.controlId, MAX_TASK_ID_BYTES)
      ? { action: 'cancel_message', controlId: body.controlId }
      : undefined;
  }
  if (
    typeof body.message !== 'string' ||
    body.message.trim() === '' ||
    body.message.length > MAX_CONTROL_MESSAGE_CHARS
  ) {
    return undefined;
  }
  return { action: body.action, message: body.message };
};

/** Cheap structural admission shared by the Express route and authoritative
 * handler. It must run before filters, moderation, or owner routing. */
export const isValidSubagentControlRequest = (value: unknown): value is SubagentControlRequest => {
  if (value == null || typeof value !== 'object') return false;
  const body = value as Partial<SubagentControlRequest>;
  if (!validAction(body.action)) return false;
  const allowedKeys = requestKeysForAction(body.action);
  return (
    Object.keys(body).every((key) => allowedKeys.has(key)) &&
    validId(body.taskId, MAX_TASK_ID_BYTES) &&
    validId(body.invocationId, MAX_INVOCATION_ID_BYTES) &&
    commandFromRequest(body as SubagentControlRequest) != null
  );
};

const commandReceiptFields = (command: SubagentTaskControlCommand) => ({
  ...(command.action === 'cancel_message' ? { controlId: command.controlId } : {}),
  ...('message' in command ? { message: command.message } : {}),
});

const responseReceipt = (
  invocationId: string,
  command: SubagentTaskControlCommand,
  result: SubagentTaskControlResult,
): SubagentControlReceipt => {
  const now = new Date().toISOString();
  let status: SubagentControlReceipt['status'] = 'rejected';
  let reason: string | undefined;
  if (result.status === 'accepted')
    status = command.action === 'cancel_message' ? 'applied' : 'accepted';
  if (result.status === 'cancelled') status = 'applied';
  if (result.status === 'not_running') reason = 'task_not_running';
  if (result.status === 'control_not_found') reason = 'control_not_found';
  if (result.status === 'invalid') reason = 'invalid_command';
  if (result.status === 'not_found') {
    status = 'failed';
    reason = 'owner_unavailable';
  }
  return {
    invocationId,
    ...commandReceiptFields(command),
    ...(command.action !== 'cancel_message' &&
    result.status === 'accepted' &&
    result.controlId != null
      ? { controlId: result.controlId }
      : {}),
    action: command.action,
    status,
    createdAt: now,
    updatedAt: now,
    ...(reason == null ? {} : { reason }),
  };
};

const publicStoredReceipt = ({
  fingerprint: _fingerprint,
  createdAt,
  updatedAt,
  status,
  ...receipt
}: ISubagentTaskControlReceipt): SubagentControlReceipt => {
  if (status === 'reserved') {
    throw new SubagentTaskOwnerUnavailableError();
  }
  return {
    ...receipt,
    status,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
};

/** Applies one parent-authorized control to the live owner and returns only its public receipt. */
export function createSubagentControlHandler(deps: Dependencies) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const tenantId = req.user?.tenantId || undefined;
    const { parentConversationId, threadId } = req.params as Params;
    const body = (req.body ?? {}) as Partial<SubagentControlRequest>;
    const command = commandFromRequest(body as SubagentControlRequest);
    if (
      !userId ||
      !validId(parentConversationId, MAX_THREAD_ID_BYTES) ||
      !validId(threadId, MAX_THREAD_ID_BYTES) ||
      parentConversationId === threadId ||
      !isValidSubagentControlRequest(body) ||
      command == null
    ) {
      res.status(400).json({ error: 'Invalid subagent control request' });
      return;
    }

    try {
      const [parent, child] = await Promise.all([
        deps.getConvoOwnership(userId, parentConversationId, tenantId ?? null),
        deps.getSubagentThreadForParent({
          user: userId,
          parentConversationId,
          conversationId: threadId,
          ...(tenantId == null ? {} : { tenantId }),
        }),
      ]);
      if (
        parent == null ||
        child?.subagentThread?.parentConversationId !== parentConversationId ||
        parent.tenantId !== tenantId ||
        child.tenantId !== tenantId
      ) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      const fingerprint = controlFingerprint(command);
      const existing = await deps.getSubagentTaskControlReceipt({
        userId,
        conversationId: threadId,
        taskId: body.taskId,
        invocationId: body.invocationId,
        ...(tenantId == null ? {} : { tenantId }),
      });
      /** `reserved` is a server-private at-most-once fence, not an authoritative
       * public receipt. Re-enter the task store so it can return owner-unavailable
       * without exposing false acceptance or reapplying the command. */
      if (existing != null && existing.status !== 'reserved') {
        const receipt =
          existing.fingerprint === fingerprint
            ? publicStoredReceipt(existing)
            : responseReceipt(body.invocationId, command, {
                status: 'invalid',
                message: 'This control invocation id was already used for a different command.',
              });
        res.status(200).json({ receipt } satisfies SubagentControlResponse);
        return;
      }
      const [taskInput] = await deps.getMessages(
        {
          user: userId,
          conversationId: threadId,
          messageId: `${body.taskId}:user`,
          ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
        },
        '+subagentTask',
      );
      if (taskInput?.subagentTask == null) {
        if (
          child.subagentThreadLease?.taskId === body.taskId &&
          child.subagentThreadLease.expiresAt.getTime() > Date.now()
        ) {
          throw new SubagentTaskOwnerUnavailableError();
        }
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      const scopeId = createSubagentThreadScopeId({
        userId,
        parentConversationId,
        ...(tenantId == null ? {} : { tenantId }),
      });
      /** Retry identity and durable settlement belong to the task store. Route
       * through that ledger even when the visible lease is stale instead of
       * synthesizing a rejection that can race the owner's delayed receipt. */
      const result = await deps.store.controlTask(scopeId, body.taskId, command, body.invocationId);
      if (result.status === 'not_found') {
        throw new SubagentTaskOwnerUnavailableError();
      }
      if ('task' in result && result.task.threadId !== threadId) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      /** Routing returns the SDK task result, whose legacy `accepted` shape cannot
       * distinguish an accepted command from one that became applied during the
       * call. The durable ledger is authoritative after the store returns. */
      const settledReceipt = await deps.getSubagentTaskControlReceipt({
        userId,
        conversationId: threadId,
        taskId: body.taskId,
        invocationId: body.invocationId,
        ...(tenantId == null ? {} : { tenantId }),
      });
      const receipt =
        settledReceipt != null && settledReceipt.fingerprint === fingerprint
          ? publicStoredReceipt(settledReceipt)
          : responseReceipt(body.invocationId, command, result);
      res.status(200).json({ receipt } satisfies SubagentControlResponse);
    } catch (error) {
      if (error instanceof SubagentTaskOwnerUnavailableError) {
        const receipt: SubagentControlReceipt = {
          invocationId: body.invocationId,
          ...commandReceiptFields(command),
          action: command.action,
          status: 'failed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reason: 'owner_unavailable',
        };
        res.status(503).json({ receipt } satisfies SubagentControlResponse);
        return;
      }
      res.status(500).json({ error: 'Failed to control subagent task' });
    }
  };
}
