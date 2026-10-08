import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import SharedLinkButton from '../SharedLinkButton';

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockShowToast = jest.fn();
let mockIsSmallScreen = false;

jest.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    useMediaQuery: () => mockIsSmallScreen,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/data-provider', () => ({
  useCreateSharedLinkMutation: () => ({ mutateAsync: mockCreate, isLoading: false }),
  useUpdateSharedLinkMutation: () => ({ mutateAsync: mockUpdate, isLoading: false }),
  useDeleteSharedLinkMutation: () => ({
    mutateAsync: mockDelete,
    isLoading: false,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useResourcePermissions: () => ({
    hasPermission: () => true,
    isLoading: false,
  }),
}));

jest.mock('~/components/Sharing/GenericGrantAccessDialog', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const share = {
  success: true,
  _id: 'share-db-id',
  shareId: 'share-old',
  conversationId: 'conversation-1',
  targetMessageId: 'message-1',
};

const renderActions = (overrides = {}) => {
  const props = {
    share,
    conversationId: 'conversation-1',
    targetMessageId: 'message-1',
    showQR: true,
    setShowQR: jest.fn(),
    sharedLink: 'http://example.test/share/share-old',
    setSharedLink: jest.fn(),
    snapshotFiles: true,
    ...overrides,
  };

  render(<SharedLinkButton {...props} />);
  return props;
};

describe('SharedLinkButton', () => {
  beforeEach(() => {
    mockIsSmallScreen = false;
    mockCreate.mockReset();
    mockUpdate.mockReset();
    mockDelete.mockReset();
    mockShowToast.mockReset();
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
  });

  it('uses a compact update action before QR and link revocation', () => {
    renderActions();

    const access = screen.getByRole('button', { name: 'com_ui_shared_link_manage_access' });
    const update = screen.getByRole('button', { name: 'com_ui_update_shared_link' });
    const qr = screen.getByRole('button', { name: 'com_ui_hide_qr' });
    const remove = screen.getByRole('button', { name: 'com_ui_delete_link' });

    expect(access).not.toHaveTextContent('com_ui_shared_link_manage_access');
    expect(update).not.toHaveTextContent('com_ui_update_shared_link');
    expect(update).toHaveClass('size-9', 'sm:size-10');
    expect(update.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(qr.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remove).toHaveClass('bg-surface-destructive');

    fireEvent.click(remove);

    const dialog = screen.getByRole('alertdialog');
    const confirmDelete = within(dialog).getByRole('button', { name: 'com_ui_delete_link' });
    expect(confirmDelete).toHaveClass('bg-surface-destructive');
  });

  it('updates the existing URL with the latest conversation state', async () => {
    mockUpdate.mockResolvedValue({ shareId: 'share-old' });
    const setSharedLink = jest.fn();
    renderActions({ setSharedLink });

    const updateButton = screen.getByRole('button', { name: 'com_ui_update_shared_link' });
    fireEvent.click(updateButton);

    expect(mockUpdate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('heading', {
        name: 'com_ui_update_shared_link_confirm_title',
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('com_ui_update_shared_link_confirm_description'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_update_shared_link' }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({
        shareId: 'share-old',
        targetMessageId: 'message-1',
        snapshotFiles: true,
      });
    });
    await waitFor(() =>
      expect(updateButton.querySelector('svg')).toHaveClass('animate-refresh-link-spin'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(setSharedLink).toHaveBeenCalledWith(expect.stringContaining('/share/share-old'));
  });

  it('refetches the persisted tail and retries once when link creation misses it', async () => {
    const resolveTargetMessageId = jest.fn().mockResolvedValue('message-1');
    mockCreate
      .mockRejectedValueOnce({
        response: { data: { code: 'TARGET_MESSAGE_NOT_FOUND' } },
      })
      .mockResolvedValueOnce({ shareId: 'share-new' });
    const setSharedLink = jest.fn();
    renderActions({
      share: { success: false, shareId: null },
      resolveTargetMessageId,
      setSharedLink,
    });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_link' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(resolveTargetMessageId).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenNthCalledWith(1, {
      conversationId: 'conversation-1',
      targetMessageId: 'message-1',
      snapshotFiles: true,
    });
    expect(mockCreate).toHaveBeenNthCalledWith(2, {
      conversationId: 'conversation-1',
      targetMessageId: 'message-1',
      snapshotFiles: true,
    });
    expect(setSharedLink).toHaveBeenCalledWith(expect.stringContaining('/share/share-new'));
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('does not publish another branch when the selected tail is still unsaved', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const missingTail = Object.assign(new Error('missing tail'), {
      code: 'TARGET_MESSAGE_NOT_FOUND',
    });
    const resolveTargetMessageId = jest.fn().mockRejectedValue(missingTail);
    renderActions({
      share: { success: false, shareId: null },
      resolveTargetMessageId,
    });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_link' }));

    await waitFor(() => expect(resolveTargetMessageId).toHaveBeenCalledTimes(2));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_share_target_not_saved',
      severity: 'error',
      showIcon: true,
    });
    consoleError.mockRestore();
  });

  it('retries a temporary empty read and publishes once persistence catches up', async () => {
    const noMessages = Object.assign(new Error('no messages'), { code: 'NO_MESSAGES' });
    const resolveTargetMessageId = jest
      .fn()
      .mockRejectedValueOnce(noMessages)
      .mockResolvedValueOnce('message-1');
    mockCreate.mockResolvedValue({ shareId: 'share-new' });
    const setSharedLink = jest.fn();
    renderActions({
      share: { success: false, shareId: null },
      resolveTargetMessageId,
      setSharedLink,
    });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_link' }));

    await waitFor(() => expect(resolveTargetMessageId).toHaveBeenCalledTimes(2));
    expect(mockCreate).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      targetMessageId: 'message-1',
      snapshotFiles: true,
    });
    expect(setSharedLink).toHaveBeenCalledWith(expect.stringContaining('/share/share-new'));
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('shows a precise error when messages are still absent after the retry', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const noMessages = Object.assign(new Error('no messages'), { code: 'NO_MESSAGES' });
    const resolveTargetMessageId = jest.fn().mockRejectedValue(noMessages);
    renderActions({
      share: { success: false, shareId: null },
      resolveTargetMessageId,
    });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_link' }));

    await waitFor(() => expect(resolveTargetMessageId).toHaveBeenCalledTimes(2));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_share_no_messages',
      severity: 'error',
      showIcon: true,
    });
    consoleError.mockRestore();
  });

  it('does not fake success when updating the link fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUpdate.mockRejectedValue(new Error('update failed'));
    const setSharedLink = jest.fn();
    renderActions({ setSharedLink });

    const updateButton = screen.getByRole('button', { name: 'com_ui_update_shared_link' });
    fireEvent.click(updateButton);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_update_shared_link' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());

    expect(setSharedLink).not.toHaveBeenCalled();
    expect(updateButton.querySelector('svg')).not.toHaveClass('animate-refresh-link-spin');
    consoleError.mockRestore();
  });

  it('closes the delete confirmation and clears the stale URL after deletion', async () => {
    mockDelete.mockResolvedValue({ success: true, shareId: 'share-old' });
    const setSharedLink = jest.fn();
    renderActions({ setSharedLink });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete_link' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_delete_link' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith({ shareId: 'share-old' });
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(setSharedLink).toHaveBeenCalledWith('');
  });

  it('exposes native sharing only on supported small screens', async () => {
    const nativeShare = jest.fn().mockResolvedValue(undefined);
    mockIsSmallScreen = true;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: nativeShare,
    });
    renderActions();

    const shareButton = await screen.findByRole('button', { name: 'com_ui_share' });
    fireEvent.click(shareButton);

    await waitFor(() => {
      expect(nativeShare).toHaveBeenCalledWith({
        title: 'com_ui_share_link_to_chat',
        url: 'http://example.test/share/share-old',
      });
    });
  });
});
