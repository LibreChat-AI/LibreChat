/**
 * @jest-environment jsdom
 */
import { useEffect } from 'react';
import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { MessagesHost } from '../../../react/messages/host';
import type { ChatContract } from '../../../react/chat/contract';
import type { ChatScreenMessagesSlots } from '../messages';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import ScreenMessages from '../messages';

beforeAll(initEnglish);
/** The client config cleared mocks between tests; this suite came from there. */
beforeEach(() => jest.clearAllMocks());

let mockMessagesKey = 'convo-1';
let mockMaximizeChatSpace = false;
let mockFlatThread = false;
const mockNavMount = jest.fn();
const mockNavUnmount = jest.fn();

/** The rail as the app mounts it: keyed to its conversation, reporting its lifetime. */
function MessageNav({ conversationId }: { conversationId?: string | null }) {
  useEffect(() => {
    mockNavMount();
    return () => mockNavUnmount();
  }, []);
  return <div data-testid="message-nav" data-conversation-id={conversationId} />;
}

/** The app's slots, the way ChatView fills them, with each piece reduced to what it was handed. */
const slots = (): ChatScreenMessagesSlots => ({
  flatThread: mockFlatThread,
  renderPendingTurn: () => null,
  renderPendingSteers: ({ conversationId, fullWidth }) => (
    <div
      data-testid="pending-steers"
      data-conversation-id={conversationId}
      data-full-width={String(fullWidth)}
    />
  ),
  renderScrollButton: () => null,
  renderNav: ({ conversationId }) => (
    <MessageNav key={conversationId} conversationId={conversationId} />
  ),
});

/** ChatScreen's default list, under the viewer's surface preferences. */
function MessagesView({
  messagesTree,
  messages,
}: {
  messagesTree: TMessage[] | null;
  messages: TMessage[] | null;
}) {
  return (
    <ChatSurfaceProvider
      value={{
        enterToSend: true,
        maximizeChatSpace: mockMaximizeChatSpace,
        showScrollButton: false,
        composerBindings: {
          shortcutsEnabled: true,
          submitOverride: undefined,
          yieldedChords: new Set<string>(),
        },
        claimForeground: () => undefined,
        handOffComposerText: () => undefined,
      }}
    >
      <ScreenMessages messagesTree={messagesTree} messages={messages} slots={slots()} />
    </ChatSurfaceProvider>
  );
}

/** Rows render as their message id, so a spec can tell which messages the thread rendered. */
const host: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => ({
    option: '',
    setOption: () => undefined,
    splitAtTarget: false,
    setSplitAtTarget: () => undefined,
    rememberOption: false,
    setRememberOption: () => undefined,
  }),
  useForkConversation: () => null,
  useMessageCopy: () => ({ copyToClipboard: () => undefined, canCopy: false }),
  useGetMessages: () => () => undefined,
  useHasPendingTurn: () => false,
  renderMessageAudio: () => null,
  useScreenshotTarget: () => undefined,
  useAutoScroll: () => false,
  useConversationMessages: () => undefined,
  useAssistant: () => undefined,
  useGetAddedConvo: () => () => null,
  useStreamedAttachments: () => undefined,
  useMessageFeedback: () => () => undefined,
  useSeenSource: () => ({
    readReply: () => undefined,
    hasReplyProof: () => false,
    markSeen: () => undefined,
    consumeFocusSuppression: () => false,
  }),
  renderMessageIcon: () => null,
  useMaximizeChatSpace: () => false,
  useHideSelectedAuthor: () => false,
  useAgentsMap: () => undefined,
  renderMessageBody: ({ message }) => <div data-testid="row">{message.messageId}</div>,
  renderWakeup: () => null,
  renderPrivateText: () => null,
  renderActivity: () => null,
  useFileMap: () => undefined,
};

const partsHost = createMessagePartsHost();
const store = createStore();

const renderedRows = () => screen.queryAllByTestId('row').map((row) => row.textContent);

/** The pane's chat contract, as far as the list reads it: the pane and the routed key. */
const queryClient = new QueryClient();

const withChat = (ui: ReactElement) => (
  <QueryClientProvider client={queryClient}>
    <Provider store={store}>
      <MessagesHostProvider host={host}>
        <MessagePartsHostProvider host={partsHost}>
          <ChatContext.Provider
            value={
              {
                index: 0,
                isSubmitting: false,
                latestMessageDepth: 0,
                messagesKey: mockMessagesKey,
              } as unknown as ChatContract
            }
          >
            {ui}
          </ChatContext.Provider>
        </MessagePartsHostProvider>
      </MessagesHostProvider>
    </Provider>
  </QueryClientProvider>
);

