/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { atom, useAtom, useAtomValue, Provider, createStore } from 'jotai';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type { ChatStream, ChatTransport, QueuedMessage, ChatSendRequest } from '../../../core';
import type { SideChatHost, SideChatSurfaceProps } from '../../../react/side/host';
import type { SideChat } from '../../../react/side/state';
import type { ChatHost } from '../../../react/chat/host';
import {
  detachedRunByConvoId,
  drainAfterAbortByIndex,
  stopRequestedByConvoId,
  queuedMessagesByConvoId,
} from '../../../react/steer/queue';
import {
  sideChatAtom,
  sideChatDraftFamily,
  sideChatDraftTakenAtom,
} from '../../../react/side/state';
import {
  useMessagesHost,
  inertSeenSource,
  MessagesHostProvider,
} from '../../../react/messages/host';
import { activeGenerationCreatedAtByConvoId } from '../../../react/steer/atoms';
import { createTurnServices } from '../../../react/chat/__fixtures__/services';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { createSteerHost } from '../../../__fixtures__/steerHost';
import { SideChatHostProvider } from '../../../react/side/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { SteerHostProvider } from '../../../react/steer/host';
import { ChatHostProvider } from '../../../react/chat/host';
import { SIDE_CHAT_PANE } from '../../../react/side/state';
import { initEnglish } from '../../../__fixtures__/i18n';
import { useFollowChat } from '../../../react/follow';
import SideChatPanel from '../panel';

/** The header's own icon, counted: the header is drawn when its title is, not with the thread. */
const mockHeaderIcon = jest.fn();
jest.mock('lucide-react', () => {
  const actual = jest.requireActual('lucide-react');
  return {
    ...actual,
    ArrowUpRight: (props: object) => {
      mockHeaderIcon();
      return <actual.ArrowUpRight {...props} />;
    },
  };
});

beforeAll(initEnglish);

const conversationId = 'side-conversation';

const conversation: TConversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: 'Release follow-up',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Investigate the release.',
  sender: 'User',
  isCreatedByUser: true,
};

const reply = (messageId: string, text: string, parentMessageId = 'user-1'): TMessage => ({
  messageId,
  parentMessageId,
  conversationId,
  text,
  sender: 'Assistant',
  isCreatedByUser: false,
  content: [{ type: ContentTypes.TEXT, text }],
});

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

const final = (requestMessage: TMessage, responseMessage: TMessage): ChatEvent =>
  ({
    type: 'final',
    data: { final: true, conversation: { conversationId }, requestMessage, responseMessage },
  }) as ChatEvent;

/** The model main chat is being compared with, which the page's host would hand a row. */
const comparison = { conversationId: 'main-comparison', endpoint: 'openAI' } as TConversation;

/** Reads what a row of the side chat is given, from where a row reads it. */
function UserRow({ text }: { text: string }) {
  const added = useMessagesHost().useGetAddedConvo()();
  return <div data-testid="row" data-added={added?.conversationId ?? 'none'}>{`user=${text}`}</div>;
}

const steerHost = createSteerHost();
const startNothing = () => undefined;

/** The page's read state, which a list asks for when reading it can mark a conversation seen. */
const pageSeenSource = jest.fn(() => inertSeenSource);
const messagesHost = createMessagesHost({
  useSeenSource: pageSeenSource,
  useGetAddedConvo: () => () => comparison,
  renderMessageBody: ({ message }) => <UserRow text={message.text ?? ''} />,
});
const partsHost = createMessagePartsHost({
  renderContentParts: ({ content }) => (
    <div data-testid="row">
      {`reply=${(content ?? []).map((part) => (part as { text?: string } | undefined)?.text ?? '').join('')}`}
    </div>
  ),
});

/**
 * A host's own composer, as the app's is: it draws the list it is handed, sends through the
 * contract, and writes in the panel's draft. What it was given is written out, so a spec reads
 * it.
 */
function HostSurface({
  contract,
  children,
  onHandedTextTaken,
  onDraftTaken,
  onDraftChange,
  ...given
}: SideChatSurfaceProps) {
  return (
    <div data-testid="host-surface">
      {children}
      <output data-testid="given">{JSON.stringify(given)}</output>
      <button type="button" onClick={() => contract.ask({ text: 'From the host' })}>
        Host send
      </button>
      <button type="button" onClick={onHandedTextTaken}>
        Took handed
      </button>
      <button type="button" onClick={() => onDraftTaken(given.handedText ?? '')}>
        Sent handed
      </button>
      <button type="button" onClick={() => onDraftChange('Half a thought')}>
        Host types
      </button>
    </div>
  );
}

