import { getDefaultStore } from 'jotai';
import { QueryClient } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  Constants,
  ContentTypes,
  LocalStorageKeys,
  QueryKeys,
  StepEvents,
  StepTypes,
  request,
} from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { Query, QueryKey } from '@tanstack/react-query';
import {
  activeUsageResponseIdFamily,
  liveTokensFamily,
  branchTotalsFamily,
  pendingUsageFamily,
  removeUsageAtoms,
} from '~/store/usage';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import type { PendingSteer } from '~/store/families';

type SSEEventListener = (e: Partial<MessageEvent> & { responseCode?: number }) => void;

interface MockSSEInstance {
  _url: string;
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  dispatchEvent: jest.Mock;
  headers: Record<string, string>;
  readyState: number;
  _listeners: Record<string, SSEEventListener>;
  _emit: (event: string, data?: Partial<MessageEvent> & { responseCode?: number }) => void;
}

const mockSSEInstances: MockSSEInstance[] = [];
const MOCK_SSE_OPEN = 1;
const MOCK_SSE_CLOSED = 2;

jest.mock('sse.js', () => {
  const SSE = jest
    .fn()
    .mockImplementation((url: string, options?: { headers?: Record<string, string> }) => {
      const listeners: Record<string, SSEEventListener> = {};
      const instance: MockSSEInstance = {
        _url: url,
        addEventListener: jest.fn((event: string, cb: SSEEventListener) => {
          listeners[event] = cb;
        }),
        stream: jest.fn(),
        dispatchEvent: jest.fn(),
        close: jest.fn(() => {
          if (instance.readyState === 2) {
            return;
          }
          instance.readyState = 2;
          instance._emit('abort');
        }),
        headers: { ...options?.headers },
        readyState: 1,
        _listeners: listeners,
        _emit: (event, data = {}) => listeners[event]?.(data as MessageEvent),
      };
      mockSSEInstances.push(instance);
      return instance;
    }) as jest.Mock & { CLOSED: number };
  SSE.CLOSED = 2;
  return { SSE };
});

const mockSetQueryData = jest.fn();
const mockGetQueryData = jest.fn();
const mockFetchQuery = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockRemoveQueries = jest.fn();
const mockBackingQueryClient = new QueryClient();
const mockQueryCache = mockBackingQueryClient.getQueryCache();
const mockFindAll = jest.fn((_queryKey?: QueryKey): Query[] => []);
const mockQueryClient = {
  setQueryData: mockSetQueryData,
  getQueryData: mockGetQueryData,
  fetchQuery: mockFetchQuery,
  invalidateQueries: mockInvalidateQueries,
  removeQueries: mockRemoveQueries,
  getQueryCache: () => ({
    findAll: mockFindAll,
    getAll: mockQueryCache.getAll.bind(mockQueryCache),
    find: mockQueryCache.find.bind(mockQueryCache),
    subscribe: mockQueryCache.subscribe.bind(mockQueryCache),
  }),
};

const mockActiveRunAtom = { key: 'activeRun' };
const mockAbortScrollAtom = { key: 'abortScroll' };
const mockSubmissionAtom = { key: 'submission' };
const mockShowStopButtonAtom = { key: 'showStopButton' };
const mockRunEndAtom = { key: 'runEnd' };
const mockDrainAfterAbortAtom = { key: 'drainAfterAbort' };
const mockPendingSteersAtom = { key: 'pendingSteers' };
const mockQueuedMessagesAtom = { key: 'queuedMessages' };
const mockSetActiveRun = jest.fn();
const mockSetAbortScroll = jest.fn();
const mockSetSubmission = jest.fn();
const mockSetShowStopButton = jest.fn();
const mockSetRunEnd = jest.fn();
const mockSetDrainAfterAbort = jest.fn();
const mockResolveSteerChip = jest.fn();
const mockUpdateSteerChips = jest.fn();
const mockSeedSteerChips = jest.fn();
const mockSettleAppliedSteerParts = jest.fn();
const mockConvertLocalSteersToQueued = jest.fn();
const mockUpdateGenerationEpoch = jest.fn();
const mockRestoreQueuedSubmission = jest.fn();
let mockRecoilCallbackIndex = 0;
const mockRecoilCallbacks = [
  mockRestoreQueuedSubmission,
  mockResolveSteerChip,
  mockUpdateSteerChips,
  mockSeedSteerChips,
  mockSettleAppliedSteerParts,
  mockConvertLocalSteersToQueued,
  mockUpdateGenerationEpoch,
];
function mockUseRecoilCallback() {
  return mockRecoilCallbacks[mockRecoilCallbackIndex++ % mockRecoilCallbacks.length];
}
const mockUseSetRecoilStateMock = jest.fn((atom: unknown) => {
  if (atom === mockActiveRunAtom) {
    return mockSetActiveRun;
  }
  if (atom === mockAbortScrollAtom) {
    return mockSetAbortScroll;
  }
  if (atom === mockSubmissionAtom) {
    return mockSetSubmission;
  }
  if (atom === mockShowStopButtonAtom) {
    return mockSetShowStopButton;
  }
  if (atom === mockRunEndAtom) {
    return mockSetRunEnd;
  }
  if (atom === mockDrainAfterAbortAtom) {
    return mockSetDrainAfterAbort;
  }
  return jest.fn();
});
function mockUseSetRecoilState(atom: unknown) {
  return mockUseSetRecoilStateMock(atom);
}

type DrainAfterAbortState =
  | false
  | {
      conversationId: string;
      generationCreatedAt: number;
    };

const applyLastDrainAfterAbortUpdate = (current: DrainAfterAbortState): DrainAfterAbortState => {
  const calls = mockSetDrainAfterAbort.mock.calls;
  const update = calls[calls.length - 1]?.[0] as
    | DrainAfterAbortState
    | ((armed: DrainAfterAbortState) => DrainAfterAbortState)
    | undefined;
  if (typeof update !== 'function') {
    throw new Error('Expected a functional drain-after-abort update');
  }
  return update(current);
};

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: mockUseSetRecoilState,
  // The hook's steer-chip/queue callbacks need a RecoilRoot; these tests render
  // bare, so return stable named spies in the hook's declaration order.
  useRecoilCallback: mockUseRecoilCallback,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    activeRunFamily: jest.fn(() => mockActiveRunAtom),
    abortScrollFamily: jest.fn(() => mockAbortScrollAtom),
    submissionByIndex: jest.fn(() => mockSubmissionAtom),
    showStopButtonByIndex: jest.fn(() => mockShowStopButtonAtom),
    runEndByIndex: jest.fn(() => mockRunEndAtom),
    drainAfterAbortByIndex: jest.fn(() => mockDrainAfterAbortAtom),
    pendingSteersByConvoId: jest.fn(() => mockPendingSteersAtom),
    queuedMessagesByConvoId: jest.fn(() => mockQueuedMessagesAtom),
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
}));

const mockFetchStreamStatus = jest.fn();
const mockGetConversationById = jest.fn();
const mockConvertSteersToQueued = jest.fn();
const mockPostGenerationRequest = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
  queueTitleGeneration: jest.fn(),
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
  fetchStreamStatus: (conversationId: string) => mockFetchStreamStatus(conversationId),
  GENERATION_PROTOCOL_VERSION: 2,
  generationProtocolHeaders: () => ({ 'X-LibreChat-Generation-Protocol': '2' }),
  getGenerationProtocolVersion: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2
      ? 2
      : 1,
  supportsGenerationProtocolV2: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2,
  postGenerationRequest: (...args: unknown[]) => mockPostGenerationRequest(...args),
}));

jest.mock('~/hooks/Chat/useSteerConvert', () => ({
  __esModule: true,
  default: () => mockConvertSteersToQueued,
}));

const mockErrorHandler = jest.fn();
const mockFinalHandler = jest.fn();
const mockCreatedHandler = jest.fn();
const mockStepHandler = jest.fn();
const mockTitleHandler = jest.fn();
const mockContentHandler = jest.fn();
const mockSyncHandler = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockClearStepMaps = jest.fn();

jest.mock('~/hooks/SSE/useEventHandlers', () => {
  const actual = jest.requireActual('~/hooks/SSE/useEventHandlers');
  return {
    __esModule: true,
    ...actual,
    // Read at call time: the hooks barrel imports useSSE during this factory.
    startedAsNewConversation: (submission: TSubmission) =>
      jest.requireActual('~/hooks/SSE/useEventHandlers').startedAsNewConversation(submission),
    buildCreatedInitialResponse: (
      submission: Pick<TSubmission, 'initialResponse' | 'userMessage' | 'isRegenerate'>,
    ) => jest.requireActual('~/hooks/SSE/useEventHandlers').buildCreatedInitialResponse(submission),
    default: jest.fn(() => ({
      errorHandler: mockErrorHandler,
      finalHandler: mockFinalHandler,
      createdHandler: mockCreatedHandler,
      attachmentHandler: jest.fn(),
      stepHandler: mockStepHandler,
      titleHandler: mockTitleHandler,
      contentHandler: mockContentHandler,
      syncHandler: mockSyncHandler,
      resetContentHandler: jest.fn(),
      syncStepMessage: jest.fn(),
      prunePtcTraces: jest.fn(),
      clearStepMaps: mockClearStepMaps,
      flushPendingDeltas: jest.fn(),
      cancelPendingDeltaFlush: jest.fn(),
      abortConversation: jest.fn(),
      messageHandler: jest.fn(),
      setIsSubmitting: mockSetIsSubmitting,
      setShowStopButton: jest.fn(),
    })),
  };
});

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
    },
    createPayload: jest.fn(() => ({
      payload: { model: 'gpt-4o' },
      server: '/api/agents/chat',
    })),
    removeNullishValues: jest.fn((v: unknown) => v),
    apiBaseUrl: jest.fn(() => ''),
    request: {
      post: jest.fn().mockResolvedValue({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      }),
      refreshToken: jest.fn(),
      dispatchTokenUpdatedEvent: jest.fn(),
    },
  };
});

import useResumableSSE, {
  selectLocalSteersForQueue,
  ABORT_SWEEP_STATUSES,
} from '~/hooks/SSE/useResumableSSE';
import useSSE from '~/hooks/SSE/useSSE';

const CONV_ID = 'conv-abc-123';

type PartialSubmission = {
  conversation: { conversationId?: string };
  isRegenerate?: boolean;
  compact?: boolean;
  editedContent?: Record<string, unknown>;
  editPrefixLength?: number;
  clientRequestId?: string;
  recoverySteerId?: string;
  expectedPredecessorCreatedAt?: number;
  queuedMessageOrigin?: unknown;
  userMessage: Record<string, unknown>;
  messages: TMessage[];
  isTemporary: boolean;
  initialResponse: Record<string, unknown>;
  endpointOption: { endpoint: string };
};

const buildSubmission = (overrides: Partial<PartialSubmission> = {}): TSubmission => {
  const conversationId = overrides.conversation?.conversationId ?? CONV_ID;
  return {
    conversation: { conversationId },
    userMessage: {
      messageId: 'msg-1',
      conversationId,
      text: 'Hello',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    },
    messages: [],
    isTemporary: false,
    initialResponse: {
      messageId: 'resp-1',
      conversationId,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    endpointOption: { endpoint: 'agents' },
    ...overrides,
  } as unknown as TSubmission;
};

const buildChatHelpers = () => ({
  setMessages: jest.fn(),
  getMessages: jest.fn<TMessage[], []>(() => []),
  setConversation: jest.fn(),
  setIsSubmitting: mockSetIsSubmitting,
  newConversation: jest.fn(),
});

const getLastSSE = (): MockSSEInstance => {
  const sse = mockSSEInstances[mockSSEInstances.length - 1];
  expect(sse).toBeDefined();
  return sse;
};

const serverNotReadyError = (retryAfter = '0') => ({
  response: {
    status: 503,
    data: { code: 'SERVER_NOT_READY' },
    headers: { 'retry-after': retryAfter },
  },
});

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const advanceRetryTimer = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await flushMicrotasks();
};

