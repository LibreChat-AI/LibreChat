import React, { createRef, isValidElement } from 'react';
import '@testing-library/jest-dom';
import type { ChatScreenMessagesSlots, ChatScreenProps } from '@librechat/chat/components';
import type { ReactElement, ReactNode } from 'react';
import PendingSteers from '../Messages/Content/Parts/PendingSteers';
import PendingTurn from '../Messages/PendingTurn';
import { FLAT_THREAD } from '../Messages/Thread';
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

const screenSlots = (): ChatScreenMessagesSlots => {
  render(<ChatView />);
  const props = mockScreenProps.mock.calls.at(-1)?.[0];
  expect(props?.renderMessages).toBeUndefined();
  return props?.messagesSlots ?? {};
};

const scrollableRef = createRef<HTMLDivElement>();

/** A slot's output as an element, failing the test when the slot rendered nothing. */
function element(node: ReactNode): ReactElement {
  if (!isValidElement(node)) {
    throw new Error('The slot did not render an element');
  }
  return node;
}

describe('ChatView message list slots', () => {
  test('leaves the list to ChatScreen and fills it with the app thread mode', () => {
    expect(screenSlots().flatThread).toBe(FLAT_THREAD);
  });

  test('leaves the scroll control to the package list', () => {
    expect(screenSlots().renderScrollButton).toBeUndefined();
  });

  test('renders the app pending turn and steers with what the list passes', () => {
    const slots = screenSlots();
    const turn = { scrollableRef, messages: null, maximizeChatSpace: true };
    const steers = { conversationId: 'convo-1', index: 0, fullWidth: false };

    const turnElement = element(slots.renderPendingTurn?.(turn));
    const steersElement = element(slots.renderPendingSteers?.(steers));

    expect(turnElement.type).toBe(PendingTurn);
    expect(turnElement.props).toEqual(turn);
    expect(steersElement.type).toBe(PendingSteers);
    expect(steersElement.props).toEqual(steers);
  });

  test('leaves the navigation rail to the package list', () => {
    expect(screenSlots().renderNav).toBeUndefined();
  });
});
