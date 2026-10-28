import { StepEvents } from 'librechat-data-provider';
import type {
  ChatEvent,
  TMessage,
  TSubmission,
  ChatTransportOptions,
} from 'librechat-data-provider';
import type { ResumableHost, StreamStatusResponse } from '../resumable';
import { createHost, createScheduler } from '../__fixtures__/resumable';
import { ResumableRun, attachResumableStream } from '../resumable';

const userMessage = {
  messageId: 'u-1',
  conversationId: 'c-1',
  isCreatedByUser: true,
  text: 'Hello',
} as TMessage;

const submission = {
  userMessage,
  initialResponse: { messageId: 'u-1_', conversationId: 'c-1', isCreatedByUser: false },
  conversation: { conversationId: 'c-1' },
  clientRequestId: 'req-1',
} as TSubmission;

/** Attaches a pane and returns a way to emit events on its connection. */
const attach = (overrides: { isResume?: boolean; generationProtocolVersion?: 1 | 2 } = {}) => {
  const clock = createScheduler();
  const fetchStatus = jest.fn<Promise<StreamStatusResponse>, [string]>();
  const host: ResumableHost = createHost(fetchStatus);
  let options: ChatTransportOptions | undefined;
  (host.stream.reconnectToStream as jest.Mock).mockImplementation((_request, opts) => {
    options = opts;
    return { closed: false };
  });
  const run = new ResumableRun(clock.scheduler);
  run.submission = submission;
  attachResumableStream(run, host, {
    streamId: 'c-1',
    submission,
    isResume: overrides.isResume ?? false,
    generationCreatedAt: 2000,
    generationProtocolVersion: overrides.generationProtocolVersion ?? 1,
  });
  const emit = async (event: ChatEvent) => {
    options?.onEvent(event);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { clock, fetchStatus, host, run, emit };
};

describe('attachResumableStream', () => {
  it('installs the epoch, binds the response and connects', () => {
    const { host, run } = attach();
    expect(host.pane.setGenerationEpoch).toHaveBeenCalledWith('c-1', 2000, undefined, 1);
    expect(host.pane.setShowStopButton).toHaveBeenCalledWith(true);
    expect(host.usage.bindResponse).toHaveBeenCalledWith(submission);
    expect(run.prefixStateGenerationId).toBe('req-1');
    expect(run.subscribedEpoch).toBe(2000);
    expect(host.stream.reconnectToStream).toHaveBeenCalledTimes(1);
  });

  it('attaches nothing for a submission the pane no longer serves', () => {
    const host = createHost();
    const run = new ResumableRun(createScheduler().scheduler);
    attachResumableStream(run, host, {
      streamId: 'c-1',
      submission,
      isResume: false,
      generationProtocolVersion: 1,
    });
    expect(host.stream.reconnectToStream).not.toHaveBeenCalled();
  });

  it('restores the controls when the connection opens', async () => {
    const { host, run, emit } = attach();
    run.reconnectAttempt = 2;
    await emit({ type: 'open' });
    expect(host.pane.setAbortScroll).toHaveBeenCalledWith(false);
    expect(host.pane.setIsSubmitting).toHaveBeenCalledWith(true);
    expect(run.reconnectAttempt).toBe(0);
  });
});

describe('handleFrame', () => {
  it('holds step events until created names the turn, then replays them', async () => {
    const { host, run, emit } = attach();
    const step = { event: StepEvents.ON_RUN_STEP, data: { id: 'step-1' } };
    await emit({ type: 'step', data: step } as ChatEvent);
    expect(host.events.stepHandler).not.toHaveBeenCalled();

    await emit({
      type: 'created',
      data: { created: true, message: { ...userMessage, messageId: 'u-2' } },
    } as ChatEvent);
    expect(host.pane.renewActiveRun).toHaveBeenCalled();
    expect(run.identityConfirmed).toBe(true);
    expect(run.submission?.userMessage.messageId).toBe('u-2');
    expect(run.submission?.initialResponse?.messageId).toBe('u-2_');
    expect(host.events.createdHandler).toHaveBeenCalled();
    expect(host.events.stepHandler).toHaveBeenCalledWith(
      step,
      expect.objectContaining({ userMessage: expect.objectContaining({ messageId: 'u-2' }) }),
    );
  });

  it('settles a final frame and publishes the run end', async () => {
    const { host, run, emit } = attach();
    const responseMessage = { messageId: 'r-1', conversationId: 'c-1' } as TMessage;
    await emit({
      type: 'final',
      data: { final: true, conversation: { conversationId: 'c-1' }, responseMessage },
    } as ChatEvent);
    expect(host.events.finalHandler).toHaveBeenCalled();
    expect(host.usage.finalizeUsage).toHaveBeenCalled();
    expect(host.steers.convertLocalToQueued).toHaveBeenCalledWith('c-1');
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-1',
        outcome: 'completed',
        generationCreatedAt: 2000,
        responseMessageId: 'r-1',
      }),
    );
    expect(host.cache.removeActiveJob).toHaveBeenCalledWith('c-1');
    expect(run.stream?.signal.aborted).toBe(true);
  });

  it('ignores an unnegotiated lifecycle reconciliation frame', async () => {
    const { host, emit } = attach();
    await emit({ type: 'final', data: { final: true, reconcile: true } } as ChatEvent);
    expect(host.cache.invalidateMessages).not.toHaveBeenCalled();
    expect(host.events.finalHandler).not.toHaveBeenCalled();
  });

  it('routes side events to the patcher, usage and steer chips', async () => {
    const { host, emit } = attach();
    await emit({ type: 'title', data: { event: 'title' } } as ChatEvent);
    await emit({ type: 'steer_updated', data: { conversationId: 'c-1', steers: [] } } as ChatEvent);
    await emit({ type: 'token_usage', data: {} } as ChatEvent);
    expect(host.events.titleHandler).toHaveBeenCalled();
    expect(host.steers.update).toHaveBeenCalled();
    expect(host.usage.usageHandler).toHaveBeenCalled();
  });
});

