/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { atom, useAtom, useAtomValue, Provider, createStore } from 'jotai';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Constants, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type { ChatStream, ChatTransport, ChatSendRequest } from '../../../core';
import type { SideChatHost } from '../../../react/side/host';
import type { SideChat } from '../../../react/side/state';
import type { ChatHost } from '../../../react/chat/host';
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
import { createTurnServices } from '../../../react/chat/__fixtures__/services';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { SideChatHostProvider } from '../../../react/side/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatHostProvider } from '../../../react/chat/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import { useFollowChat } from '../../../react/follow';
import SideChatPanel from '../panel';

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

function setup({
  chat = { conversation },
  stored = [user, reply('response-1', 'It shipped.')],
  loadMessages = jest.fn(async () => stored),
  canSubmit = () => true,
  managed = false,
  draft,
}: {
  chat?: SideChat;
  stored?: TMessage[];
  loadMessages?: jest.Mock<Promise<TMessage[]>>;
  canSubmit?: () => boolean;
  managed?: boolean;
  draft?: string;
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
  const transport: ChatTransport = {
    sendMessages,
    abort,
    reconnectToStream: async () => null,
    getStatus: async () => ({ active: false }),
  };
  const openConversation = jest.fn();
  const sideChatHost: SideChatHost = {
    useChat: ({ conversationId: id, endpoint }, options) =>
      useFollowChat({ id: id ?? '', transport, loadMessages, endpoint, ...options }),
    useOpenConversation: () => openConversation,
    useSheetLayout: () => false,
    useClearsFooter: () => false,
  };
  /** One pane store for everything that reads the pane, as the app's is. */
  const paneAtom = atom<TConversation | null>(null);
  const chatHost: ChatHost = {
    usePaneConversation: () => {
      const [held, setConversation] = useAtom(paneAtom);
      return { conversation: held, setConversation };
    },
    useNewConversation: () => () => undefined,
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
                  {managed ? (
                    <OwnedPanel />
                  ) : (
                    <SideChatPanel
                      chat={current}
                      onClose={onClose}
                      onHandedTextTaken={() => onHandedTextTaken()}
                    />
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
