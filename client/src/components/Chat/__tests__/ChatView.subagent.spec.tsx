import React from 'react';
import { render, screen } from '@testing-library/react';
import { MessagesHostTestProvider } from 'test/messagesHost';
import { ChatSurfaceHarness } from 'test/harness';
import ChatView from '../ChatView';
/** The app registers its parts host at boot (App.jsx); the child's list reads it. */
import '~/Providers/MessagePartsHostContext';

let mockConversation: Record<string, unknown> | null;

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'child-thread' }),
}));

jest.mock('recoil', () => ({
  atomFamily: () => () => ({}),
  useRecoilValue: () => false,
  useRecoilCallback: () => () => undefined,
}));

jest.mock('react-hook-form', () => ({
  useForm: () => ({}),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  Spinner: () => <div data-testid="spinner" />,
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  useLocalize: () => (key: string) => key,
  useRemScale: () => 1,
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  Constants: { NEW_CONVO: 'new', SEARCH: 'search' },
  buildTree: ({ messages }: { messages: unknown[] }) => messages,
}));

jest.mock('@librechat/chat/react', () => {
  const actual = jest.requireActual('@librechat/chat/react');
  return {
    ...actual,
    ChatSessionProvider: ({
      children,
    }: {
      children: (session: { messages: unknown[]; isLoading: boolean }) => React.ReactNode;
    }) => (
      <actual.ChatContext.Provider value={{ conversation: mockConversation }}>
        {children({ messages: [{ messageId: 'message-1' }], isLoading: false })}
      </actual.ChatContext.Provider>
    ),
  };
});

jest.mock('~/hooks', () => ({
  useAddedResponse: () => ({}),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => {
  const Passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const Context = { Provider: Passthrough };
  return {
    AddedChatContext: Context,
    useChatContext: jest.requireActual('~/Providers/ChatContext').useChatContext,
    ChatFormProvider: Passthrough,
    ComposerRestoreProvider: Passthrough,
    useFileMapContext: () => new Map(),
    useAgentsMapContext: () => undefined,
  };
});

jest.mock('~/hooks/Chat/target', () => ({
  __esModule: true,
  default: () => ({ ready: true, pending: false, failed: false, retry: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useProjectQuery: () => ({ data: undefined }),
}));

jest.mock('../Input/ConversationStarters', () => () => null);
/** The package list renders the child's messages; the app's pieces of it are not under test. */
jest.mock('../Messages/PendingTurn', () => () => null);
jest.mock('../Messages/Content/Parts/PendingSteers', () => () => null);
jest.mock('../Presentation', () => ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
));
jest.mock('../Input/ChatForm', () => () => <div data-testid="chat-form" />);
jest.mock('../Landing', () => () => <div data-testid="landing" />);
jest.mock('~/components/Lia', () => () => null);
jest.mock('../Trace', () => ({
  TraceSurface: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('../Footer', () => ({
  __esModule: true,
  default: () => <div data-testid="footer" />,
  useConfiguredFooter: () => false,
  useLandingFooter: () => true,
}));
jest.mock('../Header', () => ({ readOnly }: { readOnly?: boolean }) => (
  <div data-read-only={String(readOnly)} data-testid="header" />
));

jest.mock('~/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    centerFormOnLanding: {},
  },
}));

describe('ChatView child-thread execution identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a child without a standalone identity as view-only', () => {
    mockConversation = {
      conversationId: 'child-thread',
      title: 'Graph child',
      subagentThread: {
        parentConversationId: 'parent-thread',
      },
    };

    render(
      <ChatSurfaceHarness>
        <MessagesHostTestProvider>
          <ChatView />
        </MessagesHostTestProvider>
      </ChatSurfaceHarness>,
    );

    expect(screen.queryByTestId('chat-form')).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('com_ui_subagent_thread_read_only');
    expect(screen.getByTestId('header')).toHaveAttribute('data-read-only', 'true');
  });
});