function setup({
  chat = { conversation },
  stored = [user, reply('response-1', 'It shipped.')],
  loadMessages = jest.fn(async () => stored),
  canSubmit = () => true,
  managed = false,
  draft,
  Surface,
  steers = false,
}: {
  chat?: SideChat;
  stored?: TMessage[];
  loadMessages?: jest.Mock<Promise<TMessage[]>>;
  canSubmit?: () => boolean;
  managed?: boolean;
  draft?: string;
  Surface?: SideChatHost['Surface'];
  /** Whether the app around the panel hosts the steer hooks, and so keeps a queue. */
  steers?: boolean;
} = {}) {
  const streams: TestStream[] = [];
  const sendMessages = jest.fn(
    async (_request: ChatSendRequest): ReturnType<ChatTransport['sendMessages']> => {
      const stream = createStream();
      streams.push(stream);
      return { status: 'stream', stream };
    },
  );
  const abort = jest.fn(async () => ({ success: true }));
  /** What the server says is running under the conversation; a spec may say a run is still on. */
  let running: { active: boolean; streamId?: string; createdAt?: number } = { active: false };
  const transport: ChatTransport = {
    sendMessages,
    abort,
    reconnectToStream: async () => {
      if (!running.active) {
        return null;
      }
      const stream = createStream();
      streams.push(stream);
      return stream;
    },
    getStatus: async () => running,
  };
  const openConversation = jest.fn();
  const sideChatHost: SideChatHost = {
    useChat: ({ conversationId: id, endpoint }, options) =>
      useFollowChat({
        id: id ?? '',
        transport,
        loadMessages,
        endpoint,
        settlesLost: true,
        ...options,
      }),
    /** A new function on every render, as a host's may be: nothing is to be redrawn for it. */
    useOpenConversation:
      () =>
      (...args: Parameters<typeof openConversation>) =>
        openConversation(...args),
    useSheetLayout: () => false,
    useClearsFooter: () => false,
    Surface,
  };
  /** One pane store for everything that reads the pane, as the app's is. */
  const paneAtom = atom<TConversation | null>(null);
  const chatHost: ChatHost = {
    usePaneConversation: () => {
      const [held, setConversation] = useAtom(paneAtom);
      return { conversation: held, setConversation };
    },
    /** One function for the pane's life, as an app's is: the contract is made of it. */
    useNewConversation: () => startNothing,
    useTurnServices: () => createTurnServices({ canSubmit }),
    useAbortStream: () => () => Promise.reject(new Error('unused')),
    useMessageCache: () => {
      throw new Error('A side chat reads its own messages');
    },
    useFeedbackEnabled: () => false,
    useMessages: () => ({ messages: null, isLoading: false, isFetching: false }),
  };
  const onClose = jest.fn();
  const onHandedTextTaken = jest.fn();
  const handOffComposerText = jest.fn();
  const queryClient = new QueryClient();
  const store = createStore();
  if (draft != null) store.set(sideChatDraftFamily(conversationId), draft);
  if (managed) store.set(sideChatAtom, chat);
  function OwnedPanel() {
    const current = useAtomValue(sideChatAtom);
    return (
      current && (
        <SideChatPanel
          chat={current}
          onClose={() => {
            onClose();
            store.set(sideChatAtom, (value) => (value === current ? null : value));
          }}
          onHandedTextTaken={(expected) => {
            onHandedTextTaken();
            store.set(sideChatAtom, (value) =>
              value === expected ? { conversation: value.conversation } : value,
            );
          }}
          onDraftTaken={(expected, text) => store.set(sideChatDraftTakenAtom, expected, text)}
        />
      )
    );
  }
  const within = (panel: React.ReactElement) =>
    steers ? <SteerHostProvider host={steerHost}>{panel}</SteerHostProvider> : panel;
  const tree = (current: SideChat) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <ChatSurfaceProvider
          value={{
            enterToSend: true,
            maximizeChatSpace: false,
            showScrollButton: false,
            composerBindings: {
              shortcutsEnabled: true,
              submitOverride: undefined,
              yieldedChords: new Set<string>(),
            },
            claimForeground: () => undefined,
            handOffComposerText,
          }}
        >
          <ChatHostProvider host={chatHost}>
            <SideChatHostProvider host={sideChatHost}>
              <MessagesHostProvider host={messagesHost}>
                <MessagePartsHostProvider host={partsHost}>
                  {within(
                    managed ? (
                      <OwnedPanel />
                    ) : (
                      <SideChatPanel
                        chat={current}
                        onClose={onClose}
                        onHandedTextTaken={() => onHandedTextTaken()}
                      />
                    ),
                  )}
                </MessagePartsHostProvider>
              </MessagesHostProvider>
            </SideChatHostProvider>
          </ChatHostProvider>
        </ChatSurfaceProvider>
      </Provider>
    </QueryClientProvider>
  );
  const view = render(tree(chat));
  return {
    ...view,
    store,
    open: (next: SideChat) => act(() => store.set(sideChatAtom, next)),
    refresh: () => view.rerender(tree(chat)),
    rerenderWith: (next: SideChat) => view.rerender(tree(next)),
    /** Draws the panel again from nothing, as the layout does when it moves it. */
    remount: () => {
      view.unmount();
      return render(tree(chat));
    },
    setRunning: (next: typeof running) => {
      running = next;
    },
    streams,
    sendMessages,
    abort,
    openConversation,
    onClose,
    onHandedTextTaken,
    handOffComposerText,
    loadMessages,
  };
}

