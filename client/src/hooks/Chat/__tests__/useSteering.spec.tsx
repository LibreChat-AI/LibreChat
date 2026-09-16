import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState, type MutableSnapshot } from 'recoil';
import { getDefaultStore, Provider as JotaiProvider, createStore, useAtomValue } from 'jotai';
import {
  Constants,
  ContentTypes,
  EModelEndpoint,
  LocalStorageKeys,
  ReasoningEffort,
} from 'librechat-data-provider';
import type { TConversation, TFile, TMessage } from 'librechat-data-provider';
import type { QueuedMessage } from '~/store/families';
import type { ExtendedFile } from '~/common';
import { pendingReasoningOverrideFamily } from '~/components/Chat/Input/Composer/state';
import { clearAllDrafts, getPendingDraftId, getNewConversationDraftId } from '~/utils';
import { claimQueuedIntent, releaseQueuedIntent } from '~/utils/queueIntent';
import useSteering, { mergeQueuedTurnFileMetadata } from '../useSteering';
import useUpdateFiles from '~/hooks/Files/useUpdateFiles';
import { revealedQueuedTurnFamily } from '~/store/steer';
import useQueueDrain from '../useQueueDrain';
import store from '~/store';

const CONVO_ID = 'convo-steer-ui';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mockMutate = jest.fn();
const mockCancelSteer = jest.fn();
const mockEnqueueQueuedTurn = jest.fn();
const mockCancelQueuedTurn = jest.fn();
const mockShowToast = jest.fn();
const mockMarkUsage = jest.fn();
let mockMessages: TMessage[] | undefined;
let mockLatestMessage: TMessage | null | undefined;
let mockServerQueuedTurns: unknown[] | undefined;
let mockFileMap: Record<string, Pick<TFile, 'llmDeliveryPath'>> = {};
const mockUseAgentQueuedTurns = jest.fn((..._args: unknown[]) => ({ data: mockServerQueuedTurns }));

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
}));

jest.mock('~/data-provider', () => ({
  useCancelSteerMutation: () => ({ mutateAsync: mockCancelSteer }),
  useSteerMessageMutation: () => ({ mutate: mockMutate }),
  useAgentQueuedTurns: (...args: unknown[]) => mockUseAgentQueuedTurns(...args),
  useEnqueueAgentQueuedTurnMutation: () => ({ mutate: mockEnqueueQueuedTurn }),
  useCancelAgentQueuedTurnMutation: () => ({
    mutateAsync: mockCancelQueuedTurn,
  }),
  isDefiniteQueuedTurnRejection: (error: unknown) => {
    const response = (
      error as { response?: { status?: unknown; data?: { code?: unknown } } } | undefined
    )?.response;
    const unsupported =
      (response?.status === 404 && response.data?.code == null) ||
      (response?.status === 501 && response.data?.code === 'QUEUED_TURN_PRIORITY_UNSUPPORTED');
    return (
      !unsupported &&
      typeof response?.status === 'number' &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 425
    );
  },
  isDefiniteQueuedTurnsUnsupported: (error: unknown) => {
    const status = (error as { response?: { status?: unknown } } | undefined)?.response?.status;
    return status === 404 || status === 501;
  },
  useMarkFilesUsageMutation: () => ({ mutate: mockMarkUsage }),
  supportsGenerationProtocolV2: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2,
}));

