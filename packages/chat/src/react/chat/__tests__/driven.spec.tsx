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
import type { ChatStream, ChatTransport, ChatSendRequest, ChatStreamStatus } from '../../../core';
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
import { ChatHostProvider } from '../host';
import { filesFamily } from '../../pane';

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

const createStream = (): TestStream => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const stream: TestStream = {
    streamId: conversationId,
    generationCreatedAt: 3000,
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
const createTransport = () => {
  const streams: TestStream[] = [];
  let status: ChatStreamStatus = { active: false };
  const open = (): TestStream => {
    const stream = createStream();
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
  const reconnectToStream = jest.fn(async () => (status.active ? open() : null));
  const transport: ChatTransport = {
    sendMessages,
    abort,
    reconnectToStream,
    getStatus: async () => status,
  };
  return {
    transport,
    streams,
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
}: {
  stored?: TMessage[];
  services?: TurnServices;
  canSend?: () => boolean;
  beside?: FollowChatOptions['beside'];
  /** The conversation the pane holds, and the pane's store when a spec shares one. */
  id?: string;
  store?: ReturnType<typeof createStore>;
} = {}) {
  const queryClient = new QueryClient();
  const harness = createTransport();
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