const rows = () => screen.queryAllByTestId('row').map((row) => row.textContent);
const field = () => screen.getByRole('textbox', { name: 'Message input' });
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

describe('SideChatPanel', () => {
  it('shows the conversation beside the main one, under its title', async () => {
    setup();

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    await waitFor(() =>
      expect(rows()).toEqual(['user=Investigate the release.', 'reply=It shipped.']),
    );
    expect(screen.getByRole('region', { name: 'Side chat' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Release follow-up' })).toBeInTheDocument();
    expect(field()).toHaveAttribute('placeholder', 'Message Release follow-up');
  });

  it("reports what is read here through the page's read state, as a conversation of the reader's", async () => {
    pageSeenSource.mockClear();
    setup();
    await waitFor(() =>
      expect(rows()).toEqual(['user=Investigate the release.', 'reply=It shipped.']),
    );

    expect(pageSeenSource).toHaveBeenCalled();
  });

  it('puts focus in its field once the conversation is in, wherever it was opened from', async () => {
    /** The control that opened it: a row's menu in the sidebar, say. */
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    setup();

    await waitFor(() => expect(rows()).toHaveLength(2));

    await waitFor(() => expect(field()).toHaveFocus());
    opener.remove();
  });

  it('sends what the reader types as the conversation’s next turn, and stops it', async () => {
    const { sendMessages, streams, abort } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const send = screen.getByTestId('composer-send-button');
    expect(send).toBeDisabled();

    fireEvent.change(field(), { target: { value: 'What changed?' } });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[0][0]).toMatchObject({
      trigger: 'submit-message',
      payload: {
        endpoint: EModelEndpoint.agents,
        conversationId,
        text: 'What changed?',
        parentMessageId: 'response-1',
      },
    });
    expect(field()).toHaveValue('');
    expect(rows().slice(2)).toEqual(['user=What changed?', 'reply=']);

    /** With nothing typed while it runs, the send control is main chat's Stop. */
    fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }));
    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(abort.mock.calls[0]).toMatchObject([
      { endpoint: EModelEndpoint.agents, streamId: conversationId, generationCreatedAt: 3000 },
    ]);
  });

  describe('with a queue of the reader’s behind a run', () => {
    const queued: QueuedMessage = { id: 'queued-1', text: 'And then?', createdAt: 1 };
    /** Sends a turn from the field and returns the message the server would store for it. */
    const start = async ({
      sendMessages,
      streams,
    }: ReturnType<typeof setup>): Promise<TMessage> => {
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.change(field(), { target: { value: 'What changed?' } });
      fireEvent.click(screen.getByTestId('composer-send-button'));
      await waitFor(() => expect(streams).toHaveLength(1));
      return {
        ...user,
        messageId: sendMessages.mock.calls[0][0].payload.messageId as string,
        parentMessageId: 'response-1',
        text: 'What changed?',
      };
    };

    it('names the running generation for the composer’s controls, and sends the next queued message when it ends', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages } = view;
      const asked = await start(view);

      /** What a steer, a queued turn and an interrupt address while the reply is written. */
      expect(store.get(activeGenerationCreatedAtByConvoId(conversationId))).toBe(3000);
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));

      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
        streams[0].push(final(asked, reply('response-2', 'Two fixes.', asked.messageId)));
      });

      await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
      expect(sendMessages.mock.calls[1][0].payload).toMatchObject({
        conversationId,
        text: 'And then?',
        parentMessageId: 'response-2',
      });
      expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([]);
    });

    it('keeps the queue for the reader to send when they stopped the run', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages, abort } = view;
      const asked = await start(view);
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));

      fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }));
      await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
      act(() => {
        streams[0].push({
          type: 'final',
          data: {
            final: true,
            aborted: true,
            conversation: { conversationId },
            requestMessage: asked,
            responseMessage: {
              ...reply('response-2', 'Two', asked.messageId),
              unfinished: true,
            },
          },
        } as ChatEvent);
      });
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument(),
      );
      await settle();

      expect(store.get(activeGenerationCreatedAtByConvoId(conversationId))).toBeNull();
      expect(sendMessages).toHaveBeenCalledTimes(1);
      expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([queued]);
    });

    it('keeps the queue when the run ends on a reply marked unfinished, with no word of an abort', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages } = view;
      const asked = await start(view);
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));

      act(() =>
        streams[0].push(
          final(asked, { ...reply('response-2', 'Two', asked.messageId), unfinished: true }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument(),
      );
      await settle();

      expect(sendMessages).toHaveBeenCalledTimes(1);
      expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([queued]);
    });

    it('takes back the leave to send on a stopped run when the stop could not be saved', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages } = view;
      const asked = await start(view);
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));
      /** Interrupt and send: the queue may go even though the run is stopped. */
      act(() =>
        store.set(drainAfterAbortByIndex(SIDE_CHAT_PANE), {
          conversationId,
          generationCreatedAt: 3000,
        }),
      );

      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
        streams[0].push({
          type: 'final',
          data: {
            final: true,
            reconcile: true,
            reconcileReason: 'abort_persistence_failed',
            terminalStatus: 'aborted',
            generationProtocolVersion: 2,
            conversation: { conversationId },
          },
        } as ChatEvent);
      });
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument(),
      );
      await settle();

      expect(store.get(drainAfterAbortByIndex(SIDE_CHAT_PANE))).toBe(false);
      expect(sendMessages).toHaveBeenCalledTimes(1);
      expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([queued]);
    });

    it('sends the queue when it is opened again after the reply ended with the panel closed', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages, loadMessages } = view;
      const asked = await start(view);
      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
      });
      await settle();
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));

      /** Closed while the reply is still being written: the run is remembered by its turn. */
      view.unmount();
      expect(store.get(detachedRunByConvoId(conversationId))).toEqual({
        userMessageId: asked.messageId,
        responseMessageId: 'response-2',
        generationCreatedAt: 3000,
      });
      expect(sendMessages).toHaveBeenCalledTimes(1);

      /** It finishes on the server meanwhile. Opened again, nothing is running and its reply is stored. */
      loadMessages.mockResolvedValue([
        user,
        reply('response-1', 'It shipped.'),
        asked,
        {
          ...reply('response-2', 'Two fixes.', asked.messageId),
          createdAt: new Date().toISOString(),
        },
      ]);
      view.remount();

      await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
      expect(sendMessages.mock.calls[1][0].payload).toMatchObject({
        conversationId,
        text: 'And then?',
        parentMessageId: 'response-2',
      });
      expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
      expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([]);
    });

    it('sends the queue once when it is opened again while the reply is still being written', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages, setRunning } = view;
      const asked = await start(view);
      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
      });
      await settle();
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));
      view.unmount();
      const remembered = store.get(detachedRunByConvoId(conversationId));
      expect(remembered).not.toBeNull();

      /** Still running when the panel opens again: the same generation is followed, and its end is still owed. */
      setRunning({ active: true, streamId: conversationId, createdAt: 3000 });
      view.remount();
      await waitFor(() => expect(streams).toHaveLength(2));
      await settle();
      expect(store.get(detachedRunByConvoId(conversationId))).toBe(remembered);
      expect(sendMessages).toHaveBeenCalledTimes(1);

      /** It ends while followed: that end sends the queue, and the marker is not left to send it again. */
      setRunning({ active: false });
      view.loadMessages.mockResolvedValue([
        user,
        reply('response-1', 'It shipped.'),
        asked,
        reply('response-2', 'Two fixes.', asked.messageId),
      ]);
      act(() => streams[1].push(final(asked, reply('response-2', 'Two fixes.', asked.messageId))));
      await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
      expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
      await settle();
      expect(sendMessages).toHaveBeenCalledTimes(2);
    });

    it('sends the queue when a reply it had been closed on is lost after it was opened again, and its stored reply is whole', async () => {
      const view = setup({ steers: true });
      const { store, streams, sendMessages, setRunning } = view;
      const asked = await start(view);
      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
      });
      await settle();
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));
      view.unmount();
      setRunning({ active: true, streamId: conversationId, createdAt: 3000 });
      view.remount();
      await waitFor(() => expect(streams).toHaveLength(2));

      /** Its stream drops, and by the time it is looked for again it has finished. */
      setRunning({ active: false });
      view.loadMessages.mockResolvedValue([
        user,
        reply('response-1', 'It shipped.'),
        asked,
        {
          ...reply('response-2', 'Two fixes.', asked.messageId),
          createdAt: new Date().toISOString(),
        },
      ]);
      act(() => streams[1].push({ type: 'error', status: 0 }));

      /** Lost, so its end was not heard; but it was remembered, and the stored reply tells it. */
      await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2), { timeout: 5000 });
      expect(sendMessages.mock.calls[1][0].payload).toMatchObject({
        text: 'And then?',
        parentMessageId: 'response-2',
      });
      expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
    });

    it('lets go of an earlier run’s markers when another generation is followed', async () => {
      const view = setup({ steers: true });
      const { store } = view;
      await waitFor(() => expect(rows()).toHaveLength(2));
      store.set(detachedRunByConvoId(conversationId), {
        userMessageId: 'user-old',
        generationCreatedAt: 1000,
      });
      store.set(stopRequestedByConvoId(conversationId), { generationCreatedAt: 1000 });

      await start(view);

      expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
      expect(store.get(stopRequestedByConvoId(conversationId))).toBeNull();
    });

    it('keeps the queue when the reply it was closed on turns out to have been stopped', async () => {
      /** Stopped from another tab: the stored reply says so. */
      const elsewhere = setup({ steers: true });
      const asked = await start(elsewhere);
      act(() => {
        elsewhere.streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
      });
      await settle();
      act(() => elsewhere.store.set(queuedMessagesByConvoId(conversationId), [queued]));
      elsewhere.unmount();
      elsewhere.loadMessages.mockResolvedValue([
        user,
        reply('response-1', 'It shipped.'),
        asked,
        {
          ...reply('response-2', 'Two', asked.messageId),
          createdAt: new Date().toISOString(),
          unfinished: true,
        },
      ]);
      elsewhere.remount();
      await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(4));
      await settle();
      expect(elsewhere.sendMessages).toHaveBeenCalledTimes(1);
      expect(elsewhere.store.get(queuedMessagesByConvoId(conversationId))).toEqual([queued]);
      /** Read once: the marker is retired, so a later visit does not go over it again. */
      expect(elsewhere.store.get(detachedRunByConvoId(conversationId))).toBeNull();
    });

    it('does not remember a reply the reader stopped before closing the panel', async () => {
      const here = setup({ steers: true });
      const again = await start(here);
      act(() => {
        here.streams[0].push({
          type: 'created',
          data: { created: true, message: again, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
      });
      await settle();
      act(() => here.store.set(queuedMessagesByConvoId(conversationId), [queued]));
      fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }));
      await waitFor(() => expect(here.abort).toHaveBeenCalledTimes(1));
      expect(here.store.get(stopRequestedByConvoId(conversationId))).toEqual({
        generationCreatedAt: 3000,
      });
      here.unmount();
      expect(here.store.get(detachedRunByConvoId(conversationId))).toBeNull();
    });

    it('sends nothing of a queue where the app hosts no steer hooks', async () => {
      const view = setup();
      const { store, streams, sendMessages } = view;
      const asked = await start(view);
      act(() => store.set(queuedMessagesByConvoId(conversationId), [queued]));

      act(() => streams[0].push(final(asked, reply('response-2', 'Two fixes.', asked.messageId))));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument(),
      );
      await settle();
      expect(sendMessages).toHaveBeenCalledTimes(1);
    });
  });

  it('settles the reply and takes the next message', async () => {
    const { streams, sendMessages } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'What changed?' } });
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(streams).toHaveLength(1));
    const asked: TMessage = {
      ...user,
      messageId: sendMessages.mock.calls[0][0].payload.messageId as string,
      parentMessageId: 'response-1',
      text: 'What changed?',
    };

    act(() => {
      streams[0].push({
        type: 'created',
        data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
      } as ChatEvent);
      streams[0].push(final(asked, reply('response-2', 'Two fixes.', asked.messageId)));
    });
    await waitFor(() =>
      expect(rows().slice(2)).toEqual(['user=What changed?', 'reply=Two fixes.']),
    );
    await settle();

    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: 'Which ones?' } });
    await waitFor(() => expect(screen.getByTestId('composer-send-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(sendMessages.mock.calls[1][0].payload).toMatchObject({
      text: 'Which ones?',
      parentMessageId: 'response-2',
    });
  });

  it('sends the words handed over with the conversation once, as its next turn', async () => {
    const chat = { conversation, text: 'Carry on from here.' };
    const { sendMessages, streams, onHandedTextTaken, rerenderWith } = setup({ chat });

    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[0][0].payload).toMatchObject({
      text: 'Carry on from here.',
      parentMessageId: 'response-1',
    });
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');

    /** The owner has not dropped the words yet; they are not a second turn. */
    rerenderWith({ conversation, text: 'Carry on from here.' });
    await settle();
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');
    const asked: TMessage = {
      ...user,
      messageId: sendMessages.mock.calls[0][0].payload.messageId as string,
      parentMessageId: 'response-1',
      text: 'Carry on from here.',
    };
    act(() => {
      streams[0].push({
        type: 'created',
        data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
      } as ChatEvent);
      streams[0].push(final(asked, reply('response-2', 'Done.', asked.messageId)));
    });
    await waitFor(() => expect(rows()).toContain('reply=Done.'));
    rerenderWith({ conversation, text: 'Carry on from here.' });
    await settle();
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused handoff as an editable draft without later automatic replay', async () => {
    let allowed = false;
    const { sendMessages, onHandedTextTaken, rerenderWith } = setup({
      chat: { conversation, text: 'Carry on from here.' },
      canSubmit: () => allowed,
    });
    await waitFor(() => expect(field()).toHaveValue('Carry on from here.'));
    expect(rows()).toContain('reply=It shipped.');
    expect(sendMessages).not.toHaveBeenCalled();
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
    fireEvent.change(field(), { target: { value: 'An edited question.' } });
    allowed = true;
    rerenderWith({ conversation, text: 'Carry on from here.' });
    await settle();
    expect(field()).toHaveValue('An edited question.');
    expect(sendMessages).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: '' } });
    rerenderWith({ conversation, text: 'Carry on from here.' });
    await settle();
    expect(field()).toHaveValue('');
    expect(sendMessages).not.toHaveBeenCalled();
  });

  it('says when the conversation could not be loaded, and tries again', async () => {
    const loadMessages = jest
      .fn<Promise<TMessage[]>, []>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([user, reply('response-1', 'It shipped.')]);
    setup({ loadMessages });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This conversation couldn't be loaded.",
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(field()).toBeInTheDocument();
  });

  it('moves the conversation into the main chat’s place, or closes', async () => {
    const { openConversation, onClose } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
    expect(openConversation).toHaveBeenCalledWith(expect.objectContaining({ conversationId }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('takes the unsent words along when the conversation moves to the main chat', async () => {
    const { openConversation, handOffComposerText } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'Not sent yet' } });

    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));

    expect(handOffComposerText).toHaveBeenCalledWith(conversationId, 'Not sent yet');
    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  it('hands nothing along when nothing was written', async () => {
    const { handOffComposerText } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));

    expect(handOffComposerText).not.toHaveBeenCalled();
  });

  it('puts the words of a turn the server never kept back in the field', async () => {
    const { streams } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'What changed?' } });
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(field()).toHaveValue('');

    /** Stopped before the server had saved the turn. */
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

    await waitFor(() => expect(field()).toHaveValue('What changed?'));
    expect(rows()).toEqual(['user=Investigate the release.', 'reply=It shipped.']);
  });

  describe("with a composer of the host's own", () => {
    const given = () => JSON.parse(screen.getByTestId('given').textContent ?? '{}');

    it("draws the host's composer around the list, on the conversation's contract", async () => {
      const { sendMessages } = setup({
        Surface: HostSurface,
        chat: { conversation, text: 'Go on' },
      });
      await waitFor(() =>
        expect(rows()).toEqual(['user=Investigate the release.', 'reply=It shipped.']),
      );

      /** The list is the host's to place, and the panel's plain field is not drawn beside it. */
      const surface = screen.getByTestId('host-surface');
      expect(surface).toContainElement(screen.getAllByTestId('row')[0]);
      expect(screen.queryByRole('textbox', { name: 'Message input' })).not.toBeInTheDocument();
      await waitFor(() =>
        expect(given()).toEqual({
          ready: true,
          handedText: 'Go on',
          handoffKey: conversationId,
          draft: '',
          clearsFooter: false,
          focusWhenReady: true,
        }),
      );

      /** A turn the host's composer builds runs in this conversation. */
      fireEvent.click(screen.getByRole('button', { name: 'Host send' }));
      await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));
      expect(sendMessages.mock.calls[0][0].payload).toMatchObject({
        conversationId,
        text: 'From the host',
      });
    });

    it('redraws it for the words written in it, and not for each word of a reply', async () => {
      type Drawn = Pick<SideChatSurfaceProps, 'children' | 'contract' | 'draft'>;
      const drawn: Drawn[] = [];
      function Watched(props: SideChatSurfaceProps) {
        drawn.push({ children: props.children, contract: props.contract, draft: props.draft });
        return <HostSurface {...props} />;
      }
      const { streams, sendMessages } = setup({ Surface: Watched });
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Host send' }));
      await waitFor(() => expect(streams).toHaveLength(1));
      const asked: TMessage = {
        ...user,
        messageId: sendMessages.mock.calls[0][0].payload.messageId as string,
        parentMessageId: 'response-1',
        text: 'From the host',
      };
      const step = {
        id: 's0',
        runId: 'response-2',
        index: 0,
        type: StepTypes.MESSAGE_CREATION,
        stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: 's0' } },
        usage: null,
      };
      const word = (text: string): ChatEvent =>
        ({
          type: 'step',
          data: {
            event: StepEvents.ON_MESSAGE_DELTA,
            data: { id: 's0', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
          },
        }) as ChatEvent;
      act(() => {
        streams[0].push({
          type: 'created',
          data: { created: true, message: asked, turn: { responseMessageId: 'response-2' } },
        } as ChatEvent);
        streams[0].push({
          type: 'step',
          data: { event: StepEvents.ON_RUN_STEP, data: step },
        } as ChatEvent);
        streams[0].push(word('Two'));
      });
      await waitFor(() => expect(rows().slice(-1)[0]).toBe('reply=Two'));
      await settle();

      /** The reply goes on being written: the list shows it, and the rest is left alone. */
      const before = drawn.length;
      const headers = mockHeaderIcon.mock.calls.length;
      for (const text of [' fixes', ' so', ' far.']) {
        act(() => streams[0].push(word(text)));
        await settle();
      }
      expect(rows().slice(-1)[0]).toBe('reply=Two fixes so far.');
      expect(drawn).toHaveLength(before);
      expect(mockHeaderIcon.mock.calls.length).toBe(headers);

      /** A key pressed in it redraws it, around the same list and on the same contract. */
      const held = drawn[drawn.length - 1];
      fireEvent.click(screen.getByRole('button', { name: 'Host types' }));
      await waitFor(() => expect(drawn[drawn.length - 1].draft).toBe('Half a thought'));
      expect(drawn[drawn.length - 1].children).toBe(held.children);
      expect(drawn[drawn.length - 1].contract).toBe(held.contract);
      expect(mockHeaderIcon.mock.calls.length).toBe(headers);
    });

    it('starts with the words handed over as its draft, and lets go of them once they are sent', async () => {
      const chat = { conversation, text: 'Go on' };
      const { store } = setup({ Surface: HostSurface, chat, managed: true });
      await waitFor(() => expect(rows()).toHaveLength(2));

      /** The panel put them in the draft before the composer was drawn, and still asks to send them. */
      expect(given()).toMatchObject({ handedText: 'Go on', draft: 'Go on' });
      expect(store.get(sideChatDraftFamily(conversationId))).toBe('Go on');

      /** Sent: the draft that held those words is let go of, and nothing is left to send again. */
      fireEvent.click(screen.getByRole('button', { name: 'Sent handed' }));
      fireEvent.click(screen.getByRole('button', { name: 'Took handed' }));
      await waitFor(() => expect(given().draft).toBe(''));
      expect(store.get(sideChatDraftFamily(conversationId))).toBe('');
      expect(given().handedText).toBeUndefined();
    });

    it('keeps words the reader wrote over the ones handed, when those are said to be sent', async () => {
      const chat = { conversation, text: 'Go on' };
      const { store } = setup({ Surface: HostSurface, chat, managed: true });
      await waitFor(() => expect(rows()).toHaveLength(2));

      fireEvent.click(screen.getByRole('button', { name: 'Host types' }));
      fireEvent.click(screen.getByRole('button', { name: 'Sent handed' }));
      await settle();
      expect(store.get(sideChatDraftFamily(conversationId))).toBe('Half a thought');
    });

    it('is its own pane to the keyboard, so a shortcut pressed in it acts on this conversation', async () => {
      setup({ Surface: HostSurface });
      await waitFor(() => expect(rows()).toHaveLength(2));

      expect(screen.getByRole('region', { name: 'Side chat' })).toHaveAttribute(
        'data-chat-pane',
        '3',
      );
    });

    it('keeps what is written in it, and takes it along when the conversation moves to the main chat', async () => {
      const { handOffComposerText, openConversation, remount } = setup({ Surface: HostSurface });
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Host types' }));
      expect(given().draft).toBe('Half a thought');

      /** Crossing the breakpoint draws the panel, and the host's composer, from nothing. */
      remount();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(given().draft).toBe('Half a thought');

      fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
      expect(handOffComposerText).toHaveBeenCalledWith(conversationId, 'Half a thought');
      expect(openConversation).toHaveBeenCalledTimes(1);
    });

    it('gives it back the words of a turn the server never kept', async () => {
      const { streams } = setup({ Surface: HostSurface });
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Host send' }));
      await waitFor(() => expect(streams).toHaveLength(1));
      expect(given().draft).toBe('');

      /** Stopped before the server had saved the turn. */
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

      await waitFor(() => expect(given().draft).toBe('From the host'));
    });
  });

  it('keeps a rerun in the side chat to its own conversation', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(2));

    /** Not the model main chat is being compared with, which a rerun would otherwise send to. */
    expect(screen.getAllByTestId('row')[0]).toHaveAttribute('data-added', 'none');
  });

  it('keeps the unsent words when the layout draws the panel again', async () => {
    const { remount } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'Half a thought' } });

    /** Crossing the breakpoint moves the panel between a column and a sheet: a new mount. */
    remount();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(field()).toHaveValue('Half a thought');
  });
});

