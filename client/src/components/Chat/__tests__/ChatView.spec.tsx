import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from 'test/layout-test-utils';
import ChatView from '../ChatView';

const mockParams = jest.fn();
const mockConversation = jest.fn();
const mockChatFormProps = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => mockParams(),
}));

/** Auth is out of scope for heading selection; keep the shared harness wrappers. */
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuthContext: () => ({ isAuthenticated: false, user: null, roles: {} }),
}));

jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: () => ({ data: null, isLoading: false, isFetching: false }),
}));

/**
 * Heading selection only needs route params + conversation state. Stub the chat
 * helper surface so the suite can inject matching vs stale IDs without standing
 * up SSE, message trees, or full ChatRoute synchronization.
 */
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => (key === 'com_ui_new_chat' ? 'New chat' : key),
  useChatHelpers: () => ({ conversation: mockConversation() }),
  useAddedResponse: () => ({}),
  useAdaptiveSSE: jest.fn(),
  useResumeOnLoad: jest.fn(),
  useQueueDrain: jest.fn(),
  useQueuedTurnReveal: jest.fn(),
  useScrollbarGutterSeed: jest.fn(),
}));

jest.mock('../Presentation', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../Header', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../Footer', () => ({
  __esModule: true,
  default: () => <div />,
  useConfiguredFooter: () => false,
}));
jest.mock('../Landing', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../Messages/MessagesView', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../Input/ChatForm', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockChatFormProps(props);
    return <div />;
  },
}));
jest.mock('../Input/ConversationStarters', () => ({ __esModule: true, default: () => <div /> }));

describe('ChatView page heading', () => {
  beforeEach(() => {
    mockParams.mockReturnValue({});
    mockConversation.mockReturnValue(null);
  });

  test('exposes a single h1 to assistive technology', () => {
    render(<ChatView />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
  });

  test('keeps the heading visually hidden', () => {
    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only');
  });

  test('announces a localized new chat heading on the landing page', () => {
    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument();
  });

  test('uses the conversation title once a conversation is open', () => {
    mockParams.mockReturnValue({ conversationId: 'convo-1' });
    mockConversation.mockReturnValue({ conversationId: 'convo-1', title: 'Deploy checklist' });

    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1, name: 'Deploy checklist' })).toBeInTheDocument();
  });

  test('falls back to the localized heading when a title is blank', () => {
    mockParams.mockReturnValue({ conversationId: 'convo-1' });
    mockConversation.mockReturnValue({ conversationId: 'convo-1', title: '   ' });

    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument();
  });

  test('prefers the localized heading over a stale title on the landing page', () => {
    mockConversation.mockReturnValue({ conversationId: 'new', title: 'New Chat' });

    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument();
  });

  test('ignores a Recoil title that belongs to a different conversation than the route', () => {
    mockParams.mockReturnValue({ conversationId: 'convo-2' });
    mockConversation.mockReturnValue({ conversationId: 'convo-1', title: 'Previous chat' });

    render(<ChatView />);

    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Previous chat' }),
    ).not.toBeInTheDocument();
  });
});

describe('ChatView composer preferences', () => {
  beforeEach(() => {
    mockParams.mockReturnValue({});
    mockConversation.mockReturnValue(null);
    mockChatFormProps.mockClear();
    localStorage.clear();
  });

  /** ChatForm used to read this preference itself via `useRecoilValue(store.enterToSend)`,
   *  reaching into app-global state the composer only consumes. ChatView now owns the
   *  read and passes it down, the same boundary `showComposerTips` already follows. */
  test('reads the persisted enterToSend preference and passes it into ChatForm', () => {
    localStorage.setItem('enterToSend', JSON.stringify(false));

    render(<ChatView />);

    expect(mockChatFormProps).toHaveBeenCalledWith(expect.objectContaining({ enterToSend: false }));
  });

  /** The same boundary for the dictation preferences: ChatForm consumes them
   *  but ChatView owns the reads. */
  test('passes the persisted Auto Send Text preference and the speech init state', () => {
    localStorage.setItem('autoSendText', JSON.stringify(3));

    render(<ChatView />);

    expect(mockChatFormProps).toHaveBeenCalledWith(
      expect.objectContaining({ autoSendText: 3, speechSettingsInitialized: false }),
    );
  });

  test('falls back to the atom default when nothing is persisted', () => {
    render(<ChatView />);

    expect(mockChatFormProps).toHaveBeenCalledWith(expect.objectContaining({ enterToSend: true }));
  });
});

describe('ChatView composer column', () => {
  beforeEach(() => {
    mockParams.mockReturnValue({ conversationId: 'convo-1' });
    mockConversation.mockReturnValue({ conversationId: 'convo-1', title: 'Deploy checklist' });
  });

  /* The composer's in-flight steer overlay is painted above the composer's top
     edge, so a scroll container here would clip it out of sight for the whole
     run. The gutter that lines the column up with the messages has to be
     reserved with padding instead. */
  test('reserves the message column gutter without becoming a scroll container', () => {
    const { container } = render(<ChatView />);

    const composerColumn = container.querySelector('.scrollbar-gutter-spacer');

    expect(composerColumn).not.toBeNull();
    expect(composerColumn).not.toHaveClass('overflow-y-auto');
    expect(composerColumn).not.toHaveClass('scrollbar-gutter-stable');
  });
});
