/**
 * @jest-environment jsdom
 */
import { atom, useAtom, Provider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Constants, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type { ChatStream, ChatTransport, ChatSendRequest } from '../../../core';
import type { ChatHost, TurnServices } from '../../../react/chat/host';
import type { SideChatHost } from '../../../react/side/host';
import type { SideChat } from '../../../react/side/state';
import {
  sideChatAtom,
  sideChatDraftFamily,
  sideChatDraftSubmittedAtom,
} from '../../../react/side/state';
import { createTurnServices as createBaseTurnServices } from '../../../react/chat/__fixtures__/services';
import { MessagesHostProvider, useMessagesHost } from '../../../react/messages/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { turnInputs } from '../../../core/code/__fixtures__/turn';
import { SideChatHostProvider } from '../../../react/side/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { isSubmittingFamily } from '../../../react/submission';
import { useChatContext } from '../../../react/chat/context';
import { ChatHostProvider } from '../../../react/chat/host';
import { SIDE_CHAT_PANE } from '../../../react/side/state';
import { initEnglish } from '../../../__fixtures__/i18n';
import { useFollowChat } from '../../../react/follow';
import SideChatPanel from '../panel';

type TestServices = TurnServices & { readiness?: 'pending' | 'ready' | 'blocked' };
const createTurnServices = (overrides: Partial<TestServices> = {}): TestServices => ({
  ...createBaseTurnServices(),
  ...overrides,
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
  const chat = useChatContext();
  return (
    <>
      <div data-testid="row" data-added={added?.conversationId ?? 'none'}>{`user=${text}`}</div>
      <button
        onClick={() => chat.ask({ ...user, text: 'Edited transcript task.' }, { isEdited: true })}
      >
        Resubmit transcript
      </button>
    </>
  );
}

const messagesHost = createMessagesHost({
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
  draft,
  stored = [user, reply('response-1', 'It shipped.')],
  loadMessages = jest.fn(async () => stored),
  services = createTurnServices(),
  ownedDrafts = true,
}: {
  chat?: SideChat;
  draft?: string;
  stored?: TMessage[];
  loadMessages?: jest.Mock<Promise<TMessage[]>>;
  services?: TestServices;
  ownedDrafts?: boolean;
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
  let activeChat: ReturnType<typeof useFollowChat>['chat'];
  const sideChatHost: SideChatHost = {
    useChat: ({ conversationId: id, endpoint }, options) => {
      const followed = useFollowChat({
        id: id ?? '',
        transport,
        loadMessages,
        endpoint,
        ...options,
      });
      activeChat = followed.chat;
      return followed;
    },
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
    useTurnServices: () => services,
    useTurnReadiness: () => services.readiness ?? 'ready',
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
  store.set(sideChatAtom, chat);
  /** The real owner renders normalized state and consumes intent/close in that same store. */
  const Pane = () => {
    const [current, setCurrent] = useAtom(sideChatAtom);
    return current == null ? null : (
      <SideChatPanel
        key={current.conversation.conversationId}
        chat={current}
        onClose={() => {
          onClose();
          setCurrent(null);
        }}
        onDraftSubmitted={
          ownedDrafts
            ? (expected, submitted) => {
                if (store.get(sideChatAtom) === expected && expected.text)
                  onHandedTextTaken(expected);
                store.set(sideChatDraftSubmittedAtom, expected, submitted);
              }
            : undefined
        }
        onHandedTextTaken={(expected) => {
          onHandedTextTaken(expected);
          setCurrent((value) =>
            value === expected ? { conversation: value.conversation } : value,
          );
        }}
      />
    );
  };
  const tree = () => (
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
                  <Pane />
                </MessagePartsHostProvider>
              </MessagesHostProvider>
            </SideChatHostProvider>
          </ChatHostProvider>
        </ChatSurfaceProvider>
      </Provider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    store,
    getChat: () => activeChat,
    queryClient,
    open: (next: SideChat) => act(() => store.set(sideChatAtom, next)),
    refresh: () => view.rerender(tree()),
    /** Draws the panel again from nothing, as the layout does when it moves it. */
    remount: () => {
      view.unmount();
      return render(tree());
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
  it('preserves the optional draft callback contract for ordinary manual submissions', async () => {
    const view = setup({ ownedDrafts: false });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: '  Manual question.  ' } });
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(field()).toHaveValue('');
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
  });

  it.each([true, false])(
    'preserves a new same-ID handoff introduced by accepted commit (automatic=%s)',
    async (automatic) => {
      const services = createTurnServices({ readiness: automatic ? 'pending' : 'ready' });
      const view = setup({
        chat: { conversation, text: automatic ? 'Same words.' : undefined },
        services,
      });
      await waitFor(() => expect(rows()).toHaveLength(2));
      if (!automatic) fireEvent.change(field(), { target: { value: 'Same words.' } });
      expect(field()).toHaveValue('Same words.');
      let replaced = false;
      const unsubscribe = view.store.sub(isSubmittingFamily(SIDE_CHAT_PANE), () => {
        if (replaced || !view.store.get(isSubmittingFamily(SIDE_CHAT_PANE))) return;
        replaced = true;
        view.store.set(sideChatDraftFamily(conversationId), '');
        view.store.set(sideChatAtom, { conversation, text: 'Same words.' });
      });
      services.readiness = 'ready';
      if (automatic) view.refresh();
      else fireEvent.click(screen.getByTestId('composer-send-button'));
      await waitFor(() => expect(view.streams).toHaveLength(1));
      expect(replaced).toBe(true);
      expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('Same words.');
      expect(view.store.get(sideChatAtom)?.text).toBe('Same words.');
      unsubscribe();
    },
  );

  it('waits for an old turn before sending a new handoff to the same mounted conversation', async () => {
    const view = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'First question.' } });
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.streams).toHaveLength(1));
    const asked = view.sendMessages.mock.calls[0][0].payload as unknown as TMessage;
    view.open({ conversation, text: 'Question after this turn.' });
    await settle();
    expect(view.store.get(sideChatAtom)?.text).toBe('Question after this turn.');
    expect(field()).toHaveValue('Question after this turn.');
    expect(view.sendMessages).toHaveBeenCalledTimes(1);
    act(() =>
      view.streams[0].push(final(asked, reply('answer-first', 'First answer.', asked.messageId))),
    );
    await waitFor(() => expect(view.streams).toHaveLength(2));
    expect(view.sendMessages.mock.calls[1][0].payload).toMatchObject({
      text: 'Question after this turn.',
    });
    expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newer same-destination draft published during actual send acceptance', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Old question.' }, services });
    await waitFor(() => expect(field()).toHaveValue('Old question.'));
    let replaced = false;
    const unsubscribe = view.queryClient.getQueryCache().subscribe((event) => {
      if (replaced || event.type !== 'updated' || event.query.queryKey[0] !== 'messages') return;
      const rows = event.query.state.data as TMessage[] | undefined;
      if (!rows?.some((row) => row.text === 'Old question.')) return;
      replaced = true;
      view.store.set(sideChatDraftFamily(conversationId), '');
      view.store.set(sideChatAtom, { conversation, text: 'New question.' });
    });
    services.readiness = 'ready';
    view.refresh();
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(replaced).toBe(true);
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('New question.');
    expect(view.store.get(sideChatAtom)?.text).toBe('New question.');
    unsubscribe();
  });

  it('an accepted transcript edit supersedes automatic intent without discarding its unsent draft', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Original question.' }, services });
    await waitFor(() => expect(field()).toHaveValue('Original question.'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Resubmit transcript' })[0]);
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
    expect(field()).toHaveValue('Original question.');
    act(() =>
      view.streams[0].push({
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
    await settle();
    services.readiness = 'ready';
    view.refresh();
    await settle();
    expect(view.sendMessages).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('Original question.');
    expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
  });

  it('keeps a declined automatic request editable and releases its synchronous send lock', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Keep these words.' }, services });
    await waitFor(() => expect(field()).toHaveValue('Keep these words.'));
    const decline = jest.spyOn(view.getChat()!, 'sendMessage').mockResolvedValueOnce(undefined);
    services.readiness = 'ready';
    view.refresh();
    await settle();
    expect(view.sendMessages).not.toHaveBeenCalled();
    expect(field()).toHaveValue('Keep these words.');
    decline.mockRestore();
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(view.sendMessages.mock.calls[0][0].payload).toMatchObject({ text: 'Keep these words.' });
    expect(field()).toHaveValue('');
  });

  it('accepts a genuinely new handoff for the same mounted destination', async () => {
    const view = setup({ chat: { conversation, text: 'First question.' } });
    await waitFor(() => expect(view.streams).toHaveLength(1));
    const asked = view.sendMessages.mock.calls[0][0].payload as unknown as TMessage;
    act(() =>
      view.streams[0].push(final(asked, reply('answer-first', 'First answer.', asked.messageId))),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument(),
    );
    await settle();
    view.open({ conversation, text: 'Second question.' });
    await waitFor(() => expect(view.streams).toHaveLength(2));
    expect(view.sendMessages.mock.calls[1][0].payload).toMatchObject({ text: 'Second question.' });
    expect(field()).toHaveValue('');
    expect(view.onHandedTextTaken).toHaveBeenCalledTimes(2);
  });

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
    const { sendMessages, streams, onHandedTextTaken, refresh } = setup({
      chat: { conversation, text: 'Carry on from here.' },
    });

    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[0][0].payload).toMatchObject({
      text: 'Carry on from here.',
      parentMessageId: 'response-1',
    });
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');

    /** Rendering again cannot recreate consumed intent. */
    refresh();
    await settle();
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');
  });

  it('waits for destination readiness before consuming handed text', async () => {
    let ready = false;
    const services = createTurnServices({ readiness: 'pending', canSubmit: () => ready });
    const chat = { conversation, text: 'Carry on from here.' };
    const view = setup({ chat, services });

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.sendMessages).not.toHaveBeenCalled();
    expect(view.onHandedTextTaken).not.toHaveBeenCalled();

    ready = true;
    services.readiness = 'ready';
    view.refresh();
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');
  });

  it.each(['blocked', 'ready'] as const)(
    'keeps a %s admission rejection as a draft without retrying it',
    async (readiness) => {
      let allowed = false;
      const services = createTurnServices({ readiness, canSubmit: () => allowed });
      const chat = { conversation, text: 'Carry on from here.' };
      const view = setup({ chat, services });
      await waitFor(() => expect(field()).toHaveValue(chat.text));
      expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
      allowed = true;
      services.readiness = 'ready';
      view.refresh();
      expect(view.sendMessages).not.toHaveBeenCalled();
      expect(field()).toHaveValue(chat.text);
    },
  );

  it('preserves a failed destination handoff as an editable draft', async () => {
    const services = createTurnServices({ readiness: 'pending', canSubmit: () => false });
    const chat = { conversation, text: 'Carry on from here.' };
    const view = setup({ chat, services });
    await waitFor(() => expect(rows()).toHaveLength(2));
    services.readiness = 'blocked';
    view.refresh();
    await waitFor(() => expect(field()).toHaveValue(chat.text));
    expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('sends only the current destination handoff after switching while pending', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Old destination.' }, services });
    await waitFor(() => expect(rows()).toHaveLength(2));
    const next = {
      conversation: { ...conversation, conversationId: 'next-destination' },
      text: 'New destination.',
    };
    view.open(next);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Side chat' })).toHaveAttribute(
        'data-side-chat',
        'next-destination',
      ),
    );
    services.readiness = 'ready';
    view.refresh();
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    expect(view.sendMessages.mock.calls[0][0].payload).toMatchObject({
      text: 'New destination.',
      conversationId: 'next-destination',
    });
  });

  it.each(['ready', 'blocked'] as const)(
    'keeps an edited draft when a pending destination becomes %s',
    async (readiness) => {
      const services = createTurnServices({
        readiness: 'pending',
        canSubmit: () => readiness === 'ready',
      });
      const chat = { conversation, text: 'Original handoff.' };
      const view = setup({ chat, services });
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.change(field(), { target: { value: 'My revised question.' } });
      expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
      services.readiness = readiness;
      view.refresh();
      await settle();
      expect(field()).toHaveValue('My revised question.');
      expect(view.sendMessages).not.toHaveBeenCalled();
      expect(view.onHandedTextTaken).toHaveBeenCalledTimes(1);
      if (readiness === 'ready') {
        fireEvent.click(screen.getByTestId('composer-send-button'));
        await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
        expect(view.sendMessages.mock.calls[0][0].payload).toMatchObject({
          text: 'My revised question.',
        });
      }
    },
  );

  it('preserves an existing draft instead of automatically sending different handed words', async () => {
    const view = setup({
      chat: { conversation, text: 'New handoff.' },
      draft: 'My existing draft.',
    });
    await waitFor(() => expect(field()).toHaveValue('My existing draft.'));
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('keeps a deliberately cleared draft empty after readiness arrives', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const chat = { conversation, text: 'Original handoff.' };
    const view = setup({ chat, services });
    await waitFor(() => expect(field()).toHaveValue(chat.text));
    fireEvent.change(field(), { target: { value: '' } });
    services.readiness = 'ready';
    view.refresh();
    await settle();
    expect(field()).toHaveValue('');
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('keeps pending words when promoted before history has loaded', async () => {
    const chat = { conversation, text: 'Keep these words.' };
    const loadMessages = jest.fn<Promise<TMessage[]>, []>(() => new Promise(() => undefined));
    const view = setup({ chat, loadMessages });
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe(chat.text);
    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
    expect(view.handOffComposerText).toHaveBeenCalledWith(conversationId, chat.text);
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('');
    loadMessages.mockResolvedValue([user, reply('response-1', 'It shipped.')]);
    view.open({ conversation });
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('keeps a pending draft on switch and ordinary reopen without automatic submission', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Keep these words.' }, services });
    await waitFor(() => expect(rows()).toHaveLength(2));
    view.open({ conversation: { ...conversation, conversationId: 'other' } });
    services.readiness = 'ready';
    view.open({ conversation });
    await waitFor(() => expect(field()).toHaveValue('Keep these words.'));
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('does not duplicate a deliberate manual send while automatic readiness is pending', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const chat = { conversation, text: 'Send now.' };
    const view = setup({ chat, services });
    await waitFor(() => expect(screen.getByTestId('composer-send-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    services.readiness = 'ready';
    view.refresh();
    await settle();
    expect(view.sendMessages).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('');
  });

  it('does not re-arm an accepted manual handoff when its withdrawn turn restores identical words', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Send now.' }, services });
    await waitFor(() => expect(screen.getByTestId('composer-send-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.streams).toHaveLength(1));
    act(() =>
      view.streams[0].push({
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
    await waitFor(() => expect(field()).toHaveValue('Send now.'));
    services.readiness = 'ready';
    view.refresh();
    await settle();
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
    expect(view.sendMessages).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('Send now.');
  });

  it('leaves a rejected manual handoff armed until automatic admission becomes ready', async () => {
    let allowed = false;
    const services = createTurnServices({ readiness: 'pending', canSubmit: () => allowed });
    const view = setup({ chat: { conversation, text: 'Wait for me.' }, services });
    await waitFor(() => expect(screen.getByTestId('composer-send-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('composer-send-button'));
    expect(view.store.get(sideChatAtom)?.text).toBe('Wait for me.');
    expect(view.onHandedTextTaken).not.toHaveBeenCalled();
    expect(view.sendMessages).not.toHaveBeenCalled();
    allowed = true;
    services.readiness = 'ready';
    view.refresh();
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
    expect(field()).toHaveValue('');
  });

  it('does not automatically send an equal pre-existing draft', async () => {
    const view = setup({ chat: { conversation, text: 'My question.' }, draft: 'My question.' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
    expect(view.sendMessages).not.toHaveBeenCalled();
    expect(field()).toHaveValue('My question.');
  });

  it('does not clear different side words written during the synchronous promotion handoff', async () => {
    const view = setup({ draft: 'Transfer these words.' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    view.handOffComposerText.mockImplementation(() =>
      view.store.set(sideChatDraftFamily(conversationId), 'New side words.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
    expect(view.handOffComposerText).toHaveBeenCalledWith(conversationId, 'Transfer these words.');
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('New side words.');
  });

  it.each(['attached', 'legacy', 'recovery', 'replacement'] as const)(
    'preserves automatic intent through real %s workspace admission',
    async (mode) => {
      const inputs = turnInputs();
      if (mode === 'legacy') inputs.workspace.startupConfig = {};
      if (mode === 'recovery') inputs.workspace.recoveryPending = true;
      else if (mode === 'replacement') inputs.workspace.replacingDecision = true;
      else inputs.workspace.statuses['personal-vm'] = { isLoading: true, isError: false };
      const services = createTurnServices({ readCodeInputs: () => inputs });
      const selected = { ...conversation, ...inputs.workspace.conversation!, conversationId };
      inputs.workspace.conversation = selected;
      inputs.approval.conversation = selected;
      const view = setup({
        chat: { conversation: selected, text: 'Use the workspace.' },
        services,
      });
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(view.sendMessages).not.toHaveBeenCalled();
      expect(view.store.get(sideChatAtom)?.text).toBe('Use the workspace.');
      view.refresh();
      view.refresh();
      expect(services.logger.warn).not.toHaveBeenCalled();
      inputs.workspace.recoveryPending = false;
      inputs.workspace.replacingDecision = false;
      inputs.workspace.statuses = turnInputs().workspace.statuses;
      view.refresh();
      await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
      view.refresh();
      await settle();
      expect(view.sendMessages).toHaveBeenCalledTimes(1);
      expect(field()).toHaveValue('');
    },
  );

  it('keeps terminal workspace refusal manual without retrying on unrelated renders', async () => {
    const inputs = turnInputs();
    inputs.workspace.statuses['personal-vm'] = { isLoading: false, isError: true };
    const view = setup({
      chat: { conversation, text: 'Unavailable workspace.' },
      services: createTurnServices({ readCodeInputs: () => inputs }),
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.store.get(sideChatAtom)?.text).toBeUndefined();
    expect(field()).toHaveValue('Unavailable workspace.');
    inputs.workspace.statuses = turnInputs().workspace.statuses;
    view.refresh();
    await settle();
    expect(view.sendMessages).not.toHaveBeenCalled();
  });

  it('sends an explicit without-attached decision without waiting for unrelated workspace status', async () => {
    const inputs = turnInputs();
    inputs.workspace.conversation = {
      ...inputs.workspace.conversation!,
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    };
    inputs.workspace.statuses['personal-vm'] = { isLoading: true, isError: false };
    const view = setup({
      chat: {
        conversation: { ...conversation, codeEnvironmentMode: 'without_attached' },
        text: 'No attached workspace.',
      },
      services: createTurnServices({ readCodeInputs: () => inputs }),
    });
    await waitFor(() => expect(view.sendMessages).toHaveBeenCalledTimes(1));
    expect(field()).toHaveValue('');
  });

  it.each(['close', 'remount'] as const)(
    'preserves known withdrawn words through %s during reconciliation',
    async (action) => {
      const view = setup();
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.change(field(), { target: { value: 'Keep withdrawn words.' } });
      fireEvent.click(screen.getByTestId('composer-send-button'));
      await waitFor(() => expect(view.streams).toHaveLength(1));
      let cleaned = false;
      const unsubscribe = view.queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type !== 'updated' ||
          event.query.queryKey[0] !== 'messages' ||
          event.query.queryKey[1] !== conversationId
        )
          return;
        const messages = event.query.state.data as TMessage[] | undefined;
        if (!cleaned && messages?.length === 2) {
          cleaned = true;
          if (action === 'close') view.store.set(sideChatAtom, null);
          view.unmount();
        }
      });
      act(() =>
        view.streams[0].push({
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
      await waitFor(() => expect(cleaned).toBe(true));
      await settle();
      unsubscribe();
      expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('Keep withdrawn words.');
      if (action === 'close') view.open({ conversation });
      view.remount();
      await waitFor(() => expect(field()).toHaveValue('Keep withdrawn words.'));
      expect(view.sendMessages).toHaveBeenCalledTimes(1);
    },
  );

  it('restitutes known withdrawal before stop acknowledgement so promotion transfers exactly one copy', async () => {
    const view = setup();
    let acknowledge!: () => void;
    view.abort.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ success: true });
        }),
    );
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'Move the withdrawn words.' } });
    fireEvent.click(screen.getByTestId('composer-send-button'));
    await waitFor(() => expect(view.streams).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }));
    await waitFor(() => expect(view.abort).toHaveBeenCalledTimes(1));
    act(() =>
      view.streams[0].push({
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
    try {
      await waitFor(() => expect(field()).toHaveValue('Move the withdrawn words.'));
      fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
      expect(view.handOffComposerText).toHaveBeenCalledTimes(1);
      expect(view.handOffComposerText).toHaveBeenCalledWith(
        conversationId,
        'Move the withdrawn words.',
      );
      expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('');
    } finally {
      await act(async () => acknowledge());
    }
    await settle();
    expect(view.store.get(sideChatDraftFamily(conversationId))).toBe('');
  });

  it('does not submit a pending handoff after the panel closes', async () => {
    const services = createTurnServices({ readiness: 'pending' });
    const view = setup({ chat: { conversation, text: 'Carry on from here.' }, services });
    await waitFor(() => expect(rows()).toHaveLength(2));
    view.unmount();
    services.readiness = 'ready';
    await settle();
    expect(view.sendMessages).not.toHaveBeenCalled();
    expect(view.onHandedTextTaken).not.toHaveBeenCalled();
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
    const { openConversation, onClose, open } = setup();
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Open as the main chat' }));
    expect(openConversation).toHaveBeenCalledWith(expect.objectContaining({ conversationId }));
    expect(onClose).toHaveBeenCalledTimes(1);

    open({ conversation });
    await waitFor(() => expect(rows()).toHaveLength(2));
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
