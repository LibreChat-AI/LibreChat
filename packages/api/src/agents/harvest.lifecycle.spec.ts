import type { GenerationSettlementState } from '../stream/interfaces/IJobStore';
import type { GenerationSettledListener } from '../stream/GenerationJobManager';
import type { GenerationSettledSource } from '../stream/settled';
import type { GenerationJobStatus } from '../types/stream';
import type { ServerRequest } from '~/types';
import { InMemoryEventTransport } from '../stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../stream/GenerationJobManager';
import { createBackgroundCodeResultHandler } from './harvest';
import { waitForGenerationSettled } from '../stream/settled';

function sourceForRunningTurn() {
  const listeners = new Set<GenerationSettledListener>();
  const job: {
    status: GenerationJobStatus;
    createdAt: number;
    terminalPersistencePending?: boolean;
  } = { status: 'running', createdAt: 1 };
  return {
    job,
    listeners,
    getGenerationSettlementState: jest.fn(
      async (): Promise<GenerationSettlementState | undefined> => ({ ...job }),
    ),
    onGenerationSettled: (listener: GenerationSettledListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settle: () => {
      job.status = 'complete';
      for (const listener of [...listeners])
        listener({
          streamId: 'conversation',
          conversationId: 'conversation',
          userId: 'user',
          status: 'complete',
        });
    },
  };
}

function harvest(source: GenerationSettledSource, row: { unfinished: boolean }) {
  const update = jest.fn(async () => ({ matched: true, unfinished: row.unfinished }));
  const handler = createBackgroundCodeResultHandler({
    req: { user: { id: 'user' } } as ServerRequest,
    preflightCodeOutputBatch: async () => [],
    processCodeOutput: jest.fn(),
    updateToolCallResult: update,
    runPreviewFinalize: jest.fn(),
    waitForGenerationSettled: (conversationId, options) =>
      waitForGenerationSettled(source, conversationId, options),
  });
  let result: boolean | undefined;
  const pending = handler({
    toolName: 'execute_code',
    toolCallId: 'call',
    stepId: 'step',
    messageId: 'message',
    conversationId: 'conversation',
    output: 'finished code',
    backgroundTask: {
      taskId: 'task',
      toolName: 'execute_code',
      status: 'completed',
      settledAt: new Date(),
      completionWakeup: true,
    },
  }).then((value) => {
    result = value?.deliveryReady;
  });
  return { update, pending, getResult: () => result };
}

describe('background code harvest generation lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('keeps harvesting a live turn after a transient first status-read failure', async () => {
    const source = sourceForRunningTurn();
    source.getGenerationSettlementState.mockRejectedValueOnce(new Error('transient Redis outage'));
    const row = { unfinished: true };
    const running = harvest(source, row);
    await jest.advanceTimersByTimeAsync(1_100_000);
    const beforeSettle = running.getResult();
    expect(source.getGenerationSettlementState.mock.calls.length).toBeGreaterThan(1);
    row.unfinished = false;
    source.settle();
    await jest.advanceTimersByTimeAsync(0);
    expect(beforeSettle).toBeUndefined();
    await running.pending;
    expect(running.getResult()).toBe(true);
  });

  it('anchors the original result when a remote successor replaces the observed generation', async () => {
    const source = sourceForRunningTurn();
    const row = { unfinished: true };
    const running = harvest(source, row);
    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(running.update.mock.calls.length).toBe(14);
    row.unfinished = false;
    source.job.createdAt = 2;
    source.job.status = 'requires_action';
    await jest.advanceTimersByTimeAsync(120_000);
    const beforeSuccessorSettles = running.getResult();
    expect(running.update.mock.calls.length).toBe(15);
    source.settle();
    await jest.advanceTimersByTimeAsync(0);
    await running.pending;
    expect(beforeSuccessorSettles).toBe(true);
  });

  it('does not retire a result while the real manager is awaiting terminal message persistence', async () => {
    const manager = new GenerationJobManagerClass();
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    let finishSave!: () => void;
    const save = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    try {
      const job = await manager.createJob('conversation', 'user', 'conversation');
      const row = { unfinished: true };
      const running = harvest(manager, row);
      await jest.advanceTimersByTimeAsync(1_000_000);
      const completing = manager.completeJob('conversation', 'provider error', job.createdAt, {
        beforeErrorPublication: () => save,
      });
      await jest.advanceTimersByTimeAsync(120_000);
      const beforePersistence = running.getResult();
      expect((await store.getJob('conversation'))?.terminalPersistencePending).toBe(true);
      row.unfinished = false;
      finishSave();
      await completing;
      await jest.advanceTimersByTimeAsync(0);
      expect(beforePersistence).toBeUndefined();
      await running.pending;
      expect(running.getResult()).toBe(true);
    } finally {
      finishSave();
      await manager.destroy();
    }
  });
});
