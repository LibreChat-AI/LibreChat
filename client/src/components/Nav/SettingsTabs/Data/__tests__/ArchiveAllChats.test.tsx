import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArchiveAllChats } from '../ArchiveAllChats';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
const mockStartNewChat = jest.fn();
const mockGetConversation = jest.fn();
const mockGetConversationById = jest.fn();
let mockIsLoading = false;
let mockPendingArchives = 0;
let mockOnSuccess: (() => void) | undefined;
let mockOnError: (() => void | Promise<void>) | undefined;

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
    },
  };
});

jest.mock('~/data-provider', () => ({
  useArchiveAllConversationsMutation: (options?: {
    onSuccess?: () => void;
    onError?: () => void | Promise<void>;
  }) => {
    mockOnSuccess = options?.onSuccess;
    mockOnError = options?.onError;
    return {
      mutate: mockMutate,
      isLoading: mockIsLoading,
    };
  },
}));

jest.mock('~/hooks/Conversations/useGetConversation', () => ({
  __esModule: true,
  default: () => mockGetConversation,
}));

jest.mock('~/hooks/Chat/useNewChat', () => ({
  __esModule: true,
  default: () => ({ startNewChat: mockStartNewChat }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  return {
    ...actual,
    useIsMutating: () => mockPendingArchives,
  };
});

describe('ArchiveAllChats', () => {
  beforeEach(() => {
    mockIsLoading = false;
    mockPendingArchives = 0;
    mockOnSuccess = undefined;
    mockOnError = undefined;
    jest.clearAllMocks();
    mockGetConversation.mockReturnValue({
      conversationId: 'conversation-1',
      isTemporary: false,
    });
  });

  it('submits through the shared button and closes the confirmation dialog', async () => {
    render(<ArchiveAllChats />);

    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('disables the trigger and submit button while showing the loading spinner', () => {
    const { rerender } = render(<ArchiveAllChats />);
    const trigger = screen.getByRole('button', { name: 'com_nav_archive_all_chats' });
    fireEvent.click(trigger);

    mockIsLoading = true;
    rerender(<ArchiveAllChats />);

    const submit = screen.getByRole('button', { name: 'com_ui_archive' });
    expect(trigger).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit.querySelector('svg.spinner')).toBeInTheDocument();
  });

  it('stays disabled when another archive-all mutation is already pending', () => {
    mockPendingArchives = 1;
    render(<ArchiveAllChats />);

    const trigger = screen.getByRole('button', { name: 'com_nav_archive_all_chats' });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts a new chat when the archived conversation is still active', () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a conversation opened while the archive request was pending', () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));
    mockGetConversation.mockReturnValue({
      conversationId: 'conversation-2',
      isTemporary: false,
    });

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a temporary conversation that the backend did not archive', () => {
    mockGetConversation.mockReturnValue({
      conversationId: 'temporary-conversation',
      isTemporary: true,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a legacy temporary conversation that the backend did not archive', () => {
    mockGetConversation.mockReturnValue({
      conversationId: 'legacy-temporary-conversation',
      expiredAt: '2026-08-16T12:00:00.000Z',
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));
    mockGetConversation.mockReturnValue({
      conversationId: 'legacy-temporary-conversation',
      isTemporary: false,
    });

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps an already-archived conversation that archive-all could not have changed', () => {
    mockGetConversation.mockReturnValue({
      conversationId: 'archived-conversation',
      isArchived: true,
      isTemporary: false,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a new chat that has no persisted conversation id', () => {
    mockGetConversation.mockReturnValue(null);
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('starts a new chat when a partial archive already committed the active conversation', async () => {
    mockGetConversationById.mockResolvedValue({
      conversationId: 'conversation-1',
      isArchived: true,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    await mockOnError?.();

    expect(mockGetConversationById).toHaveBeenCalledWith('conversation-1');
    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_archive_all_error' }),
    );
  });

  it('keeps the active chat when a later archive batch fails before committing it', async () => {
    mockGetConversationById.mockResolvedValue({
      conversationId: 'conversation-1',
      isArchived: false,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    await mockOnError?.();

    expect(mockGetConversationById).toHaveBeenCalledWith('conversation-1');
    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps the active chat when archive state cannot be confirmed after an error', async () => {
    mockGetConversationById.mockRejectedValue(new Error('conversation lookup failed'));
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    await mockOnError?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_archive_all_error' }),
    );
  });

  it('does not refetch when the user opened another conversation before the error', async () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));
    mockGetConversation.mockReturnValue({
      conversationId: 'conversation-2',
      isTemporary: false,
    });

    await mockOnError?.();

    expect(mockGetConversationById).not.toHaveBeenCalled();
    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a conversation opened while the archive-state lookup is in flight', async () => {
    let resolveLookup: (value: { conversationId: string; isArchived: boolean }) => void = () => {
      throw new Error('lookup resolver was not captured');
    };
    mockGetConversationById.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_archive_all_chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_archive' }));

    const errorHandling = mockOnError?.();
    mockGetConversation.mockReturnValue({
      conversationId: 'conversation-2',
      isTemporary: false,
    });
    resolveLookup({
      conversationId: 'conversation-1',
      isArchived: true,
    });
    await errorHandling;

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });
});
