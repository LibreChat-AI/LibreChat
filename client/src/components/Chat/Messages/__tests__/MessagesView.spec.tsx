import React from 'react';
import { Provider, createStore } from 'jotai';
import { ChatContext } from '@librechat/chat/react';
import { render, screen } from '@testing-library/react';
import type { ChatContract } from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import { siblingIdxFamily } from '~/components/Chat/Messages/Thread/state';
import useThreadRows from '~/hooks/Messages/useThreadRows';
import * as thread from '~/utils/thread';

let mockMessagesKey = 'convo-1';
let mockMaximizeChatSpace = false;
let mockFlatThread = false;
const mockNavMount = jest.fn();
const mockNavUnmount = jest.fn();

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: () => false,
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
}));

jest.mock('~/Providers', () => ({
  MessagesViewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFileMapContext: () => ({}),
}));

jest.mock('~/hooks/Messages/useThreadRows', () => ({
  __esModule: true,
  default: jest.fn(() => []),
}));

jest.mock('~/components/Chat/Subagents/surface', () => ({
  useChatSurface: () => ({ showScrollButton: false, maximizeChatSpace: mockMaximizeChatSpace }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../Thread', () => ({
  get FLAT_THREAD() {
    return mockFlatThread;
  },
  ThreadList: () => <div data-testid="flat-thread" />,
}));

jest.mock('../MultiMessage', () => ({
  __esModule: true,
  default: ({ messageId }: { messageId: string | null }) => (
    <div data-testid="multi-message" data-parent-id={messageId} />
  ),
}));

jest.mock('../Content/Parts/PendingSteers', () => ({
  __esModule: true,
  default: ({ conversationId, fullWidth }: { conversationId: string; fullWidth: boolean }) => (
    <div
      data-testid="pending-steers"
      data-conversation-id={conversationId}
      data-full-width={String(fullWidth)}
    />
  ),
}));

jest.mock('../PendingTurn', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../ScrollButton', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../MessageNav', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    __esModule: true,
    default: function MessageNav({ conversationId }: { conversationId?: string | null }) {
      useEffect(() => {
        mockNavMount();
        return () => mockNavUnmount();
      }, []);
      return <div data-testid="message-nav" data-conversation-id={conversationId} />;
    },
  };
});

import MessagesView from '../MessagesView';

/** The pane's chat contract, as far as the list reads it: the pane and the routed key. */
const withChat = (ui: ReactElement) => (
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
    jest.mocked(useThreadRows).mockReset().mockReturnValue([]);
  });

  it('keeps the failed-steer surface mounted in the recursive renderer', () => {
    render(withChat(<MessagesView messagesTree={messageTree} messages={messageTree} />));

    expect(screen.getByTestId('multi-message')).toBeInTheDocument();
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
    expect(screen.queryByTestId('flat-thread')).not.toBeInTheDocument();
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

    expect(screen.getByTestId('flat-thread')).toBeInTheDocument();
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-full-width', 'true');
    expect(screen.queryByTestId('multi-message')).not.toBeInTheDocument();
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

  it('does not reuse outgoing rows while the conversation context still names the source', () => {
    mockFlatThread = true;
    jest
      .mocked(useThreadRows)
      .mockImplementation(jest.requireActual('~/hooks/Messages/useThreadRows').default);
    const resolve = jest.spyOn(thread, 'resolveThreadRows');
    const large = Array.from({ length: 12_000 }, (_, index) => ({
      ...messageTree[0],
      messageId: `large-${index}`,
      parentMessageId: index === 0 ? null : `large-${index - 1}`,
    }));
    const view = render(withChat(<MessagesView messagesTree={large} messages={large} />));
    const small = [{ ...messageTree[0], conversationId: 'convo-2', messageId: 'small' }];
    view.rerender(withChat(<MessagesView messagesTree={small} messages={small} />));

    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), 'convo-2', expect.anything(), null);
    view.unmount();
    jest.mocked(useThreadRows).mockReset().mockReturnValue([]);
  });

  it('preserves the destination root branch while the context still names the source', () => {
    mockFlatThread = true;
    jest
      .mocked(useThreadRows)
      .mockImplementation(jest.requireActual('~/hooks/Messages/useThreadRows').default);
    const resolve = jest.spyOn(thread, 'resolveThreadRows');
    const jotaiStore = createStore();
    jotaiStore.set(siblingIdxFamily('convo-2'), 1);
    const destination = [
      { ...messageTree[0], messageId: 'older-root', conversationId: 'convo-2' },
      { ...messageTree[0], messageId: 'newer-root', conversationId: 'convo-2' },
    ];
    render(
      <Provider store={jotaiStore}>
        {withChat(<MessagesView messagesTree={destination} messages={destination} />)}
      </Provider>,
    );

    expect(resolve.mock.results.at(-1)?.value[0].source.messageId).toBe('older-root');
    expect(jotaiStore.get(siblingIdxFamily('convo-2'))).toBe(1);
    expect(screen.getByTestId('message-nav')).toHaveAttribute('data-conversation-id', 'convo-2');
  });

  it('uses the rendered owner for recursive root sibling choices too', () => {
    const destination = [{ ...messageTree[0], conversationId: 'convo-2' }];
    render(withChat(<MessagesView messagesTree={destination} messages={destination} />));

    expect(screen.getByTestId('multi-message')).toHaveAttribute('data-parent-id', 'convo-2');
  });

  it('shows the empty note instead of a thread while the destination tree is empty', () => {
    mockFlatThread = true;
    mockMessagesKey = 'convo-2';
    render(withChat(<MessagesView messagesTree={[]} messages={[]} />));

    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(screen.queryByTestId('flat-thread')).not.toBeInTheDocument();
    expect(useThreadRows).not.toHaveBeenCalled();
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
