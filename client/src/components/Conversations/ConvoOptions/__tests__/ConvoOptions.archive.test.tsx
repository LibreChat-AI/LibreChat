import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import ConvoOptions from '../ConvoOptions';

const mockArchiveMutate = jest.fn();
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockRetainView = jest.fn();
const mockSetIsPopoverActive = jest.fn();
const mockAnnouncePolite = jest.fn();
const mockSetConversation = jest.fn();

jest.mock('@ariakit/react', () => ({
  MenuButton: jest
    .requireActual('react')
    .forwardRef(
      (
        { children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>,
        ref: React.ForwardedRef<HTMLButtonElement>,
      ) => (
        <button ref={ref} {...props}>
          {children}
        </button>
      ),
    ),
}));
jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));
jest.mock('librechat-data-provider', () => ({
  QueryKeys: { messages: 'messages' },
  PermissionTypes: { SHARED_LINKS: 'shared_links' },
  Permissions: { CREATE: 'create' },
}));
jest.mock('@librechat/client', () => ({
  DropdownPopup: ({
    trigger,
    items,
  }: {
    trigger: React.ReactNode;
    items: Array<{ label: string; onClick: () => void }>;
  }) => (
    <>
      {trigger}
      {items
        .filter((item) => item.label === 'com_ui_archive' || item.label === 'com_ui_unarchive')
        .map((item) => (
          <button key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        ))}
    </>
  ),
  Spinner: () => <span role="status" />,
  buttonVariants: () => '',
  useToastContext: () => ({ showToast: jest.fn() }),
  useMediaQuery: () => false,
}));

jest.mock('~/data-provider', () => ({
  useDuplicateConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useAssignConversationToProjectMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useDeleteConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useGetStartupConfig: () => ({ data: { sharedLinksEnabled: false } }),
  useArchiveConvoMutation: () => ({ mutate: mockArchiveMutate, isLoading: false }),
  usePinConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useLocalize: () => (key: string) => key,
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({
    index: 0,
    conversation: { conversationId: 'conversation-1', isArchived: true },
    setConversation: mockSetConversation,
  }),
  useLiveAnnouncer: () => ({ announcePolite: mockAnnouncePolite }),
}));

let mockOpenRouteConvoId: string | undefined = 'conversation-1';

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ conversationId: mockOpenRouteConvoId }),
  };
});

jest.mock('../ProjectButton', () => () => null);
jest.mock('../DeleteButton', () => () => null);
jest.mock('../ShareButton', () => () => null);

const renderOptions = (isArchived: boolean, isActiveConvo = false) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active: boolean) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/c/conversation-1']}>
        <Routes>
          <Route
            path="/c/:conversationId"
            element={
              <ConvoOptions
                conversationId="conversation-1"
                title="A conversation"
                isArchived={isArchived}
                retainView={mockRetainView}
                renameHandler={jest.fn()}
                isPopoverActive={false}
                setIsPopoverActive={mockSetIsPopoverActive}
                isActiveConvo={active}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const { rerender } = render(tree(isActiveConvo));
  /** Opening another chat moves the route and drops this row's active state. */
  return { openAnotherChat: () => rerender(tree(false)) };
};

describe('ConvoOptions archive action', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockArchiveMutate.mockReset();
    mockNavigate.mockReset();
    mockNewConversation.mockReset();
    mockRetainView.mockReset();
    mockSetIsPopoverActive.mockReset();
    mockAnnouncePolite.mockReset();
    mockSetConversation.mockReset();
    mockOpenRouteConvoId = 'conversation-1';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The row's own state decides the direction: an unarchived pin stays listed beside the
   *  archive, and the previous page's rows outlive a status switch, so a list-level flag
   *  would offer to restore a conversation that was never archived. */
  it('restores the open archived conversation state without navigating away from it', () => {
    renderOptions(true);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_unarchive' }));

    expect(mockArchiveMutate).toHaveBeenCalledWith(
      { conversationId: 'conversation-1', isArchived: false },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    const [, callbacks] = mockArchiveMutate.mock.calls[0];
    act(() => callbacks.onSuccess());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
    /* The restored row leaves the archived list, unmounting this menu, so the message has
       to reach the app-level live region rather than one inside the row. */
    expect(mockAnnouncePolite).toHaveBeenCalledWith({
      message: 'com_ui_convo_unarchived',
      isStatus: true,
    });
    const [updater] = mockSetConversation.mock.calls[0];
    expect(updater({ conversationId: 'conversation-1', isArchived: true })).toEqual({
      conversationId: 'conversation-1',
      isArchived: false,
    });
    /* The request outlives the row: if another chat is open by the time it resolves, the
       restore must not replace it with the one the callback was created for. */
    const otherOpen = { conversationId: 'conversation-2', isArchived: false };
    expect(updater(otherOpen)).toBe(otherOpen);
  });

  it('archives an unarchived conversation and leaves the one it just hid', () => {
    renderOptions(false);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    expect(mockArchiveMutate).toHaveBeenCalledWith(
      { conversationId: 'conversation-1', isArchived: true },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    const [, callbacks] = mockArchiveMutate.mock.calls[0];
    act(() => callbacks.onSuccess());
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  /** Archiving the open chat opens a new one in its place, but the request outlives the
   *  click: if the user has opened another chat by then, that is the one on screen and it
   *  must be left alone. */
  it('leaves a newer selection alone when the archive resolves', () => {
    const { openAnotherChat } = renderOptions(false, true);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));
    mockOpenRouteConvoId = 'conversation-2';
    act(() => openAnotherChat());

    const [, callbacks] = mockArchiveMutate.mock.calls[0];
    act(() => callbacks.onSuccess());
    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
