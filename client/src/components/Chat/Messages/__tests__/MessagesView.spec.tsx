import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';

let mockMessagesKey = 'convo-1';
let mockMaximizeChatSpace = false;
let mockFlatThread = false;

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: () => false,
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
}));

jest.mock('~/hooks', () => ({
  useScreenshot: () => ({ screenshotTargetRef: { current: null } }),
  useMessageScrolling: () => ({
    conversation: { conversationId: 'convo-1' },
    contentRef: { current: null },
    scrollableRef: { current: null },
    messagesEndRef: { current: null },
    handleSmoothToRef: jest.fn(),
    debouncedHandleScroll: jest.fn(),
    handleNearBottomChange: jest.fn(),
  }),
  useScrollbarGutter: jest.fn(),
  useConversationSeen: () => jest.fn(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  MessagesViewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useChatContext: () => ({ index: 0, latestMessageDepth: 0, messagesKey: mockMessagesKey }),
  useFileMapContext: () => ({}),
}));

jest.mock('~/hooks/Messages', () => ({
  RowMountProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useProgressiveRowMount: () => null,
}));

jest.mock('~/hooks/Messages/useThreadRows', () => ({
  __esModule: true,
  default: () => [],
}));

jest.mock('~/components/Chat/Subagents/surface', () => ({
  useChatSurface: () => ({ showScrollButton: false, maximizeChatSpace: mockMaximizeChatSpace }),
}));

jest.mock('~/store/autoScroll', () => ({ autoScrollAtom: {} }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { isSubmittingFamily: () => ({}) },
}));

jest.mock('../Thread', () => ({
  get FLAT_THREAD() {
    return mockFlatThread;
  },
  ThreadList: () => <div data-testid="flat-thread" />,
}));

jest.mock('../MultiMessage', () => ({
  __esModule: true,
  default: () => <div data-testid="multi-message" />,
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
jest.mock('../MessageNav', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

import MessagesView from '../MessagesView';

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
    render(<MessagesView messagesTree={messageTree} messages={messageTree} />);

    expect(screen.getByTestId('multi-message')).toBeInTheDocument();
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
    expect(screen.queryByTestId('flat-thread')).not.toBeInTheDocument();
  });

  it.each([false, true])(
    'passes the host chat width preference (%s) to pending steers',
    (fullWidth) => {
      mockMaximizeChatSpace = fullWidth;
      render(<MessagesView messagesTree={messageTree} messages={messageTree} />);

      expect(screen.getByTestId('pending-steers')).toHaveAttribute(
        'data-full-width',
        String(fullWidth),
      );
    },
  );

  it('passes the full-width preference in the flat renderer too', () => {
    mockMaximizeChatSpace = true;
    mockFlatThread = true;
    render(<MessagesView messagesTree={messageTree} messages={messageTree} />);

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

    render(<MessagesView messagesTree={destinationTree} messages={destinationTree} />);

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-2');
  });

  it('keeps recovery visible while the message tree is temporarily empty', () => {
    render(<MessagesView messagesTree={[]} messages={[]} />);

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
  });

  it('keys an empty destination to the route, not the lagging context', () => {
    /** Warm navigation to a chat whose tree is still empty: no message names the
     *  destination, and the context still names the source run. */
    mockMessagesKey = 'convo-2';
    render(<MessagesView messagesTree={[]} messages={[]} />);

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-2');
  });
});
