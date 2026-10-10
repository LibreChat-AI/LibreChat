import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import type { MutableSnapshot } from 'recoil';
import ShareButton from '../ShareButton';
import store from '~/store';

let mockShare: {
  success: boolean;
  shareId: string | null;
  snapshotFiles?: boolean;
} = {
  success: true,
  shareId: 'share-1',
  snapshotFiles: true,
};
const mockCopyLink = jest.fn(() => true);
const mockAnnouncePolite = jest.fn();
const mockGetMessagesByConvoId = jest.fn();
const mockGetMessageById = jest.fn();
let mockResolveTargetMessageId: (() => Promise<string>) | undefined;
let mockLatestMessageId: string | null = 'message-1';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: unknown[]) => mockGetMessagesByConvoId(...args),
      getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
    },
  };
});

jest.mock('librechat-data-provider/react-query', () => ({
  useGetSharedLinkQuery: () => ({ data: mockShare, isLoading: false }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { sharedLinksSnapshotFilesEnabled: true } }),
  fetchConversationMessages: jest.requireActual('~/data-provider/Messages/queries')
    .fetchConversationMessages,
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessageId: () => mockLatestMessageId,
  useGetLatestMessage: () => () =>
    mockLatestMessageId == null ? null : { messageId: mockLatestMessageId },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: () => mockCopyLink,
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: mockAnnouncePolite }),
}));

jest.mock('../SharedLinkButton', () => ({
  __esModule: true,
  default: ({
    showQR,
    setShowQR,
    snapshotFiles,
    targetMessageId,
    resolveTargetMessageId,
  }: {
    showQR: boolean;
    setShowQR: (show: boolean) => void;
    snapshotFiles?: boolean;
    targetMessageId?: string;
    resolveTargetMessageId?: () => Promise<string>;
  }) => {
    mockResolveTargetMessageId = resolveTargetMessageId;
    return (
      <button
        type="button"
        data-testid="share-actions"
        data-snapshot-files={String(snapshotFiles)}
        data-target-message-id={String(targetMessageId)}
        onClick={() => setShowQR(!showQR)}
      >
        {showQR ? 'com_ui_hide_qr' : 'com_ui_show_qr'}
      </button>
    );
  },
}));

const ACTIVE_CONVERSATION_ID = 'conversation-1';

const renderShareButton = (conversationId = ACTIVE_CONVERSATION_ID) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const initializeState = ({ set }: MutableSnapshot) => {
    set(store.conversationByIndex(0), {
      conversationId: ACTIVE_CONVERSATION_ID,
    } as never);
  };

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot initializeState={initializeState}>
          <ShareButton conversationId={conversationId} open={true} onOpenChange={jest.fn()} />
        </RecoilRoot>
      </QueryClientProvider>,
    ),
  };
};

