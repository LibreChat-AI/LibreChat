import { renderHook, act } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider, createStore, useAtomValue } from 'jotai';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { Agents, TMessage, TConversation, TSubmission } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { ReactNode } from 'react';
import type { PendingSteer, QueuedMessage } from '~/store/families';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import { revealedQueuedTurnFamily } from '~/store/steer';
import useResumeOnLoad from '../useResumeOnLoad';
import store from '~/store';

const mockUseStreamStatus = jest.fn();
const mockUseActiveJobs = jest.fn();
const mockUseAgentQueuedTurns = jest.fn();
const mockExtendActiveJobsGrace = jest.fn();
let mockFileMap: Record<string, { llmDeliveryPath?: 'provider' | 'text' | 'none' }> = {};

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
}));

jest.mock('~/data-provider', () => ({
  useStreamStatus: (conversationId: string | undefined, enabled: boolean) =>
    mockUseStreamStatus(conversationId, enabled),
  useActiveJobs: (enabled?: boolean, expectsSuccessor?: boolean) =>
    mockUseActiveJobs(enabled, expectsSuccessor),
  useAgentQueuedTurns: (conversationId: string, enabled: boolean) =>
    mockUseAgentQueuedTurns(conversationId, enabled),
  /** Real predicate and real window: admission semantics are the thing under
   *  test here, and a restated copy in a mock is exactly the drift sharing a
   *  function is meant to avoid. */
  isQueuedTurnSuccessorOwed: jest.requireActual('~/data-provider/SSE/queuedTurns')
    .isQueuedTurnSuccessorOwed,
  ACTIVE_JOBS_SUCCESSOR_GRACE_MS: jest.requireActual('~/data-provider/SSE/queries')
    .ACTIVE_JOBS_SUCCESSOR_GRACE_MS,
  extendActiveJobsGrace: () => mockExtendActiveJobsGrace(),
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
}));

const CONVERSATION_ID = 'conv-current';
const STALE_CONVERSATION_ID = 'conv-stale';
const USER_MESSAGE_ID = 'user-message-1';
const RESPONSE_MESSAGE_ID = 'user-message-1_';

function buildConversation(conversationId = CONVERSATION_ID): TConversation {
  return {
    conversationId,
    endpoint: 'agents',
  } as TConversation;
}

function buildUserMessage(
  conversationId: string | null = CONVERSATION_ID,
  messageId = USER_MESSAGE_ID,
): TMessage {
  return {
    text: 'Hello',
    sender: 'User',
    messageId,
    conversationId,
    isCreatedByUser: true,
    parentMessageId: Constants.NO_PARENT,
  } as TMessage;
}

function buildSubmission(conversationId: string | null | undefined): TSubmission {
  return {
    messages: [],
    isTemporary: false,
    endpointOption: { endpoint: 'agents' },
    conversation: { conversationId },
    userMessage: buildUserMessage(null),
    initialResponse: {
      text: '',
      sender: 'Assistant',
      messageId: RESPONSE_MESSAGE_ID,
      conversationId,
      isCreatedByUser: false,
      parentMessageId: USER_MESSAGE_ID,
    } as TMessage,
  } as unknown as TSubmission;
}

function renderUseResumeOnLoad({
  messages = [],
  getMessages: getMessagesOverride,
  submission = null,
  isSubmitting = false,
  attachedGenerationCreatedAt = null,
  conversationId = CONVERSATION_ID,
  messagesLoaded = true,
  onSubmission,
  siblingIndexParentId,
  onSiblingIndex,
  pendingSteers,
  onPendingSteers,
  onQueuedMessages,
  submissionStart,
  onSubmissionStart,
}: {
  messages?: TMessage[];
  getMessages?: () => TMessage[] | undefined;
  submission?: TSubmission | null;
  isSubmitting?: boolean;
  attachedGenerationCreatedAt?: number | null;
  conversationId?: string;
  messagesLoaded?: boolean;
  onSubmission?: (submission: TSubmission | null) => void;
  siblingIndexParentId?: string;
  onSiblingIndex?: (siblingIndex: number) => void;
  pendingSteers?: PendingSteer[];
  onPendingSteers?: (steers: PendingSteer[]) => void;
  onQueuedMessages?: (queued: QueuedMessage[]) => void;
  submissionStart?: number;
  onSubmissionStart?: (submissionStart: number | null) => void;
}) {
  const getMessages = jest.fn(getMessagesOverride ?? (() => messages));
  const jotaiStore = createStore();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let setSubmissionState: ((submission: TSubmission | null) => void) | undefined;
  let setIsSubmittingState: ((value: boolean) => void) | undefined;
  let setAttachedEpochState: ((value: number | null) => void) | undefined;
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.conversationByIndex(0), buildConversation(conversationId));
    snapshot.set(store.submissionByIndex(0), submission);
    snapshot.set(store.isSubmittingFamily(0), isSubmitting);
    snapshot.set(
      store.activeGenerationCreatedAtByConvoId(conversationId),
      attachedGenerationCreatedAt,
    );
    if (submissionStart != null) {
      snapshot.set(store.submissionStartFamily(0), submissionStart);
    }
    if (pendingSteers) {
      snapshot.set(store.pendingSteersByConvoId(conversationId), pendingSteers);
    }
  };

  const SubmissionProbe = () => {
    const currentSubmission = useRecoilValue(store.submissionByIndex(0));
    setSubmissionState = useSetRecoilState(store.submissionByIndex(0));
    setIsSubmittingState = useSetRecoilState(store.isSubmittingFamily(0));
    setAttachedEpochState = useSetRecoilState(
      store.activeGenerationCreatedAtByConvoId(conversationId),
    );
    onSubmission?.(currentSubmission);
    return null;
  };
  const SubmissionStartProbe = () => {
    const currentStart = useRecoilValue(store.submissionStartFamily(0));
    onSubmissionStart?.(currentStart);
    return null;
  };
  const PendingSteersProbe = () => {
    const steers = useRecoilValue(store.pendingSteersByConvoId(conversationId));
    onPendingSteers?.(steers);
    return null;
  };
  const QueuedMessagesProbe = () => {
    const queued = useRecoilValue(store.queuedMessagesByConvoId(conversationId));
    onQueuedMessages?.(queued);
    return null;
  };
  const SiblingIndexProbe = () => {
    const siblingIndex = useAtomValue(siblingIdxFamily(siblingKey(siblingIndexParentId)));
    if (siblingIndexParentId) {
      onSiblingIndex?.(siblingIndex);
    }
    return null;
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStore}>
        <RecoilRoot initializeState={initializeState}>
          <SubmissionProbe />
          <SubmissionStartProbe />
          <SiblingIndexProbe />
          <PendingSteersProbe />
          <QueuedMessagesProbe />
          {children}
        </RecoilRoot>
      </JotaiProvider>
    </QueryClientProvider>
  );

  return {
    queryClient,
    jotaiStore,
    getMessages,
    setSubmission: (nextSubmission: TSubmission | null) => setSubmissionState?.(nextSubmission),
    setIsSubmitting: (value: boolean) => setIsSubmittingState?.(value),
    setAttachedGenerationCreatedAt: (value: number | null) => setAttachedEpochState?.(value),
    ...renderHook(
      (props?: { conversationId?: string }) =>
        useResumeOnLoad(props?.conversationId ?? conversationId, getMessages, 0, messagesLoaded),
      { wrapper, initialProps: { conversationId } },
    ),
  };
}

