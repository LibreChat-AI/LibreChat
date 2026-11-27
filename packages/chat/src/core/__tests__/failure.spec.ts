import type { TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { TerminalContext, StreamStatusResponse } from '../resumable';
import { ResumableRun, ResumableSubscription, handleTransportFailure } from '../resumable';
import { createHost, createScheduler } from '../__fixtures__/resumable';

const submission = {
  userMessage: { messageId: 'u-1', conversationId: 'c-1', isCreatedByUser: true } as TMessage,
  initialResponse: { messageId: 'u-1_', conversationId: 'c-1' } as TMessage,
  conversation: { conversationId: 'c-1' },
} as TSubmission;

const setup = () => {
  const clock = createScheduler();
  const fetchStatus = jest.fn<Promise<StreamStatusResponse>, [string]>();
  const host = createHost(fetchStatus);
  const run = new ResumableRun(clock.scheduler);
  run.submission = submission;
  const sub = new ResumableSubscription(run, host, {
    streamId: 'c-1',
    submission,
    isResume: false,
    generationCreatedAt: 2000,
    generationProtocolVersion: 2,
  });
  sub.claim();
  const ctx: TerminalContext = { sub, host, applyPendingAction: jest.fn() };
  return { clock, fetchStatus, host, run, sub, ctx };
};

describe('handleTransportFailure', () => {
  it('ignores a failure after the final frame', async () => {
    const { ctx, host } = setup();
    ctx.sub.finalReceived = true;
    await handleTransportFailure(ctx, { status: 0 });
    expect(host.pane.refreshBalance).not.toHaveBeenCalled();
  });

  it('backs off and re-attaches a dropped connection', async () => {
    const { ctx, host, run, clock } = setup();
    await handleTransportFailure(ctx, { status: 0 });
    expect(run.reconnectAttempt).toBe(1);
    expect(host.pane.setIsSubmitting).toHaveBeenCalledWith(true);
    expect(host.pane.setShowStopButton).toHaveBeenCalledWith(true);
    clock.advance(999);
    expect(host.subscribe).not.toHaveBeenCalled();
    clock.advance(1);
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({ isResume: true }));
  });

  it('writes a served error once the status proves the run over', async () => {
    const { ctx, host, fetchStatus } = setup();
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await handleTransportFailure(ctx, {
      data: { message: 'quota exceeded', generationProtocolVersion: 2 },
    });
    expect(ctx.sub.finalReceived).toBe(true);
    expect(host.events.flushPendingDeltas).toHaveBeenCalled();
    expect(host.events.showError).toHaveBeenCalledWith('quota exceeded', ctx.sub.submission);
    expect(host.steers.convertLocalToQueued).toHaveBeenCalledWith('c-1', {
      claimParked: true,
      generationProtocolVersion: 2,
    });
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith({
      conversationId: 'c-1',
      outcome: 'error',
      endedAt: 0,
      generationCreatedAt: 2000,
    });
  });

  it('settles a missing stream from persisted history', async () => {
    const { ctx, host, fetchStatus } = setup();
    const persisted = [submission.userMessage];
    (host.cache.fetchMessages as jest.Mock).mockResolvedValue(persisted);
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await handleTransportFailure(ctx, { status: 404 });
    expect(host.cache.fetchMessages).toHaveBeenCalledWith('c-1', true);
    expect(host.cache.removeStreamStatus).toHaveBeenCalledWith('c-1');
    expect(host.messages.set).toHaveBeenCalledWith(persisted);
    expect(ctx.sub.retired).toBe(true);
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c-1', outcome: 'aborted' }),
      { retainDetached: false },
    );
  });

  it('keeps a missing stream attached while its generation is still live', async () => {
    const { ctx, host, fetchStatus, clock } = setup();
    fetchStatus.mockResolvedValue({
      active: true,
      streamId: 'c-1',
      createdAt: 2000,
      generationProtocolVersion: 2,
    });
    await handleTransportFailure(ctx, { status: 404 });
    expect(host.pane.publishRunEnd).not.toHaveBeenCalled();
    expect(host.steers.seed).toHaveBeenCalledWith('c-1', [], 2000, 2);
    clock.advance(1000);
    expect(host.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'c-1', generationCreatedAt: 2000 }),
    );
  });

  it('waits on a live generation once the retry ceiling is reached', async () => {
    const { ctx, host, run, fetchStatus } = setup();
    run.reconnectAttempt = 5;
    fetchStatus.mockResolvedValue({ active: true, createdAt: 2000, generationProtocolVersion: 2 });
    await handleTransportFailure(ctx, { status: 0 });
    expect(host.cache.setStreamStatus).toHaveBeenCalled();
    expect(run.reconnectAttempt).toBe(0);
    expect(host.pane.publishRunEnd).not.toHaveBeenCalled();
  });

  it('settles a run the status proves terminal past the retry ceiling', async () => {
    const { ctx, host, run, fetchStatus } = setup();
    run.reconnectAttempt = 5;
    fetchStatus.mockResolvedValue({
      active: false,
      status: 'aborted',
      createdAt: 2000,
      generationProtocolVersion: 2,
    });
    await handleTransportFailure(ctx, { status: 0 });
    expect(ctx.sub.retired).toBe(true);
    expect(host.pane.setSubmission).toHaveBeenCalledWith(null);
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'aborted', generationCreatedAt: 2000 }),
    );
  });
  describe('in a conversation the pane created, whose created frame never arrived', () => {
    const persisted = [
      submission.userMessage,
      {
        messageId: 'r-1',
        conversationId: 'c-1',
        parentMessageId: 'u-1',
        text: 'Whole',
      } as TMessage,
    ];
    const saved = { conversationId: 'c-1', title: 'Saved' } as TConversation;
    const over: StreamStatusResponse = {
      active: false,
      status: 'complete',
      createdAt: 2000,
      generationProtocolVersion: 2,
    };
    const optimistic = () => {
      const harness = setup();
      harness.run.optimisticStreamIds.add('c-1');
      harness.fetchStatus.mockResolvedValue(over);
      (harness.host.cache.fetchMessages as jest.Mock).mockResolvedValue(persisted);
      return harness;
    };

    it('reads the reply and the saved conversation back past the retry ceiling', async () => {
      const { ctx, host, run } = optimistic();
      run.reconnectAttempt = 5;
      (host.cache.fetchConversation as jest.Mock).mockResolvedValue(saved);

      await handleTransportFailure(ctx, { status: 0 });

      /** Read directly: no query for the conversation is mounted until `created` names it. */
      expect(host.cache.fetchMessages).toHaveBeenCalledWith('c-1', true);
      expect(host.cache.setConversation).toHaveBeenCalledWith('c-1', saved);
      expect(host.cache.upsertConversation).toHaveBeenCalledWith(saved);
      expect(host.cache.removeConversation).not.toHaveBeenCalled();
      expect(host.messages.set).toHaveBeenCalledWith(persisted);
      expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed' }),
      );
    });

    it('removes it past the retry ceiling only when the server has no such conversation', async () => {
      const unknown = optimistic();
      unknown.run.reconnectAttempt = 5;
      (unknown.host.cache.fetchConversation as jest.Mock).mockRejectedValue(new Error('offline'));
      await handleTransportFailure(unknown.ctx, { status: 0 });
      expect(unknown.host.cache.removeConversation).not.toHaveBeenCalled();
      expect(unknown.host.cache.refreshConversationLists).toHaveBeenCalled();

      const absent = optimistic();
      absent.run.reconnectAttempt = 5;
      (absent.host.cache.fetchConversation as jest.Mock).mockRejectedValue(
        Object.assign(new Error('Not Found'), { response: { status: 404 } }),
      );
      await handleTransportFailure(absent.ctx, { status: 0 });
      expect(absent.host.cache.removeConversation).toHaveBeenCalledWith('c-1');
    });

    it('leaves a conversation the created frame confirmed as it is', async () => {
      const { ctx, host, run } = optimistic();
      run.createdStreamIds.add('c-1');
      run.reconnectAttempt = 5;

      await handleTransportFailure(ctx, { status: 0 });

      expect(host.cache.fetchConversation).not.toHaveBeenCalled();
      expect(host.cache.removeConversation).not.toHaveBeenCalled();
      expect(host.messages.set).toHaveBeenCalledWith(persisted);
    });

    it('reads the saved conversation back when its stream is gone', async () => {
      const { ctx, host } = optimistic();
      (host.cache.fetchConversation as jest.Mock).mockResolvedValue(saved);

      await handleTransportFailure(ctx, { status: 404 });

      expect(host.cache.setConversation).toHaveBeenCalledWith('c-1', saved);
      expect(host.cache.upsertConversation).toHaveBeenCalledWith(saved);
      expect(host.cache.removeConversation).not.toHaveBeenCalled();
      expect(host.messages.set).toHaveBeenCalledWith(persisted);
    });
  });
});
