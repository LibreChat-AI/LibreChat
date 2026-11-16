import React from 'react';
import '@testing-library/jest-dom';
import type { ChatScreenProps } from '@librechat/chat/components';
import { renderMessages } from '../Messages/load';
import { render } from 'test/layout-test-utils';
import ChatView from '../ChatView';

const mockScreenProps = jest.fn<void, [ChatScreenProps]>();

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
    ChatSessionProvider: ({
      children,
    }: {
      children: (session: { messages: null; isLoading: boolean }) => React.ReactNode;
    }) => (
      <actual.ChatContext.Provider value={{ conversation: null }}>
        {children({ messages: null, isLoading: false })}
      </actual.ChatContext.Provider>
    ),
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
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
});
