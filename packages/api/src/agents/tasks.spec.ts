import type { Response } from 'express';
import type { PendingBackgroundCompletion } from './backgroundCompletion';
import type { ServerRequest } from '~/types';
import {
  createBackgroundTaskCancelHandler,
  createBackgroundTaskIndexHandler,
  createBackgroundTaskPolicyMiddleware,
} from './tasks';
import { BackgroundTaskRegistryClass } from './background';

const conversationId = 'convo-1';

type PendingList = (input: { userId: string; conversationId: string }) => Promise<{
  completions: PendingBackgroundCompletion[];
  dead: PendingBackgroundCompletion[];
  complete: boolean;
}>;

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
};

const request = ({
  userId = 'user-1',
  cancellation = true,
  body,
}: {
  userId?: string;
  cancellation?: boolean;
  body?: unknown;
} = {}) =>
  ({
    user: { id: userId },
    params: { conversationId },
    body,
    config: {
      endpoints: { agents: { backgroundTasks: { ordinaryToolCancellation: cancellation } } },
    },
  }) as unknown as ServerRequest;

const createTask = (
  registry: BackgroundTaskRegistryClass,
  toolCallId: string,
  requestCancellation: () => boolean | void = jest.fn(),
) => {
  const created = registry.create({
    userId: 'user-1',
    conversationId,
    toolCallId,
    toolName: 'bash_tool',
    messageId: 'message-1',
    requestCancellation,
  });
  if ('atCapacity' in created) {
    throw new Error('unexpected capacity');
  }
  return created.task;
};

