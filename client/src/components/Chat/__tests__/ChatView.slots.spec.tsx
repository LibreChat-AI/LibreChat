import React from 'react';
import '@testing-library/jest-dom';
import { act } from '@testing-library/react';
import type { ChatScreenProps } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import { renderMessages } from '../Messages/load';
import { render } from 'test/layout-test-utils';
import ChatView from '../ChatView';

const mockScreenProps = jest.fn<void, [ChatScreenProps]>();
const mockPresentation = jest.fn();
const mockReact = React;
/** The session's messages, which a streamed reply changes on every frame. */
const mockSession = (() => {
  let messages: TMessage[] | null = null;
  const listeners = new Set<() => void>();
  return {
    read: () => messages,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (next: TMessage[] | null) => {
      messages = next;
      listeners.forEach((listener) => listener());
    },
  };
})();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ conversationId: 'convo-1' }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuthContext: () => ({ isAuthenticated: false, user: null, roles: {} }),
}));

jest.mock('~/hooks/Chat/target', () => ({
  __esModule: true,
  default: () => ({ ready: true, pending: false, failed: false, retry: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useCachedMessages: () => ({ data: null }),
  useProjectQuery: () => ({ data: undefined }),
}));

jest.mock('@librechat/chat/react', () => {
  const actual = jest.requireActual('@librechat/chat/react');
  return {
    ...actual,
    ChatSessionProvider: ({ children }: { children: React.ReactNode }) => (
      <actual.ChatContext.Provider value={{ conversation: null }}>
        {children}
      </actual.ChatContext.Provider>
    ),
    /** Subscribed to, as the session's own is: a change redraws whoever called it. */
    useChatSessionMessages: () => ({
      messages: mockReact.useSyncExternalStore(mockSession.subscribe, mockSession.read),
      isLoading: false,
    }),
  };
});

/** The screen is the subject's receiver: record what ChatView hands it. */
jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  ChatScreen: (props: ChatScreenProps) => {
    mockScreenProps(props);
    return null;
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAddedResponse: () => ({}),
}));

jest.mock('../Presentation', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => {
    mockPresentation();
    return <div>{children}</div>;
  },
}));
jest.mock('../Footer', () => ({
  __esModule: true,
  default: () => null,
  useConfiguredFooter: () => false,
  useLandingFooter: () => true,
}));

describe('ChatView message list', () => {
  test('hands the screen the on-demand list and no message slots', () => {
    render(<ChatView />);
    const props = mockScreenProps.mock.calls.at(-1)?.[0];
    expect(props?.renderMessages).toBe(renderMessages);
    expect(props?.messagesSlots).toBeUndefined();
  });

  test('redraws the screen for each change of the messages, and nothing the screen sits in', () => {
    mockSession.write(null);
    render(<ChatView />);
    const panes = mockPresentation.mock.calls.length;
    const screens = mockScreenProps.mock.calls.length;

    const first = [{ messageId: 'm-1' }] as TMessage[];
    act(() => mockSession.write(first));
    act(() => mockSession.write([...first, { messageId: 'm-2' } as TMessage]));

    expect(mockScreenProps.mock.calls.length).toBe(screens + 2);
    expect(mockScreenProps.mock.calls.at(-1)?.[0].messages).toHaveLength(2);
    /** The providers a reply streams under are drawn once, not once per frame of it. */
    expect(mockPresentation.mock.calls.length).toBe(panes);
  });
});