const messageTree = [
  {
    messageId: 'assistant-1',
    conversationId: 'convo-1',
  },
] as unknown as TMessage[];

describe('MessagesView pending steers', () => {
  beforeEach(() => {
    mockMessagesKey = 'convo-1';
    mockMaximizeChatSpace = false;
    mockFlatThread = false;
  });

  it('keeps the failed-steer surface mounted in the recursive renderer', () => {
    render(withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />));

    expect(renderedRows()).toEqual(['assistant-1']);
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
  });

  it.each([
    [true, 'from-messages'],
    [false, 'from-tree'],
  ])('renders the package thread with FLAT_THREAD %s', (flat, rendered) => {
    mockFlatThread = flat;
    const tree = [{ ...messageTree[0], messageId: 'from-tree' }];
    const messages = [{ ...messageTree[0], messageId: 'from-messages' }];
    render(withChat(<MessagesView messagesTree={tree} messages={messages} />));

    expect(renderedRows()).toEqual([rendered]);
  });

  it.each([false, true])(
    'passes the host chat width preference (%s) to pending steers',
    (fullWidth) => {
      mockMaximizeChatSpace = fullWidth;
      render(withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />));

      expect(screen.getByTestId('pending-steers')).toHaveAttribute(
        'data-full-width',
        String(fullWidth),
      );
    },
  );

  it('passes the full-width preference in the flat renderer too', () => {
    mockMaximizeChatSpace = true;
    mockFlatThread = true;
    render(withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />));

    expect(renderedRows()).toEqual(['assistant-1']);
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-full-width', 'true');
  });

  it('keys the pending surface to the rendered tree, not the lagging context', () => {
    /** Warm-cache navigation renders the destination tree while the Recoil
     *  conversation still names the source chat. Cancel and Escalate must act
     *  on the run the reader is looking at. */
    const destinationTree = [
      { messageId: 'assistant-2', conversationId: 'convo-2' },
    ] as unknown as TMessage[];

    render(withChat(<MessagesView messagesTree={destinationTree} messages={destinationTree} />));

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-2');
  });

  it('shows the empty note instead of a thread while the destination tree is empty', () => {
    mockFlatThread = true;
    mockMessagesKey = 'convo-2';
    render(withChat(<MessagesView messagesTree={[]} messages={[]} />));

    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(renderedRows()).toEqual([]);
  });

  it('pins the screenshot identity to the rendered transcript and replaces it on navigation', () => {
    const view = render(
      withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />),
    );
    const initialTarget = screen.getByTestId('screenshot-target');
    expect(initialTarget).toHaveAttribute('data-conversation-id', 'convo-1');
    const destinationTree = [{ ...messageTree[0], conversationId: 'convo-2' }];
    view.rerender(
      withChat(<MessagesView messagesTree={destinationTree} messages={destinationTree} />),
    );
    const destinationTarget = screen.getByTestId('screenshot-target');
    expect(destinationTarget).toHaveAttribute('data-conversation-id', 'convo-2');
    expect(destinationTarget).not.toBe(initialTarget);
    expect(initialTarget.isConnected).toBe(false);
  });

  it('releases the outgoing navigation rail on a warm switch, not on same-chat updates', () => {
    const view = render(
      withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />),
    );
    expect(mockNavMount).toHaveBeenCalledTimes(1);
    const updated = [{ ...messageTree[0], text: 'updated' }];
    view.rerender(withChat(<MessagesView messagesTree={updated} messages={updated} />));
    expect(mockNavMount).toHaveBeenCalledTimes(1);
    expect(mockNavUnmount).not.toHaveBeenCalled();

    const destination = [{ ...messageTree[0], conversationId: 'convo-2' }];
    view.rerender(withChat(<MessagesView messagesTree={destination} messages={destination} />));

    expect(mockNavUnmount).toHaveBeenCalledTimes(1);
    expect(mockNavMount).toHaveBeenCalledTimes(2);
  });

  it('keeps recovery visible while the message tree is temporarily empty', () => {
    render(withChat(<MessagesView messagesTree={[]} messages={[]} />));

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
  });

  it('keys an empty destination to the route, not the lagging context', () => {
    /** Warm navigation to a chat whose tree is still empty: no message names the
     *  destination, and the context still names the source run. */
    mockMessagesKey = 'convo-2';
    render(withChat(<MessagesView messagesTree={[]} messages={[]} />));

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-2');
  });
});
