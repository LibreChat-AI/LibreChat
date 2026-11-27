/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type {
  ChatStream,
  ChatTransport,
  ChatSendRequest,
  ChatStreamStatus,
  ChatReconnectRequest,
} from '../../../core';
import type { ChatHost, TurnServices } from '../host';
import type { FollowChatOptions } from '../../follow';
import type { ExtendedFile } from '../../../core';
import { createUsageHandlers, createUsageCounters } from '../../stream/usage/handlers';
import { activeUsageResponseIdFamily, pendingUsageFamily } from '../../usage';
import { createTurnServices } from '../__fixtures__/services';
import { showStopButtonByIndex } from '../../generation';
import { toResumableUsage } from '../../stream/usage';
import { isSubmittingFamily } from '../../submission';
import { useDrivenContract } from '../driven';
import { useFollowChat } from '../../follow';
import { MAX_RETRIES } from '../../../core';
import { ChatHostProvider } from '../host';
import { filesFamily } from '../../pane';

/** Attaching again waits between tries on main chat's schedule, which a spec has no use for. */
jest.mock('../../../core/resumable/start', () => ({
  ...jest.requireActual('../../../core/resumable/start'),
  getReconnectDelay: () => 5,
}));

const conversationId = 'conversation-1';
const SIDE_PANE = 7;

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
  manualSkills: ['skill-a'],
};

const reply = (messageId: string, text: string, parentMessageId = 'user-1'): TMessage => ({
  messageId,
  parentMessageId,
  conversationId,
  text: '',
  sender: 'Assistant',
  isCreatedByUser: false,
  content: [{ type: ContentTypes.TEXT, text }],
});

const conversation: TConversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};

type TestStream = ChatStream & { push(event: ChatEvent): void; closed: boolean };

const createStream = (generationProtocolVersion?: number): TestStream => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const stream: TestStream = {
    streamId: conversationId,
    generationCreatedAt: 3000,
    generationProtocolVersion,
    closed: false,
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      stream.closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (stream.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return stream;
};

/** A transport that can start a generation: every send and every attachment opens a stream. */
const createTransport = (generationProtocolVersion?: number) => {
  const streams: TestStream[] = [];
  let status: ChatStreamStatus = { active: false };
  const open = (): TestStream => {
    const stream = createStream(generationProtocolVersion);
    streams.push(stream);
    return stream;
  };
  const sendMessages = jest.fn(
    async (_request: ChatSendRequest): ReturnType<ChatTransport['sendMessages']> => ({
      status: 'stream',
      stream: open(),
    }),
  );
  const abort = jest.fn(async () => ({ success: true }));
  /** As the generation transport does: a generation found running is named before its stream is had. */
  const reconnectToStream = jest.fn(
    async (request?: ChatReconnectRequest): Promise<ChatStream | null> => {
      if (!status.active) {
        return null;
      }
      request?.onGeneration?.({
        streamId: conversationId,
        generationCreatedAt: 3000,
        generationProtocolVersion,
      });
      return open();
    },
  );
  const transport: ChatTransport = {
    sendMessages,
    abort,
    reconnectToStream,
    getStatus: async () => status,
  };
  return {
    transport,
    streams,
    open,
    sendMessages,
    abort,
    reconnectToStream,
    setStatus: (next: ChatStreamStatus) => {
      status = next;
    },
  };
};

const runStep = (id: string, runId: string) => ({
  id,
  runId,
  index: 0,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
  usage: null,
});

const created = (message: TMessage, responseMessageId: string, turn: object = {}): ChatEvent =>
  ({
    type: 'created',
    data: { created: true, message, turn: { responseMessageId, ...turn } },
  }) as ChatEvent;

const opened = (runId: string): ChatEvent =>
  ({
    type: 'step',
    data: { event: StepEvents.ON_RUN_STEP, data: runStep('s0', runId) },
  }) as ChatEvent;

const token = (text: string): ChatEvent =>
  ({
    type: 'step',
    data: {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: { id: 's0', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
    },
  }) as ChatEvent;

const final = (requestMessage: TMessage, responseMessage: TMessage): ChatEvent =>
  ({
    type: 'final',
    data: { final: true, conversation: { conversationId }, requestMessage, responseMessage },
  }) as ChatEvent;

const ids = (messages: TMessage[] | undefined) =>
  (messages ?? []).map((message) => message.messageId);
const textOf = (messages: TMessage[] | undefined, messageId: string) =>
  (messages?.find((message) => message.messageId === messageId)?.content ?? []).map(
    (part) => (part as { text?: string } | undefined)?.text,
  );

/** Lets promises settle and the frame that writes streamed tokens run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

function setup({
  stored = [user, reply('response-1', 'Hi')],
  services = createTurnServices(),
  canSend,
  beside,
  id = conversationId,
  store = createStore(),
  runs,
  harness = createTransport(),
}: {
  stored?: TMessage[];
  services?: TurnServices;
  canSend?: () => boolean;
  beside?: FollowChatOptions['beside'];
  /** The conversation the pane holds, and the pane's store when a spec shares one. */
  id?: string;
  store?: ReturnType<typeof createStore>;
  /** What the caller is told of the conversation's generations. */
  runs?: Pick<
    FollowChatOptions,
    'onGeneration' | 'onRunEnd' | 'onStopped' | 'onDetached' | 'onIdle'
  >;
  /** The transport, when a spec sets the server's state before the conversation opens. */
  harness?: ReturnType<typeof createTransport>;
} = {}) {
  const queryClient = new QueryClient();
  const loadMessages = jest.fn(async () => stored);
  const onWithdrawn = jest.fn();
  const host: ChatHost = {
    usePaneConversation: () => {
      const [held, setConversation] = useState<TConversation | null>(conversation);
      return { conversation: held, setConversation };
    },
    useNewConversation: () => () => undefined,
    useTurnServices: () => services,
    useAbortStream: () => () => Promise.reject(new Error('unused')),
    useMessageCache: () => {
      throw new Error('A driven chat reads its own messages');
    },
    useFeedbackEnabled: () => false,
    useMessages: () => ({ messages: null, isLoading: false, isFetching: false }),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <ChatHostProvider host={host}>{children}</ChatHostProvider>
      </Provider>
    </QueryClientProvider>
  );
  const view = renderHook(
    ({ live }: { live: boolean }) => {
      const followed = useFollowChat({
        id,
        transport: harness.transport,
        loadMessages,
        live,
        endpoint: conversation.endpoint,
        onWithdrawn,
        beside,
        settlesLost: true,
        ...runs,
      });
      const contract = useDrivenContract({
        id,
        followed: canSend == null ? followed : { ...followed, canSend },
        index: SIDE_PANE,
      });
      return { followed, contract };
    },
    { wrapper, initialProps: { live: false } },
  );
  const ready = () => waitFor(() => expect(view.result.current.followed.isLoading).toBe(false));
  return { ...view, ...harness, store, services, loadMessages, onWithdrawn, ready };
}

