import type { ChatCompletionRunEnvelope } from '../envelope';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { buildPendingAction } from '~/agents/hitl/policy';
import { GenerationJobManagerClass } from '~/stream';
import { executeAgentRun } from './host';

const envelope: ChatCompletionRunEnvelope = {
  version: 1,
  protocol: 'chat.completions',
  requestId: 'request',
  receivedAt: 1,
  principal: { userId: 'user' },
  payload: { model: 'agent', messages: [{ role: 'user', content: 'hello' }] },
};

describe('execution host persistence authority', () => {
  let manager: GenerationJobManagerClass;
  beforeEach(() => {
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
  });
  afterEach(async () => {
    await manager.destroy();
  });

  it('waits every required write, journals the failed identity, and rejects provider success', async () => {
    const failure = new Error('required artifact persistence failed');
    let finishTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      finishTail = resolve;
    });
    let enrolled!: () => void;
    const ready = new Promise<void>((resolve) => {
      enrolled = resolve;
    });
    const journal = jest.fn();
    const result = executeAgentRun(
      {
        envelope,
        runId: 'required-write',
        conversationId: 'conversation',
        retainTerminalPersistence: true,
        isPrincipalActive: async () => true,
        execute: async (execution) => {
          execution.track(Promise.reject(failure));
          execution.track(tail);
          enrolled();
          return 'provider-success';
        },
        afterSettle: async (execution, error) => {
          journal(await execution.confirmTerminalIdentity(), error);
        },
      },
      { manager },
    );
    const rejected = result.catch((error: unknown) => error);
    await ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await manager.getJob('required-write'))?.status).toBe('running');
    expect(journal).not.toHaveBeenCalled();
    finishTail();
    await expect(rejected).resolves.toBe(failure);
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }), failure);
    expect(await manager.getJobStore().getJob('required-write')).toMatchObject({
      status: 'error',
      providerDrained: true,
      terminalPersistencePending: true,
    });
  });

  it('retains the terminal barrier and rejects when the terminal journal cannot persist', async () => {
    const failure = new Error('journal unavailable');
    await expect(
      executeAgentRun(
        {
          envelope,
          runId: 'journal-failure',
          conversationId: 'conversation',
          retainTerminalPersistence: true,
          isPrincipalActive: async () => true,
          execute: async () => 'provider-success',
          afterSettle: async (execution) => {
            expect(await execution.confirmTerminalIdentity()).toMatchObject({
              outcome: 'complete',
            });
            throw failure;
          },
        },
        { manager },
      ),
    ).rejects.toBe(failure);
    expect(await manager.getJobStore().getJob('journal-failure')).toMatchObject({
      status: 'complete',
      providerDrained: true,
      terminalPersistencePending: true,
    });
  });

  it('journals an error outcome and rejects a required before-settlement failure', async () => {
    const failure = new Error('checkpoint unavailable');
    const journal = jest.fn();
    await expect(
      executeAgentRun(
        {
          envelope,
          runId: 'checkpoint-failure',
          conversationId: 'conversation',
          retainTerminalPersistence: true,
          isPrincipalActive: async () => true,
          execute: async () => 'provider-success',
          beforeSettle: async () => {
            throw failure;
          },
          afterSettle: async (execution, error) => {
            journal(await execution.confirmTerminalIdentity(), error);
          },
        },
        { manager },
      ),
    ).rejects.toBe(failure);
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }), failure);
  });

  it.each([false, true])(
    'separates a durable pause from terminal settlement (persist fails: %s)',
    async (fails) => {
      const failure = new Error('pause journal unavailable');
      const terminal = jest.fn(async (execution, error) => {
        expect(await execution.confirmTerminalIdentity()).toMatchObject({ outcome: 'error' });
        expect(error).toBe(failure);
      });
      const paused = jest.fn(async (execution) => {
        expect(execution.isPaused).toBe(true);
        expect(execution.ownsSettlement).toBe(true);
      });
      const result = executeAgentRun(
        {
          envelope,
          runId: 'pause',
          conversationId: 'conversation',
          retainTerminalPersistence: true,
          isPrincipalActive: async () => true,
          execute: async (execution) => {
            await execution.pauseForReview(
              buildPendingAction(
                { type: 'ask_user_question', question: { question: 'Choose' } },
                {
                  streamId: 'pause',
                  responseMessageId: 'pause',
                  conversationId: 'conversation',
                  runId: 'pause',
                  ttlMs: 60_000,
                },
              ),
              async () => {
                if (fails) throw failure;
              },
            );
            return 'paused';
          },
          afterPause: paused,
          afterSettle: terminal,
        },
        { manager },
      );
      if (fails) {
        await expect(result).rejects.toBe(failure);
        expect(terminal).toHaveBeenCalledTimes(1);
        expect(paused).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBe('paused');
        expect(paused).toHaveBeenCalledTimes(1);
        expect(terminal).not.toHaveBeenCalled();
      }
      expect(await manager.getJobStore().getJob('pause')).toMatchObject({
        status: fails ? 'error' : 'requires_action',
        providerDrained: true,
      });
    },
  );
});