describe('ShareButton', () => {
  beforeEach(() => {
    mockShare = {
      success: true,
      shareId: 'share-1',
      snapshotFiles: true,
    };
    mockCopyLink.mockClear();
    mockCopyLink.mockReturnValue(true);
    mockAnnouncePolite.mockClear();
    mockGetMessagesByConvoId.mockReset();
    mockGetMessageById.mockReset();
    mockLatestMessageId = 'message-1';
    mockResolveTargetMessageId = undefined;
  });

  it('centers the active QR code and keeps details behind inline info controls', () => {
    renderShareButton();

    expect(screen.getByRole('heading', { name: 'com_ui_share_link_to_chat' })).toBeInTheDocument();
    expect(screen.getByText('com_ui_share_update_message')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_share_update_message')).toBeInTheDocument();
    expect(screen.getByLabelText(/com_ui_share_files_description/)).toBeInTheDocument();
    const sharedLinkInput = screen.getByTestId('shared-link-url') as HTMLInputElement;
    expect(sharedLinkInput.value).toContain('/share/share-1');
    expect(sharedLinkInput).toHaveClass('text-right');
    expect(sharedLinkInput).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('button', { name: 'com_ui_copy_link' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'com_ui_share_files' })).toBeChecked();
    expect(document.querySelector('svg[width="200"]')).toBeInTheDocument();
  });

  it('lets the action bar hide and restore the QR code', () => {
    renderShareButton();

    fireEvent.click(screen.getByTestId('share-actions'));
    expect(document.querySelector('svg[width="200"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('share-actions'));
    expect(document.querySelector('svg[width="200"]')).toBeInTheDocument();
  });

  it('copies the shared URL through the reusable copy control', () => {
    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy_link' }));

    expect(mockCopyLink).toHaveBeenCalledTimes(1);
    expect(mockAnnouncePolite).toHaveBeenCalledWith({
      message: 'com_ui_link_copied',
      isStatus: true,
    });
  });

  it('does not announce a copy that never reached the clipboard', () => {
    mockCopyLink.mockReturnValue(false);
    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy_link' }));

    expect(mockCopyLink).toHaveBeenCalledTimes(1);
    expect(mockAnnouncePolite).not.toHaveBeenCalled();
  });

  it('passes file-sharing changes to the link actions', () => {
    renderShareButton();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_share_files' }));

    expect(screen.getByTestId('share-actions')).toHaveAttribute('data-snapshot-files', 'false');
  });

  it('resets the file choice and link when the dialog moves to another conversation', () => {
    mockShare = { success: true, shareId: 'share-1', snapshotFiles: false };
    const { rerender, queryClient } = renderShareButton();

    expect(screen.getByRole('switch', { name: 'com_ui_share_files' })).not.toBeChecked();

    mockShare = { success: true, shareId: null };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }: MutableSnapshot) => {
            set(store.conversationByIndex(0), {
              conversationId: ACTIVE_CONVERSATION_ID,
            } as never);
          }}
        >
          <ShareButton conversationId="conversation-2" open={true} onOpenChange={jest.fn()} />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('switch', { name: 'com_ui_share_files' })).toBeChecked();
    const sharedLinkInput = screen.queryByTestId('shared-link-url') as HTMLInputElement | null;
    expect(sharedLinkInput?.value ?? '').not.toContain('/share/share-1');
  });

  it('targets the active branch tail when sharing the open conversation', () => {
    renderShareButton();

    expect(screen.getByTestId('share-actions')).toHaveAttribute(
      'data-target-message-id',
      'message-1',
    );
  });

  it('verifies the selected branch tail with a bounded persisted-message read', async () => {
    mockGetMessageById.mockResolvedValue([{ messageId: 'message-1' }]);
    renderShareButton();

    await expect(mockResolveTargetMessageId?.()).resolves.toBe('message-1');
    await expect(mockResolveTargetMessageId?.()).resolves.toBe('message-1');
    expect(mockGetMessageById).toHaveBeenCalledTimes(2);
    expect(mockGetMessageById).toHaveBeenCalledWith(ACTIVE_CONVERSATION_ID, 'message-1');
    expect(mockGetMessagesByConvoId).not.toHaveBeenCalled();
  });

  it('rejects an unsaved selected tail instead of dropping the branch target', async () => {
    mockGetMessageById.mockResolvedValue([]);
    renderShareButton();

    await expect(mockResolveTargetMessageId?.()).rejects.toMatchObject({
      code: 'TARGET_MESSAGE_NOT_FOUND',
    });
  });

  it('hydrates the message cache before deciding an initially unloaded chat is empty', async () => {
    mockLatestMessageId = null;
    mockGetMessagesByConvoId.mockImplementation(async () => {
      mockLatestMessageId = 'persisted-message';
      return [{ messageId: 'persisted-message' }];
    });
    mockGetMessageById.mockResolvedValue([{ messageId: 'persisted-message' }]);
    renderShareButton();

    await expect(mockResolveTargetMessageId?.()).resolves.toBe('persisted-message');
    expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(ACTIVE_CONVERSATION_ID, {
      toolPreviews: true,
    });
    expect(mockGetMessageById).toHaveBeenCalledWith(ACTIVE_CONVERSATION_ID, 'persisted-message');
  });

  it('reports an empty chat only after checking persisted messages', async () => {
    mockLatestMessageId = null;
    mockGetMessagesByConvoId.mockResolvedValue([]);
    renderShareButton();

    await expect(mockResolveTargetMessageId?.()).rejects.toMatchObject({
      code: 'NO_MESSAGES',
    });
    expect(mockGetMessagesByConvoId).toHaveBeenCalledWith(ACTIVE_CONVERSATION_ID, {
      toolPreviews: true,
    });
    expect(mockGetMessageById).not.toHaveBeenCalled();
  });

  it('sends no target message when sharing a conversation other than the open one', () => {
    renderShareButton('conversation-2');

    expect(screen.getByTestId('share-actions')).toHaveAttribute(
      'data-target-message-id',
      'undefined',
    );
  });

  it('renders the compact create state without an empty link field', () => {
    mockShare = { success: false, shareId: null };

    renderShareButton();

    expect(screen.getByText('com_ui_share_create_message')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-link-url')).not.toBeInTheDocument();
    expect(document.querySelector('svg[width="200"]')).not.toBeInTheDocument();
  });
});
