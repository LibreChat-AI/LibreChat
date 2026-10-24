import React from 'react';
import { render, screen } from '@testing-library/react';
import ChatView from '../ChatView';

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
  Spinner: () => <div data-testid="spinner" />,
}));

jest.mock('librechat-data-provider', () => ({
  Constants: { NEW_CONVO: 'new', SEARCH: 'search' },
  buildTree: ({ messages }: { messages: unknown[] }) => messages,
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
  useQueueDrain: jest.fn(),
  useQueuedTurnReveal: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useAddedResponse: () => ({}),
  useScrollbarGutterSeed: jest.fn(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Chat/useChatHelpers', () => ({
  __esModule: true,
  default: () => ({
    conversation: mockConversation,
    getMessages: jest.fn(),
    ask: jest.fn(),
  }),
}));

jest.mock('~/hooks/SSE', () => ({
  useAdaptiveSSE: jest.fn(),
  useResumeOnLoad: jest.fn(),
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
  };
});

jest.mock('~/data-provider', () => ({
  useProjectQuery: () => ({ data: undefined }),
  useGetMessagesByConvoId: () => ({
    data: [{ messageId: 'message-1' }],
    isLoading: false,
    isFetching: false,
  }),
}));

jest.mock('../Input/ConversationStarters', () => () => null);
jest.mock('../Messages/MessagesView', () => () => <div data-testid="messages" />);
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

    render(<ChatView />);

    expect(screen.queryByTestId('chat-form')).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('com_ui_subagent_thread_read_only');
    expect(screen.getByTestId('header')).toHaveAttribute('data-read-only', 'true');
  });
});