describe('background task routes', () => {
  it('loads effective policy without runtime workspace augmentation and fails closed', async () => {
    const req = request();
    const getAppConfig = jest.fn().mockResolvedValue(req.config);
    const next = jest.fn();
    const middleware = createBackgroundTaskPolicyMiddleware({ getAppConfig });
    await middleware(req, response(), next);
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        skipRuntimeAugmentation: true,
        failClosed: true,
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
    getAppConfig.mockRejectedValue(new Error('policy store unavailable'));
    const failed = response();
    await middleware(req, failed, next);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('lists only the caller’s tasks without results', async () => {
    const registry = new BackgroundTaskRegistryClass();
    const running = createTask(registry, 'call-1');
    const done = createTask(registry, 'call-2');
    registry.complete('user-1', conversationId, done.id, { content: 'secret output' });
    const handler = createBackgroundTaskIndexHandler({ registry });

    const res = response();
    await handler(request(), res);
    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.cancellable).toBe(true);
    expect(body.tasks).toEqual([
      expect.objectContaining({
        taskId: running.id,
        toolName: 'bash_tool',
        toolCallId: 'call-1',
        messageId: 'message-1',
        status: 'running',
        cancellationRequested: false,
      }),
      expect.objectContaining({
        taskId: done.id,
        status: 'completed',
        settledAt: expect.any(String),
      }),
    ]);
    expect(body.tasks[0].settledAt).toBeUndefined();
    expect(body.tasks[1].settledAt).toBe(new Date(done.settledAt!).toISOString());
    const later = jest.spyOn(Date, 'now').mockReturnValue(done.settledAt! + 60_000);
    registry.markCompletionPersistenceFinished('user-1', conversationId, done.id);
    later.mockRestore();
    const afterPersistence = response();
    await handler(request(), afterPersistence);
    expect(afterPersistence.json.mock.calls[0][0].tasks[1].settledAt).toBe(body.tasks[1].settledAt);
    expect(JSON.stringify(body)).not.toContain('secret output');

    const other = response();
    await handler(request({ userId: 'user-2', cancellation: false }), other);
    expect(other.json).toHaveBeenCalledWith({
      conversationId,
      tasks: [],
      complete: false,
      cancellable: false,
    });
  });

  describe('result delivery', () => {
    const completion = (
      taskId: string,
      overrides: Partial<PendingBackgroundCompletion> = {},
    ): PendingBackgroundCompletion => ({
      taskId,
      toolCallId: `${taskId}-call`,
      toolName: 'bash_tool',
      dispatchedAt: new Date('2026-09-25T14:52:02.000Z'),
      result: { status: 'completed', settledAt: new Date('2026-09-25T14:52:09.000Z') },
      claimedByWakeup: false,
      ...overrides,
    });

    const finishedWithWakeup = (registry: BackgroundTaskRegistryClass, toolCallId: string) => {
      const task = createTask(registry, toolCallId);
      registry.markCompletionWakeup('user-1', conversationId, task.id);
      registry.complete('user-1', conversationId, task.id, { content: 'ok' });
      return task;
    };

    const list = async (
      registry: BackgroundTaskRegistryClass,
      durable: Awaited<ReturnType<PendingList>>,
    ) => {
      const pending = { list: jest.fn<ReturnType<PendingList>, Parameters<PendingList>>() };
      pending.list.mockResolvedValue(durable);
      const res = response();
      await createBackgroundTaskIndexHandler({ registry, pending })(request(), res);
      expect(pending.list).toHaveBeenCalledWith({ userId: 'user-1', conversationId });
      expect(res.json.mock.calls[0][0].complete).toBe(durable.complete);
      return res.json.mock.calls[0][0].tasks as Array<Record<string, unknown>>;
    };

    it('marks a finished result pending until the agent receives it', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = finishedWithWakeup(registry, 'call-1');
      const tasks = await list(registry, {
        completions: [completion(task.id)],
        dead: [],
        complete: true,
      });
      expect(tasks).toEqual([
        expect.objectContaining({ taskId: task.id, status: 'completed', delivery: 'pending' }),
      ]);
    });

    it('reports delivered once a wake-up on any replica took the result', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = finishedWithWakeup(registry, 'call-1');
      const tasks = await list(registry, { completions: [], dead: [], complete: true });
      expect(tasks[0]).toEqual(expect.objectContaining({ taskId: task.id, delivery: 'delivered' }));
    });

    it('keeps the local view when the durable listing was truncated', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = finishedWithWakeup(registry, 'call-1');
      const tasks = await list(registry, { completions: [], dead: [], complete: false });
      expect(tasks[0]).toEqual(expect.objectContaining({ taskId: task.id, delivery: 'pending' }));
    });

    it('lists finished results this process does not hold, but not remote running work', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const tasks = await list(registry, {
        completions: [
          completion('remote-finished'),
          completion('remote-running', { result: undefined }),
        ],
        dead: [completion('remote-dead', { result: { status: 'error', settledAt: new Date() } })],
        complete: true,
      });
      expect(tasks).toEqual([
        {
          taskId: 'remote-finished',
          toolName: 'bash_tool',
          toolCallId: 'remote-finished-call',
          status: 'completed',
          cancellationRequested: false,
          startedAt: '2026-09-25T14:52:02.000Z',
          settledAt: '2026-09-25T14:52:09.000Z',
          delivery: 'pending',
        },
        expect.objectContaining({ taskId: 'remote-dead', status: 'error', delivery: 'failed' }),
      ]);
    });

    it('marks a local result whose delivery dead-lettered as failed', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = finishedWithWakeup(registry, 'call-1');
      const tasks = await list(registry, {
        completions: [],
        dead: [completion(task.id)],
        complete: true,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual(expect.objectContaining({ taskId: task.id, delivery: 'failed' }));
    });

    it('still lists local tasks when the durable store is unreachable', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = finishedWithWakeup(registry, 'call-1');
      const pending = { list: jest.fn().mockRejectedValue(new Error('mongo down')) };
      const res = response();
      await createBackgroundTaskIndexHandler({ registry, pending })(request(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0]).toMatchObject({
        complete: false,
        tasks: [expect.objectContaining({ taskId: task.id, delivery: 'pending' })],
      });
    });
  });

  it('cancels every running task when no ids are given', () => {
    const registry = new BackgroundTaskRegistryClass();
    const abortFirst = jest.fn();
    const abortSecond = jest.fn();
    const first = createTask(registry, 'call-1', abortFirst);
    const second = createTask(registry, 'call-2', abortSecond);
    const done = createTask(registry, 'call-3');
    registry.complete('user-1', conversationId, done.id, { content: 'ok' });
    const handler = createBackgroundTaskCancelHandler({ registry });

    const res = response();
    handler(request({ body: {} }), res);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { taskId: first.id, status: 'requested' },
        { taskId: second.id, status: 'requested' },
      ],
    });
    expect(abortFirst).toHaveBeenCalledTimes(1);
    expect(abortSecond).toHaveBeenCalledTimes(1);

    const again = response();
    handler(request({ body: { taskIds: [first.id, done.id, 'missing'] } }), again);
    expect(again.json).toHaveBeenCalledWith({
      results: [
        { taskId: first.id, status: 'already_requested' },
        { taskId: done.id, status: 'settled' },
        { taskId: 'missing', status: 'not_found' },
      ],
    });
    expect(abortFirst).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation when the deployment has not opted in', () => {
    const registry = new BackgroundTaskRegistryClass();
    const abort = jest.fn();
    createTask(registry, 'call-1', abort);
    const res = response();
    createBackgroundTaskCancelHandler({ registry })(request({ cancellation: false }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(abort).not.toHaveBeenCalled();
  });

  it('never reaches another user’s tasks', () => {
    const registry = new BackgroundTaskRegistryClass();
    const abort = jest.fn();
    const task = createTask(registry, 'call-1', abort);
    const res = response();
    createBackgroundTaskCancelHandler({ registry })(
      request({ userId: 'user-2', body: { taskIds: [task.id] } }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith({ results: [{ taskId: task.id, status: 'not_found' }] });
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies without accidentally cancelling every task', () => {
    const registry = new BackgroundTaskRegistryClass();
    const abort = jest.fn();
    createTask(registry, 'call-1', abort);
    const handler = createBackgroundTaskCancelHandler({ registry });
    for (const body of [
      undefined,
      null,
      'invalid',
      [],
      { taskIds: null },
      { taskIds: undefined },
      { taskIds: [1] },
    ]) {
      const res = response();
      handler(request({ body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(abort).not.toHaveBeenCalled();
    }
  });
});