describe('handleSync', () => {
  it('rebuilds the response from the resume snapshot', async () => {
    const { host, emit, run } = attach({ isResume: true });
    host.messages.set([userMessage, submission.initialResponse as TMessage]);
    await emit({
      type: 'sync',
      data: {
        sync: true,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'partial' }],
          userMessage: { messageId: 'u-1', parentMessageId: null, text: 'Hello' },
          responseMessageId: 'r-1',
          conversationId: 'c-1',
          pendingSteers: [],
        },
        pendingEvents: [],
      },
    } as unknown as ChatEvent);
    const response = host.messages.get()?.find((message) => message.messageId === 'r-1');
    expect(response?.content).toEqual([{ type: 'text', text: 'partial' }]);
    expect(run.editPrefixCleared).toBe(true);
    expect(host.events.resetContentHandler).toHaveBeenCalled();
    expect(host.steers.seed).toHaveBeenCalledWith('c-1', [], 2000, 1);
    expect(host.usage.seedLiveFromContent).toHaveBeenCalled();
    expect(host.pane.setIsSubmitting).toHaveBeenLastCalledWith(true);
  });
});

describe('handleClose', () => {
  it('idles the pane and sweeps failed chips on an intentional close', async () => {
    const { host, emit } = attach();
    await emit({ type: 'abort' });
    expect(host.pane.setIsSubmitting).toHaveBeenLastCalledWith(false);
    expect(host.pane.setStreamId).toHaveBeenCalledWith(null);
    expect(host.steers.convertLocalToQueued).toHaveBeenCalledWith('c-1', {
      statuses: ['failed'],
    });
  });

  it('keeps the pane busy while a reconnect is pending', async () => {
    const { host, run, emit } = attach();
    run.reconnectAttempt = 1;
    await emit({ type: 'abort' });
    expect(host.pane.setStreamId).not.toHaveBeenCalled();
  });
});
