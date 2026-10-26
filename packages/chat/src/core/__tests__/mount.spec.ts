import { Constants } from 'librechat-data-provider';
import type { TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { ResumableHost, StreamStatusResponse } from '../resumable';
import { ResumableRun, mountSubmission, releaseSubmission } from '../resumable';
import { createHost, createScheduler } from '../__fixtures__/resumable';

const submission = {
  userMessage: { messageId: 'u-1', conversationId: 'c-1', isCreatedByUser: true, text: 'Hi' },
  initialResponse: { messageId: 'u-1_', conversationId: 'c-1' } as TMessage,
  conversation: { conversationId: 'c-1', endpoint: 'agents' },
  endpointOption: { endpoint: 'agents' },
} as unknown as TSubmission;

const newChat = {
  ...submission,
  userMessage: { ...submission.userMessage, conversationId: null },
  conversation: { conversationId: Constants.NEW_CONVO, endpoint: 'agents' },
} as unknown as TSubmission;

const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = () => {
  const fetchStatus = jest.fn<Promise<StreamStatusResponse>, [string]>();
  const host: ResumableHost = createHost(fetchStatus);
  const run = new ResumableRun(createScheduler().scheduler);
  return { host, run, fetchStatus };
};

describe('mountSubmission', () => {
  it('re-attaches a resume submission without starting a generation', () => {
    const { host, run } = setup();
    mountSubmission(run, host, {
      ...submission,
      resumeStreamId: 'c-1',
      resumeGenerationCreatedAt: 2000,
      resumeGenerationProtocolVersion: 2,
    } as TSubmission);
    expect(host.queue.clearSupersededMarkers).toHaveBeenCalledWith('c-1', expect.any(Function));
    const [, isSameGeneration] = (host.queue.clearSupersededMarkers as jest.Mock).mock.calls[0];
    expect(isSameGeneration(2000)).toBe(true);
    expect(isSameGeneration(1000)).toBe(false);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.cache.addActiveJob).toHaveBeenCalledWith('c-1');
    expect(host.stream.reconnectToStream).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('resume=true') }),
      expect.anything(),
    );
  });

  it('starts a new chat, creates its optimistic records and attaches', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockResolvedValue({ streamId: 'c-9', generationCreatedAt: 5 });
    mountSubmission(run, host, newChat);
    await flush();
    expect(host.cache.queueTitleGeneration).toHaveBeenCalledWith('c-9');
    expect(host.pane.replaceNewConversationUrl).toHaveBeenCalledWith('c-9');
    expect(host.cache.addOptimisticConversation).toHaveBeenCalledWith('c-9', newChat);
    expect(
      (host.cache.addOptimisticConversation as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan((host.pane.replaceNewConversationUrl as jest.Mock).mock.invocationCallOrder[0]);
    expect(run.optimisticStreamIds.has('c-9')).toBe(true);
    expect(host.stream.reconnectToStream).toHaveBeenCalledTimes(1);
  });

  it('ends a settled start from the persisted conversation without attaching', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockResolvedValue({
      status: 'settled',
      conversationId: 'c-1',
      generationProtocolVersion: 2,
    });
    const persisted = { conversationId: 'c-1', title: 'Saved' } as TConversation;
    (host.cache.fetchConversation as jest.Mock).mockResolvedValue(persisted);
    mountSubmission(run, host, submission);
    await flush();
    expect(host.cache.setConversation).toHaveBeenCalledWith('c-1', persisted);
    expect(host.cache.invalidateMessages).toHaveBeenCalledWith('c-1', 'all');
    expect(host.pane.publishRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c-1', outcome: 'aborted' }),
    );
    expect(host.stream.reconnectToStream).not.toHaveBeenCalled();
  });

  it('hands a lost predecessor fence to the live replacement', async () => {
    const { host, run, fetchStatus } = setup();
    const error = Object.assign(new Error('mismatch'), {
      response: {
        status: 409,
        headers: {},
        data: {
          status: 'predecessor_mismatch',
          code: 'GENERATION_PREDECESSOR_MISMATCH',
          streamId: 'c-1',
          conversationId: 'c-1',
          generationCreatedAt: 3000,
          active: true,
        },
      },
    });
    (host.start as jest.Mock).mockRejectedValue(error);
    fetchStatus.mockResolvedValue({
      active: true,
      streamId: 'c-1',
      createdAt: 3000,
      generationProtocolVersion: 2,
    });
    mountSubmission(run, host, {
      ...submission,
      expectedPredecessorCreatedAt: 1000,
    } as TSubmission);
    await flush();
    await flush();
    expect(host.steers.restoreQueued).toHaveBeenCalledWith(expect.anything(), 3000);
    expect(run.replacementHandoff).toBe(true);
    expect(host.cache.setStreamStatus).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ generationHandoff: true, createdAt: 3000 }),
    );
    expect(host.pane.setSubmission).toHaveBeenCalledWith(null);
  });

  it('remembers a confirmed run the pane leaves mid-stream', () => {
    const { host, run } = setup();
    const cleanup = mountSubmission(run, host, {
      ...submission,
      resumeStreamId: 'c-1',
      resumeGenerationCreatedAt: 2000,
    } as TSubmission);
    run.identityConfirmed = true;
    cleanup();
    expect(host.queue.rememberDetachedRun).toHaveBeenCalledWith('c-1', {
      userMessageId: 'u-1',
      responseMessageId: 'u-1_',
      generationCreatedAt: 2000,
    });
    expect(run.stream).toBeNull();
    expect(host.pane.setIsSubmitting).toHaveBeenLastCalledWith(false);
  });

  it('keeps the pane busy through a generation handoff', () => {
    const { host, run } = setup();
    const cleanup = mountSubmission(run, host, submission);
    run.replacementHandoff = true;
    (host.pane.setIsSubmitting as jest.Mock).mockClear();
    cleanup();
    expect(host.pane.setIsSubmitting).not.toHaveBeenCalled();
    expect(run.replacementHandoff).toBe(false);
  });
});

describe('releaseSubmission', () => {
  it('closes the connection without aborting the generation', () => {
    const { host, run } = setup();
    const stream = new AbortController();
    run.stream = stream;
    run.submission = submission;
    run.reconnectAttempt = 3;
    releaseSubmission(run, host);
    expect(stream.signal.aborted).toBe(true);
    expect(run.submission).toBeNull();
    expect(run.reconnectAttempt).toBe(0);
    expect(host.pane.setStreamId).toHaveBeenCalledWith(null);
  });
});
