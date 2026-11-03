/**
 * @jest-environment jsdom
 */
import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { MessagesScrollButtonProps, MessagesViewProps } from '../MessagesView';
import type { MessagesHost } from '../../../react/messages/host';
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

function createHost(overrides: Partial<MessagesHost> = {}) {
  const reportNearBottom = jest.fn();
  const useConversationSeen = jest.fn<
    jest.Mock,
    [string | undefined, boolean, () => boolean | null, (messageId: string) => boolean]
  >(() => reportNearBottom);
  const host = createMessagesHost({
    useScreenshotTarget: () => useRef<HTMLDivElement>(null),
    useAutoScroll: () => false,
    useConversationSeen,
    ...overrides,
  });
  return { host, reportNearBottom, useConversationSeen };
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
  const view = (next: Partial<MessagesViewProps>) => (
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
    const { host, reportNearBottom } = createHost();
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

    button?.onNearBottomChange(false);
    expect(reportNearBottom).toHaveBeenCalledWith(false);
  });

  it('asks the seen reporter about the conversation and whether a reply has rendered', () => {
    const { host, useConversationSeen } = createHost();
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

    expect(useConversationSeen).toHaveBeenCalledWith(
      'convo-1',
      false,
      expect.any(Function),
      expect.any(Function),
    );
    const { calls } = useConversationSeen.mock;
    const isResponseRendered = calls[calls.length - 1][3];
    expect(isResponseRendered('reply-1')).toBe(true);
    expect(isResponseRendered('elsewhere')).toBe(false);
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
