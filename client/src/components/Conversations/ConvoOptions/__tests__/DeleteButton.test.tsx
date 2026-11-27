import React from 'react';
import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import { Constants } from 'librechat-data-provider';
import '@testing-library/jest-dom';
import type { TConversation } from 'librechat-data-provider';
import { DeleteConversationDialog } from '../DeleteButton';
import store from '~/store';

/** The id an unsent chat carries, on its route and in its state. */
const NEW_CHAT = String(Constants.NEW_CONVO);
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockRoute = { current: 'convo-1' as string | undefined };
const mockDeleteOptions: { current?: { onSuccess?: () => void } } = {};

jest.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ conversationId: mockRoute.current }),
}));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => ({ getQueryData: jest.fn() }),
}));
jest.mock('@librechat/client', () => {
  const Box = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  );
  return {
    Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    Spinner: () => <span role="status" />,
    OGDialog: Box,
    OGDialogClose: Box,
    OGDialogTitle: Box,
    OGDialogHeader: Box,
    OGDialogContent: Box,
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});
jest.mock('~/data-provider', () => ({
  useDeleteConversationMutation: (options: { onSuccess?: () => void }) => {
    mockDeleteOptions.current = options;
    return { mutate: jest.fn(), isLoading: false };
  },
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));

/** Renders the dialog for `convo-1` with the route and the main chat state as given. */
const renderDialog = ({
  route = 'convo-1',
  chat = 'convo-1',
  getCurrentConversationId,
}: {
  route?: string;
  chat?: string;
  getCurrentConversationId?: () => string | undefined;
} = {}) => {
  mockRoute.current = route;
  return render(
    <RecoilRoot
      initializeState={({ set }) =>
        set(store.conversationByIndex(0), { conversationId: chat } as TConversation)
      }
    >
      <DeleteConversationDialog
        conversationId="convo-1"
        title="Hello"
        retainView={jest.fn()}
        setShowDeleteDialog={jest.fn()}
        getCurrentConversationId={getCurrentConversationId}
      />
    </RecoilRoot>,
  );
};

describe('DeleteConversationDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('carries the id its menu item points aria-controls at', () => {
    const { container } = renderDialog();

    expect(container.querySelector('#delete-conversation-dialog')).not.toBeNull();
  });

  it('leaves a chat opened after the delete was confirmed', () => {
    renderDialog({ getCurrentConversationId: () => 'convo-2' });

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('replaces the chat when the deleted one is still the open one', () => {
    renderDialog({ getCurrentConversationId: () => 'convo-1' });

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  it('replaces the routed chat it deleted', () => {
    renderDialog();

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  it('leaves an unsent chat and its composer alone when another chat is deleted', () => {
    renderDialog({ route: NEW_CHAT, chat: NEW_CHAT });

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('replaces a new chat whose first reply is streaming when that chat is deleted', () => {
    renderDialog({ route: NEW_CHAT, chat: 'convo-1' });

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  it('leaves a new chat whose first reply is streaming when another chat is deleted', () => {
    renderDialog({ route: NEW_CHAT, chat: 'convo-2' });

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
