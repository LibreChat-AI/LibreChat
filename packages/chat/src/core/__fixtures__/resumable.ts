import type { TMessage } from 'librechat-data-provider';
import type { ResumableHost, ResumableScheduler, StreamStatusResponse } from '../resumable';

/** A scheduler the test drives by hand. */
export type ManualScheduler = {
  scheduler: ResumableScheduler;
  advance: (ms: number) => void;
  flushFrames: () => void;
  pending: () => number;
  frames: () => number;
};

/** Timers and frames that run only when the test advances the clock or flushes frames. */
export const createScheduler = (): ManualScheduler => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const scheduler: ResumableScheduler = {
    setTimeout: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
    now: () => now,
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  /** Runs the frames requested so far; frames they request wait for the next flush. */
  const flushFrames = (): void => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback();
    }
  };
  return {
    scheduler,
    advance,
    flushFrames,
    pending: (): number => timers.size,
    frames: (): number => frames.size,
  };
};

/** A host whose every member is a mock, with a message list it keeps for real. */
export const createHost = (
  fetchStatus: jest.Mock<Promise<StreamStatusResponse>, [string]> = jest.fn(),
): ResumableHost => {
  let messages: TMessage[] = [];
  const host: ResumableHost = {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
    fetchStatus,
    subscribe: jest.fn(),
    cache: {
      invalidateMessages: jest.fn(async () => undefined),
      fetchMessages: jest.fn(async () => [] as TMessage[]),
      refreshConversation: jest.fn(async () => undefined),
      refreshConversationLists: jest.fn(async () => undefined),
      refreshPinnedConversations: jest.fn(async () => undefined),
      setStreamStatus: jest.fn(),
      removeStreamStatus: jest.fn(),
      invalidateStreamStatus: jest.fn(),
      addActiveJob: jest.fn(),
      removeActiveJob: jest.fn(),
      fetchConversation: jest.fn(async () => undefined),
      setConversation: jest.fn(),
      upsertConversation: jest.fn(),
      removeConversation: jest.fn(),
    },
    pane: {
      setIsSubmitting: jest.fn(),
      setShowStopButton: jest.fn(),
      setSubmission: jest.fn(),
      setStreamId: jest.fn(),
      setGenerationEpoch: jest.fn(() => true),
      setPendingAction: jest.fn(),
      clearComposerDrafts: jest.fn(),
      publishRunEnd: jest.fn(),
      clearDrainAfterAbort: jest.fn(),
      refreshBalance: jest.fn(),
      updateConversation: jest.fn(),
      resolveDetachedEnd: jest.fn(() => ({ resolvable: false, end: null })),
      setAbortScroll: jest.fn(),
      renewActiveRun: jest.fn(),
      runEndTarget: jest.fn((params) => ({
        conversationId: params.conversationId,
        startedAsNewConvo: params.startedAsNewConvo,
      })),
    },
    steers: {
      resolve: jest.fn(() => []),
      markLiveApplied: jest.fn(),
      update: jest.fn(),
      isRecoveryHeld: jest.fn(() => false),
      blockRecovery: jest.fn(),
      restoreQueued: jest.fn(),
      seed: jest.fn(),
      appliedIds: jest.fn(() => []),
      settleApplied: jest.fn(),
      convertToQueued: jest.fn(),
      convertLocalToQueued: jest.fn(),
    },
    events: {
      stepHandler: jest.fn(),
      finalHandler: jest.fn(),
      createdHandler: jest.fn(),
      attachmentHandler: jest.fn(),
      titleHandler: jest.fn(),
      contentHandler: jest.fn(),
      messageHandler: jest.fn(),
      prunePtcTraces: jest.fn(),
      resetContentHandler: jest.fn(),
      syncStepMessage: jest.fn(),
      clearStepMaps: jest.fn(),
      flushPendingDeltas: jest.fn(),
      resetLive: jest.fn(),
      showError: jest.fn(),
      showStartFailure: jest.fn(),
    },
    messages: {
      get: jest.fn(() => messages),
      set: jest.fn((next: TMessage[]) => {
        messages = next;
      }),
    },
    parts: {
      applySteer: jest.fn((message) => message),
      findSteerTarget: jest.fn(() => -1),
      applyActivityLabel: jest.fn((message) => message),
      findActivityLabelTarget: jest.fn(() => -1),
      offsetActivityPhaseBoundary: jest.fn((index, prefix) => index + prefix),
      applyReasoningLabel: jest.fn((message) => message),
      findReasoningLabelTarget: jest.fn(() => -1),
    },
    usage: {
      bindResponse: jest.fn(),
      contextHandler: jest.fn(),
      usageHandler: jest.fn(),
      tapStream: jest.fn(),
      tapContent: jest.fn(),
      finalizeUsage: jest.fn(),
      backfillUsage: jest.fn(),
      seedLiveFromContent: jest.fn(),
    },
    stream: { send: jest.fn(), reconnectToStream: jest.fn(() => ({ closed: false })) },
    start: jest.fn(),
  };
  return host;
};
