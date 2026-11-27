import React from 'react';
import { RetentionMode } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ArchiveAllChats } from '../ArchiveAllChats';
import { initializeI18n } from '~/locales/i18n';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
const mockStartNewChat = jest.fn();
const mockGetConversation = jest.fn();
const mockGetConversationById = jest.fn();
let mockIsLoading = false;
let mockPendingArchives = 0;
let mockOnSuccess: (() => void) | undefined;
let mockOnError: (() => void | Promise<void>) | undefined;
let mockStartupConfig: { interface?: { retentionMode?: RetentionMode } } | undefined;

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
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks/Conversations/useGetConversation', () => ({
  __esModule: true,
  default: () => mockGetConversation,
}));

jest.mock('~/hooks/Conversations/useNewChat', () => ({
  __esModule: true,
  default: () => ({ startNewChat: mockStartNewChat }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
}));

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  return {
    ...actual,
    useIsMutating: () => mockPendingArchives,
  };
});

describe('ArchiveAllChats', () => {
  beforeAll(async () => {
    await initializeI18n();
  });

  beforeEach(() => {
    mockIsLoading = false;
    mockPendingArchives = 0;
    mockOnSuccess = undefined;
    mockOnError = undefined;
    mockStartupConfig = undefined;
    jest.clearAllMocks();
    mockGetConversation.mockReturnValue({
      conversationId: 'conversation-1',
      isTemporary: false,
    });
  });

  it.each([undefined, RetentionMode.TEMPORARY, RetentionMode.ALL])(
    'says archived chats stay under Archived chats when the retention mode is %s',
    (retentionMode) => {
      mockStartupConfig = { interface: { retentionMode } };
      render(<ArchiveAllChats />);

      fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));

      expect(
        within(screen.getByRole('dialog')).getByText(
          'Are you sure you want to archive all chats? They will be moved out of your chat list and remain available under Archived chats.',
        ),
      ).toBeInTheDocument();
    },
  );

  /** Archive-all turns every chat temporary then, so none of them stays under Archived chats. */
  it('warns that archived chats are deleted when the administrator enforces temporary chats', () => {
    mockStartupConfig = { interface: { retentionMode: RetentionMode.EPHEMERAL } };
    render(<ArchiveAllChats />);

    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(
      dialog.getByText(
        'Are you sure you want to archive all chats? Temporary Chat is enabled for all chats by your administrator, so they will not appear under Archived chats and will be deleted automatically.',
      ),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/remain available under Archived chats/)).not.toBeInTheDocument();
  });

  it('submits through the shared button and closes the confirmation dialog', async () => {
    render(<ArchiveAllChats />);

    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('disables the trigger and submit button while showing the loading spinner', () => {
    const { rerender } = render(<ArchiveAllChats />);
    const trigger = screen.getByRole('button', { name: 'Archive all chats' });
    fireEvent.click(trigger);

    mockIsLoading = true;
    rerender(<ArchiveAllChats />);

    const submit = screen.getByRole('button', { name: 'Archive' });
    expect(trigger).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit.querySelector('svg.spinner')).toBeInTheDocument();
  });

  it('stays disabled when another archive-all mutation is already pending', () => {
    mockPendingArchives = 1;
    render(<ArchiveAllChats />);

    const trigger = screen.getByRole('button', { name: 'Archive all chats' });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts a new chat when the archived conversation is still active', () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a conversation opened while the archive request was pending', () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a legacy temporary conversation that the backend did not archive', () => {
    mockGetConversation.mockReturnValue({
      conversationId: 'legacy-temporary-conversation',
      expiredAt: '2026-08-16T12:00:00.000Z',
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps a new chat that has no persisted conversation id', () => {
    mockGetConversation.mockReturnValue(null);
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    mockOnSuccess?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('starts a new chat when a partial archive already committed the active conversation', async () => {
    mockGetConversationById.mockResolvedValue({
      conversationId: 'conversation-1',
      isArchived: true,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await mockOnError?.();

    expect(mockGetConversationById).toHaveBeenCalledWith('conversation-1');
    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to archive all chats' }),
    );
  });

  it('keeps the active chat when a later archive batch fails before committing it', async () => {
    mockGetConversationById.mockResolvedValue({
      conversationId: 'conversation-1',
      isArchived: false,
    });
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await mockOnError?.();

    expect(mockGetConversationById).toHaveBeenCalledWith('conversation-1');
    expect(mockStartNewChat).not.toHaveBeenCalled();
  });

  it('keeps the active chat when archive state cannot be confirmed after an error', async () => {
    mockGetConversationById.mockRejectedValue(new Error('conversation lookup failed'));
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await mockOnError?.();

    expect(mockStartNewChat).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to archive all chats' }),
    );
  });

  it('does not refetch when the user opened another conversation before the error', async () => {
    render(<ArchiveAllChats />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive all chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

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