jest.mock('~/hooks/Messages', () => ({
  useLatestMessage: () =>
    mockLatestMessage === undefined
      ? (mockMessages?.[mockMessages.length - 1] ?? null)
      : mockLatestMessage,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

const agentsConversation = {
  conversationId: CONVO_ID,
  endpoint: EModelEndpoint.agents,
} as TConversation;

type HookParams = Partial<Parameters<typeof useSteering>[0]>;

const withActiveGeneration =
  (initialize?: (snapshot: MutableSnapshot) => void, conversationId = CONVO_ID) =>
  (snapshot: MutableSnapshot) => {
    snapshot.set(store.activeGenerationCreatedAtByConvoId(conversationId), 41);
    snapshot.set(store.activeGenerationProtocolVersionByConvoId(conversationId), 2);
    initialize?.(snapshot);
  };

function setup(params: HookParams = {}, initialize?: (snapshot: MutableSnapshot) => void) {
  const sendNow = jest.fn();
  const stopGenerating = jest.fn();
  let setGenerationCreatedAt: ((value: number | null) => void) | undefined;
  const GenerationProbe = () => {
    setGenerationCreatedAt = useSetRecoilState(
      store.activeGenerationCreatedAtByConvoId(params.conversationId ?? CONVO_ID),
    );
    return null;
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={withActiveGeneration(initialize, params.conversationId ?? CONVO_ID)}
    >
      <GenerationProbe />
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () =>
      useSteering({
        consumeDraft: () => {
          const id = params.conversationId ?? CONVO_ID;
          const conversationDraftId =
            id === Constants.NEW_CONVO ? getNewConversationDraftId(0) : id;
          clearAllDrafts(
            params.isSubmitting === false ? conversationDraftId : getPendingDraftId(0),
          );
        },
        index: 0,
        conversationId: CONVO_ID,
        conversation: agentsConversation,
        isSubmitting: true,
        answerModeActive: false,
        sendNow,
        stopGenerating,
        ...params,
      }),
    { wrapper },
  );
  return {
    ...rendered,
    sendNow,
    stopGenerating,
    setGenerationCreatedAt: (value: number | null) => setGenerationCreatedAt?.(value),
  };
}

function useQueue(convoId: string) {
  return useRecoilValue(store.queuedMessagesByConvoId(convoId));
}

/** Puts a message in the queue and then sends it, which is the only order the
 *  rail can produce: Send now is offered for a message the queue is holding. */
function sendFromQueue(
  current: {
    steering: ReturnType<typeof useSteering>;
    setQueue: (items: QueuedMessage[]) => void;
  },
  item: QueuedMessage,
) {
  current.setQueue([item]);
  current.steering.sendQueuedNow(item);
}

describe('useSteering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefaultStore().set(revealedQueuedTurnFamily(CONVO_ID), null);
    mockMessages = undefined;
    mockLatestMessage = undefined;
    mockServerQueuedTurns = undefined;
    mockFileMap = {};
  });

  it('keeps optimistic delivery metadata when a legacy receipt omits it', () => {
    expect(
      mergeQueuedTurnFileMetadata(
        [{ file_id: 'stored-doc', filename: 'report.pdf', type: 'application/pdf' }],
        [
          {
            file_id: 'stored-doc',
            filename: 'report.pdf',
            type: 'application/pdf',
            llmDeliveryPath: 'text',
          },
        ],
      ),
    ).toEqual([
      {
        file_id: 'stored-doc',
        filename: 'report.pdf',
        type: 'application/pdf',
        llmDeliveryPath: 'text',
      },
    ]);
  });

  it('hydrates legacy receipt delivery metadata from the stored file map', () => {
    expect(
      mergeQueuedTurnFileMetadata(
        [{ file_id: 'stored-doc', filename: 'report.pdf', type: 'application/pdf' }],
        undefined,
        {
          'stored-doc': {
            llmDeliveryPath: 'text',
          },
        },
      ),
    ).toEqual([
      {
        file_id: 'stored-doc',
        filename: 'report.pdf',
        type: 'application/pdf',
        llmDeliveryPath: 'text',
      },
    ]);
  });

  describe('effectiveAction', () => {
    it('defaults to queue during an active agents run', () => {
      const { result } = setup();
      expect(result.current.duringRunActive).toBe(true);
      expect(result.current.effectiveAction).toBe('queue');
    });

    it('honors the queue preference while keeping the steer override available', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'queue');
      });
      expect(result.current.effectiveAction).toBe('queue');
      // The per-send menu can still override to steer: availability is
      // independent of the default action.
      expect(result.current.canSteer).toBe(true);
    });

    it('degrades to queue without a real conversation id', () => {
      // Seed 'steer' so the assertion exercises the `canSteer ?` degrade
      // guard itself, not just the (now default) queue value falling through.
      const { result } = setup({ conversationId: Constants.NEW_CONVO as string }, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      expect(result.current.effectiveAction).toBe('queue');
    });

    it('degrades to queue while paused on a tool approval', () => {
      mockMessages = [
        {
          messageId: 'resp-1',
          isCreatedByUser: false,
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                id: 'call-1',
                name: 'shell',
                approval: { actionId: 'a1' },
                output: '',
              },
            },
          ],
        } as unknown as TMessage,
      ];
      // Seed 'steer' so this proves the pausedOnApproval guard forces queue,
      // not just that the default happens to already be queue.
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      expect(result.current.pausedOnApproval).toBe(true);
      expect(result.current.effectiveAction).toBe('queue');
      expect(result.current.canSteer).toBe(false);
    });

    it('queues during startup and exposes no live mutation until the generation epoch arrives', () => {
      const { result, stopGenerating, setGenerationCreatedAt } = setup({}, ({ set }) => {
        set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), null);
      });

      expect(result.current.duringRunActive).toBe(true);
      expect(result.current.canControlGeneration).toBe(false);
      expect(result.current.canSteer).toBe(false);
      expect(result.current.effectiveAction).toBe('queue');

      let queued = false;
      let alternateSteer = true;
      let interrupted = true;
      act(() => {
        queued = result.current.submitDuringRun('hold this until startup finishes');
        // Cmd/Ctrl+Enter reaches this explicit alternate while Queue is the
        // effective action; it must not bypass the epoch gate.
        alternateSteer = result.current.steerFromComposer('unsafe startup steer');
        interrupted = result.current.interruptAndSend('unsafe startup abort');
      });
      expect(queued).toBe(true);
      expect(alternateSteer).toBe(false);
      expect(interrupted).toBe(false);
      expect(mockMutate).not.toHaveBeenCalled();
      expect(stopGenerating).not.toHaveBeenCalled();

      act(() => setGenerationCreatedAt(42));
      expect(result.current.canControlGeneration).toBe(true);
      expect(result.current.canSteer).toBe(true);

      act(() => {
        result.current.steerFromComposer('now fenced');
        result.current.interruptAndSend('now stoppable');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          generationCreatedAt: 42,
          text: 'now fenced',
        }),
        expect.anything(),
      );
      expect(stopGenerating).toHaveBeenCalledTimes(1);
    });

    it('is inactive but exposes the paused state for ask-user answer mode', () => {
      expect(
        setup({
          conversation: {
            endpoint: EModelEndpoint.assistants,
          } as TConversation,
        }).result.current.duringRunActive,
      ).toBe(false);
      expect(setup({ index: 1 }).result.current.duringRunActive).toBe(false);
      const answerMode = setup({ answerModeActive: true }).result.current;
      expect(answerMode.duringRunActive).toBe(false);
      expect(answerMode.pausedOnApproval).toBe(true);
      expect(answerMode.canSteer).toBe(false);
    });
  });

  describe('server-owned Agent queued turns', () => {
    function setupServerQueue(initializer = withActiveGeneration()) {
      const sendNow = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot initializeState={initializer}>{children}</RecoilRoot>
      );
      const rendered = renderHook(
        () => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            sendNow,
            stopGenerating: jest.fn(),
          }),
          queue: useQueue(CONVO_ID),
          settledReceipts: useRecoilValue(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID)),
          pendingEnqueueIds: useRecoilValue(store.pendingQueuedTurnEnqueueIdsByConvoId(CONVO_ID)),
        }),
        { wrapper },
      );
      return { ...rendered, sendNow };
    }

    beforeEach(() => {
      mockMessages = [
        {
          messageId: 'visible-assistant-tail',
          isCreatedByUser: false,
          content: [],
        } as unknown as TMessage,
      ];
    });

    it('keeps startup turns local until the server generation epoch exists', async () => {
      const { result } = setupServerQueue(
        withActiveGeneration(({ set }) => {
          set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), null);
        }),
      );

      await act(async () => {
        expect(result.current.steering.queueFromComposer('wait for the epoch')).toBe(true);
        await Promise.resolve();
      });

      expect(mockEnqueueQueuedTurn).not.toHaveBeenCalled();
      expect(result.current.queue).toEqual([
        expect.objectContaining({ text: 'wait for the epoch' }),
      ]);
      expect(result.current.queue[0].server).toBeUndefined();
    });

    it('persists another follow-up against the original queue lineage after its completion boundary advances', async () => {
      const family = revealedQueuedTurnFamily(CONVO_ID);
      getDefaultStore().set(family, {
        clientRequestId: 'pending-first',
        parentMessageId: 'completed-response',
        generationCreatedAt: 42,
        queueParentMessageId: 'original-queue-parent',
        queuePredecessorCreatedAt: 41,
        text: 'first',
        revealedAt: new Date().toISOString(),
      });
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        options.onSuccess({
          ...input,
          queuedTurnId: 'durable-second',
          status: 'queued',
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
      const { result, unmount } = setup({ isSubmitting: false }, ({ set }) => {
        set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), null);
        set(store.pendingQuotesByConvoId(CONVO_ID), ['quoted context']);
        set(store.pendingManualSkillsByConvoId(CONVO_ID), ['skill']);
      });
      expect(result.current.duringRunActive).toBe(true);
      expect(result.current.canSteer).toBe(false);
      await act(async () => {
        expect(result.current.submitDuringRun('second')).toBe(true);
      });
      expect(mockEnqueueQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          parentMessageId: 'original-queue-parent',
          expectedPredecessorCreatedAt: 41,
          text: 'second',
          quotes: ['quoted context'],
          manualSkills: ['skill'],
        }),
        expect.any(Object),
      );
      unmount();
      getDefaultStore().set(family, null);
      mockServerQueuedTurns = [
        {
          ...mockEnqueueQueuedTurn.mock.calls[0][0],
          queuedTurnId: 'durable-second',
          status: 'queued',
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const restored = setupServerQueue();
      await waitFor(() =>
        expect(restored.result.current.queue[0]).toMatchObject({
          text: 'second',
          quotes: ['quoted context'],
          manualSkills: ['skill'],
          server: { id: 'durable-second', status: 'queued' },
        }),
      );
    });

    it('enrolls one optimistic row with a stable request and visible branch identity', async () => {
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        options.onSuccess({
          ...input,
          queuedTurnId: 'server-queued-1',
          status: 'queued',
          revision: 1,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(100).toISOString(),
        });
      });
      const { result } = setupServerQueue();

      await act(async () => {
        expect(result.current.steering.queueFromComposer('server owns this')).toBe(true);
        await Promise.resolve();
      });

      expect(mockEnqueueQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'server owns this',
          expectedPredecessorCreatedAt: 41,
          clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
        }),
        expect.any(Object),
      );
      await waitFor(() =>
        expect(result.current.queue).toEqual([
          expect.objectContaining({
            text: 'server owns this',
            parentMessageId: 'visible-assistant-tail',
            clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
            server: { id: 'server-queued-1', status: 'queued', revision: 1 },
          }),
        ]),
      );
    });

    it.each([
      ['new response', 'user-message_'],
      ['regenerated response', 'old-assistant_'],
      ['edited response', 'old-assistant'],
    ])('anchors an optimistic %s through its durable user parent', async (_label, messageId) => {
      mockMessages = [
        {
          messageId: 'user-message',
          parentMessageId: Constants.NO_PARENT,
          isCreatedByUser: true,
          createdAt: '2026-09-09T12:00:00.000Z',
          updatedAt: '2026-09-09T12:00:00.000Z',
        } as TMessage,
        ...(messageId === 'old-assistant_'
          ? [
              {
                messageId: 'old-assistant',
                parentMessageId: 'user-message',
                isCreatedByUser: false,
                createdAt: '2026-09-09T12:00:01.000Z',
                updatedAt: '2026-09-09T12:00:01.000Z',
              } as TMessage,
            ]
          : []),
        {
          messageId,
          parentMessageId: 'user-message',
          isCreatedByUser: false,
          clientQueueParentMessageId: 'user-message',
        } as TMessage,
      ];
      const { result } = setupServerQueue();

      await act(async () => {
        expect(result.current.steering.queueFromComposer('follow the pending answer')).toBe(true);
        await Promise.resolve();
      });

      expect(mockEnqueueQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({ parentMessageId: 'user-message' }),
        expect.any(Object),
      );
      expect(result.current.queue).toEqual([
        expect.objectContaining({ parentMessageId: 'user-message' }),
      ]);
    });

    it('preserves an exact persisted assistant id ending in an underscore', async () => {
      mockMessages = [
        {
          messageId: 'persisted-assistant_',
          parentMessageId: 'user-message',
          isCreatedByUser: false,
        } as TMessage,
      ];
      const { result } = setupServerQueue();

      await act(async () => {
        expect(result.current.steering.queueFromComposer('keep the exact branch')).toBe(true);
        await Promise.resolve();
      });

      expect(mockEnqueueQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({ parentMessageId: 'persisted-assistant_' }),
        expect.any(Object),
      );
      expect(result.current.queue).toEqual([
        expect.objectContaining({ parentMessageId: 'persisted-assistant_' }),
      ]);
    });

    it('applies an admitted POST replay to the consumed predecessor set', async () => {
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        options.onSuccess({
          ...input,
          queuedTurnId: 'server-admitted-replay',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
          revision: 1,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        });
      });
      const { result } = setupServerQueue(
        withActiveGeneration(({ set }) => {
          set(store.queuedMessagesByConvoId(CONVO_ID), [
            {
              id: 'unrelated-server-row',
              clientRequestId: 'unrelated-request',
              text: 'keep me',
              createdAt: 50,
              server: { id: 'unrelated-server-id', status: 'queued', revision: 1 },
            },
          ]);
        }),
      );

      await act(async () => {
        result.current.steering.queueFromComposer('already admitted');
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.settledReceipts).toEqual([
          {
            clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
            status: 'admitted',
            effectivePredecessorCreatedAt: 41,
          },
        ]),
      );
      expect(result.current.queue).toEqual([
        expect.objectContaining({ id: 'unrelated-server-row', text: 'keep me' }),
      ]);
    });

    it('keeps an old-server admitted receipt uncertain until its exact boundary is known', async () => {
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        options.onSuccess({
          ...input,
          queuedTurnId: 'legacy-admitted-replay',
          status: 'admitted',
          revision: 1,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        });
      });
      const { result } = setupServerQueue();

      await act(async () => {
        result.current.steering.queueFromComposer('await exact admission boundary');
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.queue).toEqual([
          expect.objectContaining({
            text: 'await exact admission boundary',
            clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
            server: expect.objectContaining({
              id: 'legacy-admitted-replay',
              status: 'uncertain',
            }),
          }),
        ]),
      );
      expect(result.current.settledReceipts).toEqual([]);
      expect(mockUseAgentQueuedTurns.mock.calls.at(-1)?.[2]).toEqual([
        result.current.queue[0].clientRequestId,
      ]);
    });

    it('does not let a stale queued POST erase incomplete admission evidence', async () => {
      let releaseQueuedPost = () => undefined;
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        releaseQueuedPost = () =>
          options.onSuccess({
            ...input,
            queuedTurnId: 'legacy-admitted-race',
            status: 'queued',
            revision: 1,
            createdAt: new Date(100).toISOString(),
            updatedAt: new Date(100).toISOString(),
          });
      });
      const rendered = setupServerQueue();

      await act(async () => {
        rendered.result.current.steering.queueFromComposer('hold incomplete admission');
        await Promise.resolve();
      });
      await waitFor(() => expect(mockEnqueueQueuedTurn).toHaveBeenCalledTimes(1));
      const input = mockEnqueueQueuedTurn.mock.calls[0][0];
      mockServerQueuedTurns = [
        {
          ...input,
          queuedTurnId: 'legacy-admitted-race',
          status: 'admitted',
          revision: 2,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      rendered.rerender();

      await waitFor(() =>
        expect(rendered.result.current.queue[0].server).toMatchObject({
          id: 'legacy-admitted-race',
          status: 'uncertain',
        }),
      );
      expect(rendered.result.current.settledReceipts).toEqual([
        { clientRequestId: input.clientRequestId, status: 'admitted_pending_boundary' },
      ]);

      await act(async () => {
        releaseQueuedPost();
        await Promise.resolve();
      });
      expect(rendered.result.current.queue).toHaveLength(1);
      expect(rendered.result.current.queue[0].server).toMatchObject({
        id: 'legacy-admitted-race',
        status: 'uncertain',
      });
      expect(rendered.result.current.pendingEnqueueIds).toEqual([]);
      expect(rendered.result.current.settledReceipts).toEqual([]);
    });

    it('does not let a stale queued POST response resurrect a terminal receipt', async () => {
      let releaseQueuedPost = () => undefined;
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        releaseQueuedPost = () =>
          options.onSuccess({
            ...input,
            queuedTurnId: 'server-stale-post',
            status: 'queued',
            revision: 1,
            createdAt: new Date(100).toISOString(),
            updatedAt: new Date(100).toISOString(),
          });
      });
      const rendered = setupServerQueue();

      await act(async () => {
        rendered.result.current.steering.queueFromComposer('settle before POST returns');
        await Promise.resolve();
      });
      await waitFor(() => expect(mockEnqueueQueuedTurn).toHaveBeenCalledTimes(1));
      const input = mockEnqueueQueuedTurn.mock.calls[0][0];
      mockServerQueuedTurns = [
        {
          ...input,
          queuedTurnId: 'server-terminal-get',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
          revision: 2,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      rendered.rerender();

      await waitFor(() => expect(rendered.result.current.queue).toEqual([]));
      await act(async () => {
        releaseQueuedPost();
        await Promise.resolve();
      });

      expect(rendered.result.current.queue).toEqual([]);
      expect(rendered.result.current.settledReceipts).toEqual([
        {
          clientRequestId: input.clientRequestId,
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    it('does not let a stale queued POST response resurrect a cancelled row', async () => {
      let releaseQueuedPost = () => undefined;
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        releaseQueuedPost = () =>
          options.onSuccess({
            ...input,
            queuedTurnId: 'server-cancel-race',
            status: 'queued',
            revision: 1,
            createdAt: new Date(100).toISOString(),
            updatedAt: new Date(100).toISOString(),
          });
      });
      const rendered = setupServerQueue();

      await act(async () => {
        rendered.result.current.steering.queueFromComposer('cancel before POST returns');
        await Promise.resolve();
      });
      await waitFor(() => expect(mockEnqueueQueuedTurn).toHaveBeenCalledTimes(1));
      const input = mockEnqueueQueuedTurn.mock.calls[0][0];
      mockServerQueuedTurns = [
        {
          ...input,
          queuedTurnId: 'server-cancel-race',
          status: 'queued',
          revision: 2,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      rendered.rerender();
      await waitFor(() =>
        expect(rendered.result.current.queue[0].server?.id).toBe('server-cancel-race'),
      );
      mockCancelQueuedTurn.mockResolvedValueOnce({
        ...input,
        queuedTurnId: 'server-cancel-race',
        status: 'cancelled',
        revision: 3,
        createdAt: new Date(100).toISOString(),
        updatedAt: new Date(300).toISOString(),
      });

      await act(async () => {
        await rendered.result.current.steering.discardQueued(rendered.result.current.queue[0]);
      });
      expect(rendered.result.current.queue[0].server).toBeUndefined();
      expect(rendered.result.current.settledReceipts).toEqual([
        { clientRequestId: input.clientRequestId, status: 'cancelled' },
      ]);

      await act(async () => {
        releaseQueuedPost();
        await Promise.resolve();
      });
      expect(rendered.result.current.queue).toEqual([
        expect.objectContaining({
          text: 'cancel before POST returns',
          clientRequestId: input.clientRequestId,
        }),
      ]);
      expect(rendered.result.current.queue[0].server).toBeUndefined();
      expect(rendered.result.current.pendingEnqueueIds).toEqual([]);
      expect(rendered.result.current.settledReceipts).toEqual([]);
    });

    it('does not let a stale queued POST response replace a definitive dead snapshot', async () => {
      let releaseQueuedPost = () => undefined;
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        releaseQueuedPost = () =>
          options.onSuccess({
            ...input,
            queuedTurnId: 'server-dead-race',
            status: 'queued',
            revision: 1,
            createdAt: new Date(100).toISOString(),
            updatedAt: new Date(100).toISOString(),
          });
      });
      const rendered = setupServerQueue();

      await act(async () => {
        rendered.result.current.steering.queueFromComposer('fail before POST returns');
        await Promise.resolve();
      });
      await waitFor(() => expect(mockEnqueueQueuedTurn).toHaveBeenCalledTimes(1));
      const input = mockEnqueueQueuedTurn.mock.calls[0][0];
      mockServerQueuedTurns = [
        {
          ...input,
          queuedTurnId: 'server-dead-race',
          status: 'dead',
          revision: 2,
          failure: { code: 'PREDECESSOR_ABORTED', message: 'The predecessor aborted' },
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      rendered.rerender();

      await waitFor(() =>
        expect(rendered.result.current.queue[0].server).toMatchObject({
          id: 'server-dead-race',
          status: 'rejected',
          errorCode: 'PREDECESSOR_ABORTED',
        }),
      );
      expect(rendered.result.current.settledReceipts).toEqual([
        { clientRequestId: input.clientRequestId, status: 'dead' },
      ]);

      await act(async () => {
        releaseQueuedPost();
        await Promise.resolve();
      });
      expect(rendered.result.current.queue).toHaveLength(1);
      expect(rendered.result.current.queue[0].server).toMatchObject({
        id: 'server-dead-race',
        status: 'rejected',
        errorCode: 'PREDECESSOR_ABORTED',
      });
      expect(rendered.result.current.pendingEnqueueIds).toEqual([]);
      expect(rendered.result.current.settledReceipts).toEqual([]);
    });

    it('does not let a stale queued POST replace indeterminate GET evidence', async () => {
      let releaseQueuedPost = () => undefined;
      mockEnqueueQueuedTurn.mockImplementation((input, options) => {
        releaseQueuedPost = () =>
          options.onSuccess({
            ...input,
            queuedTurnId: 'server-indeterminate-race',
            status: 'queued',
            revision: 1,
            createdAt: new Date(100).toISOString(),
            updatedAt: new Date(100).toISOString(),
          });
      });
      const rendered = setupServerQueue();

      await act(async () => {
        rendered.result.current.steering.queueFromComposer('unknown before POST returns');
        await Promise.resolve();
      });
      await waitFor(() => expect(mockEnqueueQueuedTurn).toHaveBeenCalledTimes(1));
      const input = mockEnqueueQueuedTurn.mock.calls[0][0];
      mockServerQueuedTurns = [
        {
          ...input,
          queuedTurnId: 'server-indeterminate-race',
          status: 'claimed',
          revision: 2,
          failure: { code: 'ADMISSION_INDETERMINATE' },
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      rendered.rerender();

      await waitFor(() =>
        expect(rendered.result.current.queue[0].server).toMatchObject({
          id: 'server-indeterminate-race',
          status: 'indeterminate',
          revision: 2,
        }),
      );
      expect(rendered.result.current.settledReceipts).toEqual([
        { clientRequestId: input.clientRequestId, status: 'indeterminate' },
      ]);

      await act(async () => {
        releaseQueuedPost();
        await Promise.resolve();
      });
      expect(rendered.result.current.queue[0].server).toMatchObject({
        id: 'server-indeterminate-race',
        status: 'indeterminate',
        revision: 2,
      });
      expect(rendered.result.current.pendingEnqueueIds).toEqual([]);
      expect(rendered.result.current.settledReceipts).toEqual([]);
    });

    it('anchors enqueue to the selected branch tail instead of a later hidden sibling', async () => {
      mockMessages = [
        {
          messageId: 'visible-assistant-tail',
          isCreatedByUser: false,
          content: [],
        } as unknown as TMessage,
        {
          messageId: 'hidden-later-sibling',
          isCreatedByUser: false,
          content: [],
        } as unknown as TMessage,
      ];
      mockLatestMessage = mockMessages[0];
      const { result } = setupServerQueue();

      await act(async () => {
        result.current.steering.queueFromComposer('stay on the visible branch');
        await Promise.resolve();
      });

      expect(mockEnqueueQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({ parentMessageId: 'visible-assistant-tail' }),
        expect.any(Object),
      );
    });

    it.each([404, 501])('falls back to the legacy local queue on definite %s', async (status) => {
      mockEnqueueQueuedTurn.mockImplementation((_input, options) => {
        options.onError({ response: { status } });
      });
      const { result } = setupServerQueue();

      await act(async () => {
        result.current.steering.queueFromComposer('legacy fallback');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.queue).toEqual([
          expect.objectContaining({ text: 'legacy fallback' }),
        ]);
        expect(result.current.queue[0].server).toBeUndefined();
        expect(result.current.queue[0].clientRequestId).toBeUndefined();
      });
    });

    it('never converts an ambiguous enqueue failure into a client-drained row', async () => {
      mockEnqueueQueuedTurn.mockImplementation((_input, options) => {
        options.onError(Object.assign(new Error('connection reset'), { code: 'ERR_NETWORK' }));
      });
      const { result } = setupServerQueue();

      await act(async () => {
        result.current.steering.queueFromComposer('outcome unknown');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.queue[0]).toMatchObject({
          text: 'outcome unknown',
          server: { status: 'uncertain', uncertainSince: expect.any(Number) },
        });
        expect(result.current.queue[0].clientRequestId).toEqual(
          expect.stringMatching(UUID_V4_PATTERN),
        );
      });
      const clientRequestId = result.current.queue[0].clientRequestId;
      const uncertainSince = result.current.queue[0].server?.uncertainSince;
      expect(mockUseAgentQueuedTurns).toHaveBeenLastCalledWith(
        CONVO_ID,
        true,
        [clientRequestId],
        uncertainSince! + 60_000,
        true,
      );
    });

    it('expires reconciliation as ambiguous instead of making the row resendable', async () => {
      jest.useFakeTimers({ now: 1_000 });
      try {
        mockEnqueueQueuedTurn.mockImplementation((_input, options) => {
          options.onError(Object.assign(new Error('connection reset'), { code: 'ERR_NETWORK' }));
        });
        const { result } = setupServerQueue();

        act(() => {
          result.current.steering.queueFromComposer('outcome remains unknown');
        });
        await act(async () => {
          jest.runAllTicks();
          await Promise.resolve();
        });
        expect(result.current.queue[0]).toMatchObject({ server: { status: 'uncertain' } });
        expect(result.current.queue[0].server).not.toHaveProperty('reconciliationExpired');

        act(() => {
          jest.advanceTimersByTime(60_000);
        });
        expect(result.current.queue[0]).toMatchObject({
          server: { status: 'uncertain', reconciliationExpired: true },
        });
        /** Held for manual recovery only: the projection owes it nothing more,
         *  so the poll no longer stays alive on its account. */
        expect(mockUseAgentQueuedTurns).toHaveBeenLastCalledWith(
          CONVO_ID,
          true,
          [result.current.queue[0].clientRequestId],
          expect.any(Number),
          false,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a definitely rejected enqueue non-drainable but explicitly actionable', async () => {
      mockEnqueueQueuedTurn.mockImplementation((_input, options) => {
        options.onError({ response: { status: 413, data: { code: 'TEXT_TOO_LARGE' } } });
      });
      const { result } = setupServerQueue();

      await act(async () => {
        result.current.steering.queueFromComposer('definitely rejected');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.queue[0]).toMatchObject({
          text: 'definitely rejected',
          server: { status: 'rejected', errorCode: 'TEXT_TOO_LARGE' },
        });
      });

      await act(async () => {
        await expect(result.current.steering.discardQueued(result.current.queue[0])).resolves.toBe(
          true,
        );
      });
      expect(mockCancelQueuedTurn).not.toHaveBeenCalled();
      expect(result.current.queue[0].server).toBeUndefined();
    });

    it('projects the authoritative server snapshot into Recoil', async () => {
      mockFileMap = {
        'stored-doc': {
          llmDeliveryPath: 'text',
        },
      };
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-snapshot-1',
          clientRequestId: 'client-snapshot-1',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'restored after reload',
          files: [{ file_id: 'stored-doc', filename: 'report.pdf', type: 'application/pdf' }],
          status: 'queued',
          revision: 3,
          createdAt: new Date(200).toISOString(),
          updatedAt: new Date(200).toISOString(),
        },
      ];
      const rendered = setupServerQueue();

      await waitFor(() => expect(rendered.result.current.queue).toHaveLength(1));
      expect(rendered.result.current.queue[0]).toMatchObject({
        id: 'client-snapshot-1',
        text: 'restored after reload',
        files: [
          {
            file_id: 'stored-doc',
            filename: 'report.pdf',
            type: 'application/pdf',
            llmDeliveryPath: 'text',
          },
        ],
        server: { id: 'server-snapshot-1', status: 'queued', revision: 3 },
      });
    });

    it('fences the predecessor boundary when the server receipt is admitted', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-admitted-1',
          clientRequestId: 'client-admitted-1',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'already started by the server',
          status: 'admitted',
          revision: 4,
          expectedPredecessorCreatedAt: 41,
          effectivePredecessorCreatedAt: 42,
          createdAt: new Date(200).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      const { result } = setupServerQueue();

      await waitFor(() =>
        expect(result.current.settledReceipts).toEqual([
          {
            clientRequestId: 'client-admitted-1',
            status: 'admitted',
            effectivePredecessorCreatedAt: 42,
          },
        ]),
      );
      expect(result.current.queue).toEqual([]);
    });

    it('settles an explicit root admission without waiting for a timestamp boundary', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-root-admitted',
          clientRequestId: 'client-root-admitted',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'started from the conversation root',
          status: 'admitted',
          revision: 4,
          rootPredecessor: true,
          createdAt: new Date(200).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      const { result } = setupServerQueue();

      await waitFor(() => expect(result.current.queue).toEqual([]));
      expect(result.current.settledReceipts).toEqual([]);
    });

    it('keeps the terminal boundary when an old-server admission lacks its exact fence', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-admitted-race',
          clientRequestId: 'client-admitted-race',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'server-owned successor',
          status: 'admitted',
          revision: 4,
          expectedPredecessorCreatedAt: 41,
          createdAt: new Date(200).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      const ask = jest.fn();
      const sendNow = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot
          initializeState={withActiveGeneration(({ set }) => {
            set(store.isSubmittingFamily(0), false);
            set(store.runEndByIndex(0), {
              conversationId: CONVO_ID,
              outcome: 'completed',
              endedAt: 200,
              generationCreatedAt: 41,
            });
            set(store.queuedMessagesByConvoId(CONVO_ID), [
              {
                id: 'client-admitted-race',
                clientRequestId: 'client-admitted-race',
                text: 'server-owned successor',
                createdAt: 100,
                server: { id: 'server-admitted-race', status: 'claimed', revision: 3 },
              },
              { id: 'local-successor', text: 'must wait', createdAt: 101 },
            ]);
          })}
        >
          {children}
        </RecoilRoot>
      );
      const { result } = renderHook(
        () => {
          useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: false,
            answerModeActive: false,
            sendNow,
            stopGenerating: jest.fn(),
          });
          useQueueDrain(0, CONVO_ID, ask);
          return {
            queue: useQueue(CONVO_ID),
            runEnd: useRecoilValue(store.runEndByIndex(0)),
          };
        },
        { wrapper },
      );

      await waitFor(() =>
        expect(result.current.queue[0]).toMatchObject({
          id: 'client-admitted-race',
          server: { id: 'server-admitted-race', status: 'uncertain' },
        }),
      );
      expect(result.current.runEnd).not.toBeNull();
      expect(result.current.queue.map((item) => item.id)).toEqual([
        'client-admitted-race',
        'local-successor',
      ]);
      expect(ask).not.toHaveBeenCalled();
      expect(sendNow).not.toHaveBeenCalled();
    });

    it('uses server sequence instead of Mongo timestamps for projected queue order', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-second',
          clientRequestId: 'client-second',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'second',
          status: 'queued',
          position: 2,
          revision: 20,
          createdAt: new Date(100).toISOString(),
          updatedAt: new Date(100).toISOString(),
        },
        {
          queuedTurnId: 'server-first',
          clientRequestId: 'client-first',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'first',
          status: 'queued',
          position: 1,
          revision: 10,
          createdAt: new Date(300).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      const { result } = setupServerQueue();

      await waitFor(() => expect(result.current.queue).toHaveLength(2));
      expect(result.current.queue.map((item) => item.text)).toEqual(['first', 'second']);
      expect(result.current.queue.map((item) => item.server?.position)).toEqual([1, 2]);
    });

    it('keeps dead work recoverable and dismisses its durable record before local control', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-dead-1',
          clientRequestId: 'client-dead-1',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'recover this failed turn',
          status: 'dead',
          revision: 4,
          failure: { code: 'ADMISSION_FAILED', message: 'The run could not be admitted' },
          createdAt: new Date(250).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      mockCancelQueuedTurn.mockResolvedValueOnce({ status: 'cancelled' });
      const rendered = setupServerQueue();

      await waitFor(() => expect(rendered.result.current.queue).toHaveLength(1));
      expect(rendered.result.current.queue[0]).toMatchObject({
        text: 'recover this failed turn',
        server: {
          id: 'server-dead-1',
          status: 'rejected',
          errorCode: 'ADMISSION_FAILED',
          errorMessage: 'The run could not be admitted',
        },
      });

      await act(async () => {
        await expect(
          rendered.result.current.steering.discardQueued(rendered.result.current.queue[0]),
        ).resolves.toBe(true);
      });
      expect(mockCancelQueuedTurn).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        queuedTurnId: 'server-dead-1',
      });
      expect(rendered.result.current.queue[0].server).toBeUndefined();
    });

    it('projects an indeterminate claim as non-progressing reconciliation work', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-indeterminate-1',
          clientRequestId: 'client-indeterminate-1',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'external result is unknown',
          status: 'claimed',
          revision: 4,
          failure: {
            code: 'ADMISSION_INDETERMINATE',
            message: 'Awaiting exact source evidence',
          },
          createdAt: new Date(250).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      const rendered = setupServerQueue();

      await waitFor(() => expect(rendered.result.current.queue).toHaveLength(1));
      expect(rendered.result.current.queue[0]).toMatchObject({
        text: 'external result is unknown',
        server: {
          id: 'server-indeterminate-1',
          status: 'indeterminate',
          errorCode: 'ADMISSION_INDETERMINATE',
          errorMessage: 'Awaiting exact source evidence',
        },
      });
      expect(rendered.result.current.settledReceipts).toEqual([]);
    });

    it('cancels the durable copy before downgrading a row to local control', async () => {
      mockServerQueuedTurns = [
        {
          queuedTurnId: 'server-cancel-1',
          clientRequestId: 'client-cancel-1',
          conversationId: CONVO_ID,
          parentMessageId: 'visible-assistant-tail',
          text: 'edit after cancel',
          status: 'queued',
          revision: 1,
          createdAt: new Date(300).toISOString(),
          updatedAt: new Date(300).toISOString(),
        },
      ];
      mockCancelQueuedTurn.mockResolvedValueOnce({ status: 'cancelled' });
      const { result } = setupServerQueue();

      await waitFor(() => expect(result.current.queue).toHaveLength(1));
      let discarded = false;
      await act(async () => {
        discarded = await result.current.steering.discardQueued(result.current.queue[0]);
      });

      expect(discarded).toBe(true);
      expect(mockCancelQueuedTurn).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        queuedTurnId: 'server-cancel-1',
      });
      expect(result.current.queue[0]).toMatchObject({
        text: 'edit after cancel',
        clientRequestId: 'client-cancel-1',
      });
      expect(result.current.queue[0].server).toBeUndefined();
    });
  });

  describe('queueReclaimedSteer', () => {
    const reclaimed = {
      steerId: 's-reclaimed',
      text: 'reclaimed words',
      status: 'pending' as const,
      createdAt: 1_000,
    };

    /** The run-end signal `useQueueDrain` consumes; seeded here to stand for a
     *  run that already finished by the time a reclaim resolved. */
    const runEnd = (outcome: 'completed' | 'aborted' | 'error', conversationId = CONVO_ID) => ({
      conversationId,
      outcome,
      endedAt: 2_000,
    });

    function setupWithQueue(
      params: HookParams = {},
      initialize?: (snapshot: MutableSnapshot) => void,
    ) {
      const sendNow = jest.fn();
      const stopGenerating = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot initializeState={withActiveGeneration(initialize)}>{children}</RecoilRoot>
      );
      const rendered = renderHook(
        () => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            sendNow,
            stopGenerating,
            ...params,
          }),
          queue: useQueue(CONVO_ID),
          /** What `useQueueDrain` watches: re-posting it is how this hook asks
           *  the drain to reconsider a queue it already passed over. */
          parkedRunEnd: useRecoilValue(store.pendingRunEndByConvoId(CONVO_ID)),
          /** Stands in for the drain CONSUMING a signal it has acted on. */
          consumeIndexSignal: useSetRecoilState(store.runEndByIndex(0)),
          consumeParkedSignal: useSetRecoilState(store.pendingRunEndByConvoId(CONVO_ID)),
        }),
        { wrapper },
      );
      return { ...rendered, sendNow };
    }

    it('keeps the steer ahead of a follow-up queued after it', () => {
      // The steer was accepted BEFORE the follow-up, so it must drain first.
      // Minting a fresh id/createdAt here would sort it last.
      const { result } = setupWithQueue();
      act(() => {
        result.current.steering.enqueue('queued later', {});
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(result.current.queue.map((item) => item.text)).toEqual([
        'reclaimed words',
        'queued later',
      ]);
      // The original identity survives, which is what the ordering rests on.
      expect(result.current.queue[0].id).toBe('s-reclaimed');
      expect(result.current.queue[0].createdAt).toBe(1_000);
    });

    it('leaves the item to the drain while the run is still going', () => {
      const { result, sendNow } = setupWithQueue({ isSubmitting: true });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(sendNow).not.toHaveBeenCalled();
      // The run's own end is still ahead of this item and will drain it, so
      // nothing needs re-arming.
      expect(result.current.parkedRunEnd).toBeNull();
      expect(result.current.queue).toHaveLength(1);
    });

    it('re-arms the drain when the run completed cleanly while the reclaim was in flight', () => {
      // The drain already consumed its one-shot signal against an empty queue,
      // so re-post it: the DRAIN sends (FIFO, via `ask`, which does not reset
      // the composer), never this hook.
      const { result, sendNow } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.runEndByIndex(0), runEnd('completed'));
      });
      act(() => {
        // The drain ran against an empty queue and consumed the signal; the
        // outcome was already captured during render.
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(result.current.parkedRunEnd).toMatchObject({
        conversationId: CONVO_ID,
        outcome: 'completed',
      });
      // The item stays queued for the drain to pick up in its turn.
      expect(result.current.queue.map((item) => item.id)).toEqual(['s-reclaimed']);
      expect(sendNow).not.toHaveBeenCalled();
    });

    it('re-arms from a run-end parked while the user was in another chat', () => {
      // The run finished with this conversation off-screen, so its signal was
      // parked rather than delivered on the index. Without watching the parked
      // carrier too, the outcome would never be seen and the item would strand.
      const { result } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.pendingRunEndByConvoId(CONVO_ID), runEnd('completed'));
      });
      act(() => {
        result.current.consumeParkedSignal(null);
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(result.current.parkedRunEnd).toMatchObject({
        outcome: 'completed',
      });
      expect(result.current.queue.map((item) => item.id)).toEqual(['s-reclaimed']);
    });

    it.each(['aborted', 'error'] as const)(
      'leaves the item for manual send when the run %s',
      (outcome) => {
        // The drain auto-sends only on a clean completion: a Stop or an error
        // means the user is taking over, so nothing may smuggle the text out.
        const { result, sendNow } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
          set(store.runEndByIndex(0), runEnd(outcome));
        });
        act(() => {
          result.current.consumeIndexSignal(null);
        });
        act(() => {
          result.current.steering.queueReclaimedSteer(reclaimed);
        });
        expect(sendNow).not.toHaveBeenCalled();
        expect(result.current.parkedRunEnd).toBeNull();
        expect(result.current.queue.map((item) => item.id)).toEqual(['s-reclaimed']);
      },
    );

    it('leaves the item for manual send when the completed run was another chat', () => {
      const { result, sendNow } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.runEndByIndex(0), runEnd('completed', 'convo-elsewhere'));
      });
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(sendNow).not.toHaveBeenCalled();
      expect(result.current.parkedRunEnd).toBeNull();
      expect(result.current.queue).toHaveLength(1);
    });

    it('keeps older queued follow-ups ahead of the reclaimed steer', () => {
      // The drain sends ONE item per run end, FIFO. Re-arming (rather than
      // sending here) is what keeps an older follow-up from being skipped.
      const { result } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.runEndByIndex(0), runEnd('completed'));
        set(store.queuedMessagesByConvoId(CONVO_ID), [
          { id: 'older', text: 'queued first', createdAt: 500 },
        ]);
      });
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(result.current.queue.map((item) => item.id)).toEqual(['older', 's-reclaimed']);
    });

    it('does not re-arm while this conversation’s run-end is still unconsumed', () => {
      // The drain has not run yet, so it will see this item on its own. Arming
      // a second carrier would drain twice and send two messages.
      const { result } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.pendingRunEndByConvoId(CONVO_ID), runEnd('completed'));
        set(store.runEndByIndex(0), runEnd('completed'));
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      // Untouched: the already-armed signal drains it.
      expect(result.current.parkedRunEnd).toMatchObject({
        outcome: 'completed',
      });
      expect(result.current.queue.map((item) => item.id)).toEqual(['s-reclaimed']);
    });

    /** Renders the hook so the chat it points at can change under it, the way
     *  ChatForm reuses it when the user navigates. */
    function setupNavigable(
      initialProps: { convoId: string; isSubmitting: boolean },
      initialize?: (snapshot: MutableSnapshot) => void,
    ) {
      const sendNow = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot initializeState={withActiveGeneration(initialize)}>{children}</RecoilRoot>
      );
      const rendered = renderHook(
        ({ convoId, isSubmitting }: { convoId: string; isSubmitting: boolean }) => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: convoId,
            conversation: agentsConversation,
            isSubmitting,
            answerModeActive: false,
            sendNow,
            stopGenerating: jest.fn(),
          }),
          parkedHere: useRecoilValue(store.pendingRunEndByConvoId(CONVO_ID)),
          queueHere: useQueue(CONVO_ID),
          /** Stands in for the drain CONSUMING a signal it has acted on. */
          consumeIndexSignal: useSetRecoilState(store.runEndByIndex(0)),
        }),
        { wrapper, initialProps },
      );
      return { ...rendered, sendNow };
    }

    it('still re-arms the origin chat after the user navigates away', () => {
      // Navigating away does not make the words any less owed a send: the run
      // they belong to completed, so its queue must still drain on return.
      const { result, rerender, sendNow } = setupNavigable(
        { convoId: CONVO_ID, isSubmitting: false },
        ({ set }) => {
          set(store.runEndByIndex(0), runEnd('completed'));
        },
      );
      // Captured while still on this chat, resolving after the user left.
      const queueReclaimed = result.current.steering.queueReclaimedSteer;
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        rerender({ convoId: 'convo-elsewhere', isSubmitting: false });
      });
      act(() => {
        queueReclaimed(reclaimed);
      });

      expect(result.current.parkedHere).toMatchObject({
        conversationId: CONVO_ID,
        outcome: 'completed',
      });
      expect(result.current.queueHere.map((item) => item.id)).toEqual(['s-reclaimed']);
      expect(sendNow).not.toHaveBeenCalled();
    });

    it('re-arms the origin completion when a delayed refusal lands off-screen', () => {
      let rejectSteer: ((error: unknown) => void) | undefined;
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        rejectSteer = onError;
      });
      const { result, rerender, sendNow } = setupNavigable({
        convoId: CONVO_ID,
        isSubmitting: true,
      });

      act(() => {
        result.current.steering.submitSteer('refused after navigation');
      });
      // The origin run completes and its empty-queue drain consumes the signal
      // before the POST response arrives.
      act(() => {
        result.current.consumeIndexSignal(runEnd('completed'));
      });
      act(() => {
        rerender({ convoId: CONVO_ID, isSubmitting: false });
      });
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        rerender({ convoId: 'convo-elsewhere', isSubmitting: false });
      });
      act(() => {
        rejectSteer?.({
          response: { status: 409, data: { code: 'RUN_PAUSED' } },
        });
      });

      expect(result.current.queueHere).toEqual([
        expect.objectContaining({ text: 'refused after navigation' }),
      ]);
      expect(result.current.parkedHere).toMatchObject({
        conversationId: CONVO_ID,
        outcome: 'completed',
      });
      expect(sendNow).not.toHaveBeenCalled();
    });

    it('never parks another chat’s run-end under this conversation', () => {
      // The run-end is keyed by conversation, so the new chat's end can never
      // be mistaken for this one's. Parking it here would give `drainNext` a
      // foreign `end.conversationId` and drain the wrong queue into this chat.
      const { result, rerender } = setupNavigable({
        convoId: CONVO_ID,
        isSubmitting: true,
      });
      const queueReclaimed = result.current.steering.queueReclaimedSteer;
      act(() => {
        // The user leaves for a chat whose own run then completes.
        rerender({ convoId: 'convo-elsewhere', isSubmitting: false });
      });
      act(() => {
        result.current.consumeIndexSignal(runEnd('completed', 'convo-elsewhere'));
      });
      act(() => {
        queueReclaimed(reclaimed);
      });

      expect(result.current.parkedHere).toBeNull();
      expect(result.current.queueHere.map((item) => item.id)).toEqual(['s-reclaimed']);
    });

    it('does not re-arm from the end of an earlier run of the same chat', () => {
      // A stale end must not authorize a drain: this chat's NEXT run is what
      // owns the item, and its own end will drain it.
      const { result, rerender } = setupNavigable(
        { convoId: CONVO_ID, isSubmitting: false },
        ({ set }) => {
          set(store.runEndByIndex(0), runEnd('completed'));
        },
      );
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        // A new run starts on this same chat, superseding that end.
        rerender({ convoId: CONVO_ID, isSubmitting: true });
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });

      expect(result.current.parkedHere).toBeNull();
      expect(result.current.queueHere.map((item) => item.id)).toEqual(['s-reclaimed']);
    });

    it('re-arms even when another conversation’s run-end occupies the index slot', () => {
      // The index slot is shared. The drain parks a foreign signal under ITS
      // conversation and then only inspects the active one's queue, so treating
      // it as proof of an upcoming drain would strand this item.
      const { result } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.runEndByIndex(0), runEnd('completed'));
      });
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        // A later run on the shared index slot, belonging to a different chat.
        result.current.consumeIndexSignal(runEnd('completed', 'convo-elsewhere'));
      });
      act(() => {
        result.current.steering.queueReclaimedSteer(reclaimed);
      });
      expect(result.current.parkedRunEnd).toMatchObject({
        conversationId: CONVO_ID,
        outcome: 'completed',
      });
      expect(result.current.queue.map((item) => item.id)).toEqual(['s-reclaimed']);
    });

    it('re-arms a consumed completion drain when receipt replay recovers a leftover', () => {
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 's-receipt-leftover',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
          settled: true,
          leftover: true,
          replayed: true,
          generationProtocolVersion: 2,
        });
      });
      const { result } = setupWithQueue({ isSubmitting: false }, ({ set }) => {
        set(store.runEndByIndex(0), runEnd('completed'));
      });
      act(() => {
        result.current.consumeIndexSignal(null);
      });
      act(() => {
        result.current.steering.submitSteer('recovered after drain');
      });

      expect(result.current.queue).toEqual([
        expect.objectContaining({
          id: 's-receipt-leftover',
          text: 'recovered after drain',
        }),
      ]);
      expect(result.current.parkedRunEnd).toMatchObject({
        conversationId: CONVO_ID,
        outcome: 'completed',
      });
    });
  });

  describe('submitDuringRun', () => {
    it('routes to the steer POST with an optimistic sending chip', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      let consumed = false;
      act(() => {
        consumed = result.current.submitDuringRun('steer this');
      });
      expect(consumed).toBe(true);
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: 'steer this',
          clientSteerId: expect.any(String),
        }),
        expect.anything(),
      );
    });

    it('routes to the client queue when the preference is queue', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'queue');
      });
      act(() => {
        result.current.submitDuringRun('after the run');
      });
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('ignores empty submissions', () => {
      // Seed 'steer' so the mockMutate assertion actually exercises the
      // steer path's blank-text guard, not the (now default) queue path.
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      let consumed = true;
      act(() => {
        consumed = result.current.submitDuringRun('   ');
      });
      expect(consumed).toBe(false);
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('steer POST outcomes', () => {
    it('queues on NO_ACTIVE_RUN while the final SSE is still settling', () => {
      // isSubmitting is still true: ask()'s in-flight guard would drop a
      // direct send, so the text must go to the queue for the run-end drain.
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });
      const { result, sendNow } = setup({ isSubmitting: true });
      act(() => {
        result.current.submitSteer('too late');
      });
      expect(sendNow).not.toHaveBeenCalled();
    });

    it('sends as a normal turn on NO_ACTIVE_RUN once submission has settled', () => {
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });
      const { result, sendNow } = setup({ isSubmitting: false });
      act(() => {
        result.current.submitSteer('too late');
      });
      expect(sendNow).toHaveBeenCalledWith(
        'too late',
        [],
        expect.objectContaining({
          expectedPredecessorCreatedAt: 41,
          queuedMessageOrigin: {
            item: expect.objectContaining({
              id: expect.stringMatching(/^local-/),
              text: 'too late',
              createdAt: expect.any(Number),
              expectedPredecessorCreatedAt: 41,
            }),
            beforeIds: [],
            afterIds: [],
          },
        }),
      );
    });

    it('fences a queued-origin fallback and carries its exact restoration slot', () => {
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });
      const queuedOrigin = {
        item: {
          id: 'queued-original',
          text: 'late queued turn',
          createdAt: 10,
        },
        beforeIds: ['queued-before'],
        afterIds: ['queued-after'],
      };
      const { result, sendNow } = setup({ isSubmitting: false });

      act(() => {
        result.current.submitSteer('late queued turn', undefined, undefined, {
          queuedOrigin,
        });
      });

      expect(sendNow).toHaveBeenCalledWith('late queued turn', [], {
        expectedPredecessorCreatedAt: 41,
        queuedMessageOrigin: queuedOrigin,
      });
    });

    it('queues + toasts when the run is paused (RUN_PAUSED)', () => {
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({ response: { data: { code: 'RUN_PAUSED' } } });
      });
      const { result } = setup();
      act(() => {
        result.current.submitSteer('paused steer');
      });
      expect(mockShowToast).toHaveBeenCalled();
    });

    it('never normal-sends into a newer live run on RUN_REPLACED', () => {
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({
          response: {
            data: { code: 'RUN_REPLACED', generationProtocolVersion: 2 },
          },
        });
      });
      const { result, sendNow } = setup({ isSubmitting: false });
      act(() => {
        result.current.submitSteer('wait for the newer run');
      });
      expect(sendNow).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalled();
    });
  });

  describe('interrupt & steer (preempt)', () => {
    it('posts preempt: true and marks the optimistic chip', () => {
      const { result } = setup();
      act(() => {
        result.current.interruptSteer('stop and do this');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'stop and do this', preempt: true }),
        expect.anything(),
      );
    });

    /**
     * Steering needs a server-side job, so `submitSteer` hard-refuses without
     * a real conversationId. Without this fallback the always-visible button
     * would be dead for the whole first turn.
     */
    it('falls back to interruptAndSend before a conversation exists', () => {
      const { result, stopGenerating } = setup({
        conversationId: Constants.NEW_CONVO as string,
      });
      let consumed = false;
      act(() => {
        consumed = result.current.interruptSteer('turn one interrupt');
      });
      expect(consumed).toBe(true);
      expect(mockMutate).not.toHaveBeenCalled();
      expect(stopGenerating).toHaveBeenCalled();
    });

    it('refuses empty text without touching the run', () => {
      const { result, stopGenerating } = setup();
      let consumed = true;
      act(() => {
        consumed = result.current.interruptSteer('   ');
      });
      expect(consumed).toBe(false);
      expect(mockMutate).not.toHaveBeenCalled();
      expect(stopGenerating).not.toHaveBeenCalled();
    });

    /**
     * `canSteer` is false while paused, but routing that into
     * `interruptAndSend` would hard-abort the run and discard the partial
     * answer: the opposite of what the action promises.
     */
    it('refuses while paused on tool approval instead of aborting', () => {
      mockMessages = [
        {
          messageId: 'm1',
          conversationId: CONVO_ID,
          isCreatedByUser: false,
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              [ContentTypes.TOOL_CALL]: {
                id: 'call_1',
                name: 't',
                approval: 'pending',
              },
            },
          ],
        } as unknown as TMessage,
      ];
      const { result, stopGenerating } = setup();
      let consumed = true;
      act(() => {
        consumed = result.current.interruptSteer('do not abort me');
      });
      mockMessages = undefined;

      expect(consumed).toBe(false);
      expect(stopGenerating).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });

    /**
     * The explicit Steer row and the Ctrl/Cmd+Enter alternate must stay
     * non-preempting, or they become indistinguishable from Interrupt & steer.
     */
    it('leaves the explicit Steer action non-preempting even with the preference on', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.steerInterruptsByDefault, true);
      });
      act(() => {
        result.current.steerFromComposer('explicit steer row');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.not.objectContaining({ preempt: true }),
        expect.anything(),
      );
    });

    /* Retry lives in `useSteerRecovery` now, which owns the chip actions the
       thread's pending block renders; its own spec covers the preempt carry. */

    it('an ordinary steer does not preempt by default', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      act(() => {
        result.current.submitDuringRun('just steer');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.not.objectContaining({ preempt: true }),
        expect.anything(),
      );
    });

    it('steerInterruptsByDefault makes the default Enter route preempt', () => {
      const { result } = setup({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
        set(store.steerInterruptsByDefault, true);
      });
      act(() => {
        result.current.submitDuringRun('enter should interrupt');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ preempt: true }),
        expect.anything(),
      );
    });

    /**
     * Capability degradation is a relabel, never an error: the server echoes
     * what it actually armed and the chip follows it.
     */
    it('honours a server echo of preempt: false on the ACK', () => {
      mockMutate.mockImplementation((_params, { onSuccess }) => {
        onSuccess({
          status: 'queued',
          steerId: 'server-1',
          position: 1,
          conversationId: CONVO_ID,
          preempt: false,
        });
      });
      const { result } = setup();
      act(() => {
        result.current.interruptSteer('interrupt me');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ preempt: true }),
        expect.anything(),
      );
    });

    it('serializes rapid steer POSTs in submission order', () => {
      const acknowledge: Array<(serverId: string) => void> = [];
      mockMutate.mockImplementation((params, { onSuccess }) => {
        acknowledge.push((serverId) =>
          onSuccess({
            status: 'queued',
            steerId: serverId,
            position: 1,
            conversationId: params.conversationId,
          }),
        );
      });
      const { result } = setup();
      act(() => {
        result.current.interruptSteer('first');
        result.current.interruptSteer('second');
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'first',
          preempt: true,
          generationCreatedAt: 41,
        }),
        expect.anything(),
      );

      act(() => {
        acknowledge[0]('server-first');
      });

      expect(mockMutate).toHaveBeenCalledTimes(2);
      expect(mockMutate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: 'second',
          preempt: true,
          generationCreatedAt: 41,
        }),
        expect.anything(),
      );

      act(() => {
        acknowledge[1]('server-second');
        result.current.interruptSteer('third');
      });
      expect(mockMutate).toHaveBeenCalledTimes(3);
      expect(mockMutate).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          text: 'third',
          preempt: true,
          generationCreatedAt: 41,
        }),
        expect.anything(),
      );
    });

    it('keeps different conversations dispatching in parallel', () => {
      const otherConversationId = 'convo-steer-ui-other';
      const acknowledge: Array<(serverId: string) => void> = [];
      mockMutate.mockImplementation((params, { onSuccess }) => {
        acknowledge.push((serverId) =>
          onSuccess({
            status: 'queued',
            steerId: serverId,
            position: 1,
            conversationId: params.conversationId,
          }),
        );
      });
      const sendNow = jest.fn();
      const stopGenerating = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), 41);
            set(store.activeGenerationProtocolVersionByConvoId(CONVO_ID), 2);
            set(store.activeGenerationCreatedAtByConvoId(otherConversationId), 42);
            set(store.activeGenerationProtocolVersionByConvoId(otherConversationId), 2);
          }}
        >
          {children}
        </RecoilRoot>
      );
      const { result, rerender } = renderHook(
        ({ conversationId }: { conversationId: string }) =>
          useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId,
            conversation: {
              ...agentsConversation,
              conversationId,
            } as TConversation,
            isSubmitting: true,
            answerModeActive: false,
            sendNow,
            stopGenerating,
          }),
        { initialProps: { conversationId: CONVO_ID }, wrapper },
      );

      act(() => {
        result.current.submitSteer('first conversation');
      });
      rerender({ conversationId: otherConversationId });
      act(() => {
        result.current.submitSteer('second conversation');
      });

      expect(mockMutate).toHaveBeenCalledTimes(2);
      expect(mockMutate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: 'first conversation',
        }),
        expect.anything(),
      );
      expect(mockMutate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          conversationId: otherConversationId,
          text: 'second conversation',
        }),
        expect.anything(),
      );

      act(() => {
        acknowledge[0]('server-first-conversation');
        acknowledge[1]('server-second-conversation');
      });
    });
  });

  describe('interruptAndSend + queue helpers', () => {
    function setupWithState(
      params: HookParams = {},
      initialize?: (snapshot: MutableSnapshot) => void,
    ) {
      const sendNow = jest.fn();
      const stopGenerating = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot initializeState={withActiveGeneration(initialize)}>{children}</RecoilRoot>
      );
      const rendered = renderHook(
        () => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            sendNow,
            stopGenerating,
            ...params,
          }),
          queue: useQueue(CONVO_ID),
          setQueue: useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID)),
          setActiveEpoch: useSetRecoilState(store.activeGenerationCreatedAtByConvoId(CONVO_ID)),
          setActiveProtocol: useSetRecoilState(
            store.activeGenerationProtocolVersionByConvoId(CONVO_ID),
          ),
          setAcceptedIds: useSetRecoilState(store.acceptedSteerClientIdsByConvoId(CONVO_ID)),
          chips: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
          setAppliedIds: useSetRecoilState(store.appliedSteerIdsByConvoId(CONVO_ID)),
          drainFlag: useRecoilValue(store.drainAfterAbortByIndex(0)),
        }),
        { wrapper },
      );
      return { ...rendered, sendNow, stopGenerating };
    }

    it('drops the ACK chip when FINAL settlement lands before the delayed 202', () => {
      let acknowledge: (() => void) | undefined;
      let clientSteerId = '';
      mockMutate.mockImplementation((params, { onSuccess }) => {
        clientSteerId = params.clientSteerId;
        acknowledge = () =>
          onSuccess({
            steerId: 'srv-1',
            status: 'queued',
            position: 1,
            conversationId: CONVO_ID,
          });
      });
      const { result } = setupWithState();
      act(() => {
        result.current.steering.submitSteer('already injected');
      });
      expect(result.current.chips).toEqual([
        expect.objectContaining({ steerId: clientSteerId, status: 'sending' }),
      ]);
      act(() => {
        result.current.setAppliedIds([clientSteerId, 'srv-1']);
      });
      act(() => {
        acknowledge?.();
      });
      // No pending chip may survive; its only removal event already passed.
      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([]);
    });

    it.each([
      [
        'a definite origin 400',
        { response: { status: 400, data: { code: 'INVALID_STEER' } } },
        false,
      ],
      ['a transport failure', new Error('network disconnected'), true],
    ] as const)('marks delivery uncertainty correctly for %s', (_scenario, error, uncertain) => {
      mockMutate.mockImplementationOnce((_params, { onError }) => onError(error));
      const { result } = setupWithState();

      act(() => {
        result.current.steering.submitSteer('classify the failure');
      });

      expect(result.current.chips).toEqual([
        expect.objectContaining({
          status: 'failed',
          ...(uncertain && { deliveryUncertain: true }),
        }),
      ]);
      if (!uncertain) {
        expect(result.current.chips[0].deliveryUncertain).toBeUndefined();
      }
    });

    it('marks an ambiguous legacy delivery as non-retryable protocol v1', () => {
      mockMutate.mockImplementationOnce((_params, { onError }) =>
        onError(new Error('network disconnected')),
      );
      const { result } = setupWithState({}, ({ set }) => {
        set(store.activeGenerationProtocolVersionByConvoId(CONVO_ID), 1);
      });

      act(() => {
        result.current.steering.submitSteer('legacy ambiguous delivery');
      });

      expect(result.current.chips).toEqual([
        expect.objectContaining({
          status: 'failed',
          deliveryUncertain: true,
          generationProtocolVersion: 1,
        }),
      ]);
    });

    it('converts the ACK chip to pending when the steer is not yet applied', () => {
      mockMutate.mockImplementation((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-2',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      const { result } = setupWithState();
      act(() => {
        result.current.steering.submitSteer('awaiting boundary');
      });
      expect(result.current.chips).toEqual([
        expect.objectContaining({ steerId: 'srv-2', status: 'pending' }),
      ]);
    });

    it('recovers a delayed ACK when a replacement generation is already active', () => {
      let acknowledge: (() => void) | undefined;
      let clientSteerId = '';
      mockMutate.mockImplementation((params, { onSuccess }) => {
        clientSteerId = params.clientSteerId;
        acknowledge = () =>
          onSuccess({
            steerId: 'srv-replaced',
            status: 'queued',
            position: 1,
            conversationId: CONVO_ID,
          });
      });
      const { result } = setupWithState();

      act(() => {
        result.current.steering.submitSteer('accepted by the old generation');
      });
      // The server's correlation update may arrive before both replacement
      // handoff and the delayed HTTP ACK. Acceptance is not proof of delivery.
      act(() => {
        result.current.setAcceptedIds([clientSteerId]);
      });
      act(() => {
        result.current.setActiveEpoch(42);
      });
      act(() => {
        acknowledge?.();
      });

      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          id: 'srv-replaced',
          text: 'accepted by the old generation',
          recoverySteerId: 'srv-replaced',
        }),
      ]);
    });

    it('recovers a delayed ACK after the source generation epoch is cleared', () => {
      let acknowledge: (() => void) | undefined;
      mockMutate.mockImplementation((params, { onSuccess }) => {
        acknowledge = () =>
          onSuccess({
            steerId: 'srv-ended',
            status: 'queued',
            position: 1,
            conversationId: params.conversationId,
          });
      });
      const { result } = setupWithState();

      act(() => {
        result.current.steering.submitSteer('accepted before the epoch cleared');
      });
      act(() => {
        result.current.setActiveEpoch(null);
      });
      act(() => {
        acknowledge?.();
      });

      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          id: 'srv-ended',
          text: 'accepted before the epoch cleared',
          recoverySteerId: 'srv-ended',
        }),
      ]);
    });

    it('fences steer submission and its retry chip to the attached generation epoch', () => {
      mockMutate.mockImplementation((_params, { onError }) => {
        onError({ response: { status: 400, data: { code: 'INVALID_STEER' } } });
      });
      const { result } = setupWithState({}, ({ set }) => {
        set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), 41);
      });

      act(() => {
        result.current.steering.submitSteer('epoch-bound');
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          generationCreatedAt: 41,
        }),
        expect.anything(),
      );
      expect(result.current.chips).toEqual([
        expect.objectContaining({ generationCreatedAt: 41, status: 'failed' }),
      ]);
    });

    it('carries the submit time through the ACK so the pending chip is not re-timestamped', () => {
      // A draft queued during the 202 round-trip must not drain ahead of a
      // steer submitted before it, so the ACK'd chip keeps its SUBMIT time,
      // not the (later) ACK time.
      const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(9_000);
      try {
        mockMutate.mockImplementation((_params, { onSuccess }) => {
          onSuccess({
            steerId: 'srv-t',
            status: 'queued',
            position: 1,
            conversationId: CONVO_ID,
          });
        });
        const { result } = setupWithState();
        act(() => {
          result.current.steering.submitSteer('submitted first');
        });
        expect(result.current.chips).toEqual([
          expect.objectContaining({
            steerId: 'srv-t',
            status: 'pending',
            createdAt: 1_000,
          }),
        ]);
      } finally {
        now.mockRestore();
      }
    });

    it('preserves the original submit time through a same-id receipt retry', () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        mockMutate.mockImplementationOnce((_params, { onError }) => {
          onError(new Error('lost response'));
        });
        const { result } = setupWithState();
        act(() => {
          result.current.steering.submitSteer('retry without reordering');
        });
        const failed = result.current.chips[0];

        now.mockReturnValue(9_000);
        act(() => {
          // A replacement deployment/run may now advertise v1. The receipt
          // still belongs to the v2 source generation captured on the chip.
          result.current.setActiveProtocol(1);
        });
        mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
          onSuccess({
            steerId: 'srv-retry-leftover',
            settled: true,
            leftover: true,
            replayed: true,
            generationProtocolVersion: 2,
          });
        });
        act(() => {
          result.current.steering.retrySteer(failed.steerId, failed.text, failed.files, undefined, {
            createdAt: failed.createdAt,
            generationCreatedAt: failed.generationCreatedAt,
            generationProtocolVersion: failed.generationProtocolVersion,
          });
        });

        expect(result.current.queue).toEqual([
          expect.objectContaining({
            id: 'srv-retry-leftover',
            createdAt: 1_000,
            clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
            recoverySteerId: 'srv-retry-leftover',
          }),
        ]);
      } finally {
        now.mockRestore();
      }
    });

    it('does not duplicate a chip already reseeded under the server id (SSE reconnect)', () => {
      mockMutate.mockImplementation((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-3',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      const { result } = setupWithState({}, ({ set }) => {
        // seedSteerChips already re-minted this chip from resumeState before
        // the 202 ACK landed; the ACK must upsert, not append.
        set(store.pendingSteersByConvoId(CONVO_ID), [
          {
            steerId: 'srv-3',
            text: 'reseeded',
            status: 'pending',
            createdAt: 1,
          },
        ]);
      });
      act(() => {
        result.current.steering.submitSteer('reseeded');
      });
      expect(result.current.chips.filter((chip) => chip.steerId === 'srv-3')).toHaveLength(1);
    });

    it('leaves a queued row untouched while an edit or remove handoff owns it', () => {
      const { result } = setupWithState();
      act(() => {
        result.current.steering.enqueue('claimed handoff');
      });
      const queued = result.current.queue[0];
      expect(claimQueuedIntent(queued.id)).toBe(true);

      try {
        act(() => {
          result.current.steering.sendQueuedNow(queued);
        });
        expect(result.current.queue).toEqual([queued]);
        expect(mockMutate).not.toHaveBeenCalled();
      } finally {
        releaseQueuedIntent(queued.id);
      }
    });

    it('restores the queued item (same id, original slot) when sendNow refuses', () => {
      const refusingSendNow = jest.fn().mockReturnValue(false);
      const { result } = setupWithState({
        isSubmitting: false,
        sendNow: refusingSendNow,
      });
      act(() => {
        result.current.steering.enqueue('refused send');
        result.current.steering.enqueue('still behind');
      });
      const [first, second] = result.current.queue;
      act(() => {
        result.current.steering.sendQueuedNow(first);
      });
      expect(refusingSendNow).toHaveBeenCalledWith('refused send', [], {
        quotes: undefined,
        manualSkills: undefined,
        clientRequestId: undefined,
        recoverySteerId: undefined,
        expectedPredecessorCreatedAt: 41,
        queuedMessageOrigin: {
          item: first,
          beforeIds: [],
          afterIds: [second.id],
        },
      });
      // `ask` refused without sending: the ORIGINAL item returns to its slot.
      expect(result.current.queue.map((item) => item.id)).toEqual([first.id, second.id]);
      expect(result.current.queue[0]).toEqual(first);
    });

    it('queues the steer text+files when a settled NO_ACTIVE_RUN send is refused', () => {
      const steerFiles = [
        {
          file_id: 'file-refused',
          filepath: '/uploads/file-refused.png',
          type: 'image/png',
        },
      ];
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });
      const refusingSendNow = jest.fn().mockReturnValue(false);
      const { result } = setupWithState({
        isSubmitting: false,
        sendNow: refusingSendNow,
      });
      act(() => {
        result.current.steering.submitSteer('refused words', steerFiles);
      });
      expect(refusingSendNow).toHaveBeenCalledWith(
        'refused words',
        steerFiles,
        expect.objectContaining({
          expectedPredecessorCreatedAt: 41,
          queuedMessageOrigin: expect.objectContaining({
            item: expect.objectContaining({
              text: 'refused words',
              files: steerFiles,
            }),
          }),
        }),
      );
      // The chip is already gone: a refused send must land in the queue, not drop.
      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([
        expect.objectContaining({ text: 'refused words', files: steerFiles }),
      ]);
    });

    it('queues the steer text+files when a settled-run rejection send is refused', () => {
      const steerFiles = [
        {
          file_id: 'file-paused',
          filepath: '/uploads/file-paused.png',
          type: 'image/png',
        },
      ];
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'STEER_UNSUPPORTED' } } });
      });
      const refusingSendNow = jest.fn().mockReturnValue(false);
      const { result } = setupWithState({
        isSubmitting: false,
        sendNow: refusingSendNow,
      });
      act(() => {
        result.current.steering.submitSteer('unsupported words', steerFiles);
      });
      expect(refusingSendNow).toHaveBeenCalledWith(
        'unsupported words',
        steerFiles,
        expect.objectContaining({
          expectedPredecessorCreatedAt: 41,
          queuedMessageOrigin: expect.objectContaining({
            item: expect.objectContaining({
              text: 'unsupported words',
              files: steerFiles,
            }),
          }),
        }),
      );
      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          text: 'unsupported words',
          files: steerFiles,
        }),
      ]);
    });

    it('does not restore the queued item when sendNow accepts', () => {
      const acceptingSendNow = jest.fn().mockReturnValue(undefined);
      const { result } = setupWithState({
        isSubmitting: false,
        sendNow: acceptingSendNow,
      });
      act(() => {
        result.current.steering.enqueue('accepted send');
      });
      const queued = result.current.queue[0];
      act(() => {
        result.current.steering.sendQueuedNow(queued);
      });
      expect(acceptingSendNow).toHaveBeenCalledWith('accepted send', [], {
        quotes: undefined,
        manualSkills: undefined,
        clientRequestId: undefined,
        recoverySteerId: undefined,
        expectedPredecessorCreatedAt: 41,
        queuedMessageOrigin: {
          item: queued,
          beforeIds: [],
          afterIds: [],
        },
      });
      expect(result.current.queue).toEqual([]);
    });

    it('leaves a queued item untouched when answer mode owns the submission slot', () => {
      const { result, sendNow } = setupWithState({ answerModeActive: true });
      act(() => {
        result.current.steering.enqueue('wait for the answer');
      });
      const queued = result.current.queue[0];

      expect(result.current.steering.canSendQueuedNow).toBe(false);
      act(() => {
        result.current.steering.sendQueuedNow(queued);
      });

      expect(result.current.queue).toEqual([queued]);
      expect(sendNow).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('does not lose a second queued item clicked before submitting state renders', () => {
      const acceptingSendNow = jest.fn().mockReturnValue(undefined);
      const { result } = setupWithState({
        isSubmitting: false,
        sendNow: acceptingSendNow,
      });
      act(() => {
        result.current.steering.enqueue('first send');
        result.current.steering.enqueue('second send');
      });
      const [first, second] = result.current.queue;

      act(() => {
        result.current.steering.sendQueuedNow(first);
        result.current.steering.sendQueuedNow(second);
      });

      expect(acceptingSendNow).toHaveBeenCalledTimes(1);
      expect(acceptingSendNow).toHaveBeenCalledWith('first send', [], {
        quotes: undefined,
        manualSkills: undefined,
        clientRequestId: undefined,
        recoverySteerId: undefined,
        expectedPredecessorCreatedAt: 41,
        queuedMessageOrigin: {
          item: first,
          beforeIds: [],
          afterIds: [second.id],
        },
      });
      expect(result.current.queue).toEqual([second]);
    });

    it('interruptAndSend queues at the front, arms the drain flag, and stops the run', () => {
      const { result, stopGenerating } = setupWithState();
      act(() => {
        result.current.steering.enqueue('already queued');
      });
      act(() => {
        result.current.steering.interruptAndSend('urgent redirect');
      });
      expect(result.current.queue.map((item) => item.text)).toEqual([
        'urgent redirect',
        'already queued',
      ]);
      expect(result.current.drainFlag).toEqual({
        conversationId: CONVO_ID,
        generationCreatedAt: 41,
      });
      expect(stopGenerating).toHaveBeenCalledTimes(1);
    });

    it('keeps multiple interrupt-and-send items FIFO ahead of ordinary follow-ups', () => {
      const now = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(20);
      try {
        const { result } = setupWithState();
        act(() => {
          result.current.steering.enqueue('ordinary');
          result.current.steering.interruptAndSend('first interrupt');
          result.current.steering.interruptAndSend('second interrupt');
        });

        expect(result.current.queue.map((item) => item.text)).toEqual([
          'first interrupt',
          'second interrupt',
          'ordinary',
        ]);
      } finally {
        now.mockRestore();
      }
    });

    it('enqueue appends and removeQueued deletes by id', () => {
      const { result } = setupWithState();
      act(() => {
        result.current.steering.enqueue('one');
        result.current.steering.enqueue('two');
      });
      expect(result.current.queue.map((item) => item.text)).toEqual(['one', 'two']);
      const firstId = result.current.queue[0].id;
      act(() => {
        result.current.steering.removeQueued(firstId);
      });
      expect(result.current.queue.map((item) => item.text)).toEqual(['two']);
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('preserves a manual queue order when another message is enqueued', () => {
      const first: QueuedMessage = { id: 'first', text: 'first', createdAt: 1 };
      const second: QueuedMessage = { id: 'second', text: 'second', createdAt: 2 };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [first, second]);
      });

      act(() => {
        result.current.steering.reorderQueued(first.id, 1);
        result.current.steering.enqueue('third', { id: 'third', createdAt: 3 });
      });

      expect(result.current.queue.map((item) => item.id)).toEqual(['second', 'first', 'third']);
    });

    it('atomically discards a recovered source and downgrades its row in place', async () => {
      mockCancelSteer.mockResolvedValueOnce({
        removed: true,
        generationProtocolVersion: 2,
      });
      const before: QueuedMessage = {
        id: 'queued-before',
        text: 'before',
        createdAt: 0,
      };
      const recovered: QueuedMessage = {
        id: 'queued-leftover',
        text: 'edit this next',
        createdAt: 1,
        clientRequestId: 'recovery-attempt',
        recoverySteerId: 'server-leftover',
        recoveryClientSteerId: 'client-leftover',
        expectedPredecessorCreatedAt: 41,
        files: [
          {
            file_id: 'file-1',
            filepath: '/uploads/file-1.txt',
            type: 'text/plain',
          },
        ],
        quotes: ['keep quote'],
        manualSkills: ['keep skill'],
        priority: true,
      };
      const after: QueuedMessage = {
        id: 'queued-after',
        text: 'after',
        createdAt: 2,
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [before, recovered, after]);
      });

      let discarded = false;
      await act(async () => {
        discarded = await result.current.steering.discardQueued(recovered);
      });

      expect(discarded).toBe(true);
      expect(mockCancelSteer).toHaveBeenCalledWith({
        conversationId: CONVO_ID,
        steerId: 'server-leftover',
        clientSteerId: 'client-leftover',
      });
      expect(result.current.queue).toEqual([
        before,
        {
          id: 'queued-leftover',
          text: 'edit this next',
          createdAt: 1,
          expectedPredecessorCreatedAt: 41,
          files: [
            {
              file_id: 'file-1',
              filepath: '/uploads/file-1.txt',
              type: 'text/plain',
            },
          ],
          quotes: ['keep quote'],
          manualSkills: ['keep skill'],
          priority: true,
        },
        after,
      ]);
    });

    it('keeps a recovered queue row when its parked source cannot be discarded', async () => {
      mockCancelSteer.mockResolvedValueOnce({
        removed: false,
        generationProtocolVersion: 2,
      });
      const recovered = {
        id: 'queued-leftover',
        text: 'do not duplicate me',
        createdAt: 1,
        recoverySteerId: 'server-leftover',
        recoveryClientSteerId: 'client-leftover',
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [recovered]);
      });

      let discarded = true;
      await act(async () => {
        discarded = await result.current.steering.discardQueued(recovered);
      });

      expect(discarded).toBe(false);
      expect(result.current.queue).toEqual([recovered]);
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'Could not cancel the steering message; it may still reach the agent',
        status: 'error',
      });
    });

    it('fails closed for a recovered row without a durable receipt correlation', async () => {
      const recovered = {
        id: 'queued-leftover',
        text: 'keep this visible',
        createdAt: 1,
        recoverySteerId: 'server-leftover',
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [recovered]);
      });

      let discarded = true;
      await act(async () => {
        discarded = await result.current.steering.discardQueued(recovered);
      });

      expect(discarded).toBe(false);
      expect(mockCancelSteer).not.toHaveBeenCalled();
      expect(result.current.queue).toEqual([recovered]);
    });

    it('sendQueuedNow steers whenever steering is available, even under the queue preference', () => {
      const { result } = setupWithState({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'queue');
      });
      act(() => {
        result.current.steering.enqueue('send me now');
      });
      const queued = result.current.queue[0];
      act(() => {
        result.current.steering.sendQueuedNow(queued);
      });
      expect(result.current.queue).toEqual([]);
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: 'send me now',
          clientSteerId: expect.any(String),
        }),
        expect.anything(),
      );
    });

    it.each([
      ['an ordinary paused steer', 'RUN_PAUSED', undefined],
      ['a preempt steer rejected at capacity', 'STEER_QUEUE_FULL', { preempt: true }],
      ['a preempt steer racing run settlement', 'NO_ACTIVE_RUN', { preempt: true }],
    ] as const)('restores a non-front queued item in place after %s', (_scenario, code, opts) => {
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code } } });
      });
      const before = { id: 'q-before', text: 'before', createdAt: 10 };
      const selected = {
        id: 'q-selected',
        text: 'restore exactly',
        createdAt: 20,
        priority: true,
        quotes: ['carried quote'],
        manualSkills: ['carried-skill'],
        files: [
          {
            file_id: 'file-selected',
            filepath: '/uploads/file-selected.txt',
            type: 'text/plain',
          },
        ],
      };
      const after = { id: 'q-after', text: 'after', createdAt: 30 };
      const originalQueue = [before, selected, after];
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), originalQueue);
      });

      act(() => {
        result.current.steering.sendQueuedNow(selected, opts);
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: selected.text,
          files: selected.files,
          clientSteerId: expect.any(String),
          ...(opts?.preempt === true && { preempt: true }),
        }),
        expect.anything(),
      );
      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual(originalQueue);
      expect(result.current.queue[1]).toBe(selected);
    });

    it('restores before a surviving successor when the queue drains during the request', () => {
      let rejectSteer: ((error: unknown) => void) | undefined;
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        rejectSteer = onError;
      });
      const before = {
        id: 'q-drained',
        text: 'drained meanwhile',
        createdAt: 10,
      };
      const selected = {
        id: 'q-racing',
        text: 'restore before successor',
        createdAt: 20,
      };
      const after = {
        id: 'q-survives',
        text: 'surviving successor',
        createdAt: 30,
      };
      const addedLater = {
        id: 'q-later',
        text: 'queued during request',
        createdAt: 40,
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [before, selected, after]);
      });

      act(() => {
        result.current.steering.sendQueuedNow(selected);
      });
      expect(result.current.queue).toEqual([before, after]);

      act(() => {
        result.current.setQueue([after, addedLater]);
        rejectSteer?.({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });

      expect(result.current.queue).toEqual([selected, after, addedLater]);
      expect(result.current.queue[0]).toBe(selected);
    });

    it('serializes two queue-origin sends and reconstructs their order when both reject', () => {
      const rejectSteer: Array<(error: unknown) => void> = [];
      mockMutate.mockImplementation((_params, { onError }) => {
        rejectSteer.push(onError);
      });
      const first = {
        id: 'q-concurrent-first',
        text: 'first instruction',
        createdAt: 10,
      };
      const second = {
        id: 'q-concurrent-second',
        text: 'second instruction',
        createdAt: 20,
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [first, second]);
      });

      act(() => {
        result.current.steering.sendQueuedNow(first);
      });
      act(() => {
        result.current.steering.sendQueuedNow(second);
      });
      expect(result.current.queue).toEqual([]);
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ text: first.text }),
        expect.anything(),
      );

      act(() => {
        rejectSteer[0]({ response: { data: { code: 'RUN_PAUSED' } } });
      });
      expect(mockMutate).toHaveBeenCalledTimes(2);
      expect(mockMutate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ text: second.text }),
        expect.anything(),
      );

      act(() => {
        rejectSteer[1]({ response: { data: { code: 'RUN_PAUSED' } } });
      });

      expect(result.current.queue).toEqual([first, second]);
      expect(result.current.queue[0]).toBe(first);
      expect(result.current.queue[1]).toBe(second);

      act(() => {
        result.current.steering.submitSteer('third after rejections');
      });
      expect(mockMutate).toHaveBeenCalledTimes(3);
      expect(mockMutate).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ text: 'third after rejections' }),
        expect.anything(),
      );
    });

    it('reconstructs FIFO when two serialized queue-origin receipts report leftovers', () => {
      const settle: Array<(serverId: string) => void> = [];
      mockMutate.mockImplementation((_params, { onSuccess }) => {
        settle.push((serverId) =>
          onSuccess({
            steerId: serverId,
            settled: true,
            leftover: true,
            replayed: true,
            generationProtocolVersion: 2,
          }),
        );
      });
      const first = {
        id: 'q-receipt-first',
        text: 'first accepted',
        createdAt: 10,
      };
      const second = {
        id: 'q-receipt-second',
        text: 'second accepted',
        createdAt: 20,
      };
      const { result } = setupWithState({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [first, second]);
      });

      act(() => {
        result.current.steering.sendQueuedNow(first);
      });
      act(() => {
        result.current.steering.sendQueuedNow(second);
      });
      expect(result.current.queue).toEqual([]);
      expect(settle).toHaveLength(1);

      act(() => {
        settle[0]('srv-receipt-first');
      });
      expect(settle).toHaveLength(2);
      act(() => {
        settle[1]('srv-receipt-second');
      });

      expect(result.current.queue).toEqual([
        expect.objectContaining({
          ...first,
          clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
          recoverySteerId: 'srv-receipt-first',
        }),
        expect.objectContaining({
          ...second,
          clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
          recoverySteerId: 'srv-receipt-second',
        }),
      ]);
      expect(result.current.queue[0].clientRequestId).not.toBe(
        result.current.queue[1].clientRequestId,
      );
      expect(result.current.queue[0].clientRequestId).not.toBe('steer-recovery:srv-receipt-first');
      expect(result.current.queue[1].clientRequestId).not.toBe('steer-recovery:srv-receipt-second');
    });
  });

  describe('attachments', () => {
    const composerFile = {
      file_id: 'file-1',
      filepath: '/uploads/file-1.png',
      type: 'image/png',
      height: 10,
      width: 10,
    };
    const queuedFiles = [{ file_id: 'file-1', filepath: '/uploads/file-1.png', type: 'image/png' }];

    /** Steering is gated on the active-generation epoch, so seed it by default
     *  or every steer here is refused as pre-epoch. `null` seeds nothing, which
     *  is the pre-epoch case itself; an initializer seeds the epoch and then
     *  whatever else that test needs. */
    function setupWithFiles(
      params: HookParams = {},
      initialize?: ((snapshot: MutableSnapshot) => void) | null,
    ) {
      const setFiles = jest.fn();
      const files = new Map([['file-1', composerFile]]) as unknown as NonNullable<
        Parameters<typeof useSteering>[0]['files']
      >;
      const sendNow = jest.fn();
      const stopGenerating = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot
          initializeState={
            initialize === null
              ? undefined
              : (snapshot) => {
                  snapshot.set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), 41);
                  initialize?.(snapshot);
                }
          }
        >
          {children}
        </RecoilRoot>
      );
      const rendered = renderHook(
        () => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            files,
            setFiles,
            sendNow,
            stopGenerating,
            ...params,
          }),
          queue: useQueue(CONVO_ID),
          setQueue: useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID)),
        }),
        { wrapper },
      );
      return { ...rendered, setFiles, sendNow, stopGenerating };
    }

    it('steers with the composer attachments as one unit', () => {
      const { result, setFiles } = setupWithFiles({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      let consumed = false;
      act(() => {
        consumed = result.current.steering.submitDuringRun('look at this image');
      });
      expect(consumed).toBe(true);
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: 'look at this image',
          clientSteerId: expect.any(String),
          files: [expect.objectContaining({ file_id: 'file-1' })],
        }),
        expect.anything(),
      );
      expect(result.current.queue).toEqual([]);
      /* Functional, never a flat overwrite: uploads write through functional
         updates of their own, and an assigned map races them. */
      const clear = setFiles.mock.calls[0][0] as (
        previous: Map<string, unknown>,
      ) => Map<string, unknown>;
      expect(typeof clear).toBe('function');
      expect(clear(new Map([['file-1', composerFile]]))).toEqual(new Map());
      /* Only the ids it took: anything staged since is left where it is. */
      expect(clear(new Map<string, unknown>([['file-2', { file_id: 'file-2' }]]))).toEqual(
        new Map([['file-2', { file_id: 'file-2' }]]),
      );
    });

    /* An upload resolving between the read and the clear used to be reapplied
       on top of the emptied map, so the attachment came back in the composer
       and rode the user's next message as well. */
    describe('uploads interleaved with a consuming submit', () => {
      const extended = (file_id: string, progress: number): ExtendedFile => ({
        file_id,
        progress,
        size: 128,
        type: 'image/png',
      });

      function setupComposer() {
        const sendNow = jest.fn();
        const stopGenerating = jest.fn();
        const observed: { files: Map<string, ExtendedFile> } = { files: new Map() };
        let updates: ReturnType<typeof useUpdateFiles> | undefined;
        let steering: ReturnType<typeof useSteering> | undefined;

        /** Real composer state, so `useUpdateFiles` and `useSteering` write
         *  through the same setter they share in `ChatForm`. */
        const Composer = () => {
          const [files, setFiles] = React.useState<Map<string, ExtendedFile>>(new Map());
          observed.files = files;
          updates = useUpdateFiles(setFiles);
          steering = useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            files,
            setFiles,
            sendNow,
            stopGenerating,
          });
          return null;
        };

        render(
          <RecoilRoot initializeState={withActiveGeneration()}>
            <Composer />
          </RecoilRoot>,
        );
        return {
          observed,
          getUpdates: () => updates!,
          getSteering: () => steering!,
        };
      }

      it('ignores a late callback for an attachment the steer already took', () => {
        const { observed, getUpdates, getSteering } = setupComposer();

        act(() => getUpdates().addFile(extended('file-consumed', 0.4)));
        expect(observed.files.has('file-consumed')).toBe(true);

        act(() => {
          getSteering().steerFromComposer('use this image');
        });
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            files: [expect.objectContaining({ file_id: 'file-consumed' })],
          }),
          expect.anything(),
        );
        expect(observed.files.size).toBe(0);

        act(() => getUpdates().replaceFile(extended('file-consumed', 1)));
        expect(observed.files.size).toBe(0);
      });

      it('still accepts an upload the user starts after the steer', () => {
        const { observed, getUpdates, getSteering } = setupComposer();

        act(() => getUpdates().addFile(extended('file-first', 1)));
        act(() => {
          getSteering().steerFromComposer('first one');
        });
        expect(observed.files.size).toBe(0);

        act(() => getUpdates().addFile(extended('file-second', 0.2)));
        act(() => getUpdates().replaceFile(extended('file-second', 1)));
        expect(observed.files.get('file-second')?.progress).toBe(1);
      });

      /* Re-attaching the same library file reuses its server id, so a
         permanent mark would make that attachment silently impossible. */
      it('accepts the same file again when it is deliberately re-attached', () => {
        const { observed, getUpdates, getSteering } = setupComposer();

        act(() => getUpdates().addFile(extended('file-library', 1)));
        act(() => {
          getSteering().steerFromComposer('about this one');
        });
        expect(observed.files.size).toBe(0);

        act(() => getUpdates().addFile(extended('file-library', 1)));
        expect(observed.files.has('file-library')).toBe(true);
        act(() => getUpdates().replaceFile(extended('file-library', 0.9)));
        expect(observed.files.get('file-library')?.progress).toBe(0.9);
      });

      /* The composer map the submit reads is a render-old snapshot: an upload
         that started after it must not be wiped by the clear. */
      it('leaves an attachment staged after the submit read the composer', () => {
        const { observed, getUpdates, getSteering } = setupComposer();

        act(() => getUpdates().addFile(extended('file-taken', 1)));
        act(() => {
          getUpdates().addFile(extended('file-newer', 0.3));
          getSteering().steerFromComposer('take the first one');
        });

        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({ files: [expect.objectContaining({ file_id: 'file-taken' })] }),
          expect.anything(),
        );
        expect(Array.from(observed.files.keys())).toEqual(['file-newer']);
      });
    });

    it('holds during-run submits while uploads are in flight', () => {
      // Seed 'steer' so this covers steerFromComposer's own filesLoading
      // guard; the queue-path guard is covered separately (queueFromComposer
      // is exercised directly with filesLoading in the composer-draft tests).
      const { result } = setupWithFiles({ filesLoading: true }, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      let consumed = true;
      act(() => {
        consumed = result.current.steering.submitDuringRun('too early');
      });
      expect(consumed).toBe(false);
      expect(result.current.queue).toEqual([]);
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('does not consume composer attachments when an explicit pre-epoch steer is refused', () => {
      const { result, setFiles } = setupWithFiles({}, null);
      let consumed = true;

      act(() => {
        consumed = result.current.steering.steerFromComposer('wait for startup');
      });

      expect(consumed).toBe(false);
      expect(mockMutate).not.toHaveBeenCalled();
      expect(setFiles).not.toHaveBeenCalled();
    });

    /* The drain can take the head between the click dispatching and the row
       unmounting. Falling back to the captured item sent the same words twice. */
    it('refuses to send a message the queue no longer holds', () => {
      const { result, sendNow } = setupWithFiles({ isSubmitting: false });
      act(() => {
        result.current.steering.sendQueuedNow({
          id: 'already-drained',
          text: 'sent moments ago',
          createdAt: Date.now(),
        });
      });
      expect(sendNow).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
      expect(result.current.queue).toEqual([]);
    });

    it('steers a queued media item with its own files during a live run', () => {
      const { result, sendNow } = setupWithFiles();
      act(() => {
        sendFromQueue(result.current, {
          id: 'q-media',
          text: 'media message',
          createdAt: Date.now(),
          files: queuedFiles,
        });
      });
      expect(sendNow).not.toHaveBeenCalled();
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVO_ID,
          text: 'media message',
          files: queuedFiles,
          clientSteerId: expect.any(String),
        }),
        expect.anything(),
      );
      expect(result.current.queue).toEqual([]);
    });

    it('sends a media item as a normal turn with its own files when idle', () => {
      const { result, sendNow } = setupWithFiles({ isSubmitting: false });
      act(() => {
        sendFromQueue(result.current, {
          id: 'q-media',
          text: 'media message',
          createdAt: Date.now(),
          files: queuedFiles,
        });
      });
      expect(sendNow).toHaveBeenCalledWith('media message', queuedFiles, {
        quotes: undefined,
        manualSkills: undefined,
        clientRequestId: undefined,
        recoverySteerId: undefined,
        expectedPredecessorCreatedAt: undefined,
        queuedMessageOrigin: {
          item: {
            id: 'q-media',
            text: 'media message',
            createdAt: expect.any(Number),
            files: queuedFiles,
          },
          beforeIds: [],
          afterIds: [],
        },
      });
    });

    it('marks queued files used exactly once when queueing from the composer', () => {
      const { result } = setupWithFiles();
      act(() => {
        result.current.steering.queueFromComposer('queued with media');
      });
      expect(mockMarkUsage).toHaveBeenCalledTimes(1);
      expect(mockMarkUsage).toHaveBeenCalledWith({ file_ids: ['file-1'] });
    });

    it('marks queued files used on interrupt & send', () => {
      const { result } = setupWithFiles();
      act(() => {
        result.current.steering.interruptAndSend('urgent with media');
      });
      expect(mockMarkUsage).toHaveBeenCalledTimes(1);
      expect(mockMarkUsage).toHaveBeenCalledWith({ file_ids: ['file-1'] });
    });

    it('does not mark usage for text-only queueing', () => {
      const { result } = setupWithFiles({ files: new Map() });
      act(() => {
        result.current.steering.queueFromComposer('just text');
      });
      expect(mockMarkUsage).not.toHaveBeenCalled();
    });

    it('does not mark usage on the steer path (the 202 already marked)', () => {
      const { result } = setupWithFiles({}, ({ set }) => {
        set(store.duringRunDefaultAction, 'steer');
      });
      act(() => {
        result.current.steering.submitDuringRun('steer with media');
      });
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMarkUsage).not.toHaveBeenCalled();
    });

    it('restores an unchanged queued media item without re-marking its files', () => {
      // Paused on approval → steering unavailable while the run is live, so
      // sendQueuedNow restores the item unchanged: its files were already marked.
      mockMessages = [
        {
          messageId: 'resp-1',
          isCreatedByUser: false,
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                id: 'call-1',
                name: 'shell',
                approval: { actionId: 'a1' },
                output: '',
              },
            },
          ],
        } as unknown as TMessage,
      ];
      const { result } = setupWithFiles();
      const queued = {
        id: 'q-requeue',
        text: 'requeued media',
        createdAt: Date.now(),
        files: queuedFiles,
      };
      act(() => {
        result.current.setQueue([queued]);
      });
      act(() => {
        result.current.steering.sendQueuedNow(queued);
      });
      expect(result.current.queue).toEqual([queued]);
      expect(result.current.queue[0]).toBe(queued);
      expect(mockMarkUsage).not.toHaveBeenCalled();
    });
  });

  describe('composer quotes + manual skill capture', () => {
    function setupWithContext(
      params: HookParams = {},
      initialize?: (snapshot: MutableSnapshot) => void,
      initialReasoning?: TMessage['reasoningOverride'],
    ) {
      const sendNow = jest.fn();
      const stopGenerating = jest.fn();
      const reasoningStore = createStore();
      reasoningStore.set(pendingReasoningOverrideFamily(CONVO_ID), initialReasoning);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <JotaiProvider store={reasoningStore}>
          <RecoilRoot initializeState={withActiveGeneration(initialize)}>{children}</RecoilRoot>
        </JotaiProvider>
      );
      const rendered = renderHook(
        () => ({
          steering: useSteering({
            consumeDraft: jest.fn(),
            index: 0,
            conversationId: CONVO_ID,
            conversation: agentsConversation,
            isSubmitting: true,
            answerModeActive: false,
            sendNow,
            stopGenerating,
            ...params,
          }),
          queue: useQueue(CONVO_ID),
          setQueue: useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID)),
          chips: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
          pendingQuotes: useRecoilValue(store.pendingQuotesByConvoId(CONVO_ID)),
          pendingSkills: useRecoilValue(store.pendingManualSkillsByConvoId(CONVO_ID)),
          pendingReasoning: useAtomValue(pendingReasoningOverrideFamily(CONVO_ID)),
          markApplied: useSetRecoilState(store.appliedSteerIdsByConvoId(CONVO_ID)),
        }),
        { wrapper },
      );
      return { ...rendered, sendNow };
    }

    const stageContext = ({ set }: MutableSnapshot) => {
      set(store.pendingQuotesByConvoId(CONVO_ID), ['quoted excerpt']);
      set(store.pendingManualSkillsByConvoId(CONVO_ID), ['skill-1']);
    };

    it('queues rather than steering when reasoning is staged for a new generation', () => {
      const { result } = setupWithContext({}, undefined, {
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });

      act(() => {
        result.current.steering.steerFromComposer('reason about this');
      });

      expect(mockMutate).not.toHaveBeenCalled();
      expect(result.current.queue[0]).toMatchObject({
        text: 'reason about this',
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      });
      expect(result.current.pendingReasoning).toBeUndefined();
    });

    it('queueFromComposer consumes staged quotes + skills into the queued item', () => {
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.queueFromComposer('with context');
      });
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          text: 'with context',
          quotes: ['quoted excerpt'],
          manualSkills: ['skill-1'],
        }),
      ]);
      // Consumed, not copied: the composer chips must not ride the NEXT send.
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.pendingSkills).toEqual([]);
    });

    it('interruptAndSend captures the staged context on the front item', () => {
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.enqueue('already queued');
      });
      act(() => {
        result.current.steering.interruptAndSend('urgent redirect');
      });
      expect(result.current.queue[0]).toEqual(
        expect.objectContaining({
          text: 'urgent redirect',
          quotes: ['quoted excerpt'],
          manualSkills: ['skill-1'],
        }),
      );
      expect(result.current.queue[1].quotes).toBeUndefined();
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.pendingSkills).toEqual([]);
    });

    it('steerFromComposer drains the quote chips into the POST, leaving skill picks staged', () => {
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('steer text');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'steer text',
          quotes: ['quoted excerpt'],
        }),
        expect.anything(),
      );
      expect(mockMutate.mock.calls[0][0]).not.toHaveProperty('manualSkills');
      // Consumed like a normal send's quotes; the excerpts now ride the steer.
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.chips[0]).toMatchObject({
        quotes: ['quoted excerpt'],
      });
      // A skill pick configures a NEW turn's run — it keeps waiting for one.
      expect(result.current.pendingSkills).toEqual(['skill-1']);
    });

    it('interruptSteer carries the staged quotes the same way', () => {
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.interruptSteer('stop and use this');
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ quotes: ['quoted excerpt'], preempt: true }),
        expect.anything(),
      );
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.pendingSkills).toEqual(['skill-1']);
    });

    it("sendQueuedNow posts a queued item's quotes when steering it into the live run", () => {
      const item: QueuedMessage = {
        id: 'q-live',
        text: 'queued with quotes',
        createdAt: 1_000,
        quotes: ['queued excerpt'],
      };
      const { result } = setupWithContext({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [item]);
      });
      act(() => {
        result.current.steering.sendQueuedNow(item);
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'queued with quotes',
          quotes: ['queued excerpt'],
        }),
        expect.anything(),
      );
    });

    it('keeps a durable reasoning row untouched during a live run', () => {
      const item: QueuedMessage = {
        id: 'q-reasoning-live',
        text: 'reason about this next',
        createdAt: 1_000,
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        server: { id: 'server-reasoning-live', status: 'queued', revision: 3 },
      };
      const { result, sendNow } = setupWithContext({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [item]);
      });

      act(() => {
        result.current.steering.sendQueuedNow(item);
      });

      expect(mockCancelQueuedTurn).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
      expect(sendNow).not.toHaveBeenCalled();
      expect(result.current.queue).toEqual([item]);
      expect(result.current.queue[0].server).toEqual(item.server);
    });

    it('queues without quotes/skills fields when nothing is staged', () => {
      const { result } = setupWithContext();
      act(() => {
        result.current.steering.queueFromComposer('plain text');
      });
      expect(result.current.queue[0].quotes).toBeUndefined();
      expect(result.current.queue[0].manualSkills).toBeUndefined();
    });

    it('sendQueuedNow passes the carried context to sendNow when idle', () => {
      const { result, sendNow } = setupWithContext({ isSubmitting: false });
      act(() => {
        sendFromQueue(result.current, {
          id: 'q-ctx',
          text: 'context send',
          createdAt: Date.now(),
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        });
      });
      expect(sendNow).toHaveBeenCalledWith('context send', [], {
        quotes: ['carried quote'],
        manualSkills: ['carried-skill'],
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        clientRequestId: undefined,
        recoverySteerId: undefined,
        expectedPredecessorCreatedAt: undefined,
        queuedMessageOrigin: {
          item: {
            id: 'q-ctx',
            text: 'context send',
            createdAt: expect.any(Number),
            quotes: ['carried quote'],
            manualSkills: ['carried-skill'],
            reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
          },
          beforeIds: [],
          afterIds: [],
        },
      });
    });

    it('requeues a degraded queued-origin steer with its carried quotes + skills', () => {
      // The item left the queue before the POST settled; the 409 fallback
      // must restore its FULL context, not just text + files.
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'RUN_PAUSED' } } });
      });
      const { result } = setupWithContext();
      act(() => {
        sendFromQueue(result.current, {
          id: 'q-degraded',
          text: 'carried context',
          createdAt: Date.now(),
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        });
      });
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          text: 'carried context',
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      ]);
    });

    it('sends a settled NO_ACTIVE_RUN fallback with the carried context as overrides', () => {
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'NO_ACTIVE_RUN' } } });
      });
      const { result, sendNow } = setupWithContext({ isSubmitting: false });
      act(() => {
        result.current.steering.submitSteer('late context', undefined, {
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        });
      });
      expect(sendNow).toHaveBeenCalledWith('late context', [], {
        quotes: ['carried quote'],
        manualSkills: ['carried-skill'],
        expectedPredecessorCreatedAt: 41,
        queuedMessageOrigin: {
          item: expect.objectContaining({
            id: expect.stringMatching(/^local-/),
            text: 'late context',
            createdAt: expect.any(Number),
            expectedPredecessorCreatedAt: 41,
            quotes: ['carried quote'],
            manualSkills: ['carried-skill'],
          }),
          beforeIds: [],
          afterIds: [],
        },
      });
    });

    it('carries a queued-origin context onto the sending chip and the 202 ACK chip', () => {
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-ctx',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
          quotesAccepted: true,
        });
      });
      const { result } = setupWithContext();
      act(() => {
        result.current.steering.submitSteer('carried steer', undefined, {
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        });
      });
      expect(result.current.chips).toEqual([
        expect.objectContaining({
          steerId: 'srv-ctx',
          status: 'pending',
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      ]);
    });

    it('keeps rejected quotes carried on the pending chip (old-server ACK)', () => {
      // A pre-quotes replica 202s the words without their excerpts, but the
      // steer has NOT injected yet — the quotes must stay attached to the
      // words: a later quote-less applied event re-stages them at the actual
      // loss, while a terminal leftover conversion carries them onto the
      // recovered row (whose normal send delivers quotes on any server).
      // Re-staging at the ACK would let that leftover auto-send bare text
      // while the excerpts glue onto an unrelated composer draft.
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-old',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('quoted for an old server');
      });
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.chips).toEqual([
        expect.objectContaining({
          steerId: 'srv-old',
          status: 'pending',
          quotes: ['quoted excerpt'],
        }),
      ]);
    });

    it('keeps quotes drained when the ACK confirms they were accepted', () => {
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-new',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
          quotesAccepted: true,
        });
      });
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('quoted for a new server');
      });
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.chips[0]).toMatchObject({
        steerId: 'srv-new',
        quotes: ['quoted excerpt'],
      });
    });

    it("keeps a queued item's quotes on its chip when Send now hits an old server", () => {
      // The pending chip and its captured origin retain the quotes so every
      // later outcome preserves them with the words: a quote-less applied
      // event re-stages, a leftover conversion restores the exact row, and a
      // reclaim hands them back to the composer.
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-q-old',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      const item: QueuedMessage = {
        id: 'q-old-server',
        text: 'queued quoted words',
        createdAt: 1_000,
        quotes: ['queued excerpt'],
      };
      const { result } = setupWithContext({}, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [item]);
      });
      act(() => {
        result.current.steering.sendQueuedNow(item);
      });
      expect(result.current.queue).toEqual([]);
      expect(result.current.pendingQuotes).toEqual([]);
      const chip = result.current.chips[0];
      expect(chip).toMatchObject({
        steerId: 'srv-q-old',
        status: 'pending',
        quotes: ['queued excerpt'],
      });
      expect(chip.queuedOrigin?.item.quotes).toEqual(['queued excerpt']);
    });

    it('never re-stages quotes a terminal conversion already moved to the queue', () => {
      // A pre-quotes server's run-end leftover event converts the chip (with
      // its quotes) into a queued follow-up and marks the ids applied BEFORE
      // the delayed no-echo 202 lands. The reclaim must find no surviving chip
      // and leave the queued copy as the single owner of the excerpts.
      let deferredOnSuccess: ((response: unknown) => void) | undefined;
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        deferredOnSuccess = onSuccess;
      });
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('converted before ACK');
      });
      const localId = result.current.chips[0].steerId;
      act(() => {
        result.current.markApplied((prev) => [...prev, localId]);
        result.current.steering.convertSteerToQueue(localId, 'converted before ACK', undefined, {
          quotes: ['quoted excerpt'],
        });
      });
      expect(result.current.queue[0]).toMatchObject({
        quotes: ['quoted excerpt'],
      });
      act(() => {
        deferredOnSuccess?.({
          steerId: 'srv-converted',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      // No re-mint, no re-stage: the queued follow-up remains the only copy.
      expect(result.current.chips).toEqual([]);
      expect(result.current.pendingQuotes).toEqual([]);
      expect(result.current.queue).toHaveLength(1);
    });

    it('re-stages quotes on a settled receipt replay that never carried them', () => {
      // Lost first ACK against an old replica; the retry's receipt replay
      // (settled, already injected) proves the excerpts never attached.
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-replayed',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
          settled: true,
          replayed: true,
          generationProtocolVersion: 2,
        });
      });
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('replayed without quotes');
      });
      expect(result.current.pendingQuotes).toEqual(['quoted excerpt']);
      expect(result.current.chips).toEqual([]);
    });

    it('restores the carried context when a late ACK converts straight to queued', () => {
      // The run ended before the 202 landed: the ACK's queued conversion is
      // the only surviving copy of the steer, so it must keep quotes + skills.
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-late',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
        });
      });
      const { result } = setupWithContext({ isSubmitting: false });
      act(() => {
        result.current.steering.submitSteer('late carried', undefined, {
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        });
      });
      expect(result.current.chips).toEqual([]);
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          id: 'srv-late',
          text: 'late carried',
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      ]);
    });

    it('restores an exact queued-origin item when its 202 lands after run end', () => {
      let acknowledge: (() => void) | undefined;
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        acknowledge = () =>
          onSuccess({
            steerId: 'server-late-id',
            status: 'queued',
            position: 1,
            conversationId: CONVO_ID,
          });
      });
      const params: HookParams = { isSubmitting: true };
      const before = { id: 'late-before', text: 'before', createdAt: 10 };
      const selected = {
        id: 'late-selected',
        text: 'accepted before run end',
        createdAt: 20,
        priority: true,
        quotes: ['original quote'],
      };
      const after = { id: 'late-after', text: 'after', createdAt: 30 };
      const { result, rerender } = setupWithContext(params, ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [before, selected, after]);
      });

      act(() => {
        result.current.steering.sendQueuedNow(selected);
      });
      expect(result.current.queue).toEqual([before, after]);

      params.isSubmitting = false;
      rerender();
      act(() => {
        acknowledge?.();
      });

      expect(result.current.queue).toEqual([
        before,
        expect.objectContaining({
          ...selected,
          clientRequestId: expect.stringMatching(UUID_V4_PATTERN),
          recoverySteerId: 'server-late-id',
          recoveryClientSteerId: expect.any(String),
        }),
        after,
      ]);
      expect(result.current.queue[1].clientRequestId).not.toBe('steer-recovery:server-late-id');
    });

    it('keeps the carried context on a failed chip through retry', () => {
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'SOME_ERROR' } } });
      });
      const { result } = setupWithContext();
      act(() => {
        result.current.steering.submitSteer('failed carried', undefined, {
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        });
      });
      const failed = result.current.chips[0];
      expect(failed).toEqual(
        expect.objectContaining({
          status: 'failed',
          deliveryUncertain: true,
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      );
      mockMutate.mockImplementationOnce((_params, { onSuccess }) => {
        onSuccess({
          steerId: 'srv-retry',
          status: 'queued',
          position: 1,
          conversationId: CONVO_ID,
          quotesAccepted: true,
        });
      });
      act(() => {
        result.current.steering.retrySteer(failed.steerId, failed.text, failed.files, {
          quotes: failed.quotes,
          manualSkills: failed.manualSkills,
        });
      });
      expect(mockMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ clientSteerId: failed.steerId }),
        expect.anything(),
      );
      expect(result.current.chips).toEqual([
        expect.objectContaining({
          steerId: 'srv-retry',
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        }),
      ]);
    });

    it('requeues a degraded composer-origin steer with its drained quotes', () => {
      mockMutate.mockImplementationOnce((_params, { onError }) => {
        onError({ response: { data: { code: 'RUN_PAUSED' } } });
      });
      const { result } = setupWithContext({}, stageContext);
      act(() => {
        result.current.steering.steerFromComposer('degraded steer');
      });
      // The quotes were consumed into the steer, so its queued fallback must
      // carry them — dropping them here would lose the user's references.
      expect(result.current.queue).toEqual([
        expect.objectContaining({
          text: 'degraded steer',
          quotes: ['quoted excerpt'],
        }),
      ]);
      expect(result.current.queue[0].manualSkills).toBeUndefined();
      expect(result.current.pendingQuotes).toEqual([]);
      // Skill picks were never consumed and stay staged for the next send.
      expect(result.current.pendingSkills).toEqual(['skill-1']);
    });
  });

  describe('composer draft consumption', () => {
    /** `useAutoSave` drafts under PENDING_CONVO for the whole run, and the
     *  composer clears via the form's programmatic `reset()`, which fires no
     *  `input` event, so nothing else drops the draft. Left behind, run end
     *  migrates it onto the conversation and restores it into the textarea,
     *  resurfacing text the user already sent. */
    const pendingDraftKey = `${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`;

    const stageDraft = () => localStorage.setItem(pendingDraftKey, 'ZHJhZnRlZCB0ZXh0');

    beforeEach(() => {
      localStorage.clear();
    });

    it('drops the pending draft when queueing from the composer', () => {
      stageDraft();
      const { result } = setup();
      act(() => {
        result.current.queueFromComposer('queued follow up');
      });
      expect(result.current.queueKey).toBe(CONVO_ID);
      expect(localStorage.getItem(pendingDraftKey)).toBeNull();
    });

    it.each([false, true])(
      'consumes the conversation draft only after a handoff submission is accepted (blocked=%s)',
      async (filesLoading) => {
        const key = `${LocalStorageKeys.TEXT_DRAFT}${CONVO_ID}`;
        const unrelatedKey = `${LocalStorageKeys.TEXT_DRAFT}another-conversation`;
        localStorage.setItem(key, 'ZHJhZnRlZCB0ZXh0');
        localStorage.setItem(unrelatedKey, 'other draft');
        getDefaultStore().set(revealedQueuedTurnFamily(CONVO_ID), {
          clientRequestId: 'pending',
          parentMessageId: 'response',
          generationCreatedAt: 41,
          text: 'pending',
          revealedAt: new Date().toISOString(),
        });
        const { result, unmount } = setup({ isSubmitting: false, filesLoading }, ({ set }) => {
          set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), null);
        });
        await act(async () => {
          expect(result.current.submitDuringRun('drafted text')).toBe(!filesLoading);
        });
        expect(localStorage.getItem(key)).toBe(filesLoading ? 'ZHJhZnRlZCB0ZXh0' : null);
        expect(localStorage.getItem(unrelatedKey)).toBe('other draft');
        unmount();
        getDefaultStore().set(revealedQueuedTurnFamily(CONVO_ID), null);
      },
    );

    it.each([false, true])(
      'delegates draft consumption to its owner only on acceptance (blocked=%s)',
      (filesLoading) => {
        const consumeDraft = jest.fn();
        const { result } = setup({ filesLoading, consumeDraft });
        act(() => {
          expect(result.current.queueFromComposer('drafted text')).toBe(!filesLoading);
        });
        expect(consumeDraft).toHaveBeenCalledTimes(filesLoading ? 0 : 1);
      },
    );

    it('drops the pending draft when steering from the composer', () => {
      stageDraft();
      const { result } = setup();
      act(() => {
        result.current.steerFromComposer('steered text');
      });
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(pendingDraftKey)).toBeNull();
    });

    it('drops the pending draft on interrupt & send', () => {
      stageDraft();
      const { result } = setup();
      act(() => {
        result.current.interruptAndSend('interrupting text');
      });
      expect(localStorage.getItem(pendingDraftKey)).toBeNull();
    });

    it('keeps the pending draft when the submit is refused', () => {
      // Nothing left the composer, so its draft must survive: an empty
      // submission and an in-flight upload both refuse without consuming.
      stageDraft();
      const { result } = setup({ filesLoading: true });
      act(() => {
        expect(result.current.queueFromComposer('held by upload')).toBe(false);
        expect(result.current.submitDuringRun('   ')).toBe(false);
      });
      expect(localStorage.getItem(pendingDraftKey)).toBe('ZHJhZnRlZCB0ZXh0');
    });
  });
});
