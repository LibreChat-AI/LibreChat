/**
 * @jest-environment jsdom
 */
import { useRef } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { ConversationSeenSource, MessagesHost } from '../../../react/messages/host';
import type { MessagesScrollButtonProps, MessagesViewProps } from '../MessagesView';
import type { ChatContract } from '../../../react/chat/contract';
import type { MessagePartsHost } from '../../../react/host';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessagesView from '../MessagesView';

beforeAll(initEnglish);

const tree = [{ messageId: 'reply-1', conversationId: 'convo-1' }] as TMessage[];

const partsHost = { useFontSize: () => 'text-base' } as unknown as MessagePartsHost;

const RESPONDED_AT = '2026-11-03T10:00:00.000Z';

function createHost(overrides: Partial<MessagesHost> = {}) {
  const markSeen = jest.fn();
  /** convo-1 has an unseen reply, reply-1, whose server fetch is the one the cache holds. */
  const source: ConversationSeenSource = {
    readReply: (conversationId) =>
      conversationId === 'convo-1'
        ? { lastResponseAt: RESPONDED_AT, lastResponseMessageId: 'reply-1', unseen: true }
        : undefined,
    hasReplyProof: (_conversationId, _stamp, from) => from === 'server',
    markSeen,
    consumeFocusSuppression: () => false,
  };
  const host = createMessagesHost({
    useScreenshotTarget: () => useRef<HTMLDivElement>(null),
    useAutoScroll: () => false,
    useConversationMessages: () => undefined,
    useSeenSource: () => source,
    ...overrides,
  });
  return { host, markSeen };
}

/** Lets the seen check's two-frame render gate run out. */
async function flushFrames() {
  for (let frame = 0; frame < 3; frame++) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

/** What the list's scrolling reads from the pane. */
const scrollingInputs: Pick<ChatContract, 'conversation' | 'abortScroll' | 'setAbortScroll'> = {
  abortScroll: false,
  setAbortScroll: jest.fn(),
  conversation: {
    conversationId: 'convo-1',
    endpoint: null,
    title: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
  },
};

const contract: ChatContract = Object.assign(
  {
    index: 0,
    isSubmitting: false,
    latestMessageDepth: 0,
    messagesKey: 'convo-1',
  } as ChatContract,
  scrollingInputs,
);

function renderView(props: Partial<MessagesViewProps>, host: MessagesHost, chat = contract) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.messages, 'convo-1'], tree);
  const view = (next: Partial<MessagesViewProps>) => (
    <QueryClientProvider client={queryClient}>
      <ChatContext.Provider value={chat}>
        <MessagesHostProvider host={host}>
          <MessagePartsHostProvider host={partsHost}>
            <MessagesView
              messagesTree={tree}
              messages={tree}
              showScrollButton
              maximizeChatSpace={false}
              renderThread={({ conversationId }) => (
                <ol aria-label="Thread" data-conversation-id={conversationId} />
              )}
              {...props}
              {...next}
            />
          </MessagePartsHostProvider>
        </MessagesHostProvider>
      </ChatContext.Provider>
    </QueryClientProvider>
  );
  const result = render(view({}));
  return {
    ...result,
    rerenderView: (next: Partial<MessagesViewProps>) => result.rerender(view(next)),
  };
}

