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

  it('runs the owned pause hook once after a committed barrier release loses its acknowledgement', async () => {
    const finish = manager.approvals.finishPausePersistence.bind(manager.approvals);
    const release = jest
      .spyOn(manager.approvals, 'finishPausePersistence')
      .mockImplementationOnce(async (...args) => {
        expect(await finish(...args)).toBe(true);
        throw new Error('lost pause release acknowledgement');
      });
    const action = buildPendingAction(
      { type: 'ask_user_question', question: { question: 'Choose' } },
      {
        streamId: 'released-pause',
        responseMessageId: 'released-pause',
        conversationId: 'conversation',
        runId: 'released-pause',
        ttlMs: 60_000,
      },
    );
    const afterPause = jest.fn();
    const afterSettle = jest.fn();
    await expect(
      executeAgentRun(
        {
          envelope,
          runId: 'released-pause',
          conversationId: 'conversation',
          retainTerminalPersistence: true,
          isPrincipalActive: async () => true,
          execute: async (execution) => {
            await execution.pauseForReview(action, async () => {});
            return 'paused';
          },
          afterPause,
          afterSettle,
        },
        { manager },
      ),
    ).resolves.toBe('paused');
    expect(release).toHaveBeenCalledTimes(1);
    expect(afterPause).toHaveBeenCalledTimes(1);
    expect(afterSettle).not.toHaveBeenCalled();
    expect(await manager.getJobStore().getJob('released-pause')).toMatchObject({
      status: 'requires_action',
      pendingActionId: action.actionId,
      terminalPersistencePending: false,
      providerDrained: true,
    });
  });

  it('does not let generic terminal publication release an external journal claim', async () => {
    const job = await manager.createJob('external-claim', 'user', 'conversation', {
      initialMetadata: { endpoint: 'responses', terminalPersistenceOwner: 'external' },
    });
    const claim = await manager.claimTerminalJob(
      job.streamId,
      'complete',
      undefined,
      job.createdAt,
    );
    expect(claim).toMatchObject({ persistencePending: true, terminalPersistenceOwner: 'external' });
    if (!claim) throw new Error('Missing terminal claim');
    await expect(manager.publishTerminalClaim(claim, null)).rejects.toThrow(
      'External terminal journal owns publication',
    );
    await manager.finishTerminalJob(claim);
    expect((await manager.getJob(job.streamId))?.metadata.terminalPersistencePending).toBe(true);
    await expect(
      manager.finishProviderTerminalPersistence(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).resolves.toBe(true);
    expect((await manager.getJob(job.streamId))?.metadata.terminalPersistencePending).toBe(false);
  });

  it.each([false, true])(
    'keeps the external barrier through a generic required-error callback (fails: %s)',
    async (fails) => {
      const job = await manager.createJob('external-error', 'user', 'conversation', {
        initialMetadata: { endpoint: 'responses', terminalPersistenceOwner: 'external' },
      });
      const finalize = jest.spyOn(manager.getJobStore(), 'finalizeTerminalPersistence');
      await expect(
        manager.completeJob(job.streamId, 'execution_failed', job.createdAt, {
          beforeErrorPublication: async () => {
            if (fails) throw new Error('required write unavailable');
          },
        }),
      ).resolves.toBe(true);
      expect(finalize).not.toHaveBeenCalled();
      expect((await manager.getJob(job.streamId))?.metadata.terminalPersistencePending).toBe(true);
    },
  );
});
