import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DeleteConversationDialog } from '../DeleteButton';

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
  useQueryClient: () => ({ getQueryData: jest.fn() }),
}));
jest.mock('librechat-data-provider', () => ({ QueryKeys: { messages: 'messages' } }));
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
jest.mock('~/common', () => ({ NotificationSeverity: { SUCCESS: 'success', ERROR: 'error' } }));

const renderDialog = (getCurrentConversationId?: () => string | undefined) =>
  render(
    <DeleteConversationDialog
      conversationId="convo-1"
      title="Hello"
      retainView={jest.fn()}
      setShowDeleteDialog={jest.fn()}
      getCurrentConversationId={getCurrentConversationId}
    />,
  );

describe('DeleteConversationDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRoute.current = 'convo-1';
  });

  it('carries the id its menu item points aria-controls at', () => {
    const { container } = renderDialog();

    expect(container.querySelector('#delete-conversation-dialog')).not.toBeNull();
  });

  it('leaves a chat opened after the delete was confirmed', () => {
    renderDialog(() => 'convo-2');

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('replaces the chat when the deleted one is still the open one', () => {
    renderDialog(() => 'convo-1');

    mockDeleteOptions.current?.onSuccess?.();

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });
});
