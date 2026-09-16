import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';

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
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  MessagesViewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useChatContext: () => ({ index: 0, latestMessageDepth: 0 }),
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
  useChatSurface: () => ({ showScrollButton: false, maximizeChatSpace: false }),
}));

jest.mock('~/store/autoScroll', () => ({ autoScrollAtom: {} }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { isSubmittingFamily: () => ({}) },
}));

jest.mock('../Thread', () => ({
  FLAT_THREAD: false,
  ThreadList: () => <div data-testid="flat-thread" />,
}));

jest.mock('../MultiMessage', () => ({
  __esModule: true,
  default: () => <div data-testid="multi-message" />,
}));

jest.mock('../Content/Parts/PendingSteers', () => ({
  __esModule: true,
  default: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="pending-steers" data-conversation-id={conversationId} />
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
  it('keeps the failed-steer surface mounted in the recursive renderer', () => {
    render(<MessagesView messagesTree={messageTree} messages={messageTree} />);

    expect(screen.getByTestId('multi-message')).toBeInTheDocument();
    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
    expect(screen.queryByTestId('flat-thread')).not.toBeInTheDocument();
  });

  it('keeps recovery visible while the message tree is temporarily empty', () => {
    render(<MessagesView messagesTree={[]} messages={[]} />);

    expect(screen.getByTestId('pending-steers')).toHaveAttribute('data-conversation-id', 'convo-1');
  });
});
