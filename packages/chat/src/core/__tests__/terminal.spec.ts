import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { TerminalContext, StreamStatusResponse } from '../resumable';
import {
  ResumableRun,
  handoffToReplacement,
  ResumableSubscription,
  authorizeTerminalTeardown,
  reconcileGenerationLifecycle,
} from '../resumable';
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

const replacement: StreamStatusResponse = {
  active: true,
  streamId: 'c-1',
  createdAt: 3000,
  generationProtocolVersion: 2,
  resumeState: { pendingSteers: [] } as unknown as StreamStatusResponse['resumeState'],
};

describe('authorizeTerminalTeardown', () => {
  it('allows teardown once the status proves the run inactive', async () => {
    const { ctx, fetchStatus } = setup();
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await expect(authorizeTerminalTeardown(ctx, 'c-1', 'FINAL')).resolves.toBe(true);
  });

  it('defers teardown and re-attaches while the same epoch is still active', async () => {
    const { ctx, fetchStatus, clock, host } = setup();
    fetchStatus.mockResolvedValue({ active: true, createdAt: 2000, generationProtocolVersion: 2 });
    await expect(authorizeTerminalTeardown(ctx, 'c-1', 'error')).resolves.toBe(false);
    expect(ctx.sub.controller.signal.aborted).toBe(true);
    clock.advance(249);
    expect(host.subscribe).not.toHaveBeenCalled();
    clock.advance(1);
    expect(host.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'c-1', isResume: true, generationCreatedAt: 2000 }),
    );
  });

  it('hands a stale attachment to the newer epoch that owns the conversation', async () => {
    const { ctx, fetchStatus, host, run } = setup();
    fetchStatus.mockResolvedValue(replacement);
    await expect(authorizeTerminalTeardown(ctx, 'c-1', 'FINAL')).resolves.toBe(false);
    expect(run.replacementHandoff).toBe(true);
    expect(run.submission).toBeNull();
    expect(host.cache.setStreamStatus).toHaveBeenCalledWith('c-1', {
      ...replacement,
      generationHandoff: true,
    });
    expect(host.pane.setGenerationEpoch).toHaveBeenCalledWith('c-1', 3000, undefined, 2);
    expect(host.cache.addActiveJob).toHaveBeenCalledWith('c-1');
    expect(host.pane.setSubmission).toHaveBeenCalledWith(null);
  });

  it('skips the status read for a legacy generation', async () => {
    const { ctx, fetchStatus, run } = setup();
    const legacy = new ResumableSubscription(run, ctx.host, {
      streamId: 'c-1',
      submission,
      isResume: false,
      generationProtocolVersion: 1,
    });
    legacy.claim();
    await expect(authorizeTerminalTeardown({ ...ctx, sub: legacy }, 'c-1', 'FINAL')).resolves.toBe(
      true,
    );
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});

describe('handoffToReplacement', () => {
  it('declines without a live, different v2 epoch', async () => {
    const { ctx } = setup();
    await expect(
      handoffToReplacement(ctx, 'c-1', { ...replacement, createdAt: 2000 }),
    ).resolves.toBe(false);
    await expect(
      handoffToReplacement(ctx, 'c-1', { ...replacement, generationProtocolVersion: 1 }),
    ).resolves.toBe(false);
    expect(ctx.sub.run.replacementHandoff).toBe(false);
  });
});

describe('reconcileGenerationLifecycle', () => {
  it('settles a completed run from durable history and publishes its end', async () => {
    const { ctx, fetchStatus, host, run } = setup();
    const persisted = [
      submission.userMessage,
      { messageId: 'r-1', parentMessageId: 'u-1', isCreatedByUser: false } as TMessage,
    ];
    (host.cache.fetchMessages as jest.Mock).mockResolvedValue(persisted);
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await reconcileGenerationLifecycle(ctx, { terminalStatus: 'complete' });

    expect(host.cache.invalidateMessages).toHaveBeenCalledWith('c-1', 'none');
    expect(host.steers.convertLocalToQueued).toHaveBeenCalled();
    expect(host.pane.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith({
      conversationId: 'c-1',
      outcome: 'completed',
      endedAt: 0,
      generationCreatedAt: 2000,
      responseMessageId: 'r-1',
    });
    expect(run.reconnectAttempt).toBe(0);
  });

  it('reports an error when history could not be read for a completed run', async () => {
    const { ctx, fetchStatus, host } = setup();
    (host.cache.fetchMessages as jest.Mock).mockRejectedValue(new Error('offline'));
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await reconcileGenerationLifecycle(ctx, { terminalStatus: 'complete' });
    expect(host.steers.convertLocalToQueued).not.toHaveBeenCalled();
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error' }),
    );
  });

  it('ignores a frame for a different epoch', async () => {
    const { ctx, host } = setup();
    await reconcileGenerationLifecycle(ctx, { generationCreatedAt: 1, terminalStatus: 'error' });
    expect(host.cache.invalidateMessages).not.toHaveBeenCalled();
  });

  it('consumes an armed interrupt when abort persistence failed', async () => {
    const { ctx, fetchStatus, host } = setup();
    fetchStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    await reconcileGenerationLifecycle(ctx, {
      terminalStatus: 'aborted',
      reconcileReason: 'abort_persistence_failed',
    });
    expect(host.pane.clearDrainAfterAbort).toHaveBeenCalledWith('c-1', 2000);
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'aborted' }),
    );
  });
});