describe('useResumeOnLoad', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockUseStreamStatus.mockReset();
    mockUseStreamStatus.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isFetching: false,
    });
    mockUseActiveJobs.mockReset();
    mockUseActiveJobs.mockReturnValue({ data: { activeJobIds: [] }, dataUpdatedAt: 1 });
    mockUseAgentQueuedTurns.mockReset();
    mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 1 });
    mockExtendActiveJobsGrace.mockReset();
    mockFileMap = {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not check for resume when a null-conversation submission matches a loaded user message', () => {
    renderUseResumeOnLoad({
      submission: buildSubmission(null),
      messages: [buildUserMessage(CONVERSATION_ID)],
    });

    expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, false);
  });

  it('checks for resume when the active submission belongs to a different conversation', () => {
    renderUseResumeOnLoad({
      submission: buildSubmission(STALE_CONVERSATION_ID),
      messages: [buildUserMessage(CONVERSATION_ID)],
    });

    expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
  });

  it('checks for resume when a null-conversation submission cannot be matched to loaded messages', () => {
    renderUseResumeOnLoad({
      submission: buildSubmission(null),
      messages: [buildUserMessage(CONVERSATION_ID, 'different-user-message')],
    });

    expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
  });

  it('stops checking for resume after loaded messages prove a null-conversation submission belongs to the route', () => {
    const submission = buildSubmission(null);
    let messages: TMessage[] = [];
    const { rerender } = renderUseResumeOnLoad({
      submission,
      getMessages: () => messages,
    });

    expect(mockUseStreamStatus).toHaveBeenLastCalledWith(CONVERSATION_ID, true);

    messages = [buildUserMessage(CONVERSATION_ID)];
    rerender();

    expect(mockUseStreamStatus).toHaveBeenLastCalledWith(CONVERSATION_ID, false);
  });

  describe('a run started by another client', () => {
    /** Mirrors `ACTIVE_JOB_REARM_INTERVAL_MS` in the hook. */
    const ACTIVE_JOB_REARM_INTERVAL_MS = 5_000;

    const INACTIVE_STATUS = {
      isSuccess: true,
      isFetching: false,
      data: { active: false },
    };

    const ACTIVE_STATUS = {
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        createdAt: 4242,
        streamId: CONVERSATION_ID,
        resumeState: {
          aggregatedContent: [{ type: ContentTypes.TEXT, text: 'partial' }],
          responseMessageId: RESPONSE_MESSAGE_ID,
          userMessage: { messageId: USER_MESSAGE_ID, conversationId: CONVERSATION_ID },
        },
      },
    };

    it('stops asking about a conversation once it has answered inactive', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({ messages: [] });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);

      rerender();

      /** Documents the gap this suite's next case closes: the status query is
       *  the only thing that could notice another client's run, and it is now
       *  switched off for the rest of this conversation's mount. */
      expect(mockUseStreamStatus).toHaveBeenLastCalledWith(CONVERSATION_ID, false);
    });

    it('attaches when a job for the viewed conversation becomes active elsewhere', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(observedSubmissions[observedSubmissions.length - 1]).toBeNull();

      /** Another tab (or another device) sends into this same conversation.
       *  `/chat/active` is scoped to the user, not to the client that started
       *  the run, so this pane can see it — and it refetches on focus. */
      mockUseStreamStatus.mockClear();
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** Re-armed: the status query re-opens off the announcement... */
      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      /** ...and closes again once the attachment exists, rather than staying
       *  open for the run's whole lifetime. */
      expect(mockUseStreamStatus).toHaveBeenLastCalledWith(CONVERSATION_ID, false);
      const attached = observedSubmissions[observedSubmissions.length - 1] as
        | (TSubmission & { resumeStreamId?: string; resumeGenerationCreatedAt?: number })
        | null;
      expect(attached?.resumeStreamId).toBe(CONVERSATION_ID);
      expect(attached?.resumeGenerationCreatedAt).toBe(4242);
    });

    it('restores the composer approval surface from the authoritative status snapshot', async () => {
      const pendingAction: Agents.PendingAction = {
        actionId: 'action-1',
        streamId: CONVERSATION_ID,
        conversationId: CONVERSATION_ID,
        createdAt: 4242,
        payload: {
          type: 'tool_approval',
          action_requests: [
            {
              name: 'bash_tool',
              tool_call_id: 'call-1',
              arguments: { command: 'npm test' },
            },
          ],
          review_configs: [
            {
              action_name: 'bash_tool',
              tool_call_id: 'call-1',
              allowed_decisions: ['approve', 'reject'],
            },
          ],
        },
      };
      mockUseStreamStatus.mockReturnValue({
        ...ACTIVE_STATUS,
        data: {
          ...ACTIVE_STATUS.data,
          status: 'requires_action',
          pendingAction,
          resumeState: {
            ...ACTIVE_STATUS.data.resumeState,
            pendingAction,
          },
        },
      });

      const { jotaiStore } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(jotaiStore.get(pendingApprovalActionFamily(CONVERSATION_ID))).toEqual(pendingAction);
    });

    /** A reloaded forced-temporary run has no conversation row to read yet, so only the
     *  status snapshot knows the run is hidden; a hard-coded `false` would send it into
     *  history caches and request a title the server never creates. */
    it.each([true, false])(
      'rebuilds the submission with the server-recorded temporary state %s',
      async (isTemporary) => {
        const observedSubmissions: Array<TSubmission | null> = [];
        mockUseStreamStatus.mockReturnValue({
          ...ACTIVE_STATUS,
          data: { ...ACTIVE_STATUS.data, isTemporary },
        });

        renderUseResumeOnLoad({
          messages: [buildUserMessage(CONVERSATION_ID)],
          onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
        });
        await act(async () => {
          await Promise.resolve();
        });

        expect(observedSubmissions.at(-1)?.isTemporary).toBe(isTemporary);
      },
    );

    /** The elapsed indicator's baseline must be the generation's real start:
     *  an attach with no surviving anchor (a reload, or a run another client
     *  started) rebuilds it clock-locally from the server-computed generation
     *  age, subtracted from the moment the status response ARRIVED — so
     *  neither cross-machine clock skew nor a slow history fetch between
     *  receipt and apply can distort the reading. */
    it('anchors the elapsed baseline via the server-computed generation age', async () => {
      const observedStarts: Array<number | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmissionStart: (start) => observedStarts.push(start),
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(observedStarts[observedStarts.length - 1]).toBeNull();

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue({
        ...ACTIVE_STATUS,
        dataUpdatedAt: 1_000_000,
        data: { ...ACTIVE_STATUS.data, elapsedMs: 30_000 },
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(observedStarts[observedStarts.length - 1]).toBe(1_000_000 - 30_000);
    });

    /** An older server without `elapsedMs` still beats counting from attach:
     *  the raw server start is adopted and the indicator clamps its skew. */
    it('falls back to the server-recorded generation start without elapsedMs', async () => {
      const observedStarts: Array<number | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmissionStart: (start) => observedStarts.push(start),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(observedStarts[observedStarts.length - 1]).toBe(4242);
    });

    /** A reattach to the run this session already anchored must keep the ask
     *  baseline — the atom deliberately outlives the submission it timed. */
    it('preserves a surviving elapsed baseline over the server-recorded start', async () => {
      const observedStarts: Array<number | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        submissionStart: 1111,
        onSubmissionStart: (start) => observedStarts.push(start),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(observedStarts[observedStarts.length - 1]).toBe(1111);
    });

    it('restores an externally started regeneration after history refreshes', async () => {
      const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
      const olderResponse = {
        messageId: 'older-response',
        parentMessageId: rootUser.messageId,
        conversationId: CONVERSATION_ID,
        text: 'Older response',
        isCreatedByUser: false,
      } as TMessage;
      const newerResponse = {
        messageId: 'newer-response',
        parentMessageId: rootUser.messageId,
        conversationId: CONVERSATION_ID,
        text: 'Newer response',
        isCreatedByUser: false,
      } as TMessage;
      const observedSubmissions: Array<TSubmission | null> = [];
      let messages = [rootUser];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender, queryClient } = renderUseResumeOnLoad({
        getMessages: () => messages,
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      messages = [rootUser, newerResponse, olderResponse];
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue({
        isSuccess: true,
        isFetching: false,
        data: {
          active: true,
          status: 'running',
          createdAt: 4242,
          streamId: CONVERSATION_ID,
          resumeState: {
            aggregatedContent: [{ type: ContentTypes.TEXT, text: 'regenerating' }],
            responseMessageId: `${olderResponse.messageId}_`,
            userMessage: {
              messageId: rootUser.messageId,
              conversationId: CONVERSATION_ID,
            },
          },
        },
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });
      const attached = observedSubmissions[observedSubmissions.length - 1];
      expect(attached?.isRegenerate).toBe(true);
      expect(attached?.initialResponse?.messageId).toBe(`${olderResponse.messageId}_`);
      expect(attached?.messages?.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        newerResponse.messageId,
        olderResponse.messageId,
      ]);
      expect(attached?.regenerateMessages?.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        newerResponse.messageId,
        olderResponse.messageId,
      ]);
    });

    it('re-arms once per run rather than on every poll of the active list', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender } = renderUseResumeOnLoad({ messages: [] });
      await act(async () => {
        await Promise.resolve();
      });

      /** The job is listed, but the status read that answers the announcement
       *  finds it already finished — a run that ended between the two calls. */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);

      mockUseStreamStatus.mockClear();
      /** The list keeps reporting the same job on its heartbeat. Each poll is a
       *  fresh fetch stamp, so the effect does run — only the elapsed-time gate
       *  stops it from re-reading status every time. */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 3,
      });
      rerender();
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 4,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).not.toHaveBeenCalledWith(CONVERSATION_ID, true);
    });

    it('forces fresh status and history reads instead of trusting warm caches', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender, queryClient } = renderUseResumeOnLoad({ messages: [] });
      await act(async () => {
        await Promise.resolve();
      });

      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** An inactive status answered inside its `staleTime` is still fresh, so
       *  re-enabling the query would replay "nothing running" and the
       *  announcement would be consumed without ever attaching. */
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['streamStatus', CONVERSATION_ID],
      });
      /** History has to be authoritative whichever way the status lands: the
       *  resume submission and `finalHandler` both build on this snapshot. */
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });
    });

    it('refetches history even when the announced run has already finished', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender, queryClient } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      /** Announced, but the run ends before the status read answers. Nothing
       *  attaches — so the refetch is the entire repair, and without it the
       *  turns that other client just completed stay missing here. */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(observedSubmissions[observedSubmissions.length - 1]).toBeNull();
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });
    });

    it('answers a second external run that never left the list', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      let clock = 1_000_000;
      nowSpy.mockImplementation(() => clock);

      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender } = renderUseResumeOnLoad({ messages: [] });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      mockUseStreamStatus.mockClear();
      /**
       * The first run ended and a second began between two polls of the active
       * list, so the list reads `[conversationId]` the whole time and never
       * shows the gap a latch would need. Only elapsed time distinguishes them.
       */
      clock += ACTIVE_JOB_REARM_INTERVAL_MS + 1;
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 3,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      nowSpy.mockRestore();
    });

    it('re-arms again for the next run once the previous one leaves the list', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender } = renderUseResumeOnLoad({ messages: [] });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({ data: { activeJobIds: [] }, dataUpdatedAt: 1 });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      mockUseStreamStatus.mockClear();
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
    });

    it('attaches to a continuation when the finished run left its submission installed', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      /**
       * The FINAL path never clears the submission atom, so a pane that just
       * finished a run still holds it. When a background tool dispatch (or any
       * server-side continuation) then starts the next generation, that stale
       * bookkeeping is the only thing standing between the announcement and the
       * attachment — and it is not an attachment: nothing is streaming.
       */
      const { rerender } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: false,
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseStreamStatus.mockClear();
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      const attached = observedSubmissions[observedSubmissions.length - 1] as
        | (TSubmission & { resumeStreamId?: string })
        | null;
      expect(attached?.resumeStreamId).toBe(CONVERSATION_ID);
    });

    it('leaves a resumed attachment alone before its stream has opened', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      /**
       * A resume installs its submission and only reads as submitting once the
       * stream opens, so between those two points a submission exists with
       * `isSubmitting` still false. An announcement landing there must not
       * mistake it for the leftovers of a finished run and tear down the
       * attachment this hook just built. The epoch is stamped first for exactly
       * this reason.
       */
      const { rerender } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: false,
        attachedGenerationCreatedAt: 4242,
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(observedSubmissions[observedSubmissions.length - 1]).not.toBeNull();
    });

    it('leaves a streaming attachment alone when its own run is announced', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: true,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseStreamStatus.mockClear();
      /** This pane's own run is what the list is reporting. */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).not.toHaveBeenCalledWith(CONVERSATION_ID, true);
    });

    it('declares an owed successor so the active list keeps being asked', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * A queued turn the backend has taken ownership of: `useQueueDrain`
       * declines the boundary, so no submission is built here and the run must
       * be recognised from the active list — which finishing the previous run
       * empties. Saying the successor is owed is what keeps that list live,
       * rather than betting on how long admission takes.
       */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [{ status: 'queued' }], dataUpdatedAt: 2 });

      renderUseResumeOnLoad({ messages: [buildUserMessage(CONVERSATION_ID)] });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);
    });

    it('declares nothing owed while its own run is the one in flight', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({ data: [{ status: 'queued' }], dataUpdatedAt: 2 });

      /** The queued turn is waiting behind a run this pane is already
       *  streaming; that attachment is what will report the successor. */
      renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: true,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
    });

    it('declares nothing owed for a turn the server cannot admit', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ status: 'claimed', failure: { code: 'ADMISSION_INDETERMINATE' } }],
        dataUpdatedAt: 2,
      });

      renderUseResumeOnLoad({ messages: [buildUserMessage(CONVERSATION_ID)] });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
    });

    it('keeps listening after the admitted receipt is dropped, until the list reports the run', async () => {
      jest.useFakeTimers();
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * Admission outlasted the handover window, so the wall-clock fallback is
       * already spent by the time the turn is admitted. The receipt reports
       * `admitted` for one fetch and is then dropped from the projection —
       * before the active list has observed the run it started. Keying on the
       * receipt alone stops listening in exactly that gap.
       */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [{ status: 'queued' }], dataUpdatedAt: 2 });
      const { rerender } = renderUseResumeOnLoad({ messages: [buildUserMessage(CONVERSATION_ID)] });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ status: 'admitted' }],
        dataUpdatedAt: 3,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 4 });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      /** Receipt gone, list still empty: the owed state has to carry this. */
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      /** The list naming the conversation is an announcement, not delivery —
       *  it carries no generation identity, so it cannot prove the successor
       *  exists. It arms a status read; attaching to a generation other than
       *  the predecessor's is what finally releases the owed state. */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 5,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      await act(async () => {
        jest.advanceTimersByTime(ACTIVE_JOB_REARM_INTERVAL_MS + 1);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
      jest.useRealTimers();
    });

    it('arms off an owed receipt alone, without waiting for the list', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseStreamStatus.mockClear();
      /** The run started and will be over before the next list poll. The
       *  status read is the authoritative answer and must not wait on it. */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ status: 'admitted' }],
        dataUpdatedAt: 2,
      });
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      const attached = observedSubmissions[observedSubmissions.length - 1] as
        | (TSubmission & { resumeStreamId?: string })
        | null;
      expect(attached?.resumeStreamId).toBe(CONVERSATION_ID);
    });

    it('retires a remounted reveal after fresh inactive status and restored successor history', async () => {
      mockUseStreamStatus.mockReturnValue({ ...INACTIVE_STATUS, isSuccess: false });
      mockUseAgentQueuedTurns.mockReturnValue({ data: [] });
      const messages = [
        buildUserMessage(CONVERSATION_ID),
        { messageId: 'successor', parentMessageId: 'response' } as TMessage,
      ];
      const { rerender, jotaiStore, queryClient } = renderUseResumeOnLoad({ messages });
      const family = revealedQueuedTurnFamily(CONVERSATION_ID);
      act(() => {
        queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], messages);
        jotaiStore.set(family, {
          clientRequestId: 'queued',
          parentMessageId: 'response',
          generationCreatedAt: 41,
          text: 'queued',
          revealedAt: new Date(Date.now() - 60_000).toISOString(),
        });
      });
      mockUseStreamStatus.mockReturnValue({ ...INACTIVE_STATUS, dataUpdatedAt: Date.now() + 1 });
      rerender();
      expect(jotaiStore.get(family)).toBeNull();
    });

    it('lets the owed state lapse once the receipt has gone quiet for the window', async () => {
      jest.useFakeTimers();
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({ data: [{ status: 'queued' }], dataUpdatedAt: 2 });
      const { rerender, jotaiStore } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      const revealFamily = revealedQueuedTurnFamily(CONVERSATION_ID);
      jotaiStore.set(revealFamily, {
        clientRequestId: 'queued',
        parentMessageId: 'response',
        generationCreatedAt: 41,
        text: 'queued',
        revealedAt: new Date().toISOString(),
      });

      /** A long wait behind an unadmitted turn must not burn the window: the
       *  countdown starts only when the receipt stops reporting. */
      await act(async () => {
        jest.advanceTimersByTime(ACTIVE_JOB_REARM_INTERVAL_MS * 20);
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      expect(jotaiStore.get(revealFamily)).not.toBeNull();
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      await act(async () => {
        jest.advanceTimersByTime(30_000 + 1);
      });
      rerender();
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
      expect(jotaiStore.get(revealFamily)).toBeNull();
      jest.useRealTimers();
    });

    it('does not count the predecessor attachment as delivery of the successor', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * The turn was queued behind this pane's own run, so its receipt is
       * admitted while that predecessor is still attached. If that attachment
       * counted as delivery the latch would be cleared — or never recorded —
       * and once the predecessor closes and the receipt is gone, nothing would
       * be left to notice the successor.
       */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ status: 'admitted' }],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: true,
        attachedGenerationCreatedAt: 1000,
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });
      /** Attached to the predecessor: nothing to poll for yet, nothing to arm. */
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);

      /** Predecessor ends: its FINAL clears the epoch and submitting state and
       *  leaves the finished submission installed; the list is already empty
       *  from the optimistic removal, and the receipt is dropped. */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
      mockUseStreamStatus.mockClear();
      mockUseStreamStatus.mockReturnValue(ACTIVE_STATUS);
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** The latch carried the handover: with the receipt gone and the list
       *  empty, the pane still declared the successor owed... */
      expect(mockUseActiveJobs).toHaveBeenCalledWith(true, true);
      /** ...which armed the status read, which attached to the successor. */
      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      const attached = observedSubmissions[observedSubmissions.length - 1] as
        | (TSubmission & { resumeStreamId?: string; resumeGenerationCreatedAt?: number })
        | null;
      expect(attached?.resumeStreamId).toBe(CONVERSATION_ID);
      expect(attached?.resumeGenerationCreatedAt).toBe(4242);
      /** And attaching to a generation other than the predecessor's is the
       *  delivery that releases it. */
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
    });

    it('treats attachment to a different generation as delivery', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ status: 'admitted' }],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: true,
        attachedGenerationCreatedAt: 1000,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** Receipt gone, and this pane is now attached to a newer epoch — that
       *  IS the successor, so nothing remains owed once it detaches again. */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
      await act(async () => {
        setAttachedGenerationCreatedAt(2000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
    });

    it('does not let a listed, unattached predecessor deliver the successor', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * The predecessor runs elsewhere: this pane is not attached, but the
       * active list names the conversation. The list has no generation identity,
       * so being listed cannot prove the successor exists — treating it as
       * delivery means the latch is never recorded, and a successor that runs
       * inside a poll gap after the predecessor ends is never seen.
       */
      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued', expectedPredecessorCreatedAt: 1000 }],
        dataUpdatedAt: 2,
      });
      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** Predecessor ends and the successor is admitted, runs, and finishes
       *  between two polls: list empty again, receipt already dropped. The
       *  first arm happened at mount (the listed predecessor announced), so
       *  step past the throttle before the transition. */
      const nowSpy = jest.spyOn(Date, 'now');
      const later = Date.now() + ACTIVE_JOB_REARM_INTERVAL_MS + 1;
      nowSpy.mockImplementation(() => later);
      mockUseActiveJobs.mockReturnValue({ data: { activeJobIds: [] }, dataUpdatedAt: 3 });
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
      mockUseStreamStatus.mockClear();
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** Still owed — the latch survived the listed predecessor — so the pane
       *  keeps asking and re-reads status/history instead of going idle. */
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);
      expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
      nowSpy.mockRestore();
    });

    it('learns the predecessor from a generation seen while the turn still waits', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /** Enqueued elsewhere without a boundary, so the only way to learn which
       *  generation is the predecessor is to see it live while the receipt is
       *  still queued. Once the turn is admitted, that same generation must
       *  not read as the successor just because a boundary was never sent. */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued' }],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: false,
        attachedGenerationCreatedAt: null,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** Predecessor becomes live here while the turn is still queued. */
      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(1000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      /** Turn admitted while that same generation is still attached. */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'admitted' }],
        dataUpdatedAt: 3,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      /** Predecessor ends; receipt dropped. */
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 4 });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);
    });

    it('re-arms history only on a receipt transition, not on every receipt poll', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      const { rerender, queryClient } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      const historyRefetches = () =>
        invalidate.mock.calls.filter(([options]) => {
          const key = (options as { queryKey?: unknown } | undefined)?.queryKey;
          return Array.isArray(key) && key[0] === QueryKeys.messages;
        }).length;

      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued' }],
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(historyRefetches()).toBe(1);

      /** The same queued receipt, refetched on its two-second heartbeat while
       *  admission is delayed. Nothing has happened; nothing should download. */
      const nowSpy = jest.spyOn(Date, 'now');
      let clock = Date.now();
      nowSpy.mockImplementation(() => clock);
      for (const stamp of [3, 4, 5]) {
        clock += ACTIVE_JOB_REARM_INTERVAL_MS + 1;
        mockUseAgentQueuedTurns.mockReturnValue({
          data: [{ queuedTurnId: 'q1', status: 'queued' }],
          dataUpdatedAt: stamp,
        });
        /** The active list polls on its own heartbeat while a successor is
         *  owed, so the arm DOES re-enter here — only the gate keeps it from
         *  downloading history again. */
        mockUseActiveJobs.mockReturnValue({ data: { activeJobIds: [] }, dataUpdatedAt: stamp });
        rerender();
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(historyRefetches()).toBe(1);

      /** Admission is a transition: now history matters again. */
      clock += ACTIVE_JOB_REARM_INTERVAL_MS + 1;
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'admitted' }],
        dataUpdatedAt: 6,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(historyRefetches()).toBe(2);
      nowSpy.mockRestore();
    });

    it.each(['queued', 'claimed', 'admitted'])(
      'retains off-screen admission ownership while a cached receipt is %s',
      async (status) => {
        jest.useFakeTimers();
        mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
        mockUseAgentQueuedTurns.mockReturnValue({
          data: [{ queuedTurnId: 'q1', status }],
          dataUpdatedAt: 2,
        });
        const { rerender, queryClient, jotaiStore } = renderUseResumeOnLoad({
          messages: [buildUserMessage(CONVERSATION_ID)],
        });
        const family = revealedQueuedTurnFamily(CONVERSATION_ID);
        act(() => {
          jotaiStore.set(family, {
            clientRequestId: 'request',
            parentMessageId: 'response',
            generationCreatedAt: 41,
            text: 'queued',
            revealedAt: new Date().toISOString(),
          });
          queryClient.setQueryData(agentQueuedTurnsQueryKey(CONVERSATION_ID), [
            { queuedTurnId: 'q1', status },
          ]);
        });
        mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
        rerender({ conversationId: STALE_CONVERSATION_ID });
        await act(async () => {
          jest.advanceTimersByTime(30_001);
        });
        expect(jotaiStore.get(family)).not.toBeNull();
        mockUseAgentQueuedTurns.mockReturnValue({
          data: [{ queuedTurnId: 'q1', status }],
          dataUpdatedAt: 4,
        });
        rerender({ conversationId: CONVERSATION_ID });
        expect(jotaiStore.get(family)).not.toBeNull();
        jest.useRealTimers();
      },
    );

    it('expires the owed state on an absolute window even while its conversation is off-screen', async () => {
      jest.useFakeTimers();
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued' }],
        dataUpdatedAt: 2,
      });
      const { rerender, queryClient } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      /** Navigate away. No receipts are observed for an off-screen
       *  conversation, so the latch must start its window now rather than
       *  waiting for a return it may never get. */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 3 });
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      rerender({ conversationId: STALE_CONVERSATION_ID });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(30_000 + 1);
      });

      /** Window spent off-screen: one repair refetch for THAT conversation. */
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });

      /** Returning must not reopen it. */
      rerender({ conversationId: CONVERSATION_ID });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
      jest.useRealTimers();
    });

    it('settles when the successor attaches while its admitted receipt is still cached', async () => {
      const depthErrors: string[] = [];
      const consoleError = jest.spyOn(console, 'error').mockImplementation((...args) => {
        const text = args.map(String).join(' ');
        if (text.includes('Maximum update depth')) {
          depthErrors.push(text);
        }
      });
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * The receipt carries the predecessor epoch and stays `admitted` in the
       * cache for a fetch after the successor attaches. Attachment to a
       * different generation is delivery — but the same still-reporting
       * receipt must not immediately relatch, or clear/relatch cycles
       * synchronously until the cache moves on.
       */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'admitted', effectivePredecessorCreatedAt: 1000 }],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: false,
        attachedGenerationCreatedAt: null,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      /** The successor (a different generation than the boundary) attaches. */
      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(2000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(depthErrors).toHaveLength(0);
      /** Delivered: with the receipt still cached, nothing is owed and the
       *  fallback window was restarted from this live observation. */
      expect(mockExtendActiveJobsGrace).toHaveBeenCalledTimes(1);
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
      consoleError.mockRestore();
    });

    it("does not let a remount's cached receipt reopen a window that already started", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000_000);
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued' }],
        dataUpdatedAt: 900_000,
      });
      const { rerender, queryClient } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** Leave: the window starts now (quietSince = 1_000_000). Receipts are
       *  fetched per conversation, so the other conversation reports none. */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 900_000 });
      rerender({ conversationId: STALE_CONVERSATION_ID });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });

      /** Return: React Query first exposes the receipt cached BEFORE the
       *  window started, while its refetch is still in flight. That stale
       *  observation must not reset the clock. */
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'queued' }],
        dataUpdatedAt: 900_000,
      });
      rerender({ conversationId: CONVERSATION_ID });
      await act(async () => {
        await Promise.resolve();
      });
      /** The authoritative refetch: the turn is gone. */
      mockUseAgentQueuedTurns.mockReturnValue({ data: [], dataUpdatedAt: 1_010_500 });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** Absolute expiry: 30s from the ORIGINAL start, not from the return. */
      await act(async () => {
        jest.advanceTimersByTime(20_000 + 1);
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });
      rerender();
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
      jest.useRealTimers();
    });

    it('tracks delivery per queued turn, not per receipt set', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * Two turns queued elsewhere behind the same generation. Delivering the
       * first must not mark the second delivered — and the first successor,
       * now the live link the second turn waits behind, is the SECOND turn's
       * predecessor, not its successor.
       */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [
          { queuedTurnId: 'q1', status: 'queued', expectedPredecessorCreatedAt: 1000 },
          { queuedTurnId: 'q2', status: 'queued', expectedPredecessorCreatedAt: 1000 },
        ],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: true,
        attachedGenerationCreatedAt: 1000,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** q1 admitted; predecessor ends; pane attaches to q1's successor (2000). */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [
          { queuedTurnId: 'q1', status: 'admitted', effectivePredecessorCreatedAt: 1000 },
          { queuedTurnId: 'q2', status: 'queued', expectedPredecessorCreatedAt: 1000 },
        ],
        dataUpdatedAt: 3,
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(2000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      /** q1's receipt dropped; q2 still queued; successor 2000 finishes. The
       *  pane must still owe q2 — the whole point of per-turn tracking. */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q2', status: 'queued', expectedPredecessorCreatedAt: 1000 }],
        dataUpdatedAt: 4,
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      /** Pane re-attaches to 2000 (still q1's successor, q2's predecessor);
       *  q2 is admitted while it is live, and its receipt still names only the
       *  chain's ROOT. The link learned while q2 waited must outrank that: the
       *  live 2000 is q2's predecessor, not its delivery. */
      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(2000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q2', status: 'admitted', expectedPredecessorCreatedAt: 1000 }],
        dataUpdatedAt: 5,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      /** q2's own successor (3000) is the delivery. */
      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(3000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, false);
    });

    it("keeps one conversation's owed state when another also owes a run", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(2_000_000);
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'a1', status: 'queued' }],
        dataUpdatedAt: 1_999_000,
      });
      const { rerender, queryClient } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });

      /** Navigate to B, which reports its own queued turn. A's latch must
       *  survive, and A's expiry must still fire while B is on screen. */
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'b1', status: 'queued' }],
        dataUpdatedAt: 2_000_500,
      });
      rerender({ conversationId: STALE_CONVERSATION_ID });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(30_000 + 1);
      });

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [QueryKeys.messages, CONVERSATION_ID],
      });
      /** B's own owed state is untouched by A's expiry. */
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);
      jest.useRealTimers();
    });

    it('does not treat a live generation as delivery when no boundary is known', async () => {
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);
      /**
       * Latched while unattached, from a receipt that carries no boundary, then
       * a generation comes live. It could be the predecessor as easily as the
       * successor; guessing "delivered" would silence the poll while the run is
       * still owed. Stay owed and let the bounded expiry be the fallback.
       */
      mockUseAgentQueuedTurns.mockReturnValue({
        data: [{ queuedTurnId: 'q1', status: 'admitted' }],
        dataUpdatedAt: 2,
      });
      const { rerender, setIsSubmitting, setAttachedGenerationCreatedAt } = renderUseResumeOnLoad({
        submission: buildSubmission(CONVERSATION_ID),
        isSubmitting: false,
        attachedGenerationCreatedAt: null,
        messages: [buildUserMessage(CONVERSATION_ID)],
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);

      await act(async () => {
        setIsSubmitting(true);
        setAttachedGenerationCreatedAt(1000);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        setIsSubmitting(false);
        setAttachedGenerationCreatedAt(null);
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockExtendActiveJobsGrace).not.toHaveBeenCalled();
      expect(mockUseActiveJobs).toHaveBeenLastCalledWith(true, true);
    });

    it('does not re-arm for a conversation that is not the one being viewed', async () => {
      const observedSubmissions: Array<TSubmission | null> = [];
      mockUseStreamStatus.mockReturnValue(INACTIVE_STATUS);

      const { rerender } = renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
      });
      await act(async () => {
        await Promise.resolve();
      });

      mockUseActiveJobs.mockReturnValue({
        data: { activeJobIds: [STALE_CONVERSATION_ID] },
        dataUpdatedAt: 2,
      });
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUseStreamStatus).toHaveBeenLastCalledWith(CONVERSATION_ID, false);
      expect(observedSubmissions[observedSubmissions.length - 1]).toBeNull();
    });
  });

  it('does not replace a null-conversation submission when stream status matches its resume state', async () => {
    const submission = buildSubmission(null);
    const observedSubmissions: Array<TSubmission | null> = [];
    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: 'stream-1',
        resumeState: {
          aggregatedContent: [],
          responseMessageId: RESPONSE_MESSAGE_ID,
          userMessage: { messageId: USER_MESSAGE_ID },
        },
      },
    });

    renderUseResumeOnLoad({
      submission,
      messages: [],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUseStreamStatus).toHaveBeenCalledWith(CONVERSATION_ID, true);
    expect(observedSubmissions[observedSubmissions.length - 1]).toBe(submission);
  });

  it('restores model spec icon metadata on the resumed assistant placeholder', async () => {
    const observedSubmissions: Array<TSubmission | null> = [];
    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        createdAt: 1234,
        generationProtocolVersion: 2,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'Streaming...' }],
          responseMessageId: RESPONSE_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          sender: 'Spec Agent',
          iconURL: 'https://example.com/spec-icon.png',
          model: 'gpt-4.1',
          userMessage: {
            messageId: USER_MESSAGE_ID,
            parentMessageId: Constants.NO_PARENT,
            conversationId: CONVERSATION_ID,
            text: 'Hello',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [
        buildUserMessage(CONVERSATION_ID),
        {
          messageId: RESPONSE_MESSAGE_ID,
          parentMessageId: USER_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          text: '',
          isCreatedByUser: false,
          iconURL: '',
          model: '',
        } as TMessage,
      ],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(observedSubmissions[observedSubmissions.length - 1]?.initialResponse).toEqual(
      expect.objectContaining({
        messageId: RESPONSE_MESSAGE_ID,
        sender: 'Spec Agent',
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-4.1',
      }),
    );
    expect(
      (
        observedSubmissions[observedSubmissions.length - 1] as TSubmission & {
          resumeGenerationCreatedAt?: number;
          resumeGenerationProtocolVersion?: number;
        }
      ).resumeGenerationCreatedAt,
    ).toBe(1234);
    expect(
      (
        observedSubmissions[observedSubmissions.length - 1] as TSubmission & {
          resumeGenerationProtocolVersion?: number;
        }
      ).resumeGenerationProtocolVersion,
    ).toBe(2);
  });

  it('reprocesses the same conversation when a stale attachment hands off to a newer epoch', async () => {
    const observedSubmissions: Array<TSubmission | null> = [];
    const staleSubmission = buildSubmission(CONVERSATION_ID);
    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        generationHandoff: true,
        generationProtocolVersion: 2,
        status: 'running',
        streamId: CONVERSATION_ID,
        createdAt: 2000,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'replacement content' }],
          responseMessageId: 'replacement-response',
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: 'replacement-user',
            parentMessageId: Constants.NO_PARENT,
            conversationId: CONVERSATION_ID,
            text: 'Replacement prompt',
          },
        },
      },
    });

    const rendered = renderUseResumeOnLoad({
      submission: staleSubmission,
      messages: [buildUserMessage(CONVERSATION_ID)],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      rendered.setSubmission(null);
      await Promise.resolve();
    });

    const replacement = observedSubmissions[observedSubmissions.length - 1] as TSubmission & {
      resumeStreamId?: string;
      resumeGenerationCreatedAt?: number;
    };
    expect(replacement.resumeStreamId).toBe(CONVERSATION_ID);
    expect(replacement.resumeGenerationCreatedAt).toBe(2000);
    expect(replacement.userMessage?.messageId).toBe('replacement-user');

    await act(async () => {
      rendered.setSubmission(null);
      await Promise.resolve();
    });

    const replacementInstalls = observedSubmissions.filter(
      (candidate) =>
        (candidate as (TSubmission & { resumeGenerationCreatedAt?: number }) | null)
          ?.resumeGenerationCreatedAt === 2000,
    );
    expect(replacementInstalls).toHaveLength(1);
    expect(observedSubmissions[observedSubmissions.length - 1]).toBeNull();
  });

  it('strips the paused user/assistant rows from submission.messages (no duplicate on resume)', async () => {
    const observedSubmissions: Array<TSubmission | null> = [];
    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'Streaming...' }],
          responseMessageId: RESPONSE_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          sender: 'Agent',
          userMessage: {
            messageId: USER_MESSAGE_ID,
            parentMessageId: Constants.NO_PARENT,
            conversationId: CONVERSATION_ID,
            text: 'Hello',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      // The reloaded DB array already holds the paused user row + the partial
      // (unfinished) assistant row under the same ids the resume re-supplies.
      messages: [
        buildUserMessage(CONVERSATION_ID),
        {
          messageId: RESPONSE_MESSAGE_ID,
          parentMessageId: USER_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          text: '',
          isCreatedByUser: false,
          unfinished: true,
        } as TMessage,
      ],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    const ids = (submission?.messages ?? []).map((m) => m.messageId);
    // Stripped from the flat array (re-supplied via the placeholders + final event)...
    expect(ids).not.toContain(USER_MESSAGE_ID);
    expect(ids).not.toContain(RESPONSE_MESSAGE_ID);
    // ...but still carried on the placeholders for re-insertion.
    expect(submission?.userMessage?.messageId).toBe(USER_MESSAGE_ID);
    expect(submission?.initialResponse?.messageId).toBe(RESPONSE_MESSAGE_ID);
  });

  it('prefers the exact active response over an older assistant sibling', async () => {
    const observedSubmissions: Array<TSubmission | null> = [];
    const userMessage = buildUserMessage(CONVERSATION_ID);
    const olderSibling = {
      messageId: 'older-sibling-response',
      parentMessageId: userMessage.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Older sibling',
      isCreatedByUser: false,
    } as TMessage;
    const activeResponse = {
      messageId: 'active-response',
      parentMessageId: userMessage.messageId,
      conversationId: CONVERSATION_ID,
      text: '',
      isCreatedByUser: false,
      unfinished: true,
    } as TMessage;

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'Active branch streaming' }],
          responseMessageId: activeResponse.messageId,
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: userMessage.messageId,
            parentMessageId: userMessage.parentMessageId,
            conversationId: CONVERSATION_ID,
            text: userMessage.text,
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [userMessage, olderSibling, activeResponse],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    expect(submission?.initialResponse?.messageId).toBe(activeResponse.messageId);
    expect((submission?.messages ?? []).map((message) => message.messageId)).toEqual([
      olderSibling.messageId,
    ]);
  });

  it('does not claim an older sibling when resume state omits the response ID', async () => {
    const observedSubmissions: Array<TSubmission | null> = [];
    const userMessage = buildUserMessage(CONVERSATION_ID);
    const olderSibling = {
      messageId: 'older-sibling-response',
      parentMessageId: userMessage.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Older sibling',
      isCreatedByUser: false,
    } as TMessage;

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [{ type: 'text', text: 'Active branch streaming' }],
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: userMessage.messageId,
            parentMessageId: userMessage.parentMessageId,
            conversationId: CONVERSATION_ID,
            text: userMessage.text,
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [userMessage, olderSibling],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    expect(submission?.initialResponse?.messageId).toBe(`${userMessage.messageId}_`);
    expect((submission?.messages ?? []).map((message) => message.messageId)).toEqual([
      olderSibling.messageId,
    ]);
  });

  it('restores the branch that owns a pending OAuth resume user message', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const branchOneResponse = {
      messageId: 'branch-one-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch one response',
      isCreatedByUser: false,
    } as TMessage;
    const branchOneFollowUp = buildUserMessage(CONVERSATION_ID, 'branch-one-follow-up');
    branchOneFollowUp.parentMessageId = branchOneResponse.messageId;
    const branchOneTail = {
      messageId: 'branch-one-tail',
      parentMessageId: branchOneFollowUp.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch one tail',
      isCreatedByUser: false,
    } as TMessage;
    const branchTwoResponse = {
      messageId: 'branch-two-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch two response',
      isCreatedByUser: false,
    } as TMessage;
    const observedSiblingIndexes: number[] = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          replayEvents: [],
          responseMessageId: 'pending-user_',
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: 'pending-user',
            parentMessageId: branchOneTail.messageId,
            conversationId: CONVERSATION_ID,
            text: 'Use OAuth tool on branch one',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [rootUser, branchOneResponse, branchOneFollowUp, branchOneTail, branchTwoResponse],
      siblingIndexParentId: rootUser.messageId,
      onSiblingIndex: (siblingIndex) => observedSiblingIndexes.push(siblingIndex),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(observedSiblingIndexes[observedSiblingIndexes.length - 1]).toBe(1);
  });

  /**
   * A manual compaction submits no user turn: the server projects the LEAF it
   * summarizes up to into the job's user-message slot, identity only
   * (`projectCompactionAnchor`). Resuming one must adopt that leaf, not
   * synthesize an empty root-parented USER row over it — the row it names is
   * usually the assistant answer, and rewriting it detaches every turn above it.
   */
  it('resumes a compaction against the anchor it summarizes up to', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const anchor = {
      messageId: 'branch-one-answer',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch one answer',
      isCreatedByUser: false,
    } as TMessage;
    const newerSibling = {
      messageId: 'branch-two-answer',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch two answer',
      isCreatedByUser: false,
    } as TMessage;
    const observedSiblingIndexes: number[] = [];
    const observedSubmissions: Array<TSubmission | null> = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          replayEvents: [],
          responseMessageId: `${anchor.messageId}_`,
          conversationId: CONVERSATION_ID,
          isRegenerate: true,
          userMessage: {
            messageId: anchor.messageId,
            conversationId: CONVERSATION_ID,
            text: '',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [rootUser, anchor, newerSibling],
      siblingIndexParentId: rootUser.messageId,
      onSiblingIndex: (siblingIndex) => observedSiblingIndexes.push(siblingIndex),
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    /** The slot keeps the anchor's own identity. */
    expect(submission?.userMessage).toEqual(
      expect.objectContaining({
        messageId: anchor.messageId,
        parentMessageId: rootUser.messageId,
        text: anchor.text,
        isCreatedByUser: false,
      }),
    );
    /** ...is marked as the anchored run it is, so no handler writes it as a row, */
    expect(submission?.compact).toBe(true);
    /** ...stays in the history the run replays, */
    expect((submission?.messages ?? []).map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      anchor.messageId,
      newerSibling.messageId,
    ]);
    /** ...and the summary hangs off it. */
    expect(submission?.initialResponse?.parentMessageId).toBe(anchor.messageId);
    /** The compaction runs on the branch it was started from, not the newest. */
    expect(observedSiblingIndexes[observedSiblingIndexes.length - 1]).toBe(1);
  });

  /**
   * Compact runs on whatever leaf the branch ends with and `canCompact` does not
   * restrict that leaf's author, so the anchor is a USER message whenever the
   * branch ends in one (the `compaction-on-user-turn` scenarios cover the
   * rendered form). Recognizing the anchor by "not user-created" saw only the
   * assistant-leaf kind: this one was rebuilt as an ordinary turn, and the sync
   * path then merged the identity-only projection over the stored row, blanking
   * the prompt the user is still looking at.
   */
  it('resumes a compaction anchored on a user leaf', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const answer = {
      messageId: 'answer',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'The long answer',
      isCreatedByUser: false,
    } as TMessage;
    const userLeaf = buildUserMessage(CONVERSATION_ID, 'user-leaf');
    userLeaf.parentMessageId = answer.messageId;
    userLeaf.text = 'Compact this before I continue';
    const observedSubmissions: Array<TSubmission | null> = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          replayEvents: [],
          responseMessageId: `${userLeaf.messageId}_`,
          conversationId: CONVERSATION_ID,
          isRegenerate: true,
          /** `projectCompactionAnchor`: identity only, whoever wrote the leaf. */
          userMessage: {
            messageId: userLeaf.messageId,
            conversationId: CONVERSATION_ID,
            text: '',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [rootUser, answer, userLeaf],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    /** Marked, so no handler writes the anchor as a row... */
    expect(submission?.compact).toBe(true);
    /** ...and the leaf keeps the prompt the user actually sent. */
    expect(submission?.userMessage).toEqual(
      expect.objectContaining({
        messageId: userLeaf.messageId,
        parentMessageId: answer.messageId,
        text: 'Compact this before I continue',
        isCreatedByUser: true,
      }),
    );
    expect(submission?.initialResponse?.parentMessageId).toBe(userLeaf.messageId);
    expect((submission?.messages ?? []).map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      answer.messageId,
      userLeaf.messageId,
    ]);
  });

  it('restores a compacting branch from the anchor when no response id is published yet', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const anchor = {
      messageId: 'branch-one-answer',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch one answer',
      isCreatedByUser: false,
    } as TMessage;
    const newerSibling = {
      messageId: 'branch-two-answer',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Branch two answer',
      isCreatedByUser: false,
    } as TMessage;
    const observedSiblingIndexes: number[] = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          replayEvents: [],
          conversationId: CONVERSATION_ID,
          isRegenerate: true,
          /** The anchor carries no parent, so it has to name the branch itself. */
          userMessage: {
            messageId: anchor.messageId,
            conversationId: CONVERSATION_ID,
            text: '',
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [rootUser, anchor, newerSibling],
      siblingIndexParentId: rootUser.messageId,
      onSiblingIndex: (siblingIndex) => observedSiblingIndexes.push(siblingIndex),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(observedSiblingIndexes[observedSiblingIndexes.length - 1]).toBe(1);
  });

  it('restores the regenerate branch without claiming its older response', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const olderResponse = {
      messageId: 'older-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Older response',
      sender: 'Agent One',
      model: 'gpt-5',
      iconURL: 'https://example.com/agent-one.png',
      isCreatedByUser: false,
    } as TMessage;
    const newerResponse = {
      messageId: 'newer-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Newer response',
      isCreatedByUser: false,
    } as TMessage;
    const observedSiblingIndexes: number[] = [];
    const observedSubmissions: Array<TSubmission | null> = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          replayEvents: [],
          responseMessageId: `${olderResponse.messageId}_`,
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: rootUser.messageId,
            parentMessageId: rootUser.parentMessageId,
            conversationId: CONVERSATION_ID,
            text: rootUser.text,
          },
        },
      },
    });

    renderUseResumeOnLoad({
      // Put the unrelated sibling first: parent-only fallback would select it.
      messages: [rootUser, newerResponse, olderResponse],
      siblingIndexParentId: rootUser.messageId,
      onSiblingIndex: (siblingIndex) => observedSiblingIndexes.push(siblingIndex),
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(observedSiblingIndexes[observedSiblingIndexes.length - 1]).toBe(0);
    const submission = observedSubmissions[observedSubmissions.length - 1];
    expect(submission?.initialResponse?.messageId).toBe(`${olderResponse.messageId}_`);
    expect(submission?.initialResponse).toEqual(
      expect.objectContaining({
        sender: olderResponse.sender,
        model: olderResponse.model,
        iconURL: olderResponse.iconURL,
      }),
    );
    expect(submission?.isRegenerate).toBe(true);
    expect((submission?.messages ?? []).map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      newerResponse.messageId,
      olderResponse.messageId,
    ]);
    expect((submission?.regenerateMessages ?? []).map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      newerResponse.messageId,
      olderResponse.messageId,
    ]);
  });

  it('preserves an exact-ID edited regeneration branch for early-abort rollback', async () => {
    const rootUser = buildUserMessage(CONVERSATION_ID, 'root-user');
    const editedResponse = {
      messageId: 'edited-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Original response before the edit',
      isCreatedByUser: false,
    } as TMessage;
    const siblingResponse = {
      messageId: 'sibling-response',
      parentMessageId: rootUser.messageId,
      conversationId: CONVERSATION_ID,
      text: 'Unrelated sibling',
      isCreatedByUser: false,
    } as TMessage;
    const observedSubmissions: Array<TSubmission | null> = [];

    mockUseStreamStatus.mockReturnValue({
      isSuccess: true,
      isFetching: false,
      data: {
        active: true,
        status: 'running',
        streamId: CONVERSATION_ID,
        resumeState: {
          runSteps: [],
          aggregatedContent: [],
          responseMessageId: editedResponse.messageId,
          isRegenerate: true,
          conversationId: CONVERSATION_ID,
          userMessage: {
            messageId: rootUser.messageId,
            parentMessageId: rootUser.parentMessageId,
            conversationId: CONVERSATION_ID,
            text: rootUser.text,
          },
        },
      },
    });

    renderUseResumeOnLoad({
      messages: [rootUser, siblingResponse, editedResponse],
      onSubmission: (currentSubmission) => observedSubmissions.push(currentSubmission),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const submission = observedSubmissions[observedSubmissions.length - 1];
    expect(submission?.isRegenerate).toBe(true);
    expect(submission?.initialResponse?.messageId).toBe(editedResponse.messageId);
    expect(submission?.messages?.map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      siblingResponse.messageId,
    ]);
    expect(submission?.regenerateMessages?.map((message) => message.messageId)).toEqual([
      rootUser.messageId,
      siblingResponse.messageId,
      editedResponse.messageId,
    ]);
  });

  describe('steer chip restore', () => {
    const staleChip: PendingSteer = {
      steerId: 'stale-1',
      text: 'applied while away',
      status: 'pending',
      createdAt: 1,
    };
    const failedChip: PendingSteer = {
      steerId: 'failed-1',
      text: 'recoverable words',
      status: 'failed',
      createdAt: 2,
    };

    function buildActiveStatus(pendingSteers?: Array<Record<string, unknown>>) {
      return {
        isSuccess: true,
        isFetching: false,
        data: {
          active: true,
          status: 'running',
          streamId: CONVERSATION_ID,
          createdAt: 1234,
          generationProtocolVersion: 2,
          resumeState: {
            runSteps: [],
            aggregatedContent: [],
            responseMessageId: RESPONSE_MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            userMessage: {
              messageId: USER_MESSAGE_ID,
              parentMessageId: Constants.NO_PARENT,
              conversationId: CONVERSATION_ID,
              text: 'Hello',
            },
            ...(pendingSteers && { pendingSteers }),
          },
        },
      };
    }

    it('clears stale pending chips when the server reports no still-queued steers', async () => {
      const observedSteers: PendingSteer[][] = [];
      mockUseStreamStatus.mockReturnValue(buildActiveStatus());

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        pendingSteers: [staleChip, failedChip],
        onPendingSteers: (steers) => observedSteers.push(steers),
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Only the failed chip survives — its text is client-local and recoverable.
      expect(observedSteers[observedSteers.length - 1]).toEqual([failedChip]);
    });

    it('restores still-queued steers (with files) and drops chips absent from the server list', async () => {
      const observedSteers: PendingSteer[][] = [];
      const files = [{ file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' }];
      mockUseStreamStatus.mockReturnValue(
        buildActiveStatus([{ steerId: 'queued-1', text: 'still queued', createdAt: 5, files }]),
      );

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        pendingSteers: [staleChip],
        onPendingSteers: (steers) => observedSteers.push(steers),
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(observedSteers[observedSteers.length - 1]).toEqual([
        {
          steerId: 'queued-1',
          text: 'still queued',
          status: 'pending',
          createdAt: 5,
          files,
          generationCreatedAt: 1234,
          generationProtocolVersion: 2,
        },
      ]);
    });

    it('seeds the pending snapshot before settling an inline applied steer', async () => {
      const observedSteers: PendingSteer[][] = [];
      mockUseStreamStatus.mockReturnValue({
        isSuccess: true,
        isFetching: false,
        data: {
          active: true,
          status: 'running',
          streamId: CONVERSATION_ID,
          resumeState: {
            runSteps: [],
            pendingSteers: [
              {
                steerId: 'steer-snapshot-race',
                clientSteerId: 'local-snapshot-race',
                text: 'applied at snapshot boundary',
                createdAt: 5,
              },
            ],
            aggregatedContent: [
              {
                type: ContentTypes.STEER,
                steerId: 'steer-snapshot-race',
                clientSteerId: 'local-snapshot-race',
                steer: 'applied at snapshot boundary',
              },
            ],
            responseMessageId: RESPONSE_MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            userMessage: {
              messageId: USER_MESSAGE_ID,
              parentMessageId: Constants.NO_PARENT,
              conversationId: CONVERSATION_ID,
              text: 'Hello',
            },
          },
        },
      });

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onPendingSteers: (steers) => observedSteers.push(steers),
      });

      await act(async () => {
        await Promise.resolve();
      });

      // The status snapshot and aggregated content can straddle the same apply
      // boundary. Restore-then-settle must finish with no resurrected chip.
      expect(observedSteers[observedSteers.length - 1]).toEqual([]);
    });

    it('clears stale pending chips when the run finished while away (no active job)', async () => {
      const observedSteers: PendingSteer[][] = [];
      mockUseStreamStatus.mockReturnValue({
        isSuccess: true,
        isFetching: false,
        data: { active: false },
      });

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        pendingSteers: [staleChip, failedChip],
        onPendingSteers: (steers) => observedSteers.push(steers),
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(observedSteers[observedSteers.length - 1]).toEqual([failedChip]);
    });

    it('converts resumeState.pendingSteers to queued when inactive (expired action, unparked queue)', async () => {
      const observedSteers: PendingSteer[][] = [];
      const observedQueues: QueuedMessage[][] = [];
      mockUseStreamStatus.mockReturnValue({
        isSuccess: true,
        isFetching: false,
        data: {
          active: false,
          resumeState: {
            pendingSteers: [{ steerId: 'steer-unparked', text: 'still queued', createdAt: 5 }],
          },
        },
      });

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        // Local chip carries the client-only context the server list lacks.
        pendingSteers: [
          {
            steerId: 'steer-unparked',
            text: 'still queued',
            status: 'pending',
            createdAt: 5,
            quotes: ['carried quote'],
            manualSkills: ['carried-skill'],
          },
        ],
        onPendingSteers: (steers) => observedSteers.push(steers),
        onQueuedMessages: (queued) => observedQueues.push(queued),
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(observedQueues[observedQueues.length - 1]).toEqual([
        expect.objectContaining({
          id: 'steer-unparked',
          text: 'still queued',
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      ]);
      expect(observedSteers[observedSteers.length - 1]).toEqual([]);
    });

    it('dedupes unrecoveredSteers against resumeState.pendingSteers by steer id', async () => {
      const observedQueues: QueuedMessage[][] = [];
      mockUseStreamStatus.mockReturnValue({
        isSuccess: true,
        isFetching: false,
        data: {
          active: false,
          unrecoveredSteers: [{ steerId: 'steer-dup', text: 'delivered once', createdAt: 3 }],
          resumeState: {
            pendingSteers: [
              { steerId: 'steer-dup', text: 'delivered once', createdAt: 3 },
              { steerId: 'steer-extra', text: 'second words', createdAt: 4 },
            ],
          },
        },
      });

      renderUseResumeOnLoad({
        messages: [buildUserMessage(CONVERSATION_ID)],
        onQueuedMessages: (queued) => observedQueues.push(queued),
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(observedQueues[observedQueues.length - 1]).toEqual([
        expect.objectContaining({ id: 'steer-dup', text: 'delivered once' }),
        expect.objectContaining({ id: 'steer-extra', text: 'second words' }),
      ]);
    });
  });
});