describe('useResumableSSE', () => {
  beforeEach(() => {
    mockSSEInstances.length = 0;
    localStorage.clear();
    mockErrorHandler.mockClear();
    mockFinalHandler.mockClear();
    mockCreatedHandler.mockClear();
    mockStepHandler.mockClear();
    mockTitleHandler.mockClear();
    mockClearStepMaps.mockClear();
    mockSetIsSubmitting.mockClear();
    mockSetQueryData.mockClear();
    mockGetQueryData.mockReset();
    mockFetchQuery.mockReset();
    mockFetchQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) =>
      Promise.resolve(mockGetQueryData(queryKey) ?? []),
    );
    mockInvalidateQueries.mockClear();
    mockRemoveQueries.mockClear();
    mockFindAll.mockReset();
    mockFindAll.mockReturnValue([]);
    mockBackingQueryClient.clear();
    mockUseSetRecoilStateMock.mockClear();
    mockSetActiveRun.mockClear();
    mockSetAbortScroll.mockClear();
    mockSetSubmission.mockClear();
    mockSetShowStopButton.mockClear();
    mockSetRunEnd.mockClear();
    mockSetDrainAfterAbort.mockClear();
    mockResolveSteerChip.mockClear();
    mockUpdateSteerChips.mockClear();
    mockSeedSteerChips.mockClear();
    mockSettleAppliedSteerParts.mockClear();
    mockConvertLocalSteersToQueued.mockClear();
    mockUpdateGenerationEpoch.mockClear();
    mockRestoreQueuedSubmission.mockClear();
    mockRecoilCallbackIndex = 0;
    mockConvertSteersToQueued.mockClear();
    mockFetchStreamStatus.mockReset();
    mockFetchStreamStatus.mockResolvedValue({ active: false });
    mockGetConversationById.mockReset();
    mockGetConversationById.mockResolvedValue({
      conversationId: CONV_ID,
      endpoint: 'agents',
    });
    (request.post as jest.Mock).mockReset();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-123',
      generationCreatedAt: 1000,
    });
    (request.refreshToken as jest.Mock).mockReset();
    (request.dispatchTokenUpdatedEvent as jest.Mock).mockReset();
    mockPostGenerationRequest.mockReset();
    mockPostGenerationRequest.mockImplementation((url: string, body: Record<string, unknown>) =>
      request.post(url, { ...body, generationProtocolVersion: 2 }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const seedDraft = (conversationId: string) => {
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`, 'draft text');
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`, '[]');
  };

  const render404Scenario = async (
    conversationId = CONV_ID,
    submissionOverrides: Partial<PartialSubmission> = {},
  ) => {
    const submission = buildSubmission({
      ...submissionOverrides,
      conversation: { conversationId },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    return { sse, unmount, chatHelpers };
  };

  it.each([useSSE, useResumableSSE])(
    '%p binds a created response before any output or usage',
    async (useTransport) => {
      removeUsageAtoms(CONV_ID);
      const submission = buildSubmission();
      const { unmount } = renderHook(() => useTransport(submission, buildChatHelpers()));
      await flushMicrotasks();
      const sse = getLastSSE();
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            created: true,
            message: { ...submission.userMessage, messageId: 'created-user-id' },
          }),
        });
      });
      expect(getDefaultStore().get(activeUsageResponseIdFamily(CONV_ID))).toBe('created-user-id_');
      expect(getDefaultStore().get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
      sse.readyState = MOCK_SSE_CLOSED;
      unmount();
    },
  );

  it.each(['final', 'cancel', 'error'])(
    'keeps Assistants sync identity consistent through content, usage, and %s',
    async (terminal) => {
      removeUsageAtoms(CONV_ID);
      const submission = buildSubmission({ endpointOption: { endpoint: 'assistants' } });
      const helpers = buildChatHelpers();
      const { unmount } = renderHook(() => useSSE(submission, helpers));
      const sse = getLastSSE();
      const synced = {
        messageId: 'assistant-server-id',
        parentMessageId: 'server-user',
        conversationId: CONV_ID,
        isCreatedByUser: false,
        text: '',
      };
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            sync: true,
            requestMessage: { ...submission.userMessage, messageId: 'server-user' },
            responseMessage: synced,
          }),
        });
      });
      const store = getDefaultStore();
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe(synced.messageId);
      expect(mockSyncHandler.mock.calls.at(-1)?.[1].initialResponse.messageId).toBe(
        synced.messageId,
      );
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({ type: 'text', index: 0, text: { value: 'x'.repeat(400) } }),
        });
        sse._emit('message', {
          data: JSON.stringify({
            event: 'on_token_usage',
            data: {
              input_tokens: 5,
              output_tokens: 100,
              cost: 0.01,
              runId: 'assistant-usage',
              seq: 1,
            },
          }),
        });
      });
      expect(mockContentHandler.mock.calls.at(-1)?.[0].submission.initialResponse.messageId).toBe(
        synced.messageId,
      );
      expect(mockContentHandler.mock.calls.at(-1)?.[0].submission.userMessage.messageId).toBe(
        'server-user',
      );
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe(synced.messageId);
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(1);
      // The rendered response has the same ID that the accounting owner uses.
      helpers.getMessages.mockReturnValue([synced]);
      if (terminal === 'final') {
        await act(async () =>
          sse._emit('message', {
            data: JSON.stringify({
              final: true,
              responseMessage: synced,
              conversation: { conversationId: CONV_ID },
            }),
          }),
        );
        expect(mockFinalHandler.mock.calls.at(-1)?.[1].initialResponse.messageId).toBe(
          synced.messageId,
        );
      } else {
        await act(async () =>
          sse._emit(terminal, { data: JSON.stringify({ message: 'Stream ended' }) }),
        );
      }
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBeNull();
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
      if (terminal !== 'error') {
        expect(store.get(branchTotalsFamily(CONV_ID)).tailId).toBe(synced.messageId);
        expect(store.get(branchTotalsFamily(CONV_ID)).lastTurnUsage?.output).toBe(100);
      }
      sse.readyState = MOCK_SSE_CLOSED;
      unmount();
    },
  );

  it('binds the waiting submission before the start request resolves', async () => {
    removeUsageAtoms(CONV_ID);
    let finishStart!: (value: unknown) => void;
    (request.post as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const submission = buildSubmission();
    const { unmount } = renderHook(() => useResumableSSE(submission, buildChatHelpers()));
    expect(getDefaultStore().get(activeUsageResponseIdFamily(CONV_ID))).toBe('resp-1');
    expect(getDefaultStore().get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
    unmount();
    await act(async () => {
      finishStart({ streamId: 'stream-123', generationCreatedAt: 1000 });
    });
  });

  it.each([useSSE, useResumableSSE])(
    '%p retains authoritative legacy text response ownership for subsequent usage events',
    async (useTransport) => {
      removeUsageAtoms(CONV_ID);
      const submission = buildSubmission();
      const { unmount } = renderHook(() => useTransport(submission, buildChatHelpers()));
      await flushMicrotasks();
      const sse = getLastSSE();
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            message: true,
            messageId: 'server-text-id',
            parentMessageId: 'msg-1',
            text: 'a'.repeat(400),
          }),
        });
      });
      const store = getDefaultStore();
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe('server-text-id');
      expect(store.get(liveTokensFamily(CONV_ID))).toBe(100);
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            event: 'on_token_usage',
            data: { input_tokens: 5, output_tokens: 100, runId: 'legacy-call', seq: 1 },
          }),
        });
      });
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBe('server-text-id');
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(1);
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            final: true,
            responseMessage: {
              messageId: 'server-text-id',
              parentMessageId: 'msg-1',
              conversationId: CONV_ID,
              isCreatedByUser: false,
              text: 'done',
            },
            conversation: { conversationId: CONV_ID },
          }),
        });
      });
      expect(store.get(activeUsageResponseIdFamily(CONV_ID))).toBeNull();
      expect(store.get(pendingUsageFamily(CONV_ID)).eventCount).toBe(0);
      // A finalized legacy stream closes without dispatching cancellation.
      sse.readyState = MOCK_SSE_CLOSED;
      unmount();
    },
  );

  it('clears the text and files draft from localStorage on 404', async () => {
    seedDraft(CONV_ID);
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${CONV_ID}`)).not.toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${CONV_ID}`)).not.toBeNull();

    const { unmount } = await render404Scenario(CONV_ID);

    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${CONV_ID}`)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${CONV_ID}`)).toBeNull();
    unmount();
  });

  it('invalidates message cache and clears stream status on 404 instead of showing error', async () => {
    const { unmount } = await render404Scenario(CONV_ID);

    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['messages', CONV_ID],
      refetchType: 'none',
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ['streamStatus', CONV_ID],
    });
    expect(mockClearStepMaps).toHaveBeenCalled();
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    unmount();
  });

  it('clears both TEXT and FILES drafts for new-convo when conversationId is absent', async () => {
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`, 'unsent message');
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`, '[]');

    const submission = buildSubmission({ conversation: {} });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`)).toBeNull();
    expect(
      localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`),
    ).toBeNull();
    unmount();
  });

  it('invalidates the stream conversation id on 404 for a new conversation', async () => {
    /* Key-aware: the conversation cache helpers now run a second, pinned-keyed pass,
       and a fixed return value would attribute those writes to allConversations. */
    mockFindAll.mockImplementation((queryKey?: QueryKey) => [
      mockQueryCache.build(mockBackingQueryClient, { queryKey: [queryKey![0]] as QueryKey }),
    ]);
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, 'stream-123'],
      refetchType: 'none',
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ['streamStatus', 'stream-123'],
    });

    const allConversationWrites = mockSetQueryData.mock.calls.filter(
      ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === QueryKeys.allConversations,
    );
    expect(allConversationWrites).toHaveLength(2);

    const removeUpdater = allConversationWrites[1][1] as (data: {
      pages: { conversations: { conversationId: string }[]; nextCursor: null }[];
      pageParams: never[];
    }) => { pages: { conversations: { conversationId: string }[] }[] };
    const result = removeUpdater({
      pages: [
        {
          conversations: [{ conversationId: 'stream-123' }, { conversationId: 'other' }],
          nextCursor: null,
        },
      ],
      pageParams: [],
    });
    expect(result.pages[0].conversations).toEqual([{ conversationId: 'other' }]);
    unmount();
  });

  it('reconciles conversations via refetch instead of removing them on a resume 404', async () => {
    /* Key-aware: the conversation cache helpers now run a second, pinned-keyed pass,
       and a fixed return value would attribute those writes to allConversations. */
    mockFindAll.mockImplementation((queryKey?: QueryKey) => [
      mockQueryCache.build(mockBackingQueryClient, { queryKey: [queryKey![0]] as QueryKey }),
    ]);
    // A deduped start returns status: 'resumed', so the client subscribes with resume=true.
    (request.post as jest.Mock).mockResolvedValue({ streamId: 'stream-123', status: 'resumed' });
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    // Reconcile against the server (refetch) rather than dropping a possibly-persisted
    // conversation. The handler is a mutually-exclusive isResume ? invalidate : remove, so
    // asserting the invalidate proves the immediate removal did not run.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.allConversations],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.pinnedConversations],
    });
    unmount();
  });

  it('closes the SSE connection on 404', async () => {
    const { sse, unmount } = await render404Scenario();

    expect(sse.close).toHaveBeenCalled();
    unmount();
  });

  it('preserves and reattaches a generation when status proves a 404 stream is still active', async () => {
    jest.useFakeTimers();
    const pendingSteers = [{ steerId: 'still-active', text: 'keep me', createdAt: 1 }];
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: 'stream-123',
      status: 'running',
      createdAt: 1000,
      resumeState: { pendingSteers, aggregatedContent: [] },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const initialSSE = getLastSSE();

    await act(async () => {
      initialSSE._emit('error', { responseCode: 404 });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({ active: true, createdAt: 1000 }),
    );
    expect(mockSeedSteerChips).toHaveBeenCalledWith(CONV_ID, pendingSteers, 1000, 1);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetSubmission).not.toHaveBeenCalledWith(null);
    expect(mockSetIsSubmitting).toHaveBeenLastCalledWith(true);
    expect(mockSetShowStopButton).toHaveBeenLastCalledWith(true);

    await advanceRetryTimer(1_000);
    expect(mockSSEInstances).toHaveLength(2);
    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-123?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    unmount();
  });

  it('claims parked steers and writes a non-completed run end on 404', async () => {
    const parked = [{ steerId: 'p1', text: 'parked words', createdAt: 1 }];
    mockFetchStreamStatus.mockResolvedValue({ active: false, unrecoveredSteers: parked });

    const { unmount } = await render404Scenario(CONV_ID);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(CONV_ID, parked, {
      generationProtocolVersion: 1,
    });
    // The true outcome is unknown: the run-end signal must release parked
    // interrupt flags WITHOUT auto-sending queued messages.
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'aborted' }),
    );
    expect(mockSetRunEnd).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
    );
    unmount();
  });

  it('authorizes only the exact failed recovery source past the conversion tombstone', async () => {
    const parked = [
      { steerId: 'failed-source', text: 'retry these words', createdAt: 1 },
      { steerId: 'unrelated-source', text: 'dedupe this snapshot', createdAt: 2 },
    ];
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-123',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      generationProtocolVersion: 2,
      unrecoveredSteers: parked,
    });

    const { unmount } = await render404Scenario(CONV_ID, {
      clientRequestId: 'steer-recovery:failed-source',
    });
    await flushMicrotasks();

    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(CONV_ID, parked, {
      generationProtocolVersion: 2,
      allowPreviouslyConvertedIds: ['failed-source'],
    });
    unmount();
  });

  it('suppresses persisted-applied and parked steer ids from local 404 recovery', async () => {
    const persisted = [
      {
        messageId: 'persisted-response',
        parentMessageId: 'persisted-user',
        conversationId: CONV_ID,
        isCreatedByUser: false,
        text: 'already applied',
        content: [
          {
            type: ContentTypes.STEER,
            steerId: 'persisted-steer',
            clientSteerId: 'persisted-client-steer',
            steer: 'already applied',
          },
        ],
      },
    ] as TMessage[];
    const parked = [
      {
        steerId: 'parked-steer',
        clientSteerId: 'parked-client-steer',
        text: 'recover exactly once',
        createdAt: 1,
      },
    ];
    mockGetQueryData.mockReturnValue(persisted);
    mockFetchStreamStatus.mockResolvedValue({ active: false, unrecoveredSteers: parked });

    const { unmount } = await render404Scenario(CONV_ID);
    await flushMicrotasks();

    expect(mockSettleAppliedSteerParts).toHaveBeenCalledWith(CONV_ID, persisted);
    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(CONV_ID, parked, {
      generationProtocolVersion: 1,
    });
    expect(mockConvertLocalSteersToQueued).toHaveBeenCalledTimes(1);
    const recoveryOptions = mockConvertLocalSteersToQueued.mock.calls[0][1] as {
      excludeSteerIds: Iterable<string>;
    };
    expect(new Set(recoveryOptions.excludeSteerIds)).toEqual(
      new Set(['persisted-steer', 'persisted-client-steer', 'parked-steer', 'parked-client-steer']),
    );
    unmount();
  });

  it('does not convert anything when the 404 status claim returns no parked steers', async () => {
    const { unmount } = await render404Scenario(CONV_ID);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(mockSetRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
    unmount();
  });

  it('still completes 404 cleanup when the status claim fails', async () => {
    mockFetchStreamStatus.mockRejectedValue(new Error('network down'));

    const { unmount } = await render404Scenario(CONV_ID);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(mockSetRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    unmount();
  });

  it('seeds sidebar and message caches for a new conversation once the stream id is known', async () => {
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSetQueryData).toHaveBeenCalledWith(
      [QueryKeys.conversation, 'stream-123'],
      expect.any(Function),
    );
    expect(mockSetQueryData).toHaveBeenCalledWith(
      [QueryKeys.messages, 'stream-123'],
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'msg-1', conversationId: 'stream-123' }),
        expect.objectContaining({ messageId: 'msg-1_', conversationId: 'stream-123' }),
      ]),
    );
    expect(mockSetQueryData).toHaveBeenCalledWith(
      [QueryKeys.messages, Constants.NEW_CONVO],
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'msg-1', conversationId: 'stream-123' }),
      ]),
    );
    expect(mockFindAll).toHaveBeenCalledWith([QueryKeys.allConversations], { exact: false });

    unmount();
  });

  it('replaces the new-chat URL when the stream id is known despite a stale parent id', async () => {
    window.history.pushState({}, '', '/c/new');
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: 'stale-parent-message',
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe('/c/stream-123');
    expect(mockSetQueryData).toHaveBeenCalledWith(
      [QueryKeys.messages, 'stream-123'],
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'msg-1', conversationId: 'stream-123' }),
      ]),
    );

    unmount();
    window.history.pushState({}, '', '/');
  });

  it('hydrates the submission conversation id before created handlers run', async () => {
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          created: true,
          message: {
            messageId: 'msg-1',
            conversationId: 'stream-123',
          },
        }),
      });
    });

    expect(mockCreatedHandler).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        conversation: expect.objectContaining({ conversationId: 'stream-123' }),
        userMessage: expect.objectContaining({ conversationId: 'stream-123' }),
      }),
    );
    unmount();
  });

  it('queues run step events until created hydrates the submission', async () => {
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStepEvent = {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: 'step-oauth',
        runId: 'msg-1_',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'Google-Workspace', args: '' }],
        },
      },
    };

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', { data: JSON.stringify(runStepEvent) });
    });

    expect(mockStepHandler).not.toHaveBeenCalled();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          created: true,
          message: {
            messageId: 'msg-1',
            conversationId: 'stream-123',
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenCalledWith(
      runStepEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'stream-123',
        }),
      }),
    );
    unmount();
  });

  it('renders OAuth run step events before created while retaining replay after hydration', async () => {
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStepEvent = {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: 'step-oauth',
        runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
        },
      },
    };
    const runStepDeltaEvent = {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: 'step-oauth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
          expires_at: 1780791946,
        },
      },
    };

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', { data: JSON.stringify(runStepEvent) });
      sse._emit('message', { data: JSON.stringify(runStepDeltaEvent) });
    });

    expect(mockStepHandler).toHaveBeenCalledTimes(2);
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      1,
      runStepEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'stream-123',
        }),
      }),
    );
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      2,
      runStepDeltaEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'stream-123',
        }),
      }),
    );

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          created: true,
          message: {
            messageId: 'msg-1',
            conversationId: 'stream-123',
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenCalledTimes(4);
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      3,
      runStepEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'stream-123',
        }),
      }),
    );
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      4,
      runStepDeltaEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'stream-123',
        }),
      }),
    );
    unmount();
  });

  it('replays pre-created OAuth completion against the hydrated response id', async () => {
    const previousUser = {
      messageId: 'previous-user',
      conversationId: CONV_ID,
      text: 'hi',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: Constants.NO_PARENT,
    } as TMessage;
    const previousResponse = {
      messageId: 'previous-response',
      conversationId: CONV_ID,
      text: 'hello',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: previousUser.messageId,
    } as TMessage;
    const submission = buildSubmission({
      conversation: { conversationId: CONV_ID },
      userMessage: {
        messageId: 'optimistic-user',
        conversationId: CONV_ID,
        text: 'thanks!',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: previousResponse.messageId,
      },
      messages: [previousUser, previousResponse],
      initialResponse: {
        messageId: 'optimistic-user_',
        conversationId: CONV_ID,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
        parentMessageId: 'optimistic-user',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStepEvent = {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: 'step-oauth',
        runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
        index: 0,
        type: 'tool_calls',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
        },
      },
    };
    const runStepDeltaEvent = {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: 'step-oauth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
          expires_at: 1780791946,
        },
      },
    };
    const completedEvent = {
      event: StepEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          id: 'step-oauth',
          index: 0,
          tool_call: {
            id: 'call-oauth',
            name: 'oauth_mcp_Google-Workspace',
            args: '',
            output: 'OAuth authentication completed',
            type: 'tool_call',
          },
        },
      },
    };
    const createdEvent = {
      created: true,
      message: {
        messageId: 'server-user',
        parentMessageId: previousResponse.messageId,
        conversationId: CONV_ID,
        sender: 'User',
        text: 'thanks!',
        isCreatedByUser: true,
      },
      streamId: CONV_ID,
    };

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', { data: JSON.stringify(runStepEvent) });
      sse._emit('message', { data: JSON.stringify(runStepDeltaEvent) });
      sse._emit('message', { data: JSON.stringify(completedEvent) });
    });

    expect(mockStepHandler).toHaveBeenCalledTimes(3);
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      3,
      completedEvent,
      expect.objectContaining({
        initialResponse: expect.objectContaining({
          messageId: 'optimistic-user_',
          parentMessageId: 'optimistic-user',
        }),
      }),
    );

    await act(async () => {
      sse._emit('message', { data: JSON.stringify(createdEvent) });
    });

    expect(mockCreatedHandler).toHaveBeenCalledWith(
      createdEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({
          messageId: 'server-user',
          parentMessageId: previousResponse.messageId,
        }),
        initialResponse: expect.objectContaining({
          messageId: 'server-user_',
          parentMessageId: 'server-user',
        }),
      }),
    );
    expect(mockStepHandler).toHaveBeenCalledTimes(6);
    for (let callIndex = 4; callIndex <= 6; callIndex++) {
      expect(mockStepHandler).toHaveBeenNthCalledWith(
        callIndex,
        expect.any(Object),
        expect.objectContaining({
          userMessage: expect.objectContaining({
            messageId: 'server-user',
            parentMessageId: previousResponse.messageId,
          }),
          initialResponse: expect.objectContaining({
            messageId: 'server-user_',
            parentMessageId: 'server-user',
          }),
        }),
      );
    }

    unmount();
  });

  it('routes title stream events to the title handler', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const titleEvent = {
      event: 'title',
      data: {
        conversationId: CONV_ID,
        title: 'Streamed Title',
      },
    };
    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', { data: JSON.stringify(titleEvent) });
    });

    expect(mockTitleHandler).toHaveBeenCalledWith(titleEvent);
    expect(mockStepHandler).not.toHaveBeenCalled();
    unmount();
  });

  it('carries the generation epoch on the initial SSE URL and every reconnect', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-epoch',
      status: 'started',
      generationCreatedAt: 1000,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    expect(initialSSE._url).toBe(
      '/api/agents/chat/stream/stream-epoch?generationCreatedAt=1000&generationProtocolVersion=2',
    );
    expect(initialSSE.headers).toEqual({
      Authorization: 'Bearer test-token',
      'X-LibreChat-Generation-Protocol': '2',
    });
    expect(request.post).toHaveBeenCalledWith(
      '/api/agents/chat',
      expect.objectContaining({ generationProtocolVersion: 2 }),
    );

    await act(async () => {
      initialSSE._emit('error', { responseCode: 0 });
    });
    await advanceRetryTimer(1000);

    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-epoch?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    unmount();
  });

  it('preserves the generation protocol header across a 401 token refresh', async () => {
    (request.refreshToken as jest.Mock).mockResolvedValueOnce({ token: 'refreshed-token' });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();

    await act(async () => {
      sse._emit('error', { responseCode: 401 });
      await Promise.resolve();
    });

    expect(sse.headers).toEqual({
      Authorization: 'Bearer refreshed-token',
      'X-LibreChat-Generation-Protocol': '2',
    });
    expect(request.dispatchTokenUpdatedEvent).toHaveBeenCalledWith('refreshed-token');
    expect(sse.stream).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('withholds live Stop until the start response installs a generation epoch', async () => {
    let resolveStart: ((value: { streamId: string; generationCreatedAt: number }) => void) | null =
      null;
    (request.post as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockSetShowStopButton).toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(true);

    await act(async () => {
      resolveStart?.({ streamId: 'stream-epoch', generationCreatedAt: 1000 });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(getLastSSE()._url).toContain('generationCreatedAt=1000');
    expect(mockUpdateGenerationEpoch).toHaveBeenCalledWith('stream-epoch', 1000, undefined, 1);
    expect(mockSetShowStopButton).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it('keeps live controls hidden across reconnects when a malformed start omits the epoch', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({ streamId: 'stream-without-epoch' });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    await act(async () => {
      getLastSSE()._emit('error');
    });

    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(true);
    expect(mockSetShowStopButton).toHaveBeenLastCalledWith(false);
    unmount();
  });

  it('adopts an authoritative replacement epoch for an epoch-less attachment', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: { pendingSteers: [], aggregatedContent: [] },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const epochlessSSE = getLastSSE();

    await act(async () => {
      epochlessSSE._emit('error', { responseCode: 409 });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({ createdAt: 2000, generationHandoff: true }),
    );
    expect(mockUpdateGenerationEpoch).toHaveBeenCalledWith(CONV_ID, 2000, undefined, 2);
    expect(mockSetSubmission).toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    unmount();
  });

  it('refetches a settled duplicate without opening an SSE stream', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      conversationId: CONV_ID,
      status: 'settled',
      generationProtocolVersion: 2,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await waitFor(() => {
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
    });

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
      refetchType: 'all',
    });
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'aborted' }),
    );
    unmount();
  });

  it('keeps a mode picked while a settled start was pending', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      conversationId: CONV_ID,
      status: 'settled',
      generationProtocolVersion: 2,
    });
    mockGetConversationById.mockResolvedValue({
      conversationId: CONV_ID,
      endpoint: 'agents',
      codeApprovalMode: 'fullAccess',
    });
    mockGetQueryData.mockImplementation((queryKey: unknown[]) =>
      queryKey[0] === QueryKeys.conversation
        ? { conversationId: CONV_ID, codeApprovalMode: 'ask' }
        : undefined,
    );
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(buildSubmission(), chatHelpers));

    await waitFor(() => {
      expect(chatHelpers.setConversation).toHaveBeenCalled();
    });

    const update = chatHelpers.setConversation.mock.calls.at(-1)?.[0];
    expect(update({ conversationId: CONV_ID, codeApprovalMode: 'ask' }).codeApprovalMode).toBe(
      'ask',
    );
    expect(
      update({ conversationId: 'conv-elsewhere', codeApprovalMode: 'ask' }).codeApprovalMode,
    ).toBe('fullAccess');
    expect(mockSetQueryData).toHaveBeenCalledWith(
      [QueryKeys.conversation, CONV_ID],
      expect.objectContaining({ codeApprovalMode: 'ask' }),
    );
    unmount();
  });

  it.each(['settled', 'replaced'] as const)(
    'rejects an unnegotiated %s start control response',
    async (status) => {
      (request.post as jest.Mock).mockResolvedValue({
        status,
        streamId: CONV_ID,
        conversationId: CONV_ID,
        generationCreatedAt: 1000,
      });
      const submission = buildSubmission();
      const chatHelpers = buildChatHelpers();

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

      expect(mockSSEInstances).toHaveLength(0);
      expect(mockErrorHandler).toHaveBeenCalledWith(expect.objectContaining({ submission }));
      unmount();
    },
  );

  it('returns a settled first turn to new chat only after an authoritative 404', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      conversationId: CONV_ID,
      status: 'settled',
      generationProtocolVersion: 2,
    });
    mockGetConversationById.mockRejectedValueOnce({ response: { status: 404 } });
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockSSEInstances).toHaveLength(0);
    expect(chatHelpers.newConversation).toHaveBeenCalledWith({
      template: { conversationId: String(Constants.NEW_CONVO) },
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.conversation, CONV_ID],
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
    });
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'aborted' }),
    );
    unmount();
  });

  it('preserves a settled first turn when conversation lookup fails transiently', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      conversationId: CONV_ID,
      status: 'settled',
      generationProtocolVersion: 2,
    });
    mockGetConversationById.mockRejectedValueOnce({ response: { status: 503 } });
    const submission = buildSubmission({ conversation: {} });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockSSEInstances).toHaveLength(0);
    expect(chatHelpers.newConversation).not.toHaveBeenCalled();
    expect(mockRemoveQueries).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
      refetchType: 'all',
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.allConversations],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.pinnedConversations],
    });
    /** The settled response carries no epoch, so it cannot authorize clearing
     * whichever conversation/generation may now own this pane's arm. */
    expect(mockSetDrainAfterAbort).not.toHaveBeenCalled();
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'error' }),
    );
    unmount();
  });

  it('drops an awaited settled-start callback after conversation B starts', async () => {
    const conversationB = 'conv-b-settled-race';
    (request.post as jest.Mock)
      .mockResolvedValueOnce({
        conversationId: CONV_ID,
        status: 'settled',
        generationProtocolVersion: 2,
      })
      .mockResolvedValueOnce({
        streamId: conversationB,
        status: 'started',
        generationCreatedAt: 2000,
        generationProtocolVersion: 2,
      });
    let resolveConversation!: (value: { conversationId: string; endpoint: string }) => void;
    mockGetConversationById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConversation = resolve;
        }),
    );
    const submissionA = buildSubmission({ clientRequestId: 'settled-request-a' });
    const submissionB = buildSubmission({
      conversation: { conversationId: conversationB },
      clientRequestId: 'request-b',
      userMessage: {
        ...submissionA.userMessage,
        messageId: 'msg-b',
        conversationId: conversationB,
      },
      initialResponse: {
        ...submissionA.initialResponse,
        messageId: 'resp-b',
        conversationId: conversationB,
      },
    });
    const chatHelpers = buildChatHelpers();
    const { rerender, unmount } = renderHook(
      ({ current }: { current: TSubmission }) => useResumableSSE(current, chatHelpers),
      { initialProps: { current: submissionA } },
    );
    await waitFor(() => expect(mockGetConversationById).toHaveBeenCalledWith(CONV_ID));

    rerender({ current: submissionB });
    await waitFor(() => expect(mockSSEInstances).toHaveLength(1));
    const generationB = getLastSSE();
    chatHelpers.setConversation.mockClear();
    mockSetSubmission.mockClear();
    mockSetRunEnd.mockClear();
    mockSetIsSubmitting.mockClear();
    mockSetShowStopButton.mockClear();

    await act(async () => {
      resolveConversation({ conversationId: CONV_ID, endpoint: 'agents' });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(chatHelpers.setConversation).not.toHaveBeenCalled();
    expect(mockSetSubmission).not.toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(false);
    expect(generationB.close).not.toHaveBeenCalled();
    unmount();
  });

  it('hands a stale SSE attachment to the active replacement generation', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: {
        conversationId: CONV_ID,
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'replacement content' }],
        pendingSteers: [],
      },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const staleSSE = getLastSSE();
    await act(async () => {
      staleSSE._emit('error', { responseCode: 409 });
      await Promise.resolve();
    });

    expect(staleSSE.close).toHaveBeenCalled();
    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({
        active: true,
        createdAt: 2000,
        generationHandoff: true,
      }),
    );
    expect(mockSetSubmission).toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    unmount();
  });

  it('does not let a delayed FINAL from generation A idle active generation B', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: {
        conversationId: CONV_ID,
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'generation B content' }],
        pendingSteers: [],
      },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const generationA = getLastSSE();
    await act(async () => {
      generationA._emit('message', {
        data: JSON.stringify({
          final: true,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
          requestMessage: submission.userMessage,
          responseMessage: submission.initialResponse,
        }),
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));
    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({
        active: true,
        createdAt: 2000,
        generationHandoff: true,
      }),
    );
    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    unmount();
  });

  it('drops an awaited FINAL callback after navigation installs conversation B', async () => {
    const conversationB = 'conv-b-456';
    (request.post as jest.Mock)
      .mockResolvedValueOnce({
        streamId: CONV_ID,
        status: 'started',
        generationCreatedAt: 1000,
        generationProtocolVersion: 2,
      })
      .mockResolvedValueOnce({
        streamId: conversationB,
        status: 'started',
        generationCreatedAt: 2000,
        generationProtocolVersion: 2,
      });
    let resolveTerminalStatus!: (value: { active: false; generationProtocolVersion: 2 }) => void;
    mockFetchStreamStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTerminalStatus = resolve;
        }),
    );
    const submissionA = buildSubmission({ clientRequestId: 'request-a' });
    const submissionB = buildSubmission({
      conversation: { conversationId: conversationB },
      clientRequestId: 'request-b',
      userMessage: {
        ...submissionA.userMessage,
        messageId: 'msg-b',
        conversationId: conversationB,
      },
      initialResponse: {
        ...submissionA.initialResponse,
        messageId: 'resp-b',
        conversationId: conversationB,
      },
    });
    const chatHelpers = buildChatHelpers();
    const { rerender, unmount } = renderHook(
      ({ current }: { current: TSubmission }) => useResumableSSE(current, chatHelpers),
      { initialProps: { current: submissionA } },
    );
    await flushMicrotasks();

    const generationA = getLastSSE();
    act(() => {
      generationA._emit('message', {
        data: JSON.stringify({
          final: true,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
          requestMessage: submissionA.userMessage,
          responseMessage: submissionA.initialResponse,
        }),
      });
    });
    await waitFor(() => expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID));

    rerender({ current: submissionB });
    await waitFor(() => expect(mockSSEInstances).toHaveLength(2));
    const generationB = getLastSSE();
    mockFinalHandler.mockClear();
    mockSetSubmission.mockClear();
    mockSetRunEnd.mockClear();
    mockSetIsSubmitting.mockClear();
    mockSetShowStopButton.mockClear();

    await act(async () => {
      resolveTerminalStatus({ active: false, generationProtocolVersion: 2 });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockSetSubmission).not.toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(false);
    expect(generationB.close).not.toHaveBeenCalled();
    unmount();
  });

  it('drops an awaited synthesized reconciliation after conversation B starts', async () => {
    const conversationB = 'conv-b-789';
    (request.post as jest.Mock)
      .mockResolvedValueOnce({
        streamId: CONV_ID,
        status: 'started',
        generationCreatedAt: 1000,
        generationProtocolVersion: 2,
      })
      .mockResolvedValueOnce({
        streamId: conversationB,
        status: 'started',
        generationCreatedAt: 2000,
        generationProtocolVersion: 2,
      });
    let resolveMessages!: (value: TMessage[]) => void;
    mockFetchQuery.mockImplementationOnce(
      () =>
        new Promise<TMessage[]>((resolve) => {
          resolveMessages = resolve;
        }),
    );
    const submissionA = buildSubmission({ clientRequestId: 'request-a' });
    const submissionB = buildSubmission({
      conversation: { conversationId: conversationB },
      clientRequestId: 'request-b',
      userMessage: {
        ...submissionA.userMessage,
        messageId: 'msg-b',
        conversationId: conversationB,
      },
      initialResponse: {
        ...submissionA.initialResponse,
        messageId: 'resp-b',
        conversationId: conversationB,
      },
    });
    const chatHelpers = buildChatHelpers();
    const { rerender, unmount } = renderHook(
      ({ current }: { current: TSubmission }) => useResumableSSE(current, chatHelpers),
      { initialProps: { current: submissionA } },
    );
    await flushMicrotasks();

    act(() => {
      getLastSSE()._emit('message', {
        data: JSON.stringify({
          final: true,
          reconcile: true,
          reconcileReason: 'abort_persistence_failed',
          terminalStatus: 'aborted',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
        }),
      });
    });
    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());

    rerender({ current: submissionB });
    await waitFor(() => expect(mockSSEInstances).toHaveLength(2));
    const generationB = getLastSSE();
    mockFetchStreamStatus.mockClear();
    mockFinalHandler.mockClear();
    mockSetSubmission.mockClear();
    mockSetRunEnd.mockClear();
    mockSetDrainAfterAbort.mockClear();
    mockSetIsSubmitting.mockClear();
    mockSetShowStopButton.mockClear();
    mockSettleAppliedSteerParts.mockClear();

    await act(async () => {
      resolveMessages([]);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchStreamStatus).not.toHaveBeenCalled();
    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockSettleAppliedSteerParts).not.toHaveBeenCalled();
    expect(mockSetSubmission).not.toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetDrainAfterAbort).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(false);
    expect(generationB.close).not.toHaveBeenCalled();
    unmount();
  });

  it('does not let a delayed error from generation A idle active generation B', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: {
        conversationId: CONV_ID,
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'generation B content' }],
        pendingSteers: [],
      },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const generationA = getLastSSE();
    await act(async () => {
      generationA._emit('error', {
        data: JSON.stringify({
          error: 'generation A failed late',
          generationProtocolVersion: 2,
        }),
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));
    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({
        active: true,
        createdAt: 2000,
        generationHandoff: true,
      }),
    );
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    unmount();
  });

  it('retries the exact fenced generation when FINAL races an active status', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 1000,
      generationProtocolVersion: 2,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const generationSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    await act(async () => {
      generationSSE._emit('message', {
        data: JSON.stringify({
          final: true,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
          requestMessage: submission.userMessage,
          responseMessage: submission.initialResponse,
        }),
      });
      await Promise.resolve();
    });

    expect(generationSSE.close).toHaveBeenCalled();
    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();

    await advanceRetryTimer(250);

    expect(mockSSEInstances).toHaveLength(sseCount + 1);
    expect(getLastSSE()._url).toContain('resume=true');
    expect(getLastSSE()._url).toContain('generationCreatedAt=1000');
    unmount();
  });

  it('retries the exact fenced generation when error status is inconclusive', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockRejectedValue(new Error('status unavailable'));
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const generationSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    await act(async () => {
      generationSSE._emit('error', {
        data: JSON.stringify({
          error: 'generation failed',
          generationProtocolVersion: 2,
        }),
      });
      await Promise.resolve();
    });

    expect(generationSSE.close).toHaveBeenCalled();
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();

    await advanceRetryTimer(250);

    expect(mockSSEInstances).toHaveLength(sseCount + 1);
    expect(getLastSSE()._url).toContain('resume=true');
    expect(getLastSSE()._url).toContain('generationCreatedAt=1000');
    unmount();
  });

  it('hands a replaced start to the authoritative generation without attaching the stale submission', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      status: 'replaced',
      streamId: CONV_ID,
      conversationId: CONV_ID,
      generationCreatedAt: 2000,
      generationProtocolVersion: 2,
    });
    const pendingSteers = [{ steerId: 'replacement-steer', text: 'new epoch', createdAt: 2 }];
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: {
        conversationId: CONV_ID,
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'replacement content' }],
        pendingSteers,
      },
    });
    mockGetQueryData.mockImplementation((queryKey: unknown[]) =>
      queryKey[0] === QueryKeys.conversation
        ? { conversationId: CONV_ID, endpoint: 'agents' }
        : undefined,
    );
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({
        active: true,
        createdAt: 2000,
        generationHandoff: true,
      }),
    );
    expect(mockSeedSteerChips).toHaveBeenCalledWith(CONV_ID, pendingSteers, 2000, 2);
    expect(mockUpdateGenerationEpoch).toHaveBeenCalledWith(CONV_ID, 2000, undefined, 2);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    unmount();
  });

  it('only disarms the replacement epoch when replacement status cannot be confirmed', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      status: 'replaced',
      streamId: CONV_ID,
      conversationId: CONV_ID,
      generationCreatedAt: 2000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      createdAt: 2000,
      generationProtocolVersion: 2,
    });

    const { unmount } = renderHook(() => useResumableSSE(buildSubmission(), buildChatHelpers()));
    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockSetDrainAfterAbort).toHaveBeenCalledWith(expect.any(Function));
    const conversationBArm = {
      conversationId: 'conv-b',
      generationCreatedAt: 3000,
    };
    const newerSameConversationArm = {
      conversationId: CONV_ID,
      generationCreatedAt: 3000,
    };
    expect(applyLastDrainAfterAbortUpdate(conversationBArm)).toBe(conversationBArm);
    expect(applyLastDrainAfterAbortUpdate(newerSameConversationArm)).toBe(newerSameConversationArm);
    expect(
      applyLastDrainAfterAbortUpdate({
        conversationId: CONV_ID,
        generationCreatedAt: 2000,
      }),
    ).toBe(false);
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, generationCreatedAt: 2000 }),
    );
    unmount();
  });

  it('never treats an incomplete replaced response as an ordinary stream start', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      status: 'replaced',
      streamId: CONV_ID,
      conversationId: CONV_ID,
      generationProtocolVersion: 2,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockErrorHandler).toHaveBeenCalledWith(expect.objectContaining({ submission }));
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    'status',
    'submission',
    'unique-placeholder',
    'ambiguous-placeholder',
    'missing-response',
  ])(
    'reconciles a synthesized terminal using %s response identity instead of a later sibling',
    async (identitySource) => {
      (request.post as jest.Mock).mockResolvedValue({
        streamId: CONV_ID,
        status: 'started',
        generationCreatedAt: 1000,
        generationProtocolVersion: 2,
      });
      const persisted = [
        {
          messageId: 'persisted-response',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: 'Persisted answer',
        },
        {
          messageId: 'later-sibling',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: 'A different branch',
        },
      ] as TMessage[];
      if (identitySource === 'unique-placeholder') {
        persisted.pop();
      }
      mockGetQueryData.mockReturnValue(persisted);
      mockFetchStreamStatus.mockResolvedValue({
        active: false,
        generationProtocolVersion: 2,
        ...(identitySource === 'status' && {
          resumeState: { responseMessageId: 'persisted-response' },
        }),
      });
      const responseIds: Record<string, string> = {
        submission: 'persisted-response_',
        'missing-response': 'missing-response_',
      };
      const submission = buildSubmission({
        initialResponse: { messageId: responseIds[identitySource] ?? 'msg-1_' },
      });
      const chatHelpers = buildChatHelpers();
      getDefaultStore().set(pendingApprovalActionFamily(CONV_ID), {
        actionId: 'stale-action',
        streamId: CONV_ID,
        createdAt: 1000,
        payload: { type: 'tool_approval', action_requests: [], review_configs: [] },
      });

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await flushMicrotasks();

      const sse = getLastSSE();
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            final: true,
            reconcile: true,
            reconcileReason: 'terminal_payload_missing',
            terminalStatus: 'complete',
            generationCreatedAt: 1000,
            generationProtocolVersion: 2,
            conversation: { conversationId: CONV_ID },
          }),
        });
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(mockFinalHandler).not.toHaveBeenCalled();
      expect(mockErrorHandler).not.toHaveBeenCalled();
      expect(getDefaultStore().get(pendingApprovalActionFamily(CONV_ID))).toBeNull();
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONV_ID],
        refetchType: 'none',
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: [QueryKeys.allConversations],
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: [QueryKeys.pinnedConversations],
      });
      expect(mockSettleAppliedSteerParts).toHaveBeenCalledWith(CONV_ID, persisted);
      expect(mockSetRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONV_ID,
          outcome: 'completed',
          ...(['status', 'submission', 'unique-placeholder'].includes(identitySource) && {
            responseMessageId: 'persisted-response',
          }),
        }),
      );
      if (['ambiguous-placeholder', 'missing-response'].includes(identitySource)) {
        expect(mockSetRunEnd.mock.calls.at(-1)?.[0]).not.toHaveProperty('responseMessageId');
      }
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
      expect(mockUpdateGenerationEpoch).toHaveBeenCalledWith(CONV_ID, null, 1000);
      unmount();
    },
  );

  it('ignores v2-only lifecycle reconciliation on a legacy generation', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();
    mockInvalidateQueries.mockClear();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          reconcile: true,
          reconcileReason: 'terminal_payload_missing',
          generationProtocolVersion: 2,
          generationCreatedAt: 1000,
          conversation: { conversationId: CONV_ID },
        }),
      });
      await Promise.resolve();
    });

    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(sse.close).not.toHaveBeenCalled();
    unmount();
  });

  it('does not publish a completed run when synthesized persistence cannot be fetched', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchQuery.mockRejectedValueOnce(new Error('message refetch failed'));
    mockFetchStreamStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    await act(async () => {
      getLastSSE()._emit('message', {
        data: JSON.stringify({
          final: true,
          reconcile: true,
          reconcileReason: 'terminal_payload_missing',
          terminalStatus: 'complete',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
        }),
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'error' }),
    );
    expect(mockSetRunEnd).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
    );
    expect(mockConvertLocalSteersToQueued).not.toHaveBeenCalled();
    unmount();
  });

  it('disarms interrupt drain before publishing an abort persistence failure', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchQuery.mockResolvedValueOnce([]);
    mockFetchStreamStatus.mockResolvedValue({ active: false, generationProtocolVersion: 2 });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    await act(async () => {
      getLastSSE()._emit('message', {
        data: JSON.stringify({
          final: true,
          reconcile: true,
          reconcileReason: 'abort_persistence_failed',
          terminalStatus: 'aborted',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
        }),
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSetDrainAfterAbort).toHaveBeenCalledWith(expect.any(Function));
    const conversationBArm = {
      conversationId: 'conv-b',
      generationCreatedAt: 2000,
    };
    const newerSameConversationArm = {
      conversationId: CONV_ID,
      generationCreatedAt: 2000,
    };
    expect(applyLastDrainAfterAbortUpdate(conversationBArm)).toBe(conversationBArm);
    expect(applyLastDrainAfterAbortUpdate(newerSameConversationArm)).toBe(newerSameConversationArm);
    expect(
      applyLastDrainAfterAbortUpdate({
        conversationId: CONV_ID,
        generationCreatedAt: 1000,
      }),
    ).toBe(false);
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'aborted' }),
    );
    expect(mockSetDrainAfterAbort.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetRunEnd.mock.invocationCallOrder[0],
    );
    unmount();
  });

  it('hands a synthesized generation-replaced frame to the newer active epoch', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: CONV_ID,
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: CONV_ID,
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: { runSteps: [], aggregatedContent: [] },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          reconcile: true,
          reconcileReason: 'generation_replaced',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
          conversation: { conversationId: CONV_ID },
        }),
      });
      await Promise.resolve();
    });

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({ createdAt: 2000, generationHandoff: true }),
    );
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockSetSubmission).toHaveBeenCalledWith(null);
    expect(mockUpdateGenerationEpoch).toHaveBeenCalledWith(CONV_ID, 2000, undefined, 2);
    unmount();
  });

  it('renders a steer applied before the first run step on the live placeholder', async () => {
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const userMessage = {
      messageId: 'user-1',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const submission = buildSubmission({ userMessage });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();

    /** `created` carries only the user message; the pane renders the response
     *  under `${userMessageId}_` until the first run step renames it. */
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({ created: true, message: { ...userMessage } }),
      });
    });
    chatHelpers.getMessages.mockReturnValue([
      userMessage,
      { messageId: 'user-1_', conversationId: CONV_ID, isCreatedByUser: false, content: [] },
    ] as TMessage[]);
    chatHelpers.setMessages.mockClear();

    /** An interrupt before the model has said a word: the steer is injected at
     *  content index 0, stamped with the server's pre-allocated response id —
     *  which no local row carries yet. */
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          event: 'on_steer_applied',
          data: {
            steerId: 'server-1',
            clientSteerId: 'client-1',
            conversationId: CONV_ID,
            responseMessageId: 'a1b2c3d4-preallocated',
            index: 0,
            part: {
              type: ContentTypes.STEER,
              [ContentTypes.STEER]: 'change of plan',
              steerId: 'server-1',
              clientSteerId: 'client-1',
            },
          },
        }),
      });
    });

    const committed = chatHelpers.setMessages.mock.calls
      .map(([messages]) => messages as TMessage[])
      .find((messages) => messages?.some((m) => m.messageId === 'user-1_'));
    const placeholder = committed?.find((m) => m.messageId === 'user-1_');
    expect(placeholder?.content?.[0]).toEqual(
      expect.objectContaining({ type: ContentTypes.STEER, steerId: 'server-1' }),
    );
    /** Landed on the first pass — no frame retries burned waiting for a rename
     *  that only the first run step can perform. */
    expect(requestFrame).not.toHaveBeenCalled();
    requestFrame.mockRestore();
    unmount();
  });

  it('hands the step handler a submission whose placeholder carries the early steer', async () => {
    /** A regenerate seeds the renamed response from `submission.initialResponse`,
     *  not from the store tail, so the steer landed on the placeholder must also
     *  reach the submission the first run step is handed. */
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const userMessage = {
      messageId: 'user-1',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const submission = buildSubmission({
      userMessage,
      isRegenerate: true,
      initialResponse: {
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        conversationId: CONV_ID,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({ created: true, message: { ...userMessage } }),
      });
    });
    chatHelpers.getMessages.mockReturnValue([
      userMessage,
      { messageId: 'user-1_', conversationId: CONV_ID, isCreatedByUser: false, content: [] },
    ] as TMessage[]);

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          event: 'on_steer_applied',
          data: {
            steerId: 'server-1',
            clientSteerId: 'client-1',
            conversationId: CONV_ID,
            responseMessageId: 'a1b2c3d4-preallocated',
            index: 0,
            part: {
              type: ContentTypes.STEER,
              [ContentTypes.STEER]: 'change of plan',
              steerId: 'server-1',
              clientSteerId: 'client-1',
            },
          },
        }),
      });
    });

    mockStepHandler.mockClear();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'a1b2c3d4-preallocated',
            index: 1,
            type: 'message_creation',
            stepDetails: { type: 'message_creation', message_creation: { message_id: 'm-1' } },
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenCalled();
    const calls = mockStepHandler.mock.calls;
    const handed = calls[calls.length - 1][1] as TSubmission;
    expect(handed.initialResponse?.messageId).toBe('user-1_');
    expect(handed.initialResponse?.content?.[0]).toEqual(
      expect.objectContaining({ type: ContentTypes.STEER, steerId: 'server-1' }),
    );
    requestFrame.mockRestore();
    unmount();
  });

  it('shifts an early steer past the retained prefix of an edited resubmission', async () => {
    /** The server indexes only the NEW content of an edited resubmission and
     *  the steer claims that same server-local space, so it lands after the
     *  kept prefix — and the seed handed to the first run step carries it. */
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const userMessage = {
      messageId: 'user-1',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const keptPrefix = [
      { type: ContentTypes.TEXT, text: 'kept one' },
      { type: ContentTypes.TEXT, text: 'kept two' },
    ];
    const submission = buildSubmission({
      userMessage,
      editedContent: { index: 1, type: ContentTypes.TEXT, text: 'kept two' },
      editPrefixLength: keptPrefix.length,
      initialResponse: {
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        conversationId: CONV_ID,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
        content: keptPrefix,
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({ created: true, message: { ...userMessage } }),
      });
    });
    chatHelpers.getMessages.mockReturnValue([
      userMessage,
      {
        messageId: 'user-1_',
        conversationId: CONV_ID,
        isCreatedByUser: false,
        content: keptPrefix,
      },
    ] as TMessage[]);
    chatHelpers.setMessages.mockClear();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          event: 'on_steer_applied',
          data: {
            steerId: 'server-1',
            clientSteerId: 'client-1',
            conversationId: CONV_ID,
            responseMessageId: 'a1b2c3d4-preallocated',
            index: 0,
            part: {
              type: ContentTypes.STEER,
              [ContentTypes.STEER]: 'change of plan',
              steerId: 'server-1',
              clientSteerId: 'client-1',
            },
          },
        }),
      });
    });

    const committed = chatHelpers.setMessages.mock.calls
      .map(([messages]) => messages as TMessage[])
      .find((messages) => messages?.some((m) => m.messageId === 'user-1_'));
    const placeholder = committed?.find((m) => m.messageId === 'user-1_');
    expect(placeholder?.content?.[0]).toEqual(expect.objectContaining({ text: 'kept one' }));
    expect(placeholder?.content?.[1]).toEqual(expect.objectContaining({ text: 'kept two' }));
    expect(placeholder?.content?.[2]).toEqual(
      expect.objectContaining({ type: ContentTypes.STEER, steerId: 'server-1' }),
    );

    mockStepHandler.mockClear();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'a1b2c3d4-preallocated',
            index: 1,
            type: 'message_creation',
            stepDetails: { type: 'message_creation', message_creation: { message_id: 'm-1' } },
          },
        }),
      });
    });
    const calls = mockStepHandler.mock.calls;
    const handed = calls[calls.length - 1][1] as TSubmission;
    expect(handed.initialResponse?.content?.[2]).toEqual(
      expect.objectContaining({ type: ContentTypes.STEER, steerId: 'server-1' }),
    );
    requestFrame.mockRestore();
    unmount();
  });

  it('settles every applied steer immediately and cancels all render retries at terminal', async () => {
    let nextFrameId = 0;
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => ++nextFrameId);
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const sse = getLastSSE();

    for (const [steerId, clientSteerId] of [
      ['server-1', 'client-1'],
      ['server-2', 'client-2'],
    ]) {
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            event: 'on_steer_applied',
            data: {
              steerId,
              clientSteerId,
              conversationId: CONV_ID,
              index: 0,
              part: {
                type: ContentTypes.STEER,
                [ContentTypes.STEER]: steerId,
                steerId,
                clientSteerId,
              },
            },
          }),
        });
      });
    }

    // 4th arg: the applied part's quotes (absent here) — see the pre-quotes
    // server restage in resolveSteerChip.
    expect(mockResolveSteerChip).toHaveBeenNthCalledWith(
      1,
      CONV_ID,
      'server-1',
      'client-1',
      undefined,
    );
    expect(mockResolveSteerChip).toHaveBeenNthCalledWith(
      2,
      CONV_ID,
      'server-2',
      'client-2',
      undefined,
    );
    expect(requestFrame).toHaveBeenCalledTimes(2);

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: CONV_ID },
          requestMessage: { messageId: 'msg-1', conversationId: CONV_ID },
          responseMessage: { messageId: 'resp-1', conversationId: CONV_ID },
        }),
      });
    });

    expect(cancelFrame).toHaveBeenCalledTimes(2);
    expect(cancelFrame).toHaveBeenNthCalledWith(1, 1);
    expect(cancelFrame).toHaveBeenNthCalledWith(2, 2);
    unmount();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it('does not publish a completed run when the ordinary final cannot be applied', async () => {
    mockFinalHandler.mockImplementationOnce(() => {
      throw new Error('final application failed');
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    await act(async () => {
      getLastSSE()._emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: CONV_ID },
          requestMessage: { messageId: 'msg-1', conversationId: CONV_ID },
          responseMessage: {
            messageId: 'resp-1',
            conversationId: CONV_ID,
            unfinished: false,
          },
        }),
      });
    });

    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'error' }),
    );
    expect(mockSetRunEnd).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
    );
    unmount();
  });

  it('completes an applied authoritative final without requiring a client persistence refetch', async () => {
    mockFetchQuery.mockRejectedValue(new Error('a reconciliation fetch would fail'));
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();
    const finalPayload = {
      final: true,
      conversation: { conversationId: CONV_ID },
      requestMessage: { messageId: 'msg-1', conversationId: CONV_ID },
      responseMessage: {
        messageId: 'resp-1',
        conversationId: CONV_ID,
        unfinished: false,
      },
    };

    await act(async () => {
      getLastSSE()._emit('message', { data: JSON.stringify(finalPayload) });
    });

    expect(mockFinalHandler).toHaveBeenCalledWith(
      finalPayload,
      expect.objectContaining(submission),
    );
    expect(mockFetchQuery).not.toHaveBeenCalled();
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'completed' }),
    );
    unmount();
  });

  it('continues retrying chat start while the server reports startup readiness pending', async () => {
    jest.useFakeTimers();
    for (let i = 0; i < 9; i++) {
      (request.post as jest.Mock).mockRejectedValueOnce(serverNotReadyError('1'));
    }
    (request.post as jest.Mock).mockResolvedValueOnce({ streamId: 'stream-ready' });

    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await flushMicrotasks();

    for (let i = 0; i < 9; i++) {
      await advanceRetryTimer(1000);
    }

    expect(request.post).toHaveBeenCalledTimes(10);
    expect(mockSSEInstances).toHaveLength(1);
    expect(mockSSEInstances[0].stream).toHaveBeenCalledTimes(1);
    expect(mockErrorHandler).not.toHaveBeenCalled();
    unmount();
    jest.useRealTimers();
  });

  it('cancels startup readiness retries on cleanup before opening a stream', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock)
      .mockRejectedValueOnce(serverNotReadyError('1'))
      .mockResolvedValueOnce({ streamId: 'stale-stream' });

    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await flushMicrotasks();
    unmount();
    await advanceRetryTimer(1000);

    expect(request.post).toHaveBeenCalledTimes(1);
    expect(mockSSEInstances).toHaveLength(0);
    expect(mockErrorHandler).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('clears submission and stop state when starting generation fails', async () => {
    (request.post as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 500,
        data: { message: 'failed to start' },
      },
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await waitFor(() => {
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
    });

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockErrorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: JSON.stringify({ message: 'failed to start' }),
          metadata: { streamStartFailed: true },
        },
        submission,
      }),
    );
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(true);
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(true);
    expect(mockSetShowStopButton).toHaveBeenCalledWith(false);
    unmount();
  });

  it('restores an exact queued row after a definitive pre-create rejection', async () => {
    (request.post as jest.Mock).mockRejectedValueOnce({
      response: { status: 429, data: { message: 'too many requests' } },
    });
    const queuedMessageOrigin = {
      item: { id: 'queued-1', text: 'try later', createdAt: 1 },
      beforeIds: [],
      afterIds: ['queued-2'],
    };
    const submission = buildSubmission({ queuedMessageOrigin });
    const { unmount } = renderHook(() => useResumableSSE(submission, buildChatHelpers()));

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockRestoreQueuedSubmission).toHaveBeenCalledWith(submission);
    expect(mockSSEInstances).toHaveLength(0);
    unmount();
  });

  it('restores queued C and hands off to B when B wins the predecessor status window', async () => {
    (request.post as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          status: 'predecessor_mismatch',
          code: 'GENERATION_PREDECESSOR_MISMATCH',
          streamId: CONV_ID,
          conversationId: CONV_ID,
          generationCreatedAt: 2000,
          active: true,
        },
      },
    });
    // The atomic admission response can beat status publication. Its active
    // replacement identity must still win over retrying C against stale A.
    mockFetchStreamStatus.mockRejectedValueOnce(new Error('status publication lag'));
    const queuedMessageOrigin = {
      item: {
        id: 'queued-c',
        text: 'send C after B',
        createdAt: 3,
        expectedPredecessorCreatedAt: 1000,
      },
      beforeIds: [],
      afterIds: ['queued-d'],
    };
    const submission = buildSubmission({
      expectedPredecessorCreatedAt: 1000,
      queuedMessageOrigin,
    });
    const { unmount } = renderHook(() => useResumableSSE(submission, buildChatHelpers()));

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(request.post).toHaveBeenCalledTimes(1);
    expect(mockRestoreQueuedSubmission).toHaveBeenNthCalledWith(1, submission);
    expect(mockRestoreQueuedSubmission).toHaveBeenLastCalledWith(submission, 2000);
    expect(mockSSEInstances).toHaveLength(0);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({
        active: true,
        streamId: CONV_ID,
        createdAt: 2000,
        generationProtocolVersion: 2,
        generationHandoff: true,
      }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
      refetchType: 'all',
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.allConversations],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.pinnedConversations],
    });
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    unmount();
  });

  it('keeps the rejected row queued when predecessor mismatch finds no active replacement', async () => {
    (request.post as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          status: 'predecessor_mismatch',
          code: 'GENERATION_PREDECESSOR_MISMATCH',
          streamId: CONV_ID,
          conversationId: CONV_ID,
          generationCreatedAt: 2000,
          active: false,
        },
      },
    });
    mockFetchStreamStatus.mockResolvedValueOnce({
      active: false,
      generationProtocolVersion: 2,
      createdAt: 2000,
    });
    const queuedMessageOrigin = {
      item: {
        id: 'queued-c',
        text: 'keep C queued',
        createdAt: 3,
        expectedPredecessorCreatedAt: 1000,
      },
      beforeIds: [],
      afterIds: [],
    };
    const submission = buildSubmission({
      expectedPredecessorCreatedAt: 1000,
      queuedMessageOrigin,
    });
    const { unmount } = renderHook(() => useResumableSSE(submission, buildChatHelpers()));

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(request.post).toHaveBeenCalledTimes(1);
    expect(mockRestoreQueuedSubmission).toHaveBeenNthCalledWith(1, submission);
    expect(mockRestoreQueuedSubmission).toHaveBeenLastCalledWith(submission, 2000);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
      refetchType: 'all',
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.allConversations],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.pinnedConversations],
    });
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    expect(mockSSEInstances).toHaveLength(0);
    expect(mockSetDrainAfterAbort).toHaveBeenCalledWith(expect.any(Function));
    const replacementArm = {
      conversationId: CONV_ID,
      generationCreatedAt: 2000,
    };
    expect(applyLastDrainAfterAbortUpdate(replacementArm)).toBe(replacementArm);
    expect(
      applyLastDrainAfterAbortUpdate({
        conversationId: CONV_ID,
        generationCreatedAt: 1000,
      }),
    ).toBe(false);
    unmount();
  });

  it('re-queues a released recovery source after an ambiguous start failure', async () => {
    (request.post as jest.Mock).mockRejectedValueOnce({
      response: { status: 500, data: { message: 'failed to start' } },
    });
    const released = { steerId: 'source-steer', text: 'recover again', createdAt: 1 };
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      generationProtocolVersion: 2,
      unrecoveredSteers: [released],
    });
    const submission = buildSubmission({
      clientRequestId: 'attempt-uuid',
      recoverySteerId: 'source-steer',
    });
    const { unmount } = renderHook(() => useResumableSSE(submission, buildChatHelpers()));

    await waitFor(() => expect(mockSetSubmission).toHaveBeenCalledWith(null));

    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(CONV_ID, [released], {
      generationProtocolVersion: 2,
      allowPreviouslyConvertedIds: ['source-steer'],
    });
    expect(mockRestoreQueuedSubmission).not.toHaveBeenCalled();
    unmount();
  });

  it('surfaces SSE error bodies returned while starting generation', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce(
      'event: error\ndata: {"text":"No model spec selected"}\n\n',
    );
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await waitFor(() => {
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
    });

    expect(mockSSEInstances).toHaveLength(0);
    expect(mockErrorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: 'No model spec selected',
          metadata: { streamStartFailed: true },
        },
        submission,
      }),
    );
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    expect(mockSetShowStopButton).toHaveBeenCalledWith(false);
    unmount();
  });

  it('surfaces CRLF SSE error bodies returned while starting generation', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce(
      'event: error\r\ndata: {"text":"No model spec selected"}\r\n\r\n',
    );
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await waitFor(() => {
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
    });

    expect(mockErrorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: 'No model spec selected',
          metadata: { streamStartFailed: true },
        },
        submission,
      }),
    );
    unmount();
  });

  it('uses only the error event data from multi-event SSE start failures', async () => {
    (request.post as jest.Mock).mockResolvedValueOnce(
      [
        'event: message',
        'data: {"created":true,"message":{"messageId":"msg-1"}}',
        '',
        'event: error',
        'data: {"text":"Request was blocked"}',
        '',
        '',
      ].join('\n'),
    );
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await waitFor(() => {
      expect(mockSetSubmission).toHaveBeenCalledWith(null);
    });

    expect(mockErrorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: 'Request was blocked',
          metadata: { streamStartFailed: true },
        },
        submission,
      }),
    );
    unmount();
  });

  it('replays title events from resume state sync', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const titleEvent = {
      event: 'title',
      data: {
        conversationId: CONV_ID,
        title: 'Resumed Title',
      },
    };
    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            titleEvent,
          },
        }),
      });
    });

    expect(mockTitleHandler).toHaveBeenCalledWith(titleEvent);
    unmount();
  });

  describe('sync content reconciliation', () => {
    const DB_CONTENT = [{ type: 'text', text: 'streamed before the reload' }];

    const renderWithLoadedResponse = () => {
      const submission = buildSubmission();
      const chatHelpers = buildChatHelpers();
      chatHelpers.getMessages.mockReturnValue([
        {
          messageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: true,
          text: 'Hello',
        },
        {
          messageId: 'resp-1',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: '',
          content: DB_CONTENT,
        },
      ] as unknown as TMessage[]);
      return { submission, chatHelpers };
    };

    const emitSync = async (aggregatedContent: unknown[]) => {
      const sse = getLastSSE();
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            sync: true,
            resumeState: {
              runSteps: [],
              aggregatedContent,
              responseMessageId: 'resp-1',
            },
          }),
        });
      });
    };

    const syncedResponse = (chatHelpers: ReturnType<typeof buildChatHelpers>) => {
      const call = chatHelpers.setMessages.mock.calls
        .map(([messages]) => messages as TMessage[])
        .reverse()
        .find((messages) => messages?.some((m) => m.messageId === 'resp-1'));
      return call?.find((m) => m.messageId === 'resp-1');
    };

    /**
     * An empty snapshot is what a resuming client gets when the conversation's job was
     * replaced mid-flight. Assigning it erased the content the messages query had already
     * loaded, leaving a message that renders as a bare cursor forever.
     */
    it('keeps already-loaded content when the resume snapshot is empty', async () => {
      const { submission, chatHelpers } = renderWithLoadedResponse();
      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await act(async () => {
        await Promise.resolve();
      });

      await emitSync([]);

      expect(syncedResponse(chatHelpers)?.content).toEqual(DB_CONTENT);
      unmount();
    });

    it('does not reuse an older response that only shares the user parent', async () => {
      const submission = buildSubmission({
        initialResponse: {
          messageId: 'resp-1',
          conversationId: CONV_ID,
          text: '',
          isCreatedByUser: false,
          sender: 'Custom Assistant',
          endpoint: 'azureOpenAI',
          iconURL: 'https://example.com/assistant.png',
          model: 'gpt-4.1',
        },
      });
      const chatHelpers = buildChatHelpers();
      chatHelpers.getMessages.mockReturnValue([
        {
          messageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: true,
          text: 'Hello',
        },
        {
          messageId: 'resp-previous',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: '',
          content: [{ type: 'text', text: 'the answer being regenerated' }],
        },
      ] as unknown as TMessage[]);

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await act(async () => {
        await Promise.resolve();
      });

      const sse = getLastSSE();
      await act(async () => {
        sse._emit('message', {
          data: JSON.stringify({
            sync: true,
            resumeState: {
              runSteps: [],
              aggregatedContent: [],
              responseMessageId: 'resp-regenerated',
            },
          }),
        });
      });

      const syncedMessages = chatHelpers.setMessages.mock.calls
        .map(([messages]) => messages as TMessage[])
        .reverse()
        .find((messages) => messages?.some((m) => m.messageId === 'resp-regenerated'));
      expect(syncedMessages?.find((m) => m.messageId === 'resp-previous')?.content).toEqual([
        { type: 'text', text: 'the answer being regenerated' },
      ]);
      expect(syncedMessages?.map((message) => message.messageId)).toEqual([
        'msg-1',
        'resp-previous',
        'resp-regenerated',
      ]);
      expect(syncedMessages?.find((m) => m.messageId === 'resp-regenerated')).toEqual(
        expect.objectContaining({
          content: [],
          sender: 'Custom Assistant',
          endpoint: 'azureOpenAI',
          iconURL: 'https://example.com/assistant.png',
          model: 'gpt-4.1',
        }),
      );
      unmount();
    });

    /**
     * A row with no `content` array must still be assigned the snapshot's array. Handing it
     * `undefined` would flip which renderer `MultiMessage` selects (it branches on
     * `message.content` truthiness, and `[]` is truthy while `undefined` is not).
     */
    it('assigns the snapshot when the matched row has no content array', async () => {
      const submission = buildSubmission();
      const chatHelpers = buildChatHelpers();
      chatHelpers.getMessages.mockReturnValue([
        {
          messageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: true,
          text: 'Hello',
        },
        {
          messageId: 'resp-1',
          parentMessageId: 'msg-1',
          conversationId: CONV_ID,
          isCreatedByUser: false,
          text: 'legacy text-only row',
        },
      ] as unknown as TMessage[]);

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await act(async () => {
        await Promise.resolve();
      });

      await emitSync([]);

      expect(syncedResponse(chatHelpers)?.content).toEqual([]);
      unmount();
    });

    it('still applies the resume snapshot when it carries content', async () => {
      const { submission, chatHelpers } = renderWithLoadedResponse();
      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
      await act(async () => {
        await Promise.resolve();
      });

      const resumed = [{ type: 'text', text: 'authoritative resumed content' }];
      await emitSync(resumed);

      expect(syncedResponse(chatHelpers)?.content).toEqual(resumed);
      unmount();
    });
  });

  it('replays OAuth run step delta events from resume state sync', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStep = {
      id: 'step-oauth',
      runId: 'resp-1',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-oauth', name: 'Google-Workspace', args: '' }],
      },
    };
    const replayEvent = {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: 'step-oauth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ name: 'Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
          expires_at: 1780791946,
        },
      },
    };

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [runStep],
            replayEvents: [replayEvent],
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenNthCalledWith(
      1,
      { event: StepEvents.ON_RUN_STEP, data: runStep },
      expect.objectContaining({ userMessage: expect.objectContaining({ messageId: 'msg-1' }) }),
    );
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      2,
      replayEvent,
      expect.objectContaining({ userMessage: expect.objectContaining({ messageId: 'msg-1' }) }),
    );

    unmount();
  });

  it('anchors preliminary OAuth replay events to the response message from resume state sync', async () => {
    const submission = buildSubmission({
      userMessage: {
        messageId: 'original-user',
        conversationId: CONV_ID,
        text: 'Original prompt',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'original-response',
        conversationId: CONV_ID,
        text: 'Original response',
        isCreatedByUser: false,
        sender: 'Assistant',
        parentMessageId: 'original-user',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStep = {
      id: 'step-oauth',
      runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
      },
    };
    const replayEvent = {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: 'step-oauth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
          expires_at: 1780791946,
        },
      },
    };

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [runStep],
            replayEvents: [replayEvent],
            responseMessageId: 'follow-up-response',
            conversationId: CONV_ID,
            iconURL: 'https://example.com/spec-icon.png',
            model: 'gpt-4.1',
            userMessage: {
              messageId: 'follow-up-user',
              parentMessageId: 'original-response',
              conversationId: CONV_ID,
              text: 'Follow-up prompt',
            },
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenNthCalledWith(
      1,
      { event: StepEvents.ON_RUN_STEP, data: runStep },
      expect.objectContaining({
        userMessage: expect.objectContaining({ messageId: 'follow-up-user' }),
        initialResponse: expect.objectContaining({
          messageId: 'follow-up-response',
          parentMessageId: 'follow-up-user',
        }),
      }),
    );
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      2,
      replayEvent,
      expect.objectContaining({
        userMessage: expect.objectContaining({ messageId: 'follow-up-user' }),
        initialResponse: expect.objectContaining({
          messageId: 'follow-up-response',
          parentMessageId: 'follow-up-user',
        }),
      }),
    );

    unmount();
  });

  it('hydrates a projected pending OAuth prompt once against the resumed response', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();
    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const runStep = {
      id: 'step-oauth',
      runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
      index: 0,
      type: StepTypes.TOOL_CALLS,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
      },
    };
    const replayEvent = {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: 'step-oauth',
        delta: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
        },
      },
    };

    await act(async () => {
      getLastSSE()._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [runStep],
            replayEvents: [replayEvent],
            responseMessageId: 'resumed-response',
            userMessage: {
              messageId: 'resumed-user',
              conversationId: CONV_ID,
              text: 'Use Google Workspace',
            },
            pendingOAuthPrompts: [
              {
                stepId: 'step-oauth',
                runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
                index: 0,
                toolCallId: 'call-oauth',
                toolName: 'oauth_mcp_Google-Workspace',
                authURL: 'https://auth.example.com/oauth',
              },
            ],
          },
        }),
      });
    });

    expect(mockStepHandler).toHaveBeenCalledTimes(2);
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      1,
      {
        event: StepEvents.ON_RUN_STEP,
        data: expect.objectContaining({
          id: 'step-oauth',
          runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
          index: 0,
        }),
      },
      expect.objectContaining({
        initialResponse: expect.objectContaining({ messageId: 'resumed-response' }),
      }),
    );
    expect(mockStepHandler).toHaveBeenNthCalledWith(
      2,
      {
        event: StepEvents.ON_RUN_STEP_DELTA,
        data: expect.objectContaining({
          id: 'step-oauth',
          delta: expect.objectContaining({ auth: 'https://auth.example.com/oauth' }),
        }),
      },
      expect.objectContaining({
        initialResponse: expect.objectContaining({ messageId: 'resumed-response' }),
      }),
    );

    unmount();
  });

  it('merges resumed user and response messages into loaded conversation history', async () => {
    const originalUser = {
      messageId: 'original-user',
      conversationId: CONV_ID,
      text: 'Original prompt',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    };
    const originalResponse = {
      messageId: 'original-response',
      conversationId: CONV_ID,
      text: 'Original response',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'original-user',
    };
    const submission = {
      ...buildSubmission({
        conversation: { conversationId: CONV_ID },
        userMessage: originalUser,
        initialResponse: originalResponse,
      }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([originalUser, originalResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            replayEvents: [],
            aggregatedContent: [
              {
                type: 'tool_call',
                tool_call: {
                  id: 'call-oauth',
                  name: 'oauth_mcp_Google-Workspace',
                  args: '',
                },
              },
            ],
            responseMessageId: 'follow-up-response',
            conversationId: CONV_ID,
            iconURL: 'https://example.com/spec-icon.png',
            model: 'gpt-4.1',
            userMessage: {
              messageId: 'follow-up-user',
              parentMessageId: 'original-response',
              conversationId: CONV_ID,
              text: 'Follow-up prompt',
            },
          },
        }),
      });
    });

    const lastMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0];
    expect(lastMessages.map((message: { messageId: string }) => message.messageId)).toEqual([
      'original-user',
      'original-response',
      'follow-up-user',
      'follow-up-response',
    ]);
    expect(lastMessages[2]).toEqual(
      expect.objectContaining({
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        text: 'Follow-up prompt',
      }),
    );
    expect(lastMessages[3]).toEqual(
      expect.objectContaining({
        messageId: 'follow-up-response',
        parentMessageId: 'follow-up-user',
        content: expect.any(Array),
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-4.1',
      }),
    );

    unmount();
  });

  it('keeps a compaction anchor intact when a resumed sync carries its user-message slot', async () => {
    /** A manual compaction submits no user turn: its `userMessage` slot holds
     *  the LEAF it summarizes up to (see `useCompactConversation`), and the
     *  server's job metadata projects that anchor the same way — identity
     *  only, no parent, no author. Merging it as a row would rewrite the
     *  answer it points at into an empty, parentless user message, which the
     *  message tree renders as a phantom root: the thread folds. */
    const originalUser = {
      messageId: 'original-user',
      conversationId: CONV_ID,
      text: 'Original prompt',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: String(Constants.NO_PARENT),
    };
    const anchor = {
      messageId: 'original-response',
      conversationId: CONV_ID,
      text: 'Original response',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'original-user',
    };
    const summaryPlaceholder = {
      messageId: 'original-response_',
      conversationId: CONV_ID,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'original-response',
      content: [],
    };
    const submission = {
      ...buildSubmission({
        conversation: { conversationId: CONV_ID },
        /** Exactly what `useChatFunctions` builds for a compaction. */
        userMessage: {
          messageId: 'original-response',
          parentMessageId: 'original-response',
          conversationId: CONV_ID,
          text: '',
          isCreatedByUser: true,
          sender: 'User',
        },
        initialResponse: summaryPlaceholder,
        isRegenerate: true,
        compact: true,
        messages: [originalUser, anchor] as TMessage[],
      }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([
      originalUser,
      anchor,
      summaryPlaceholder,
    ] as TMessage[]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            replayEvents: [],
            aggregatedContent: [
              {
                type: ContentTypes.SUMMARY,
                summary: { content: [{ type: 'text', text: 'Earlier turns, compacted.' }] },
              },
            ],
            responseMessageId: 'original-response_',
            conversationId: CONV_ID,
            isRegenerate: true,
            /** `projectCompactionAnchor` on the server: identity only. */
            userMessage: {
              messageId: 'original-response',
              conversationId: CONV_ID,
              text: '',
            },
          },
        }),
      });
    });

    const lastMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(lastMessages.map((message) => message.messageId)).toEqual([
      'original-user',
      'original-response',
      'original-response_',
    ]);
    /** The anchor is still the answer it always was. */
    expect(lastMessages[1]).toEqual(
      expect.objectContaining({
        messageId: 'original-response',
        parentMessageId: 'original-user',
        text: 'Original response',
        isCreatedByUser: false,
      }),
    );
    /** ...and the summary still hangs off it. */
    expect(lastMessages[2]).toEqual(
      expect.objectContaining({
        messageId: 'original-response_',
        parentMessageId: 'original-response',
        isCreatedByUser: false,
      }),
    );

    unmount();
  });

  it('keeps a user-leaf compaction anchor intact when the submission carries no flag', async () => {
    /** A compaction anchored on a user turn, re-attached by a submission that
     *  never learned it was one. The projection is identity-only either way, so
     *  merging it as a row blanks the prompt still on screen. The anchor is
     *  recognized from that SHAPE, not from a flag the submission may not carry. */
    const rootUser = {
      messageId: 'root-user',
      conversationId: CONV_ID,
      text: 'Original prompt',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: String(Constants.NO_PARENT),
    };
    const userLeaf = {
      messageId: 'user-leaf',
      conversationId: CONV_ID,
      text: 'Compact this before I continue',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: 'root-user',
    };
    const summaryPlaceholder = {
      messageId: 'user-leaf_',
      conversationId: CONV_ID,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'user-leaf',
      content: [],
    };
    const submission = {
      ...buildSubmission({
        conversation: { conversationId: CONV_ID },
        userMessage: userLeaf,
        initialResponse: summaryPlaceholder,
        isRegenerate: true,
        messages: [rootUser, userLeaf] as TMessage[],
      }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([rootUser, userLeaf, summaryPlaceholder] as TMessage[]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            replayEvents: [],
            aggregatedContent: [
              {
                type: ContentTypes.SUMMARY,
                summary: { content: [{ type: 'text', text: 'Earlier turns, compacted.' }] },
              },
            ],
            responseMessageId: 'user-leaf_',
            conversationId: CONV_ID,
            isRegenerate: true,
            userMessage: { messageId: 'user-leaf', conversationId: CONV_ID, text: '' },
          },
        }),
      });
    });

    const lastMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    /** One row per id: the anchor is never appended a second time. */
    expect(lastMessages.map((message) => message.messageId)).toEqual([
      'root-user',
      'user-leaf',
      'user-leaf_',
    ]);
    /** The prompt survives the resume. */
    expect(lastMessages[1]).toEqual(
      expect.objectContaining({
        messageId: 'user-leaf',
        parentMessageId: 'root-user',
        text: 'Compact this before I continue',
        isCreatedByUser: true,
      }),
    );

    unmount();
  });

  it('uses the resumed submission for final events after sync', async () => {
    const originalUser = {
      messageId: 'original-user',
      conversationId: CONV_ID,
      text: 'Original prompt',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: String(Constants.NO_PARENT),
    };
    const originalResponse = {
      messageId: 'original-response',
      conversationId: CONV_ID,
      text: 'Original response',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'original-user',
    };
    const submission = {
      ...buildSubmission({
        conversation: { conversationId: CONV_ID },
        userMessage: originalUser,
        initialResponse: originalResponse,
      }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([originalUser, originalResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            replayEvents: [],
            responseMessageId: 'follow-up-response',
            conversationId: CONV_ID,
            userMessage: {
              messageId: 'follow-up-user',
              parentMessageId: 'original-response',
              conversationId: CONV_ID,
              text: 'Follow-up prompt',
            },
          },
        }),
      });
    });

    const finalPayload = {
      final: true,
      conversation: { conversationId: CONV_ID },
      requestMessage: {
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId: CONV_ID,
        text: 'Follow-up prompt',
        isCreatedByUser: true,
      },
      responseMessage: {
        messageId: 'follow-up-response',
        parentMessageId: 'follow-up-user',
        conversationId: CONV_ID,
        text: 'Done',
        isCreatedByUser: false,
      },
    };

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify(finalPayload),
      });
    });

    expect(mockFinalHandler).toHaveBeenCalledWith(
      finalPayload,
      expect.objectContaining({
        userMessage: expect.objectContaining({ messageId: 'follow-up-user' }),
        initialResponse: expect.objectContaining({
          messageId: 'follow-up-response',
          parentMessageId: 'follow-up-user',
        }),
      }),
    );

    unmount();
  });

  it('uses the resumed submission for final events after reconnecting from sync', async () => {
    jest.useFakeTimers();
    const originalUser = {
      messageId: 'original-user',
      conversationId: CONV_ID,
      text: 'Original prompt',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: String(Constants.NO_PARENT),
    };
    const originalResponse = {
      messageId: 'original-response',
      conversationId: CONV_ID,
      text: 'Original response',
      isCreatedByUser: false,
      sender: 'Assistant',
      parentMessageId: 'original-user',
    };
    const submission = {
      ...buildSubmission({
        conversation: { conversationId: CONV_ID },
        userMessage: originalUser,
        initialResponse: originalResponse,
      }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([originalUser, originalResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const initialSSE = getLastSSE();
    await act(async () => {
      initialSSE._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            replayEvents: [],
            responseMessageId: 'follow-up-response',
            conversationId: CONV_ID,
            userMessage: {
              messageId: 'follow-up-user',
              parentMessageId: 'original-response',
              conversationId: CONV_ID,
              text: 'Follow-up prompt',
            },
          },
        }),
      });
    });

    await act(async () => {
      initialSSE._emit('error');
    });
    await advanceRetryTimer(1000);

    expect(mockSSEInstances).toHaveLength(2);
    const reconnectedSSE = getLastSSE();
    const finalPayload = {
      final: true,
      conversation: { conversationId: CONV_ID },
      requestMessage: {
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId: CONV_ID,
        text: 'Follow-up prompt',
        isCreatedByUser: true,
      },
      responseMessage: {
        messageId: 'follow-up-response',
        parentMessageId: 'follow-up-user',
        conversationId: CONV_ID,
        text: 'Done',
        isCreatedByUser: false,
      },
    };

    await act(async () => {
      reconnectedSSE._emit('message', {
        data: JSON.stringify(finalPayload),
      });
    });

    expect(mockFinalHandler).toHaveBeenLastCalledWith(
      finalPayload,
      expect.objectContaining({
        userMessage: expect.objectContaining({ messageId: 'follow-up-user' }),
        initialResponse: expect.objectContaining({
          messageId: 'follow-up-response',
          parentMessageId: 'follow-up-user',
        }),
      }),
    );

    unmount();
  });

  it('keeps an active job locked and resubscribes after the reconnect retry ceiling', async () => {
    jest.useFakeTimers();
    const pendingSteers = [
      { steerId: 'still-running-steer', text: 'wait for boundary', createdAt: 1 },
    ];
    const aggregatedContent = [{ type: 'text', text: 'partial answer' }];
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      status: 'running',
      streamId: CONV_ID,
      createdAt: 1000,
      resumeState: { pendingSteers, aggregatedContent },
    });
    const submission = {
      ...buildSubmission(),
      resumeStreamId: CONV_ID,
      resumeGenerationCreatedAt: 1000,
    } as TSubmission & { resumeStreamId: string; resumeGenerationCreatedAt: number };
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      const current = getLastSSE();
      await act(async () => {
        current._emit('error');
        await Promise.resolve();
      });
      await advanceRetryTimer(delay);
    }
    expect(mockSSEInstances).toHaveLength(6);

    const retryCeilingSSE = getLastSSE();
    const countAtCeiling = mockSSEInstances.length;
    await act(async () => {
      retryCeilingSSE._emit('error');
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSeedSteerChips).toHaveBeenCalledWith(CONV_ID, pendingSteers, 1000, 1);
    expect(mockSettleAppliedSteerParts).toHaveBeenCalledWith(CONV_ID, aggregatedContent);
    expect(mockSetIsSubmitting).toHaveBeenLastCalledWith(true);
    expect(mockSetShowStopButton).toHaveBeenLastCalledWith(true);
    expect(mockSetSubmission).not.toHaveBeenCalledWith(null);
    expect(mockSSEInstances).toHaveLength(countAtCeiling);

    await advanceRetryTimer(30_000);
    expect(mockSSEInstances).toHaveLength(countAtCeiling + 1);
    expect(getLastSSE().stream).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('hands off to a newer epoch discovered at the reconnect retry ceiling', async () => {
    jest.useFakeTimers();
    const pendingSteers = [
      { steerId: 'replacement-steer', text: 'belongs to replacement', createdAt: 2 },
    ];
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      status: 'running',
      streamId: CONV_ID,
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: { pendingSteers, aggregatedContent: [] },
    });
    const submission = {
      ...buildSubmission(),
      resumeStreamId: CONV_ID,
      resumeGenerationCreatedAt: 1000,
      resumeGenerationProtocolVersion: 2,
    } as TSubmission & {
      resumeStreamId: string;
      resumeGenerationCreatedAt: number;
      resumeGenerationProtocolVersion: 2;
    };
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => {
        getLastSSE()._emit('error');
        await Promise.resolve();
      });
      await advanceRetryTimer(delay);
    }
    const countAtCeiling = mockSSEInstances.length;

    await act(async () => {
      getLastSSE()._emit('error');
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['streamStatus', CONV_ID],
      expect.objectContaining({ createdAt: 2000, generationHandoff: true }),
    );
    expect(mockSeedSteerChips).toHaveBeenCalledWith(CONV_ID, pendingSteers, 2000, 2);
    expect(mockSetSubmission).toHaveBeenCalledWith(null);
    expect(mockSetRunEnd).not.toHaveBeenCalled();
    await advanceRetryTimer(30_000);
    expect(mockSSEInstances).toHaveLength(countAtCeiling);
    unmount();
  });

  it('does not complete a terminal retry-ceiling status when persisted messages cannot be fetched', async () => {
    jest.useFakeTimers();
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      status: 'complete',
      streamId: CONV_ID,
      createdAt: 1000,
      resumeState: { pendingSteers: [], aggregatedContent: [] },
    });
    mockFetchQuery.mockRejectedValueOnce(new Error('message refetch failed'));
    const submission = {
      ...buildSubmission(),
      resumeStreamId: CONV_ID,
      resumeGenerationCreatedAt: 1000,
    } as TSubmission & { resumeStreamId: string; resumeGenerationCreatedAt: number };
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => {
        getLastSSE()._emit('error');
        await Promise.resolve();
      });
      await advanceRetryTimer(delay);
    }
    await act(async () => {
      getLastSSE()._emit('error');
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'error' }),
    );
    expect(mockSetRunEnd).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
    );
    expect(mockConvertLocalSteersToQueued).not.toHaveBeenCalled();
    unmount();
  });

  it.each([undefined, 500, 503])(
    'does not call errorHandler for responseCode %s (reconnect path)',
    async (responseCode) => {
      const submission = buildSubmission();
      const chatHelpers = buildChatHelpers();

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

      await act(async () => {
        await Promise.resolve();
      });

      const sse = getLastSSE();

      await act(async () => {
        sse._emit('error', { responseCode });
      });

      expect(mockErrorHandler).not.toHaveBeenCalled();
      unmount();
    },
  );

  it('treats responseCode === 0 with raw SSE buffer data as transport failure (reconnect path)', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('error', {
        responseCode: 0,
        data: 'event: message\ndata: {"created":true,"message":{}}\n\n',
      });
    });

    expect(mockErrorHandler).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores responseCode === 0 after FINAL instead of reconnecting a completed stream', async () => {
    jest.useFakeTimers();
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    const sseCount = mockSSEInstances.length;
    const finalPayload = {
      final: true,
      conversation: { conversationId: CONV_ID },
      requestMessage: {
        messageId: 'msg-1',
        conversationId: CONV_ID,
        text: 'Hello',
        isCreatedByUser: true,
      },
      responseMessage: {
        messageId: 'resp-1',
        parentMessageId: 'msg-1',
        conversationId: CONV_ID,
        text: 'Done',
        isCreatedByUser: false,
      },
    };

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify(finalPayload),
      });
    });

    expect(sse.close).toHaveBeenCalled();
    mockSetIsSubmitting.mockClear();
    mockSetShowStopButton.mockClear();

    await act(async () => {
      sse._emit('error', { responseCode: 0 });
    });
    await advanceRetryTimer(1000);

    expect(mockSSEInstances).toHaveLength(sseCount);
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(true);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(true);
    expect(mockErrorHandler).not.toHaveBeenCalled();
    unmount();
  });

  it('reconnects when the user agent aborts a live stream instead of going idle', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-epoch',
      status: 'started',
      generationCreatedAt: 1000,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    mockSetIsSubmitting.mockClear();

    /** Backgrounding a mobile browser cancels the in-flight XHR, which surfaces
     *  as an abort with no terminal event behind it. */
    await act(async () => {
      initialSSE._emit('abort');
    });

    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(true);

    await advanceRetryTimer(1000);

    expect(mockSSEInstances).toHaveLength(sseCount + 1);
    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-epoch?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    unmount();
  });

  it('keeps climbing the ladder when the user agent aborts the replacement before it opens', async () => {
    jest.useFakeTimers();
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-epoch',
      status: 'started',
      generationCreatedAt: 1000,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const sseCount = mockSSEInstances.length;

    await act(async () => {
      getLastSSE()._emit('abort');
    });
    await advanceRetryTimer(1000);
    expect(mockSSEInstances).toHaveLength(sseCount + 1);

    /** The retry fired while the tab was still backgrounded, so the user agent
     *  cancels the replacement too — before it ever emits `open`, which is what
     *  would have cleared the shared reconnect counter. Recovery has to read
     *  this as the replacement's own failure, not the previous connection's
     *  deliberate close. */
    await act(async () => {
      getLastSSE()._emit('abort');
    });
    await advanceRetryTimer(2000);

    expect(mockSSEInstances).toHaveLength(sseCount + 2);
    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-epoch?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    unmount();
  });

  it('does not reconnect on the abort that follows a FINAL event', async () => {
    jest.useFakeTimers();
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const sse = getLastSSE();
    const sseCount = mockSSEInstances.length;

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: CONV_ID },
          requestMessage: {
            messageId: 'msg-1',
            conversationId: CONV_ID,
            text: 'Hello',
            isCreatedByUser: true,
          },
          responseMessage: {
            messageId: 'resp-1',
            parentMessageId: 'msg-1',
            conversationId: CONV_ID,
            text: 'Done',
            isCreatedByUser: false,
          },
        }),
      });
    });

    mockSetIsSubmitting.mockClear();
    mockSetShowStopButton.mockClear();

    await act(async () => {
      sse._emit('abort');
    });
    await advanceRetryTimer(1000);

    expect(mockSSEInstances).toHaveLength(sseCount);
    expect(mockSetIsSubmitting).not.toHaveBeenCalledWith(true);
    expect(mockSetShowStopButton).not.toHaveBeenCalledWith(true);
    unmount();
  });

  it('re-attaches on foreground when the stream closed while the page was hidden', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-epoch',
      status: 'started',
      generationCreatedAt: 1000,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    /** The response body ended under a frozen tab, so sse.js dispatched
     *  neither an error nor an abort — only the closed transport is left. */
    initialSSE.readyState = MOCK_SSE_CLOSED;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockSSEInstances).toHaveLength(sseCount + 1);
    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-epoch?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    unmount();
  });

  it('reconciles durable messages when an apparently open stream is terminal on foreground', async () => {
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-epoch',
      status: 'started',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      status: 'complete',
      createdAt: 1000,
      generationProtocolVersion: 2,
    });
    const persisted = [
      {
        messageId: 'resp-1',
        parentMessageId: 'msg-1',
        conversationId: CONV_ID,
        text: 'Completed while backgrounded',
        isCreatedByUser: false,
      },
    ] as TMessage[];
    mockFetchQuery.mockResolvedValue(persisted);
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    initialSSE.readyState = MOCK_SSE_OPEN;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSSEInstances).toHaveLength(sseCount + 1);
    expect(getLastSSE()._url).toBe(
      '/api/agents/chat/stream/stream-epoch?resume=true&generationCreatedAt=1000&generationProtocolVersion=2',
    );
    expect(initialSSE.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      getLastSSE()._emit('error', { responseCode: 404 });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchQuery).toHaveBeenCalledWith({
      queryKey: [QueryKeys.messages, CONV_ID],
    });
    expect(mockSettleAppliedSteerParts).toHaveBeenCalledWith(CONV_ID, persisted);
    unmount();
  });

  it('leaves a still-open active stream alone when the page returns to the foreground', async () => {
    mockFetchStreamStatus.mockResolvedValue({
      active: true,
      streamId: 'stream-123',
      status: 'running',
      createdAt: 1000,
      generationProtocolVersion: 2,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;
    initialSSE.readyState = MOCK_SSE_OPEN;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockSSEInstances).toHaveLength(sseCount);
    expect(initialSSE.close).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps an apparently open stream when foreground status belongs to another epoch', async () => {
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      status: 'complete',
      createdAt: 2000,
      generationProtocolVersion: 2,
    });
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const initialSSE = getLastSSE();
    const sseCount = mockSSEInstances.length;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockSSEInstances).toHaveLength(sseCount);
    expect(initialSSE.close).not.toHaveBeenCalled();
    unmount();
  });

  it('does not re-attach on foreground once FINAL has closed the stream', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    const sse = getLastSSE();
    const sseCount = mockSSEInstances.length;

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          conversation: { conversationId: CONV_ID },
          requestMessage: {
            messageId: 'msg-1',
            conversationId: CONV_ID,
            text: 'Hello',
            isCreatedByUser: true,
          },
          responseMessage: {
            messageId: 'resp-1',
            parentMessageId: 'msg-1',
            conversationId: CONV_ID,
            text: 'Done',
            isCreatedByUser: false,
          },
        }),
      });
    });

    expect(sse.readyState).toBe(MOCK_SSE_CLOSED);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockSSEInstances).toHaveLength(sseCount);
    unmount();
  });

  it('does not re-attach on foreground after a 404 already reconciled the run', async () => {
    const { sse, unmount } = await render404Scenario();
    const sseCount = mockSSEInstances.length;

    /** The 404 reconcile leaves the submission installed and the attachment
     *  pointing at a stream the server no longer has, so only the retirement
     *  flag keeps the foreground path from resurrecting it. */
    expect(sse.readyState).toBe(MOCK_SSE_CLOSED);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockSSEInstances).toHaveLength(sseCount);
    unmount();
  });

  it('parses and surfaces server-sent error events (no responseCode, JSON data)', async () => {
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    const errorPayload = JSON.stringify({
      error: JSON.stringify({ type: 'token_limit' }),
    });

    await act(async () => {
      sse._emit('error', { data: errorPayload });
    });

    expect(mockErrorHandler).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('re-queues the exact recovery source released by a post-start terminal error', async () => {
    const released = { steerId: 'failed-source', text: 'retry these words', createdAt: 1 };
    (request.post as jest.Mock).mockResolvedValue({
      streamId: 'stream-123',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    mockFetchStreamStatus.mockResolvedValue({
      active: false,
      generationProtocolVersion: 2,
      unrecoveredSteers: [
        released,
        { steerId: 'unrelated-source', text: 'leave deduped', createdAt: 2 },
      ],
    });
    const submission = buildSubmission({
      clientRequestId: 'steer-recovery:failed-source',
    });
    const chatHelpers = buildChatHelpers();
    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await flushMicrotasks();

    await act(async () => {
      getLastSSE()._emit('error', {
        data: JSON.stringify({
          error: 'initialization failed',
          generationProtocolVersion: 2,
        }),
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONV_ID);
    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(CONV_ID, [released], {
      generationProtocolVersion: 2,
      allowPreviouslyConvertedIds: ['failed-source'],
    });
    expect(mockSetRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, outcome: 'error' }),
    );
    unmount();
  });

  it('removes the optimistic sidebar row when a new conversation errors before created', async () => {
    /* Key-aware: the conversation cache helpers now run a second, pinned-keyed pass,
       and a fixed return value would attribute those writes to allConversations. */
    mockFindAll.mockImplementation((queryKey?: QueryKey) => [
      mockQueryCache.build(mockBackingQueryClient, { queryKey: [queryKey![0]] as QueryKey }),
    ]);
    const submission = buildSubmission({
      conversation: {},
      userMessage: {
        messageId: 'msg-1',
        conversationId: null,
        text: 'Hello',
        isCreatedByUser: true,
        sender: 'User',
        parentMessageId: Constants.NO_PARENT,
      },
      initialResponse: {
        messageId: 'msg-1_',
        conversationId: null,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('error', { data: JSON.stringify({ error: 'failed before created' }) });
    });

    const allConversationWrites = mockSetQueryData.mock.calls.filter(
      ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === QueryKeys.allConversations,
    );
    expect(allConversationWrites).toHaveLength(2);

    const removeUpdater = allConversationWrites[1][1] as (data: {
      pages: { conversations: { conversationId: string }[]; nextCursor: null }[];
      pageParams: never[];
    }) => { pages: { conversations: { conversationId: string }[] }[] };
    const result = removeUpdater({
      pages: [
        {
          conversations: [{ conversationId: 'stream-123' }, { conversationId: 'other' }],
          nextCursor: null,
        },
      ],
      pageParams: [],
    });
    expect(result.pages[0].conversations).toEqual([{ conversationId: 'other' }]);
    expect(mockErrorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        submission: expect.objectContaining({
          conversation: expect.objectContaining({ conversationId: 'stream-123' }),
        }),
      }),
    );
    unmount();
  });
});

describe('useResumableSSE - sync response identity', () => {
  beforeEach(() => {
    mockSSEInstances.length = 0;
    mockSetIsSubmitting.mockClear();
  });

  const emitSync = async (
    sse: MockSSEInstance,
    aggregatedContent: TMessage['content'],
    responseMessageId?: string,
    sender?: string,
    userMessage?: Partial<TMessage>,
  ) => {
    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: { aggregatedContent, responseMessageId, sender, userMessage },
        }),
      });
    });
  };

  it('updates the submission-owned response when sync omits the response ID', async () => {
    const userMessage = {
      messageId: 'server-user-id',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const activeResponse = {
      messageId: 'server-response-id',
      parentMessageId: 'server-user-id',
      conversationId: CONV_ID,
      text: '',
      content: [],
      isCreatedByUser: false,
    } as TMessage;
    const submission = {
      ...buildSubmission({ userMessage, initialResponse: activeResponse }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([userMessage, activeResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await act(async () => {
      await Promise.resolve();
    });

    const aggregatedContent: TMessage['content'] = [
      { type: ContentTypes.TEXT, text: { value: 'Recovered answer' } },
    ];
    await emitSync(getLastSSE(), aggregatedContent);

    const updatedMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(updatedMessages).toHaveLength(2);
    expect(updatedMessages.find((message) => message.messageId === 'server-response-id')).toEqual({
      ...activeResponse,
      content: aggregatedContent,
    });
    expect(
      updatedMessages.find((message) => message.messageId === 'server-user-id_'),
    ).toBeUndefined();
    unmount();
  });

  it('adds resumed sender metadata to an exact persisted response', async () => {
    const userMessage = {
      messageId: 'server-user-id',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const activeResponse = {
      messageId: 'server-response-id',
      parentMessageId: 'server-user-id',
      conversationId: CONV_ID,
      text: '',
      content: [],
      isCreatedByUser: false,
    } as TMessage;
    const submission = {
      ...buildSubmission({ userMessage, initialResponse: activeResponse }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([userMessage, activeResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await act(async () => {
      await Promise.resolve();
    });

    await emitSync(getLastSSE(), [], activeResponse.messageId, 'Restored Assistant');

    const updatedMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(updatedMessages[1]).toEqual({
      ...activeResponse,
      sender: 'Restored Assistant',
    });
    unmount();
  });

  it('appends a missing submission-owned response after older regeneration siblings', async () => {
    const userMessage = {
      messageId: 'server-user-id',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const olderResponse = {
      messageId: 'older-response-id',
      parentMessageId: 'server-user-id',
      conversationId: CONV_ID,
      text: 'Earlier answer',
      content: [{ type: 'text', text: { value: 'Earlier answer' } }],
      isCreatedByUser: false,
    } as TMessage;
    const activeResponse = {
      messageId: 'active-response-id',
      parentMessageId: 'server-user-id',
      conversationId: CONV_ID,
      text: '',
      content: [],
      isCreatedByUser: false,
    } as TMessage;
    const submission = {
      ...buildSubmission({ userMessage, initialResponse: activeResponse }),
      isRegenerate: true,
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([userMessage, olderResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await act(async () => {
      await Promise.resolve();
    });

    const aggregatedContent: TMessage['content'] = [
      { type: ContentTypes.TEXT, text: { value: 'Regenerated answer' } },
    ];
    await emitSync(getLastSSE(), aggregatedContent);

    const updatedMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(updatedMessages.find((message) => message.messageId === 'older-response-id')).toEqual(
      olderResponse,
    );
    expect(updatedMessages.map((message) => message.messageId)).toEqual([
      'server-user-id',
      'older-response-id',
      'active-response-id',
    ]);
    expect(updatedMessages.find((message) => message.messageId === 'active-response-id')).toEqual({
      ...activeResponse,
      content: aggregatedContent,
    });
    unmount();
  });

  it('replaces the current-run placeholder without erasing its loaded content', async () => {
    const userMessage = {
      messageId: 'server-user-id',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const preliminaryResponse = {
      messageId: 'server-user-id_',
      parentMessageId: 'server-user-id',
      conversationId: CONV_ID,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: { value: 'Already streaming' } }],
      sender: 'Assistant',
      isCreatedByUser: false,
    } as TMessage;
    const submission = {
      ...buildSubmission({ userMessage, initialResponse: preliminaryResponse }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([userMessage, preliminaryResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await act(async () => {
      await Promise.resolve();
    });

    await emitSync(getLastSSE(), [], 'assigned-response-id');

    const updatedMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(updatedMessages.map((message) => message.messageId)).toEqual([
      'server-user-id',
      'assigned-response-id',
    ]);
    expect(updatedMessages[1]).toEqual({
      ...preliminaryResponse,
      messageId: 'assigned-response-id',
    });
    unmount();
  });

  it('replaces the current-run user when sync assigns both durable IDs', async () => {
    const preliminaryUser = {
      messageId: 'client-user-id',
      parentMessageId: 'previous-response-id',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
    } as TMessage;
    const preliminaryResponse = {
      messageId: 'client-user-id_',
      parentMessageId: preliminaryUser.messageId,
      conversationId: CONV_ID,
      text: '',
      content: [],
      isCreatedByUser: false,
    } as TMessage;
    const submission = {
      ...buildSubmission({ userMessage: preliminaryUser, initialResponse: preliminaryResponse }),
      resumeStreamId: CONV_ID,
    } as TSubmission & { resumeStreamId: string };
    const chatHelpers = buildChatHelpers();
    chatHelpers.getMessages.mockReturnValue([preliminaryUser, preliminaryResponse]);

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));
    await act(async () => {
      await Promise.resolve();
    });

    const assignedUser = {
      ...preliminaryUser,
      messageId: 'assigned-user-id',
    };
    await emitSync(getLastSSE(), [], 'assigned-response-id', undefined, assignedUser);

    const updatedMessages = chatHelpers.setMessages.mock.calls.at(-1)?.[0] as TMessage[];
    expect(updatedMessages.map((message) => message.messageId)).toEqual([
      'assigned-user-id',
      'assigned-response-id',
    ]);
    expect(updatedMessages[1]?.parentMessageId).toBe('assigned-user-id');
    unmount();
  });
});

/**
 * `convertLocalSteersToQueued` (the `final` handler and the intentional-close
 * `abort` listener both call it, alongside the two failure-terminal paths
 * covered above) is a thin `useRecoilCallback` wrapper: read the conversation's
 * chips, run them through this selection, hand the result to `useSteerConvert`.
 * This file's `useRecoilCallback: () => jest.fn()` mock (see above, "the
 * hook's steer-chip/queue callbacks need a RecoilRoot; these tests render
 * bare") makes that wrapper, and every other recoil-callback in this hook
 * (`resolveSteerChip`, `seedSteerChips` included; neither has a direct test
 * in this file either), inert: calling it from the `final`/`abort` source
 * lines is invisible to `mockConvertSteersToQueued` assertions here, since the
 * mock discards the real closure before it can ever call through. Covering
 * the selection logic directly (this is the exact piece of logic finding 3
 * was about: which statuses survive a run end) rather than faking a
 * RecoilRoot-backed integration around the rest of this large hook's mocks.
 *
 * The `statuses` parameter pins a second contract: the `final` handler and
 * the two error/404 terminals call `convertLocalSteersToQueued` with no
 * override (default `pending || failed`, the run is genuinely over), while
 * the intentional-close `abort` listener passes `{ statuses: ['failed'] }`
 * because that listener also fires on navigation away while the run
 * CONTINUES server-side: a server-ACK'd `pending` chip must be left alone
 * there, not swept into the queue as a duplicate of the server's own injection.
 */
describe('selectLocalSteersForQueue', () => {
  const chip = (over: Partial<PendingSteer> = {}): PendingSteer => ({
    steerId: 's1',
    text: 'default text',
    status: 'pending',
    createdAt: 1,
    ...over,
  });

  it('final/error-path selection (default statuses) includes pending and failed chips, excluding sending', () => {
    const chips = [
      chip({ steerId: 'p1', status: 'pending' }),
      chip({ steerId: 'f1', status: 'failed' }),
      chip({ steerId: 'sending-1', status: 'sending' }),
    ];
    expect(selectLocalSteersForQueue(chips).map((steer) => steer.steerId)).toEqual(['p1', 'f1']);
  });

  it('abort-path selection (statuses: ["failed"]) sweeps only failed chips, leaving pending alone', () => {
    // The abort listener fires on navigation away while the run CONTINUES
    // server-side: a `pending` chip already has a server id and will be
    // injected by the server regardless, so sweeping it here too would make
    // `useQueueDrain` resend the same words as a duplicate turn at run end.
    const chips = [
      chip({ steerId: 'p1', status: 'pending' }),
      chip({ steerId: 'f1', status: 'failed' }),
      chip({ steerId: 'sending-1', status: 'sending' }),
    ];
    expect(selectLocalSteersForQueue(chips, ['failed']).map((steer) => steer.steerId)).toEqual([
      'f1',
    ]);
  });

  it('converts a failed local chip present at a run-end path into a queueable item', () => {
    // The leak finding 3 was about: a `failed` chip carries a local-* id the
    // server never reports, so `data.pendingSteers`/the abort response can
    // never carry it: this selection is the ONLY place left that can catch
    // it before the `final`/`abort` paths hand off to `useSteerConvert`.
    const failed = chip({ steerId: 'local-failed', status: 'failed', text: 'redo this' });
    expect(selectLocalSteersForQueue([failed])).toEqual([
      expect.objectContaining({ steerId: 'local-failed', text: 'redo this', createdAt: 1 }),
    ]);
  });

  it('does not sweep a sending chip: its own POST callback owns it', () => {
    // Converting it here too would race that callback: a late ACK's re-add
    // in `resolveAcknowledgedSteer` could then double-queue the same words.
    const sending = chip({ steerId: 'in-flight', status: 'sending' });
    expect(selectLocalSteersForQueue([sending])).toEqual([]);
  });

  it('preserves uncertain deliveries for explicit same-id recovery', () => {
    const legacy = chip({
      steerId: 'legacy-uncertain',
      status: 'failed',
      deliveryUncertain: true,
      generationProtocolVersion: 1,
    });
    const modern = chip({
      steerId: 'modern-uncertain',
      status: 'failed',
      deliveryUncertain: true,
      generationProtocolVersion: 2,
    });

    expect(selectLocalSteersForQueue([legacy, modern])).toEqual([]);
    expect(selectLocalSteersForQueue([legacy], ABORT_SWEEP_STATUSES)).toEqual([]);
  });

  it('carries files only when present', () => {
    const withFiles = chip({
      steerId: 'p2',
      files: [{ file_id: 'f1', filename: 'a.png' }],
    });
    const withoutFiles = chip({ steerId: 'p3' });
    const [withResult, withoutResult] = selectLocalSteersForQueue([withFiles, withoutFiles]);
    expect(withResult.files).toEqual(withFiles.files);
    expect(withoutResult.files).toBeUndefined();
  });

  describe('the abort sweep', () => {
    /* The abort path is the one terminal where the run may still be live on the
       server, so a chip it has already ACK'd must be left for it to inject. */
    it('sweeps only what never reached the server', () => {
      expect([...ABORT_SWEEP_STATUSES]).toEqual(['failed']);
    });

    it("leaves an ACK'd chip alone where the default sweep would take it", () => {
      const chips = [
        chip({ steerId: 'acked', status: 'pending' }),
        chip({ steerId: 'never-sent', status: 'failed' }),
      ];
      expect(selectLocalSteersForQueue(chips, ABORT_SWEEP_STATUSES).map((s) => s.steerId)).toEqual([
        'never-sent',
      ]);
      /* Where the run has genuinely ended, both are swept. */
      expect(selectLocalSteersForQueue(chips).map((s) => s.steerId)).toEqual([
        'acked',
        'never-sent',
      ]);
    });
  });
});
