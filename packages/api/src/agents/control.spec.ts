import type { IConversation } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { controlFingerprint, SubagentTaskOwnerUnavailableError } from './subagentTaskRouting';
import { createSubagentControlHandler, isValidSubagentControlRequest } from './control';

const parentConversationId = 'parent-conversation';
const threadId = 'child-thread';
const taskId = 'task-1';
const parent = {
  conversationId: parentConversationId,
  user: 'user-1',
  tenantId: 'tenant-1',
} as IConversation;
const child = {
  conversationId: threadId,
  user: 'user-1',
  tenantId: 'tenant-1',
  subagentThread: {
    rootConversationId: parentConversationId,
    parentConversationId,
    parentMessageId: 'parent-message',
    parentToolCallId: 'parent-tool-call',
    parentAgentId: 'parent-agent',
    subagentType: 'researcher',
    subagentKind: 'agent',
    depth: 1,
  },
  subagentThreadLease: {
    token: 'lease-token',
    taskId,
    expiresAt: new Date('2099-08-24T12:00:00.000Z'),
  },
} as IConversation;

const response = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { value: { status } as unknown as Response, status, json };
};

const request = (body: Record<string, unknown>): ServerRequest =>
  ({
    params: { parentConversationId, threadId },
    body,
    user: { id: 'user-1', tenantId: 'tenant-1' },
  }) as ServerRequest;

const dependencies = (controlTask = jest.fn()) => ({
  getConvoOwnership: jest.fn().mockResolvedValue(parent),
  getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
  getMessages: jest
    .fn()
    .mockResolvedValue([{ messageId: `${taskId}:user`, subagentTask: { status: 'running' } }]),
  getSubagentTaskControlReceipt: jest.fn().mockResolvedValue(null),
  recordSubagentTaskControlReceipt: jest.fn().mockResolvedValue(true),
  store: { controlTask },
});

