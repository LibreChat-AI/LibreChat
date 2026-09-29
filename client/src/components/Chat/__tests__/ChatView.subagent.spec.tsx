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

jest.mock('~/hooks', () => ({
  useAddedResponse: () => ({}),
  useResumeOnLoad: jest.fn(),
  useAdaptiveSSE: jest.fn(),
  useQueueDrain: jest.fn(),
  useQueuedTurnReveal: jest.fn(),
  useScrollbarGutterSeed: jest.fn(),
  useLocalize: () => (key: string) => key,
  useChatHelpers: () => ({
    conversation: mockConversation,
    getMessages: jest.fn(),
    ask: jest.fn(),
  }),
}));

jest.mock('~/Providers', () => {
  const Passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const Context = { Provider: Passthrough };
  return {
    ChatContext: Context,
    AddedChatContext: Context,
    ChatFormProvider: Passthrough,
    useFileMapContext: () => new Map(),
  };
});

jest.mock('~/data-provider', () => ({
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
jest.mock('../Trace', () => ({
  TraceSurface: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('../Footer', () => ({
  __esModule: true,
  default: () => <div data-testid="footer" />,
  useConfiguredFooter: () => false,
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
    submissionByIndex: jest.fn(),
    isSubmittingFamily: jest.fn(),
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

  it('keeps a saved-agent child view-only after it settles', () => {
    mockConversation = {
      conversationId: 'child-thread',
      title: 'Saved agent child',
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