describe('MessagesView', () => {
  it('renders the thread inside the screenshot target of the conversation it belongs to', () => {
    renderView({}, createHost().host);

    const target = screen.getByTestId('screenshot-target');
    expect(target).toHaveAttribute('data-conversation-id', 'convo-1');
    expect(target).toContainElement(screen.getByRole('list', { name: 'Thread' }));
  });

  it('shows the empty note instead of a thread for an empty tree', () => {
    const renderThread = jest.fn(() => null);
    renderView({ messagesTree: [], messages: [], renderThread }, createHost().host);

    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(renderThread).not.toHaveBeenCalled();
  });

  it('keys the thread and the rail to the rendered tree, not the lagging conversation', () => {
    const renderNav = jest.fn(() => null);
    const destination = [{ messageId: 'reply-2', conversationId: 'convo-2' }] as TMessage[];
    renderView({ messagesTree: destination, messages: destination, renderNav }, createHost().host);

    expect(screen.getByRole('list', { name: 'Thread' })).toHaveAttribute(
      'data-conversation-id',
      'convo-2',
    );
    expect(renderNav).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'convo-2' }),
    );
  });

  it('keys the pending steers to the routed conversation while the tree is empty', () => {
    const renderPendingSteers = jest.fn(() => null);
    renderView(
      { messagesTree: [], messages: [], renderPendingSteers, maximizeChatSpace: true },
      createHost().host,
      { ...contract, messagesKey: 'convo-2' } as ChatContract,
    );

    expect(renderPendingSteers).toHaveBeenLastCalledWith({
      conversationId: 'convo-2',
      index: 0,
      fullWidth: true,
    });
  });

  it('replaces the screenshot target when the rendered conversation changes', () => {
    const { rerenderView } = renderView({}, createHost().host);
    const first = screen.getByTestId('screenshot-target');

    const destination = [{ messageId: 'reply-2', conversationId: 'convo-2' }] as TMessage[];
    rerenderView({ messagesTree: destination, messages: destination });

    expect(screen.getByTestId('screenshot-target')).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it('wires the scroll control to the end marker and to both near-bottom listeners', () => {
    const { host } = createHost();
    let button: MessagesScrollButtonProps | undefined;
    const { container } = renderView(
      {
        renderScrollButton: (props) => {
          button = props;
          return <button onClick={props.scrollHandler}>Jump</button>;
        },
      },
      host,
    );

    expect(button?.enabled).toBe(true);
    expect(button?.conversationId).toBe('convo-1');
    expect(button?.messagesEndRef.current).toBe(container.querySelector('#messages-end'));
    expect(button?.scrollableRef.current).toBe(
      container.querySelector('#messages-end')?.closest('.scrollbar-gutter-stable'),
    );

    const end = container.querySelector<HTMLElement>('#messages-end');
    const scrollIntoView = jest.fn();
    if (end) {
      end.scrollIntoView = scrollIntoView;
    }
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });
  });

  describe('seen reporting', () => {
    let hasFocus: jest.SpyInstance;

    beforeEach(() => {
      hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    afterEach(() => hasFocus.mockRestore());

    it('marks the conversation seen once its reply is rendered in the list and the end is in view', async () => {
      const { host, markSeen } = createHost();
      let button: MessagesScrollButtonProps | undefined;
      renderView(
        {
          renderThread: () => (
            <div id="reply-1">
              <div data-testid="message-body">Hello</div>
            </div>
          ),
          renderScrollButton: (props) => {
            button = props;
            return null;
          },
        },
        host,
      );

      act(() => button?.onNearBottomChange(true));

      await waitFor(() =>
        expect(markSeen).toHaveBeenCalledWith({
          conversationId: 'convo-1',
          lastResponseAt: RESPONDED_AT,
        }),
      );
      expect(markSeen).toHaveBeenCalledTimes(1);
    });

    it('does not credit a reply row that another surface rendered', async () => {
      const { host, markSeen } = createHost();
      const elsewhere = document.createElement('div');
      elsewhere.id = 'reply-1';
      elsewhere.innerHTML = '<div data-testid="message-body">Hello</div>';
      document.body.appendChild(elsewhere);
      let button: MessagesScrollButtonProps | undefined;
      renderView(
        {
          renderScrollButton: (props) => {
            button = props;
            return null;
          },
        },
        host,
      );

      act(() => button?.onNearBottomChange(true));
      await flushFrames();

      expect(markSeen).not.toHaveBeenCalled();
      elsewhere.remove();
    });

    it('waits while the window is unfocused', async () => {
      hasFocus.mockReturnValue(false);
      const { host, markSeen } = createHost();
      renderView(
        {
          renderThread: () => (
            <div id="reply-1">
              <div data-testid="message-body">Hello</div>
            </div>
          ),
        },
        host,
      );

      await flushFrames();
      expect(markSeen).not.toHaveBeenCalled();
    });
  });

  it('listens to the scroll container and keeps native scroll anchoring outside a mount window', () => {
    let button: MessagesScrollButtonProps | undefined;
    renderView(
      {
        renderScrollButton: (props) => {
          button = props;
          return null;
        },
      },
      createHost().host,
    );

    const scrollable = button?.scrollableRef.current;
    expect(scrollable).toHaveClass('scrollbar-gutter-stable', 'overflow-y-auto');
    expect(scrollable).not.toHaveClass('[overflow-anchor:none]');
  });
});

describe('MessagesView default rail', () => {
  const turns = (conversationId: string) =>
    ['one', 'two', 'three'].map((id, index) => ({
      messageId: `${conversationId}-${id}`,
      conversationId,
      isCreatedByUser: index % 2 === 0,
      text: id,
    })) as TMessage[];
  /** The rail builds its entries from the rendered rows. */
  const renderThread: MessagesViewProps['renderThread'] = ({ messages }) => (
    <ol aria-label="Thread">
      {messages?.map((message) => (
        <li key={message.messageId} id={message.messageId} className="message-render">
          {message.text}
        </li>
      ))}
    </ol>
  );

  it('keeps the rail on same-chat updates and replaces it on a warm switch', async () => {
    const { rerenderView } = renderView(
      { messagesTree: turns('convo-1'), messages: turns('convo-1'), renderThread },
      createHost({ useConversationMessages: (id) => turns(id ?? 'convo-1') }).host,
    );
    const rail = await screen.findByRole('navigation');

    rerenderView({ messagesTree: turns('convo-1'), messages: turns('convo-1') });
    expect(screen.getByRole('navigation')).toBe(rail);

    rerenderView({ messagesTree: turns('convo-2'), messages: turns('convo-2') });
    expect(rail.isConnected).toBe(false);
    expect(await screen.findByRole('navigation')).not.toBe(rail);
  });
});