describe('subagent control handler', () => {
  it('rejects fields outside the action-specific public control contract', () => {
    expect(
      isValidSubagentControlRequest({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Check the primary source.',
      }),
    ).toBe(true);
    expect(
      isValidSubagentControlRequest({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Check the primary source.',
        answers: ['unrelated moderation input'],
      }),
    ).toBe(false);
    expect(
      isValidSubagentControlRequest({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel',
        message: 'unused',
      }),
    ).toBe(false);
  });

  it('returns one bounded public accepted receipt from the authorized live owner', async () => {
    const controlTask = jest.fn().mockResolvedValue({
      status: 'accepted',
      controlId: 'control-1',
      task: { taskId, threadId, status: 'running' },
    });
    const deps = dependencies(controlTask);
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Check the primary source.',
      }),
      res.value,
    );

    expect(controlTask).toHaveBeenCalledWith(
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        parentConversationId,
        tenantId: 'tenant-1',
      }),
      taskId,
      { action: 'queue', message: 'Check the primary source.' },
      'invocation-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        controlId: 'control-1',
        action: 'queue',
        status: 'accepted',
      }),
    });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('task');
    expect(deps.getMessages).toHaveBeenCalledWith(
      {
        user: 'user-1',
        tenantId: 'tenant-1',
        conversationId: threadId,
        messageId: `${taskId}:user`,
      },
      '+subagentTask',
    );
  });

  it('returns the durable applied receipt when settlement races the owner response', async () => {
    const command = { action: 'queue' as const, message: 'Check the primary source.' };
    const controlTask = jest.fn().mockResolvedValue({
      status: 'accepted',
      controlId: 'control-1',
      task: { taskId, threadId, status: 'running' },
    });
    const deps = dependencies(controlTask);
    deps.getSubagentTaskControlReceipt.mockResolvedValueOnce(null).mockResolvedValueOnce({
      invocationId: 'invocation-race',
      fingerprint: controlFingerprint(command),
      controlId: 'control-1',
      action: 'queue',
      status: 'applied',
      boundary: 'turn',
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:01.000Z'),
    });
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(request({ taskId, invocationId: 'invocation-race', ...command }), res.value);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-race',
        status: 'applied',
        boundary: 'turn',
      }),
    });
    expect(deps.getSubagentTaskControlReceipt).toHaveBeenCalledTimes(2);
  });

  it('fails parent authorization closed without contacting a task owner', async () => {
    const deps = dependencies();
    deps.getConvoOwnership.mockResolvedValue(null);
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel_message',
        controlId: 'queued-control',
      }),
      res.value,
    );

    expect(deps.store.controlTask).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('reads a tenantless task seed only from tenantless rows', async () => {
    const controlTask = jest.fn().mockResolvedValue({
      status: 'accepted',
      controlId: 'control-1',
      task: { taskId, threadId, status: 'running' },
    });
    const deps = dependencies(controlTask);
    deps.getConvoOwnership.mockResolvedValue({ ...parent, tenantId: undefined });
    deps.getSubagentThreadForParent.mockResolvedValue({ ...child, tenantId: undefined });
    const req = request({
      taskId,
      invocationId: 'invocation-1',
      action: 'queue',
      message: 'Check the primary source.',
    });
    req.user = { id: 'user-1' } as ServerRequest['user'];
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(req, res.value);

    expect(deps.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        conversationId: threadId,
        messageId: `${taskId}:user`,
        tenantId: { $exists: false },
      }),
      '+subagentTask',
    );
    expect(controlTask).toHaveBeenCalledTimes(1);
  });

  it('returns an authoritative rejection when the selected task is no longer live', async () => {
    const deps = dependencies(
      jest.fn().mockResolvedValue({
        status: 'not_running',
        task: { taskId, threadId, status: 'completed' },
      }),
    );
    deps.getSubagentThreadForParent.mockResolvedValue({
      ...child,
      subagentThreadLease: undefined,
    });
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel_message',
        controlId: 'queued-control',
      }),
      res.value,
    );

    expect(deps.store.controlTask).toHaveBeenCalledWith(
      expect.any(String),
      taskId,
      { action: 'cancel_message', controlId: 'queued-control' },
      'invocation-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        controlId: 'queued-control',
        action: 'cancel_message',
        status: 'rejected',
        reason: 'task_not_running',
      }),
    });
  });

  it('replays the durable authoritative receipt before rejecting an expired lease', async () => {
    const deps = dependencies();
    deps.getSubagentThreadForParent.mockResolvedValue({
      ...child,
      subagentThreadLease: undefined,
    });
    deps.getSubagentTaskControlReceipt.mockResolvedValue({
      invocationId: 'invocation-1',
      fingerprint: controlFingerprint({ action: 'queue', message: 'Check the primary source.' }),
      controlId: 'control-1',
      action: 'queue',
      status: 'applied',
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:01.000Z'),
      boundary: 'turn',
      message: 'Check the primary source.',
    });
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Check the primary source.',
      }),
      res.value,
    );

    expect(deps.store.controlTask).not.toHaveBeenCalled();
    expect(deps.recordSubagentTaskControlReceipt).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'applied',
        boundary: 'turn',
      }),
    });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('fingerprint');
  });

  it('never exposes a private reservation as an accepted public receipt', async () => {
    const controlTask = jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError());
    const deps = dependencies(controlTask);
    deps.getSubagentTaskControlReceipt.mockResolvedValue({
      invocationId: 'invocation-1',
      fingerprint: controlFingerprint({ action: 'queue', message: 'Check the primary source.' }),
      action: 'queue',
      status: 'reserved',
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
      message: 'Check the primary source.',
    });
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Check the primary source.',
      }),
      res.value,
    );

    expect(controlTask).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'failed',
        reason: 'owner_unavailable',
      }),
    });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('reserved');
  });

  it('rejects invocation-id reuse with different command content', async () => {
    const deps = dependencies();
    deps.getSubagentTaskControlReceipt.mockResolvedValue({
      invocationId: 'invocation-1',
      fingerprint: controlFingerprint({ action: 'queue', message: 'Original command.' }),
      controlId: 'control-1',
      action: 'queue',
      status: 'accepted',
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
      message: 'Original command.',
    });
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'queue',
        message: 'Different command.',
      }),
      res.value,
    );

    expect(deps.store.controlTask).not.toHaveBeenCalled();
    expect(deps.recordSubagentTaskControlReceipt).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'rejected',
        reason: 'invalid_command',
      }),
    });
  });

  it('preserves a missing cancel_message target in the authoritative rejection', async () => {
    const deps = dependencies(
      jest.fn().mockResolvedValue({
        status: 'control_not_found',
        task: { taskId, threadId, status: 'running' },
      }),
    );
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel_message',
        controlId: 'missing-control',
      }),
      res.value,
    );

    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        controlId: 'missing-control',
        action: 'cancel_message',
        status: 'rejected',
        reason: 'control_not_found',
      }),
    });
  });

  it('makes owner unavailability explicit so the same invocation can be retried', async () => {
    const deps = dependencies(jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()));
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({ taskId, invocationId: 'invocation-1', action: 'interrupt', message: 'Stop.' }),
      res.value,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'failed',
        reason: 'owner_unavailable',
      }),
    });
  });

  it('returns a retryable failure when routing cannot resolve a live owner', async () => {
    const deps = dependencies(
      jest.fn().mockResolvedValue({
        status: 'not_found',
        task: { taskId, threadId, status: 'running' },
      }),
    );
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({ taskId, invocationId: 'invocation-1', action: 'queue', message: 'Continue.' }),
      res.value,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'failed',
        reason: 'owner_unavailable',
      }),
    });
  });

  it('rejects a task result owned by a sibling child thread', async () => {
    const deps = dependencies(
      jest.fn().mockResolvedValue({
        status: 'accepted',
        controlId: 'control-1',
        task: { taskId, threadId: 'sibling-thread', status: 'running' },
      }),
    );
    const handler = createSubagentControlHandler(deps);
    const res = response();
    deps.getSubagentThreadForParent.mockResolvedValue({
      ...child,
      subagentThreadLease: undefined,
    });
    deps.getMessages.mockResolvedValue([]);

    await handler(
      request({ taskId, invocationId: 'invocation-1', action: 'queue', message: 'Continue.' }),
      res.value,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    expect(deps.store.controlTask).not.toHaveBeenCalled();
  });

  it('keeps a live pre-seed control retryable without applying it', async () => {
    const deps = dependencies();
    deps.getMessages.mockResolvedValue([]);
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({ taskId, invocationId: 'invocation-1', action: 'queue', message: 'Continue.' }),
      res.value,
    );

    expect(deps.store.controlTask).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      receipt: expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'failed',
        reason: 'owner_unavailable',
      }),
    });
  });

  it('rejects malformed controls before authorization or routing', async () => {
    const deps = dependencies();
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({ taskId, invocationId: 'invocation-1', action: 'steer', message: ' ' }),
      res.value,
    );

    expect(deps.getConvoOwnership).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects task ids beyond the durable storage bound before authorization', async () => {
    const deps = dependencies();
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId: 't'.repeat(257),
        invocationId: 'invocation-1',
        action: 'cancel',
      }),
      res.value,
    );

    expect(deps.getConvoOwnership).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['parentConversationId', 'threadId'] as const)(
    'rejects %s beyond the downstream storage bound before authorization',
    async (field) => {
      const deps = dependencies();
      const handler = createSubagentControlHandler(deps);
      const req = request({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel',
      });
      (req.params as Record<string, string>)[field] = 'c'.repeat(257);
      const res = response();

      await handler(req, res.value);

      expect(deps.getConvoOwnership).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    },
  );

  it('rejects control ids beyond the durable receipt bound before authorization', async () => {
    const deps = dependencies();
    const handler = createSubagentControlHandler(deps);
    const res = response();

    await handler(
      request({
        taskId,
        invocationId: 'invocation-1',
        action: 'cancel_message',
        controlId: 'c'.repeat(257),
      }),
      res.value,
    );

    expect(deps.getConvoOwnership).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