describe('useDrivenContract', () => {
  it('sends the turn ask builds through the chat, and shows the generation it starts', async () => {
    const { result, sendMessages, streams, store, loadMessages, ready } = setup();
    await ready();

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    /** The body main chat posts for this turn: a new message under the tail of the branch. */
    const { trigger, payload } = sendMessages.mock.calls[0][0];
    expect(trigger).toBe('submit-message');
    expect(payload).toMatchObject({
      endpoint: EModelEndpoint.agents,
      conversationId,
      text: 'Next question',
      parentMessageId: 'response-1',
    });
    /** The rows ask shows meanwhile, written by the chat: the message and its empty reply. */
    const shown = result.current.contract.getMessages() ?? [];
    expect(ids(shown).slice(0, 2)).toEqual(['user-1', 'response-1']);
    expect(shown[2]).toMatchObject({ isCreatedByUser: true, text: 'Next question' });
    expect(shown[3]).toMatchObject({ isCreatedByUser: false, parentMessageId: shown[2].messageId });
    expect(result.current.contract.isSubmitting).toBe(true);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(true);

    const sent = shown[2];
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(opened('response-2'));
      streams[0].push(token('Answer'));
    });
    await settle();
    expect(ids(result.current.contract.getMessages())).toEqual([
      'user-1',
      'response-1',
      sent.messageId,
      'response-2',
    ]);
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Answer']);

    act(() => streams[0].push(final(sent, reply('response-2', 'Answer', sent.messageId))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    /** The turn's own final frame is its result: nothing is read back over it. */
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(false);
    expect(store.get(showStopButtonByIndex(SIDE_PANE))).toBe(false);
    expect(result.current.contract.readOnly).toBeUndefined();
    /** A stop here needs no generation named first: the chat finds the one to stop itself. */
    expect(result.current.contract.stopsUnnamed).toBe(true);
  });

  it('keeps one row for a message the server stores under an id of its own', async () => {
    const { result, streams, loadMessages, ready } = setup();
    await ready();

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const [, , sent, placeholder] = result.current.contract.getMessages() ?? [];

    /** What the server sends: the message under the id it saved it with, not the one drawn. */
    const stored = {
      messageId: 'user-2-stored',
      parentMessageId: sent.parentMessageId,
      conversationId,
      sender: 'User',
      text: 'Next question',
      isCreatedByUser: true,
    } as TMessage;
    act(() => {
      streams[0].push(created(stored, 'response-2'));
      streams[0].push(opened('response-2'));
      streams[0].push(token('Answer'));
    });
    await settle();

    /** The row drawn for the message is the turn's message: no second one beside it. */
    const streaming = result.current.contract.getMessages() ?? [];
    expect(ids(streaming)).toEqual(['user-1', 'response-1', sent.messageId, 'response-2']);
    /** And the reply drawn under it is the one that fills, as the turn drew it. */
    expect(streaming[3]).toMatchObject({
      parentMessageId: sent.messageId,
      sender: placeholder.sender,
    });
    expect(textOf(streaming, 'response-2')).toEqual(['Answer']);

    act(() => streams[0].push(final(stored, reply('response-2', 'Answer', stored.messageId))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    /** The stored message takes the drawn row's place, and the list is not read again. */
    expect(ids(result.current.contract.getMessages())).toEqual([
      'user-1',
      'response-1',
      'user-2-stored',
      'response-2',
    ]);
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it('says the list is settled when a turn ends on its own final frame, and not for one taken back', async () => {
    const onSettled = jest.fn();
    const { result, streams, loadMessages, ready } = setup({ beside: { onSettled } });
    await ready();
    /** The stored rows it opened with. */
    expect(onSettled).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = (result.current.contract.getMessages() ?? [])[2];
    const ending = final(sent, reply('response-2', 'Answer', sent.messageId));
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(ending);
    });
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    /** Told with the frame, holding the list that frame left, and without another read. */
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith((ending as { data: unknown }).data);
    expect(loadMessages).toHaveBeenCalledTimes(1);

    /** A turn stopped before the server kept anything of it leaves no reply to stamp. */
    act(() => {
      result.current.contract.ask({ text: 'Never mind' });
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    act(() =>
      streams[1].push({
        type: 'final',
        data: { final: true, earlyAbort: true, conversation: { conversationId } },
      } as ChatEvent),
    );
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('drops what was counted for a reply that fails, and keeps it for one that ends', async () => {
    const store = createStore();
    const usage = toResumableUsage(createUsageHandlers(store, createUsageCounters()));
    const { result, streams, ready } = setup({ store, beside: { usage } });
    await ready();
    const spent = (output_tokens: number, seq: number): ChatEvent =>
      ({
        type: 'token_usage',
        data: { input_tokens: 10, output_tokens, runId: 'run-2', seq },
      }) as ChatEvent;

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = (result.current.contract.getMessages() ?? [])[2];
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(spent(40, 0));
    });
    await waitFor(() => expect(store.get(pendingUsageFamily(conversationId)).output).toBe(40));
    expect(store.get(activeUsageResponseIdFamily(conversationId))).not.toBeNull();

    act(() => streams[0].push({ type: 'error', status: 500, data: { message: 'failed' } }));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await settle();

    /** Nothing of the failed reply is left to be added to the conversation's next one. */
    expect(store.get(pendingUsageFamily(conversationId))).toMatchObject({
      output: 0,
      eventCount: 0,
    });
    expect(store.get(activeUsageResponseIdFamily(conversationId))).toBeNull();

    /** A reply that ends on its final frame is settled by that frame instead. */
    const resetLive = jest.spyOn(usage, 'resetLive');
    act(() => {
      result.current.contract.ask({ text: 'Again' });
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    const again = (result.current.contract.getMessages() ?? []).find(
      (message) => message.text === 'Again',
    ) as TMessage;
    act(() => {
      streams[1].push(created(again, 'response-3'));
      streams[1].push(spent(25, 1));
      streams[1].push(final(again, reply('response-3', 'Answer', again.messageId)));
    });
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await settle();
    expect(resetLive).not.toHaveBeenCalled();
  });

  describe('what it says of the generations it follows', () => {
    const watch = () => {
      const onGeneration = jest.fn();
      const onRunEnd = jest.fn();
      return { onGeneration, onRunEnd, runs: { onGeneration, onRunEnd } };
    };

    it('names the generation a turn runs under, and how it ended once another turn can be taken', async () => {
      const { onGeneration, onRunEnd, runs } = watch();
      const { result, streams, ready } = setup({ runs });
      await ready();
      /** Whether the chat would take a turn at the moment it says the run ended. */
      const free: boolean[] = [];
      onRunEnd.mockImplementation(() => free.push(result.current.followed.canSend()));
      expect(onGeneration).not.toHaveBeenCalled();

      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 1 });
      expect(onRunEnd).not.toHaveBeenCalled();

      const sent = (result.current.contract.getMessages() ?? [])[2];
      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push(final(sent, reply('response-2', 'Answer', sent.messageId)));
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      expect(onRunEnd).toHaveBeenCalledWith({
        outcome: 'completed',
        generationCreatedAt: 3000,
        responseMessageId: 'response-2',
      });
      expect(free).toEqual([true]);
      /** No generation is named once it has ended. */
      expect(onGeneration).toHaveBeenLastCalledWith(null);
    });

    it('names the generation once the server has taken the turn, while its stream is still to open', async () => {
      const { onGeneration, runs } = watch();
      const harness = createTransport(2);
      /** The server answers the start; the stream it names has not opened yet. */
      let open: (() => void) | undefined;
      harness.sendMessages.mockImplementationOnce(async (request: ChatSendRequest) => {
        request.onGeneration?.({
          streamId: conversationId,
          generationCreatedAt: 3000,
          generationProtocolVersion: 2,
        });
        await new Promise<void>((resolve) => {
          open = resolve;
        });
        return { status: 'stream', stream: harness.open() };
      });
      const { result, streams, ready } = setup({ runs, harness });
      await ready();

      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(open).toBeDefined());

      expect(streams).toHaveLength(0);
      expect(onGeneration).toHaveBeenCalledTimes(1);
      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 2 });

      /** The stream opening names the same generation, so nothing of the turn starts over. */
      act(() => open?.());
      await waitFor(() => expect(streams).toHaveLength(1));
      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 2 });
      expect(onGeneration).not.toHaveBeenCalledWith(null);
    });

    it('says a turn failed, and that one stopped before the server kept it was taken back', async () => {
      const { onRunEnd, runs } = watch();
      const { result, streams, ready } = setup({ runs });
      await ready();

      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      act(() => streams[0].push({ type: 'error', data: { message: 'failed' } }));
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(onRunEnd).toHaveBeenLastCalledWith(
        expect.objectContaining({ outcome: 'error', generationCreatedAt: 3000 }),
      );

      act(() => {
        result.current.contract.ask({ text: 'Never mind' });
      });
      await waitFor(() => expect(streams).toHaveLength(2));
      act(() =>
        streams[1].push({
          type: 'final',
          data: { final: true, earlyAbort: true, conversation: { conversationId } },
        } as ChatEvent),
      );
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(2));
      expect(onRunEnd).toHaveBeenLastCalledWith(
        expect.objectContaining({ outcome: 'aborted', generationCreatedAt: 3000 }),
      );
    });

    it('says a turn was stopped when its final frame only marks the reply unfinished', async () => {
      const { onRunEnd, runs } = watch();
      const { result, streams, ready } = setup({ runs });
      await ready();
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      const sent = (result.current.contract.getMessages() ?? [])[2];

      /** What the server sends for a stop that lands just before completion: no `aborted`. */
      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push(
          final(sent, { ...reply('response-2', 'Part of an', sent.messageId), unfinished: true }),
        );
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(onRunEnd).toHaveBeenCalledWith({
        outcome: 'aborted',
        generationCreatedAt: 3000,
        responseMessageId: 'response-2',
      });
    });

    it('says nothing ended while a dropped stream is attached to again, then says it once', async () => {
      const { onGeneration, onRunEnd, runs } = watch();
      const { result, streams, setStatus, loadMessages, ready } = setup({ runs });
      await ready();
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      const sent = (result.current.contract.getMessages() ?? [])[2];

      setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push({ type: 'error', status: 0 });
      });
      await waitFor(() => expect(streams).toHaveLength(2));
      expect(onRunEnd).not.toHaveBeenCalled();
      /** The same generation, still named: its controls stay addressed to it. */
      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 1 });

      loadMessages.mockResolvedValue([
        user,
        reply('response-1', 'Hi'),
        sent,
        reply('response-2', 'Whole', sent.messageId),
      ]);
      setStatus({ active: false });
      act(() => streams[1].push(final(sent, reply('response-2', 'Whole', sent.messageId))));
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed', responseMessageId: 'response-2' }),
      );
      await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
      expect(onGeneration).toHaveBeenLastCalledWith(null);
    });

    it('leaves a generation named when the chat is let go of while it runs', async () => {
      const { onGeneration, onRunEnd, runs } = watch();
      const { streams, setStatus, rerender, unmount, ready } = setup({ runs });
      await ready();
      setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
      rerender({ live: true });
      await waitFor(() => expect(streams).toHaveLength(1));
      await waitFor(() => expect(onGeneration).toHaveBeenCalledTimes(1));

      /**
       * Its stream drops, and the panel closes (or the conversation moves to the main chat)
       * while this chat waits to attach again. The run goes on, and whoever shows the
       * conversation next addresses it by the same name.
       */
      act(() => streams[0].push({ type: 'error', status: 0 }));
      await settle();
      unmount();
      await settle();

      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 1 });
      expect(onGeneration).not.toHaveBeenCalledWith(null);
      expect(onRunEnd).not.toHaveBeenCalled();
    });

    it('says a generation it did not start ended, once its stored rows are read', async () => {
      const { onGeneration, onRunEnd, runs } = watch();
      const { streams, setStatus, loadMessages, rerender, ready } = setup({ runs });
      await ready();

      setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
      rerender({ live: true });
      await waitFor(() => expect(streams).toHaveLength(1));
      await waitFor(() =>
        expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 1 }),
      );

      const reads = loadMessages.mock.calls.length;
      setStatus({ active: false });
      act(() => streams[0].push(final(user, reply('response-1', 'Hi'))));
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(loadMessages.mock.calls.length).toBeGreaterThan(reads);
      expect(onRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
    });
  });

  describe('a run it is let go of, or finds already over', () => {
    const watch = () => {
      const onStopped = jest.fn();
      const onDetached = jest.fn();
      const onIdle = jest.fn();
      const onRunEnd = jest.fn();
      return {
        onStopped,
        onDetached,
        onIdle,
        onRunEnd,
        runs: { onStopped, onDetached, onIdle, onRunEnd },
      };
    };
    const start = async ({ result, streams }: ReturnType<typeof setup>, text = 'Next question') => {
      act(() => {
        result.current.contract.ask({ text });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      return (result.current.contract.getMessages() ?? [])[2];
    };

    it('names a run still being written when it is let go of, by the turn the server named', async () => {
      const { onDetached, runs } = watch();
      const view = setup({ runs });
      await view.ready();
      const sent = await start(view);
      /** The server stores the message under an id of its own, which is the one that names the turn. */
      act(() => view.streams[0].push(created({ ...sent, messageId: 'user-stored' }, 'response-2')));
      await settle();

      view.unmount();

      expect(onDetached).toHaveBeenCalledTimes(1);
      expect(onDetached).toHaveBeenCalledWith({
        userMessageId: 'user-stored',
        responseMessageId: 'response-2',
        generationCreatedAt: 3000,
      });
    });

    it('names a run it only found running, from the snapshot it joined on', async () => {
      const { onDetached, runs } = watch();
      const harness = createTransport();
      harness.setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
      const view = setup({ runs, harness });
      await view.ready();
      await waitFor(() => expect(view.streams).toHaveLength(1));
      act(() =>
        view.streams[0].push({
          type: 'sync',
          data: {
            sync: true,
            resumeState: {
              conversationId,
              responseMessageId: 'response-9',
              userMessage: { ...user, messageId: 'user-9', parentMessageId: 'response-1' },
              runSteps: [],
              aggregatedContent: [],
            },
          },
        } as ChatEvent),
      );
      await settle();

      view.unmount();

      expect(onDetached).toHaveBeenCalledWith({
        userMessageId: 'user-9',
        responseMessageId: 'response-9',
        generationCreatedAt: 3000,
      });
    });

    it('names no run that is over, that the server has not named, that reruns a turn, or that was stopped', async () => {
      /** Over: its end was said, so there is nothing left to read later. */
      const over = watch();
      const ended = setup({ runs: over.runs });
      await ended.ready();
      const asked = await start(ended);
      act(() => {
        ended.streams[0].push(created(asked, 'response-2'));
        ended.streams[0].push(final(asked, reply('response-2', 'Answer', asked.messageId)));
      });
      await waitFor(() => expect(over.onRunEnd).toHaveBeenCalledTimes(1));
      ended.unmount();
      expect(over.onDetached).not.toHaveBeenCalled();

      /** Not named yet: no stored reply could be matched to it. */
      const unnamed = watch();
      const early = setup({ runs: unnamed.runs });
      await early.ready();
      await start(early);
      early.unmount();
      expect(unnamed.onDetached).not.toHaveBeenCalled();

      /** A rerun: the list it leaves is not one a queued turn should follow unseen. */
      const again = watch();
      const rerun = setup({ runs: again.runs });
      await rerun.ready();
      act(() => {
        rerun.result.current.contract.regenerate({ parentMessageId: 'user-1' });
      });
      await waitFor(() => expect(rerun.streams).toHaveLength(1));
      act(() => rerun.streams[0].push(created(user, 'response-1b')));
      await settle();
      rerun.unmount();
      expect(again.onDetached).not.toHaveBeenCalled();

      /** Stopped: said so when asked, and what is queued behind it is the reader's to send. */
      const halted = watch();
      const stopped = setup({ runs: halted.runs });
      await stopped.ready();
      const sent = await start(stopped);
      act(() => stopped.streams[0].push(created(sent, 'response-2')));
      await settle();
      await act(async () => {
        void stopped.result.current.contract.stopGenerating();
        await Promise.resolve();
      });
      expect(halted.onStopped).toHaveBeenCalledWith({ createdAt: 3000, protocolVersion: 1 });
      stopped.unmount();
      expect(halted.onDetached).not.toHaveBeenCalled();
    });

    it('says when it opens with nothing running, with the rows it read, and not when a run is on', async () => {
      const idle = watch();
      const quiet = setup({ runs: idle.runs });
      await quiet.ready();
      await settle();
      expect(idle.onIdle).toHaveBeenCalledTimes(1);
      expect(idle.onIdle).toHaveBeenCalledWith([user, reply('response-1', 'Hi')]);

      const busy = watch();
      const harness = createTransport();
      harness.setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
      const running = setup({ runs: busy.runs, harness });
      await running.ready();
      await waitFor(() => expect(running.streams).toHaveLength(1));
      await settle();
      expect(busy.onIdle).not.toHaveBeenCalled();
    });
  });

  describe('a run whose stream is lost', () => {
    const record = () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const log =
        (name: string, result?: unknown) =>
        (...args: unknown[]): unknown => {
          calls.push([name, ...args]);
          return result;
        };
      const steers = {
        resolve: log('resolve', []),
        markLiveApplied: log('markLive'),
        update: log('update'),
        seed: log('seed'),
        settleApplied: log('settle'),
        appliedIds: log('appliedIds', ['steer-taken']),
        adoptPromoted: log('adopt', []),
        convertToQueued: log('toQueued'),
        convertLocalToQueued: log('sweep'),
        restoreQueued: log('restore'),
        blockRecovery: log('block'),
        isRecoveryHeld: () => false,
      } as unknown as NonNullable<NonNullable<FollowChatOptions['beside']>['steers']>;
      return { calls, steers };
    };
    /** Sends a turn and lets the server name it. */
    const begin = async (view: ReturnType<typeof setup>) => {
      act(() => {
        view.result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(view.streams).toHaveLength(1));
      const sent = (view.result.current.contract.getMessages() ?? [])[2];
      act(() => view.streams[0].push(created(sent, 'response-2')));
      await settle();
      return sent;
    };
    /** Drops the stream in hand, and each one opened to attach again, `times` in all. */
    const dropping = async (view: ReturnType<typeof setup>, times: number) => {
      for (let dropped = 0; dropped < times; dropped++) {
        await waitFor(() => expect(view.streams.length).toBeGreaterThan(dropped));
        act(() => view.streams[dropped].push({ type: 'error', status: 0 }));
      }
    };
    const whole = (sent: TMessage) => [
      user,
      reply('response-1', 'Hi'),
      sent,
      reply('response-2', 'Whole', sent.messageId),
    ];

    describe('for a chat opened on a reply already running', () => {
      const running = {
        active: true,
        streamId: conversationId,
        createdAt: 3000,
        generationProtocolVersion: 2,
      };
      const named = {
        streamId: conversationId,
        generationCreatedAt: 3000,
        generationProtocolVersion: 2,
      };
      const opened = () => {
        const onGeneration = jest.fn();
        const onRunEnd = jest.fn();
        const harness = createTransport(2);
        harness.setStatus(running);
        return { harness, onGeneration, onRunEnd, runs: { onGeneration, onRunEnd } };
      };

      it('is looked for again when its stream is gone while the server still says it runs', async () => {
        const { harness, onGeneration, onRunEnd, runs } = opened();
        /** The stream's record is briefly lost: the generation is named, and nothing opens. */
        harness.reconnectToStream.mockImplementationOnce(async (request) => {
          request?.onGeneration?.(named);
          return null;
        });
        const view = setup({ runs, harness });
        await view.ready();

        await waitFor(() => expect(view.streams).toHaveLength(1));
        expect(harness.reconnectToStream).toHaveBeenCalledTimes(2);
        expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 2 });
        expect(onGeneration).not.toHaveBeenCalledWith(null);
        expect(onRunEnd).not.toHaveBeenCalled();
        expect(view.result.current.followed.isUnattached).toBe(false);
      });

      it('is settled by the server’s word when its stream could never be had', async () => {
        const { harness, onGeneration, onRunEnd, runs } = opened();
        harness.reconnectToStream.mockImplementation(async (request) => {
          request?.onGeneration?.(named);
          /** Over by the time the last retry has failed. */
          if (harness.reconnectToStream.mock.calls.length > MAX_RETRIES) {
            harness.setStatus({ ...running, active: false, status: 'complete' });
          }
          throw Object.assign(new Error('The generation stream could not be opened'), {
            code: 'ERR_BAD_RESPONSE',
            response: { status: 502 },
          });
        });
        const view = setup({ runs, harness });
        await view.ready();

        await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(harness.reconnectToStream).toHaveBeenCalledTimes(MAX_RETRIES + 1);
        expect(onRunEnd).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'completed', generationCreatedAt: 3000 }),
        );
        expect(onGeneration).toHaveBeenLastCalledWith(null);
      });
    });

    it('is taken as stopped when nothing is running by the time it is looked for again', async () => {
      const { calls, steers } = record();
      const onRunEnd = jest.fn();
      const onIdle = jest.fn();
      const view = setup({ beside: { steers }, runs: { onRunEnd, onIdle } });
      await view.ready();
      const sent = await begin(view);
      calls.length = 0;
      onIdle.mockClear();
      view.loadMessages.mockResolvedValue(whole(sent));
      /** Even when the server still says it completed: main chat's rule for a stream that is gone. */
      view.setStatus({ active: false, status: 'complete', createdAt: 3000 });

      await dropping(view, 1);
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt', 'sweep']);
      expect(calls[1]).toEqual(['settle', conversationId, whole(sent)]);
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'aborted', generationCreatedAt: 3000 }),
      );
      /**
       * Before that, the caller is handed the rows the run left, with nothing running: one that
       * had remembered this run when it stopped watching it can read its end from them.
       */
      expect(onIdle).toHaveBeenCalledTimes(1);
      expect(ids(onIdle.mock.calls[0][0])).toEqual(ids(whole(sent)));
      expect(onIdle.mock.invocationCallOrder[0]).toBeLessThan(onRunEnd.mock.invocationCallOrder[0]);
    });

    it('follows the generation that is running instead, when one is by the time it is looked for', async () => {
      const onRunEnd = jest.fn();
      const onIdle = jest.fn();
      const onGeneration = jest.fn();
      const view = setup({ runs: { onRunEnd, onIdle, onGeneration } });
      await view.ready();
      await begin(view);
      onIdle.mockClear();
      /** Nothing to attach to when it is looked for; a newer run by the time its rows are read. */
      const reads = view.loadMessages.mock.calls.length;
      const newer = { active: true, streamId: conversationId, createdAt: 9000 };
      view.transport.getStatus = async () =>
        view.loadMessages.mock.calls.length > reads ? newer : { active: false };
      view.reconnectToStream.mockImplementation(async () =>
        view.loadMessages.mock.calls.length > reads ? view.open() : null,
      );

      await dropping(view, 1);

      /** No rows are handed over as the lost run's, and nothing is said to have ended. */
      await waitFor(() => expect(view.streams).toHaveLength(2));
      expect(onIdle).not.toHaveBeenCalled();
      expect(onRunEnd).not.toHaveBeenCalled();
      expect(onGeneration).not.toHaveBeenLastCalledWith(null);
    });

    it('sweeps no waiting steers when nothing proved the run over to a client of its protocol', async () => {
      const { calls, steers } = record();
      const onRunEnd = jest.fn();
      const harness = createTransport(2);
      const view = setup({ beside: { steers }, runs: { onRunEnd }, harness });
      await view.ready();
      const sent = await begin(view);
      calls.length = 0;
      view.loadMessages.mockResolvedValue(whole(sent));
      /** Gone when it is looked for, and its status cannot be read once its rows are in. */
      const reads = view.loadMessages.mock.calls.length;
      view.transport.getStatus = async () => {
        if (view.loadMessages.mock.calls.length > reads) {
          throw new Error('The status route is down');
        }
        return { active: false };
      };

      await dropping(view, 1);
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      /** What the stored rows hold is settled; a chip still waiting may yet be taken, and stays. */
      expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt']);
      expect(onRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
    });

    it('settles nothing on the word of a server that does not speak the generation’s protocol', async () => {
      const { calls, steers } = record();
      const onRunEnd = jest.fn();
      const onGeneration = jest.fn();
      const harness = createTransport(2);
      const view = setup({ beside: { steers }, runs: { onRunEnd, onGeneration }, harness });
      await view.ready();
      const sent = await begin(view);
      calls.length = 0;
      view.setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
      await dropping(view, MAX_RETRIES + 1);
      await waitFor(() => expect(view.streams.length).toBe(MAX_RETRIES + 2));

      /** Past the last retry, an older responder says nothing is running: it cannot say that of this run. */
      view.loadMessages.mockResolvedValue(whole(sent));
      view.setStatus({ active: false, status: 'complete', createdAt: 3000 });
      act(() => view.streams[MAX_RETRIES + 1].push({ type: 'error', status: 0 }));
      await settle();
      await settle();
      expect(onRunEnd).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(onGeneration).toHaveBeenLastCalledWith({ createdAt: 3000, protocolVersion: 2 });

      /** A responder that speaks it says the same, and now it is settled. */
      view.setStatus({
        active: false,
        status: 'complete',
        createdAt: 3000,
        generationProtocolVersion: 2,
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt', 'sweep']);
      expect(onGeneration).toHaveBeenLastCalledWith(null);
    });

    it('keeps the generation while it is looked for again, so a later round can still settle it', async () => {
      const onRunEnd = jest.fn();
      const view = setup({ runs: { onRunEnd } });
      await view.ready();
      const sent = await begin(view);
      view.setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
      await dropping(view, MAX_RETRIES + 2);
      const opened = view.reconnectToStream.mock.calls.length;

      /** The next round never opens a stream at all, and by its end the run has finished. */
      view.reconnectToStream.mockRejectedValue(new Error('The stream route is down'));
      await waitFor(() =>
        expect(view.reconnectToStream.mock.calls.length).toBeGreaterThan(opened + 1),
      );
      view.loadMessages.mockResolvedValue(whole(sent));
      view.setStatus({ active: false, status: 'complete', createdAt: 3000 });

      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(onRunEnd).toHaveBeenCalledWith(expect.objectContaining({ generationCreatedAt: 3000 }));
    });

    it('is settled by the server’s word once reconnecting has failed past its last retry', async () => {
      const { calls, steers } = record();
      const onRunEnd = jest.fn();
      const onGeneration = jest.fn();
      const view = setup({ beside: { steers }, runs: { onRunEnd, onGeneration } });
      await view.ready();
      const sent = await begin(view);
      calls.length = 0;
      /** Still running as far as the server says, and every attachment drops. */
      view.setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
      await dropping(view, MAX_RETRIES + 1);
      expect(onRunEnd).not.toHaveBeenCalled();

      /** By the last failure it has finished, and the server says how. */
      await waitFor(() => expect(view.streams.length).toBe(MAX_RETRIES + 2));
      view.loadMessages.mockResolvedValue(whole(sent));
      view.setStatus({ active: false, status: 'complete', createdAt: 3000 });
      act(() => view.streams[MAX_RETRIES + 1].push({ type: 'error', status: 0 }));
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      expect(ids(view.result.current.contract.getMessages())).toEqual(ids(whole(sent)));
      expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt', 'sweep']);
      expect(calls[1]).toEqual(['settle', conversationId, whole(sent)]);
      expect(onRunEnd).toHaveBeenCalledWith({
        outcome: 'completed',
        generationCreatedAt: 3000,
        responseMessageId: 'response-2',
      });
      /** It is over: nothing is addressed as running, and the next turn can be taken. */
      expect(onGeneration).toHaveBeenLastCalledWith(null);
      await waitFor(() => expect(view.result.current.contract.isSubmitting).toBe(false));
      expect(view.result.current.followed.isUnattached).toBe(false);
      expect(view.result.current.followed.canSend()).toBe(true);
    });

    it('is looked for again, and nothing is said of it, while the server says it is still running', async () => {
      const { calls, steers } = record();
      const onRunEnd = jest.fn();
      const view = setup({ beside: { steers }, runs: { onRunEnd } });
      await view.ready();
      await begin(view);
      calls.length = 0;
      view.setStatus({ active: true, streamId: conversationId, createdAt: 3000 });

      await dropping(view, MAX_RETRIES + 2);

      /** Past the last retry, and still asked for: the connection gave up, not the generation. */
      await waitFor(() => expect(view.streams.length).toBeGreaterThan(MAX_RETRIES + 2));
      expect(onRunEnd).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  });

  describe('the reader’s steers and queue when a run ends without its reply', () => {
    /** Main chat's steer bookkeeping, recording what it is called with and in what order. */
    const record = (held = new Set<string>()) => {
      const calls: Array<[string, ...unknown[]]> = [];
      const log =
        (name: string, result?: unknown) =>
        (...args: unknown[]): unknown => {
          calls.push([name, ...args]);
          return result;
        };
      const steers = {
        resolve: log('resolve', []),
        markLiveApplied: log('markLive'),
        update: log('update'),
        seed: log('seed'),
        settleApplied: log('settle'),
        appliedIds: log('appliedIds', ['steer-taken']),
        adoptPromoted: log('adopt', ['steer-promoted']),
        convertToQueued: log('toQueued'),
        convertLocalToQueued: log('sweep'),
        restoreQueued: log('restore'),
        blockRecovery: log('block'),
        isRecoveryHeld: (...args: unknown[]) => {
          calls.push(['held?', ...args]);
          return held.has(args[1] as string);
        },
      } as unknown as NonNullable<NonNullable<FollowChatOptions['beside']>['steers']>;
      return { calls, steers, named: (name: string) => calls.filter(([call]) => call === name) };
    };
    const watch = () => {
      const onGeneration = jest.fn();
      const onRunEnd = jest.fn();
      return { onGeneration, onRunEnd, runs: { onGeneration, onRunEnd } };
    };
    /** A frame that only says the run is over: none of its messages, and why. */
    const control = (data: Record<string, unknown>): ChatEvent =>
      ({
        type: 'final',
        data: {
          final: true,
          reconcile: true,
          generationProtocolVersion: 2,
          conversation: { conversationId },
          ...data,
        },
      }) as ChatEvent;
    const refusal = (status: number, data: Record<string, unknown>) =>
      Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data, headers: {} },
      });

    it('settles steers against the rows it reads, not against a frame that carries none', async () => {
      const { calls, steers, named } = record();
      const { onRunEnd, runs } = watch();
      const { result, streams, loadMessages, ready } = setup({ beside: { steers }, runs });
      await ready();
      calls.length = 0;
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      const sent = (result.current.contract.getMessages() ?? [])[2];
      const stored = [
        user,
        reply('response-1', 'Hi'),
        sent,
        reply('response-2', 'Whole', sent.messageId),
      ];
      loadMessages.mockResolvedValue(stored);

      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push(
          control({
            reconcileReason: 'terminal_payload_missing',
            terminalStatus: 'complete',
            promotedSteers: [{ steerId: 'steer-promoted' }],
          }),
        );
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      /** Nothing was swept on the frame's word; the stored rows decided, once read. */
      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(named('toQueued')).toEqual([]);
      expect(calls.map(([name]) => name)).toEqual(['appliedIds', 'settle', 'adopt', 'sweep']);
      expect(calls[0][1]).toEqual(stored);
      expect(calls[1]).toEqual(['settle', conversationId, stored]);
      expect(calls[2]).toEqual(['adopt', conversationId, [{ steerId: 'steer-promoted' }]]);
      expect(calls[3]).toEqual([
        'sweep',
        conversationId,
        {
          excludeSteerIds: new Set(['steer-taken', 'steer-promoted']),
          generationProtocolVersion: 1,
        },
      ]);
      /** The server says it completed, and the reply the rows hold is the one it left. */
      expect(onRunEnd).toHaveBeenCalledWith({
        outcome: 'completed',
        generationCreatedAt: 3000,
        responseMessageId: 'response-2',
        reconcileReason: 'terminal_payload_missing',
      });
    });

    it('sweeps nothing after such a frame while another generation is already running', async () => {
      const { calls, steers } = record();
      const { onRunEnd, runs } = watch();
      const { result, streams, setStatus, ready } = setup({ beside: { steers }, runs });
      await ready();
      calls.length = 0;
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      const sent = (result.current.contract.getMessages() ?? [])[2];

      /** The server has started the next turn itself: its frames settle the steers. */
      setStatus({ active: true, streamId: conversationId, createdAt: 6000 });
      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push(
          control({ reconcileReason: 'terminal_payload_missing', terminalStatus: 'complete' }),
        );
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

      expect(calls).toEqual([]);
    });

    it('says a run whose stop could not be saved was stopped, and why', async () => {
      const { steers } = record();
      const { onRunEnd, runs } = watch();
      const { result, streams, ready } = setup({ beside: { steers }, runs });
      await ready();
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(streams).toHaveLength(1));
      const sent = (result.current.contract.getMessages() ?? [])[2];

      act(() => {
        streams[0].push(created(sent, 'response-2'));
        streams[0].push(
          control({ reconcileReason: 'abort_persistence_failed', terminalStatus: 'aborted' }),
        );
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(onRunEnd).toHaveBeenCalledWith({
        outcome: 'aborted',
        generationCreatedAt: 3000,
        responseMessageId: undefined,
        reconcileReason: 'abort_persistence_failed',
      });
    });

    it('says a start the server answered as already settled was not a completed run', async () => {
      const { onRunEnd, runs } = watch();
      const { result, sendMessages, ready } = setup({ runs });
      await ready();
      sendMessages.mockResolvedValueOnce({
        status: 'settled',
        conversationId,
        generationProtocolVersion: 2,
      });
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(onRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
    });

    it('puts a turn back in the queue when the server refuses its start, and not when it may have started', async () => {
      const { calls, steers, named } = record();
      const { onRunEnd, runs } = watch();
      const { result, sendMessages, ready } = setup({ beside: { steers }, runs });
      await ready();
      calls.length = 0;

      sendMessages.mockRejectedValueOnce(refusal(403, { message: 'Not allowed' }));
      act(() => {
        result.current.contract.ask({ text: 'Next question' });
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
      expect(named('restore')).toHaveLength(1);
      expect(named('restore')[0][1]).toMatchObject({ userMessage: { text: 'Next question' } });
      expect(named('block')).toEqual([]);
      /** The refusal is the turn's reply, and nothing queued behind it is sent on its account. */
      expect(onRunEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));

      /** A failure that may have started the turn puts nothing back: it could be sent twice. */
      sendMessages.mockRejectedValueOnce(refusal(502, { message: 'Bad gateway' }));
      act(() => {
        result.current.contract.ask({ text: 'Again' });
      });
      await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(2));
      expect(named('restore')).toHaveLength(1);
    });

    it('leaves nothing of a turn another generation got ahead of, and follows that generation', async () => {
      const { calls, steers, named } = record();
      const { onRunEnd, runs } = watch();
      const { result, sendMessages, streams, setStatus, onWithdrawn, ready } = setup({
        beside: { steers },
        runs,
      });
      await ready();
      calls.length = 0;

      /** The place this turn was queued for was taken by a generation started elsewhere. */
      setStatus({ active: true, streamId: conversationId, createdAt: 5000 });
      sendMessages.mockRejectedValueOnce(
        refusal(409, {
          status: 'predecessor_mismatch',
          code: 'GENERATION_PREDECESSOR_MISMATCH',
          streamId: conversationId,
          conversationId,
          generationCreatedAt: 5000,
          active: true,
        }),
      );
      act(() => {
        result.current.contract.ask({ text: 'Queued follow-up' });
      });

      /** Back in the queue behind the winner, which is the generation now followed. */
      await waitFor(() => expect(streams).toHaveLength(1));
      expect(named('restore')).toHaveLength(1);
      expect(named('restore')[0].slice(1)).toEqual([
        expect.objectContaining({
          userMessage: expect.objectContaining({ text: 'Queued follow-up' }),
        }),
        5000,
      ]);
      /** Neither its message nor a failure stays in the list, and no run is said to have ended. */
      expect(ids(result.current.contract.getMessages())).toEqual(['user-1', 'response-1']);
      expect(result.current.followed.error).toBeUndefined();
      expect(onRunEnd).not.toHaveBeenCalled();
      /** The words are in the queue, so they are not also handed back to the composer. */
      expect(onWithdrawn).not.toHaveBeenCalled();
    });

    describe('for a turn that replays a steer the server had parked', () => {
      /** A turn from the reader's queue that is the recovery of the parked steer `steer-parked`. */
      const replay = (result: { current: { contract: ReturnType<typeof useDrivenContract> } }) =>
        act(() => {
          result.current.contract.ask(
            { text: 'Parked by the server' },
            { overrideRecoverySteerId: 'steer-parked' },
          );
        });
      const source = [{ steerId: 'steer-parked', text: 'Parked by the server' }];
      const letGo = {
        active: false,
        generationProtocolVersion: 2,
        unrecoveredSteers: source,
      } as ChatStreamStatus;

      it('sends nothing when the reader has already dealt with that steer', async () => {
        const { steers, named } = record(new Set(['steer-parked']));
        const { onRunEnd, runs } = watch();
        const { result, sendMessages, ready } = setup({ beside: { steers }, runs });
        await ready();

        replay(result);
        await waitFor(() => expect(named('restore')).toHaveLength(1));
        await settle();

        expect(named('held?')).toEqual([['held?', conversationId, 'steer-parked']]);
        expect(sendMessages).not.toHaveBeenCalled();
        expect(ids(result.current.contract.getMessages())).toEqual(['user-1', 'response-1']);
        expect(result.current.followed.error).toBeUndefined();
        expect(onRunEnd).not.toHaveBeenCalled();
      });

      it('puts the steer back when a start that may have run turns out not to have kept it', async () => {
        const { steers, named } = record();
        const { onRunEnd, runs } = watch();
        const { result, sendMessages, setStatus, ready } = setup({ beside: { steers }, runs });
        await ready();
        setStatus(letGo);
        sendMessages.mockRejectedValueOnce(refusal(502, { message: 'Bad gateway' }));

        replay(result);
        await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));

        /** Not as a refused start, which it was not, but on the server's word after the end. */
        expect(named('restore')).toEqual([]);
        expect(named('toQueued')).toEqual([
          [
            'toQueued',
            conversationId,
            source,
            { generationProtocolVersion: 2, allowPreviouslyConvertedIds: ['steer-parked'] },
          ],
        ]);
      });

      it('puts the steer back when its stream reports the failure, and not for a turn that replays none', async () => {
        const { calls, steers, named } = record();
        const { onRunEnd, runs } = watch();
        const harness = createTransport(2);
        const { result, streams, ready } = setup({ beside: { steers }, runs, harness });
        await ready();
        harness.setStatus(letGo);
        const failure = {
          type: 'error',
          data: { message: 'failed', generationProtocolVersion: 2 },
        } as ChatEvent;

        replay(result);
        await waitFor(() => expect(streams).toHaveLength(1));
        act(() => streams[0].push(failure));
        await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
        expect(named('toQueued')).toHaveLength(1);
        expect(named('toQueued')[0][2]).toEqual(source);

        calls.length = 0;
        act(() => {
          result.current.contract.ask({ text: 'An ordinary turn' });
        });
        await waitFor(() => expect(streams).toHaveLength(2));
        act(() => streams[1].push(failure));
        await waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(2));
        expect(named('toQueued')).toEqual([]);
      });
    });

    it('settles steers left waiting by a run that ended while the conversation was not open', async () => {
      const { calls, steers } = record();
      const harness = createTransport();
      const parked = { steerId: 'steer-parked', text: 'Parked by the server' };
      /** A pause that expired: reported over before the server has parked what it accepted. */
      const accepted = { steerId: 'steer-accepted', text: 'Accepted, not parked yet' };
      harness.setStatus({
        active: false,
        generationProtocolVersion: 2,
        unrecoveredSteers: [parked],
        resumeState: { pendingSteers: [parked, accepted] },
      } as ChatStreamStatus);
      const { ready } = setup({ beside: { steers }, harness });
      await ready();
      await settle();

      /**
       * Both lists, each steer once, under the protocol the status speaks: no stream is open to
       * have named one. Then what the stored rows hold is settled, and no chip is left waiting.
       */
      const stored = [user, reply('response-1', 'Hi')];
      expect(calls).toEqual([
        ['toQueued', conversationId, [parked, accepted], { generationProtocolVersion: 2 }],
        ['settle', conversationId, stored],
        ['seed', conversationId, []],
      ]);
    });

    it('restores nothing, and still clears stale chips, when nothing was left behind', async () => {
      const { calls, steers } = record();
      const { ready } = setup({ beside: { steers } });
      await ready();
      await settle();

      expect(calls.map(([name]) => name)).toEqual(['settle', 'seed']);
    });

    it('settles nothing from stored rows while a generation is running, or after one that ended on its reply', async () => {
      const running = record();
      const harness = createTransport();
      harness.setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
      const attached = setup({ beside: { steers: running.steers }, harness });
      await attached.ready();
      await waitFor(() => expect(attached.streams).toHaveLength(1));
      await settle();
      /** Its own frames settle them: nothing is swept on the strength of rows mid-run. */
      expect(running.named('sweep')).toEqual([]);

      /** It ends on a final frame with the reply in it, which settles them as it is applied. */
      harness.setStatus({ active: false });
      act(() => attached.streams[0].push(final(user, reply('response-1', 'Hi'))));
      await waitFor(() => expect(attached.result.current.followed.isFollowing).toBe(false));
      await settle();
      expect(running.named('sweep')).toEqual([['sweep', conversationId]]);
    });
  });

  it("drops the files another conversation left staged in the pane, and keeps this one's", async () => {
    const staged = new Map([['file-1', { file_id: 'file-1', progress: 1 } as ExtendedFile]]);
    const first = setup();
    await first.ready();
    act(() => first.result.current.contract.setFiles(staged));
    expect(first.result.current.contract.files.size).toBe(1);

    /** The same conversation drawn again, as when the layout moves the panel: still staged. */
    const again = setup({ store: first.store });
    await again.ready();
    expect(again.result.current.contract.files.size).toBe(1);

    /** Another conversation in the pane: nothing of the first one's goes out with its turns. */
    const other = setup({ store: first.store, id: 'another-conversation' });
    await other.ready();
    expect(other.result.current.contract.files.size).toBe(0);
  });

  it('regenerates and continues a reply as main chat does', async () => {
    const { result, sendMessages, streams, ready } = setup();
    await ready();

    act(() => {
      result.current.contract.regenerate({ parentMessageId: 'user-1' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[0][0]).toMatchObject({
      trigger: 'regenerate-message',
      payload: { isRegenerate: true, text: 'Hello', manualSkills: ['skill-a'] },
    });
    /** No second user message: the empty reply is drawn under the one replayed. */
    const rerun = result.current.contract.getMessages() ?? [];
    expect(rerun.filter((message) => message.isCreatedByUser)).toHaveLength(1);
    expect(rerun[rerun.length - 1]).toMatchObject({ parentMessageId: 'user-1', content: [] });

    act(() => streams[0].push(final(user, reply('response-1b', 'Again'))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    act(() => {
      result.current.contract.handleContinue({
        preventDefault: () => undefined,
      } as React.MouseEvent<HTMLButtonElement>);
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(sendMessages.mock.calls[1][0]).toMatchObject({
      trigger: 'continue-message',
      payload: { isContinued: true, text: 'Hello' },
    });
  });

  it('stops the generation the chat is running', async () => {
    const { result, abort, streams, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    await act(async () => {
      void result.current.contract.stopGenerating();
      await Promise.resolve();
    });

    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(abort.mock.calls[0]).toMatchObject([
      { endpoint: EModelEndpoint.agents, streamId: conversationId, generationCreatedAt: 3000 },
    ]);
  });

  it('attaches again to a turn whose stream dropped, then takes the stored result', async () => {
    const { result, streams, reconnectToStream, setStatus, loadMessages, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = (result.current.contract.getMessages() ?? [])[2];
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(opened('response-2'));
      streams[0].push(token('Half'));
    });
    await settle();

    /** The stream ends with no final frame while the generation runs on. */
    setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
    const { chat, canSend } = result.current.followed;
    const free: boolean[] = [];
    const unsubscribe = chat?.subscribe(() => free.push(canSend()));
    act(() => streams[0].close());
    await waitFor(() => expect(reconnectToStream).toHaveBeenCalledTimes(1), { timeout: 4000 });
    /**
     * Still the reader's turn in flight, so nothing else may be sent over it: not once the page
     * shows it attached again, and not in the moments between, when the chat reads as stopped.
     */
    unsubscribe?.();
    expect(free.length).toBeGreaterThan(0);
    expect(free).not.toContain(true);
    expect(result.current.contract.isSubmitting).toBe(true);
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Half']);

    const stored = [
      user,
      reply('response-1', 'Hi'),
      sent,
      reply('response-2', 'Whole', sent.messageId),
    ];
    loadMessages.mockResolvedValue(stored);
    setStatus({ active: false });
    act(() => streams[1].push(final(sent, reply('response-2', 'Whole', sent.messageId))));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Whole']);
  });

  it('reads the stored messages when the server had already run the turn', async () => {
    const { result, sendMessages, loadMessages, ready } = setup();
    await ready();
    const stored = [user, reply('response-1', 'Hi'), reply('response-2', 'Already answered')];
    loadMessages.mockResolvedValue(stored);
    sendMessages.mockResolvedValueOnce({
      status: 'settled',
      conversationId,
      generationProtocolVersion: 2,
    });

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });

    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ids(result.current.contract.getMessages())).toEqual(ids(stored)));
    expect(result.current.contract.isSubmitting).toBe(false);
  });

  it('refuses a turn while a generation it did not start is running, leaving the composer as it was', async () => {
    const { result, sendMessages, streams, setStatus, store, services, rerender, ready } = setup();
    await ready();
    const staged = new Map<string, ExtendedFile>([
      ['file-1', { file_id: 'file-1', progress: 1, size: 1 }],
    ]);
    act(() => store.set(filesFamily(SIDE_PANE), staged));

    setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
    rerender({ live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.contract.isSubmitting).toBe(true);

    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Next question' });
    });

    expect(asked).toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
    expect(services.releaseFiles).not.toHaveBeenCalled();
    expect(store.get(filesFamily(SIDE_PANE))).toBe(staged);
  });

  it('asks the chat, not the last render, whether a turn can be taken', async () => {
    /** The render says the conversation is free; the chat, asked at that instant, says it is not. */
    const { result, sendMessages, store, services, ready } = setup({ canSend: () => false });
    await ready();
    const staged = new Map<string, ExtendedFile>([
      ['file-1', { file_id: 'file-1', progress: 1, size: 1 }],
    ]);
    act(() => store.set(filesFamily(SIDE_PANE), staged));
    expect(result.current.contract.isSubmitting).toBe(false);

    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Next question' });
    });

    expect(asked).toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
    expect(services.releaseFiles).not.toHaveBeenCalled();
    expect(store.get(filesFamily(SIDE_PANE))).toBe(staged);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(false);
  });

  it('takes no turn while the stored messages are being read back', async () => {
    const { result, sendMessages, loadMessages, ready } = setup();
    await ready();
    const stored = [user, reply('response-1', 'Hi'), reply('response-2', 'Already answered')];
    let land: (messages: TMessage[]) => void = () => undefined;
    loadMessages.mockReturnValue(
      new Promise<TMessage[]>((resolve) => {
        land = resolve;
      }),
    );
    sendMessages.mockResolvedValueOnce({
      status: 'settled',
      conversationId,
      generationProtocolVersion: 2,
    });
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    /** The turn is over and nothing streams, but the list is about to be replaced. */
    expect(result.current.followed.status).toBe('ready');
    expect(result.current.followed.canSend()).toBe(false);
    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Too soon' });
    });
    expect(asked).toBe(false);
    expect(sendMessages).toHaveBeenCalledTimes(1);

    await act(async () => land(stored));
    await waitFor(() => expect(result.current.followed.canSend()).toBe(true));
    expect(ids(result.current.contract.getMessages())).toEqual(ids(stored));
  });

  it('leaves a refused start as the reply to its message, and takes the next turn', async () => {
    const { result, sendMessages, streams, ready } = setup();
    await ready();
    sendMessages.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { message: 'Not allowed' }, headers: {} },
      }),
    );

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await settle();

    /** Main chat's rows for a start the server refused: the message, and the refusal under it. */
    const failed = result.current.contract.getMessages() ?? [];
    expect(ids(failed).slice(0, 2)).toEqual(['user-1', 'response-1']);
    expect(failed).toHaveLength(4);
    expect(failed[2]).toMatchObject({ isCreatedByUser: true, text: 'Next question' });
    expect(failed[3]).toMatchObject({
      error: true,
      parentMessageId: failed[2].messageId,
      metadata: { streamStartFailed: true },
    });
    expect(failed[3].text).toContain('Not allowed');

    /** Not a reply still on its way, so the conversation takes another message. */
    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Again' });
    });
    expect(asked).not.toBe(false);
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[1][0].payload).toMatchObject({ text: 'Again' });
  });

  it('gives a rerun back the branches it set aside once its reply is in', async () => {
    const later: TMessage = {
      ...user,
      messageId: 'user-2',
      parentMessageId: 'response-1',
      text: 'And then?',
    };
    const stored = [user, reply('response-1', 'Hi'), later, reply('response-2', 'Then', 'user-2')];
    const { result, streams, loadMessages, ready } = setup({ stored });
    await ready();

    act(() => {
      result.current.contract.regenerate({
        messageId: 'response-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
      });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    /** While it runs, only the branch being rerun is on screen, as ask shows it. */
    expect(ids(result.current.contract.getMessages())).not.toContain('response-2');

    act(() => streams[0].push(final(user, reply('response-1b', 'Again'))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await settle();

    const settled = ids(result.current.contract.getMessages());
    expect(settled).toEqual(
      expect.arrayContaining(['user-1', 'response-1', 'user-2', 'response-2']),
    );
    expect(settled).toContain('response-1b');
    expect(settled.some((id) => id.endsWith('_'))).toBe(false);
    /** Restored from what the turn set aside, not by reading the conversation again. */
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it('stops a generation it did not start, on the endpoint the conversation runs on', async () => {
    const { result, abort, streams, setStatus, rerender, ready } = setup();
    await ready();
    setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
    rerender({ live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    await settle();

    let refusal: unknown;
    await act(async () => {
      result.current.contract.stopGenerating().catch((error: unknown) => {
        refusal = error;
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(refusal).toBeUndefined();
    expect(abort.mock.calls[0]).toMatchObject([{ endpoint: EModelEndpoint.agents }]);
  });

  it('reads the conversation back when the server answered a rerun with a newer generation', async () => {
    const { result, sendMessages, streams, reconnectToStream, setStatus, loadMessages, ready } =
      setup();
    await ready();
    /** Someone else's turn got there first: the start names the generation that replaced it. */
    setStatus({ active: true, streamId: conversationId, createdAt: 4000 });
    sendMessages.mockResolvedValueOnce({
      status: 'replaced',
      conversationId,
      streamId: conversationId,
      generationCreatedAt: 4000,
      generationProtocolVersion: 2,
    });

    act(() => {
      result.current.contract.regenerate({
        messageId: 'response-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
      });
    });
    await waitFor(() => expect(reconnectToStream).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(streams).toHaveLength(1));

    const theirs: TMessage = {
      ...user,
      messageId: 'user-2',
      parentMessageId: 'response-1',
      text: 'Theirs',
    };
    const stored = [user, reply('response-1', 'Hi'), theirs, reply('response-2', 'Done', 'user-2')];
    loadMessages.mockResolvedValue(stored);
    setStatus({ active: false });
    act(() => streams[0].push(final(theirs, reply('response-2', 'Done', 'user-2'))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    /** Their turn whole, and the reply the rerun never replaced: not this turn's snapshot. */
    expect(ids(result.current.contract.getMessages())).toEqual(ids(stored));
  });

  it('stops a turn the server has not answered yet by its conversation, and does not follow it', async () => {
    const { result, sendMessages, abort, reconnectToStream, loadMessages, ready } = setup();
    await ready();
    /** The start never answers; cancelling it leaves a generation that may be running unnamed. */
    sendMessages.mockImplementationOnce(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        }),
    );
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.contract.stopGenerating();
    });

    expect(abort).toHaveBeenCalledWith({ chatId: conversationId, endpoint: EModelEndpoint.agents });
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    /** The reader's stop is not a dropped stream: nothing is attached to again. */
    expect(reconnectToStream).not.toHaveBeenCalled();
    expect(ids(result.current.contract.getMessages())).toEqual(['user-1', 'response-1']);
  });

  it('stops by name a generation that appears only after the stop by conversation', async () => {
    const { result, sendMessages, abort, setStatus, ready } = setup();
    await ready();
    sendMessages.mockImplementationOnce(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        }),
    );
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));
    setStatus({ active: true, streamId: conversationId, createdAt: 5000 });

    await act(async () => {
      await result.current.contract.stopGenerating();
    });

    expect(abort.mock.calls).toEqual([
      [{ chatId: conversationId, endpoint: EModelEndpoint.agents }],
      [
        {
          chatId: conversationId,
          endpoint: EModelEndpoint.agents,
          streamId: conversationId,
          generationCreatedAt: 5000,
        },
      ],
    ]);
  });

  it('takes back a turn stopped before the server kept anything of it', async () => {
    const { result, sendMessages, streams, onWithdrawn, loadMessages, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.contract.getMessages()).toHaveLength(4);

    /** What the server sends for a stop that landed before it had saved the turn. */
    act(() =>
      streams[0].push({
        type: 'final',
        data: {
          final: true,
          earlyAbort: true,
          conversation: { conversationId },
          requestMessage: null,
          responseMessage: null,
        },
      } as unknown as ChatEvent),
    );
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await settle();

    /** The rows from before the turn: no message that was never saved, no reply still to come. */
    expect(ids(result.current.contract.getMessages())).toEqual(['user-1', 'response-1']);
    expect(loadMessages).toHaveBeenCalledTimes(1);
    /** The words were the reader's, and are offered back. */
    expect(onWithdrawn).toHaveBeenCalledTimes(1);
    expect(onWithdrawn.mock.calls[0][0].submission.userMessage.text).toBe('Next question');

    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Again' });
    });
    expect(asked).not.toBe(false);
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
    expect(sendMessages.mock.calls[1][0].payload).toMatchObject({
      text: 'Again',
      parentMessageId: 'response-1',
    });
  });

  it('reads the conversation back when a turn ends with its reply still unanswered', async () => {
    const { result, sendMessages, streams, loadMessages, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = (result.current.contract.getMessages() ?? [])[2];
    const stored = [user, reply('response-1', 'Hi'), sent];
    loadMessages.mockResolvedValue(stored);

    /** A stop the stream reports with no rows of its own: nothing fills the empty reply. */
    act(() => streams[0].push({ type: 'abort' } as ChatEvent));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    expect(ids(result.current.contract.getMessages())).toEqual(ids(stored));
    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Again' });
    });
    expect(asked).not.toBe(false);
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
  });
});