describe('pending side-chat draft ownership', () => {
  it('moves the question to the main composer before history loads, without leaving a second draft', async () => {
    const loadMessages = jest.fn<Promise<TMessage[]>, []>(() => new Promise(() => undefined));
    const chat = { conversation, text: 'Keep these words.' };
    const view = setup({ chat, loadMessages, managed: true });
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe(chat.text);
    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
    expect(view.handOffComposerText).toHaveBeenCalledWith(conversationId, chat.text);
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('');
    loadMessages.mockResolvedValue([user, reply('response-1', 'It shipped.')]);
    view.open({ conversation });
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('keeps the question manual after close and ordinary reopen while history loads', async () => {
    let finish!: (messages: TMessage[]) => void;
    const loadMessages = jest
      .fn<Promise<TMessage[]>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([user, reply('response-1', 'It shipped.')]);
    const view = setup({
      chat: { conversation, text: 'Keep these words.' },
      loadMessages,
      managed: true,
    });
    await waitFor(() => expect(loadMessages).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => finish([user, reply('response-1', 'It shipped.')]));
    expect(view.sendMessages).not.toHaveBeenCalled();
    view.open({ conversation });
    await waitFor(() => expect(field()).toHaveValue('Keep these words.'));
    expect(view.sendMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    expect(field()).toHaveValue('');
  });

  it('isolates an old loading question from the new destination and does not replay it on return', async () => {
    let finish!: (messages: TMessage[]) => void;
    const loadMessages = jest
      .fn<Promise<TMessage[]>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([user, reply('response-1', 'It shipped.')]);
    const view = setup({
      chat: { conversation, text: 'First question.' },
      loadMessages,
      managed: true,
    });
    await waitFor(() => expect(loadMessages).toHaveBeenCalled());
    view.open({
      conversation: { ...conversation, conversationId: 'other' },
      text: 'Other question.',
    });
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    expect(view.sendMessages.mock.calls[0][0].payload).toMatchObject({
      conversationId: 'other',
      text: 'Other question.',
    });
    await act(async () => finish([user, reply('response-1', 'It shipped.')]));
    view.open({ conversation });
    await waitFor(() => expect(field()).toHaveValue('First question.'));
    expect(view.sendMessages).toHaveBeenCalledTimes(1);
  });

  it.each(['Same words.', 'Different draft.'])(
    'preserves a pre-existing draft without arming a handoff: %s',
    async (draft) => {
      const view = setup({ chat: { conversation, text: 'Same words.' }, draft, managed: true });
      await waitFor(() => expect(field()).toHaveValue(draft));
      expect(view.sendMessages).not.toHaveBeenCalled();
    },
  );
});
