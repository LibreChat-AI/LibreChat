import { useEffect, useState, useRef } from 'react';
import { Trans } from 'react-i18next';
import { Link2Off, QrCode, RotateCw, Share, Users } from 'lucide-react';
import {
  PermissionTypes,
  Permissions,
  PermissionBits,
  ResourceType,
} from 'librechat-data-provider';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogDescription,
  TooltipAnchor,
  OGDialogTitle,
  OGDialogHeader,
  useMediaQuery,
  useToastContext,
  OGDialogContent,
} from '@librechat/client';
import type { TSharedLinkGetResponse } from 'librechat-data-provider';
import {
  useCreateSharedLinkMutation,
  useUpdateSharedLinkMutation,
  useDeleteSharedLinkMutation,
} from '~/data-provider';
import GenericGrantAccessDialog from '~/components/Sharing/GenericGrantAccessDialog';
import { useHasAccess, useResourcePermissions, useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';
import { buildShareLinkUrl } from '~/utils';

type SharePublicationErrorCode = 'TARGET_MESSAGE_NOT_FOUND' | 'NO_MESSAGES';

const getSharePublicationErrorCode = (error: unknown): SharePublicationErrorCode | undefined => {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }

  const directCode = 'code' in error ? error.code : undefined;
  if (directCode === 'TARGET_MESSAGE_NOT_FOUND' || directCode === 'NO_MESSAGES') {
    return directCode;
  }

  if (!('response' in error) || error.response == null || typeof error.response !== 'object') {
    return undefined;
  }
  const data = 'data' in error.response ? error.response.data : undefined;
  if (data == null || typeof data !== 'object' || !('code' in data)) {
    return undefined;
  }
  return data.code === 'TARGET_MESSAGE_NOT_FOUND' || data.code === 'NO_MESSAGES'
    ? data.code
    : undefined;
};

const publishWithTailRetry = async <T,>(
  resolveTargetMessageId: () => Promise<string | undefined>,
  publish: (targetMessageId?: string) => Promise<T>,
): Promise<T> => {
  try {
    return await publish(await resolveTargetMessageId());
  } catch (error) {
    const code = getSharePublicationErrorCode(error);
    if (code !== 'TARGET_MESSAGE_NOT_FOUND' && code !== 'NO_MESSAGES') {
      throw error;
    }
  }

  return publish(await resolveTargetMessageId());
};

export default function SharedLinkButton({
  share,
  conversationId,
  targetMessageId,
  resolveTargetMessageId,
  showQR,
  setShowQR,
  sharedLink,
  setSharedLink,
  snapshotFiles,
}: {
  share: TSharedLinkGetResponse | undefined;
  conversationId: string;
  targetMessageId?: string;
  resolveTargetMessageId?: () => Promise<string>;
  showQR: boolean;
  setShowQR: (showQR: boolean) => void;
  sharedLink: string;
  setSharedLink: (sharedLink: string) => void;
  snapshotFiles?: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [refreshAnimationId, setRefreshAnimationId] = useState(0);
  const [isPublishing, setIsPublishing] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const shareId = share?.shareId ?? '';
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const { mutateAsync: mutate, isLoading: isCreateLoading } = useCreateSharedLinkMutation();

  const { mutateAsync, isLoading: isUpdateLoading } = useUpdateSharedLinkMutation();

  const deleteMutation = useDeleteSharedLinkMutation({
    onSuccess: () => {
      setShowDeleteDialog(false);
      setTimeout(() => {
        const dialog = document
          .getElementById('share-conversation-dialog')
          ?.closest('[role="dialog"]');
        if (dialog instanceof HTMLElement) {
          dialog.focus();
        }
      }, 0);
    },
    onError: (error) => {
      console.error('Delete error:', error);
      showToast({
        message: localize('com_ui_share_delete_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const generateShareLink = (shareId: string) => buildShareLinkUrl(shareId);

  const showPublicationError = (error: unknown) => {
    const code = getSharePublicationErrorCode(error);
    let message = localize('com_ui_share_error');
    if (code === 'TARGET_MESSAGE_NOT_FOUND') {
      message = localize('com_ui_share_target_not_saved');
    } else if (code === 'NO_MESSAGES') {
      message = localize('com_ui_share_no_messages');
    }
    showToast({
      message,
      severity: NotificationSeverity.ERROR,
      showIcon: true,
    });
  };

  const resolvePublicationTarget = () =>
    resolveTargetMessageId?.() ?? Promise.resolve(targetMessageId);

  const updateSharedLink = async () => {
    if (!shareId) {
      return;
    }

    setIsPublishing(true);
    try {
      const updateShare = await publishWithTailRetry(resolvePublicationTarget, (resolvedTargetId) =>
        mutateAsync({ shareId, targetMessageId: resolvedTargetId, snapshotFiles }),
      );
      setRefreshAnimationId((animationId) => animationId + 1);
      setSharedLink(generateShareLink(updateShare.shareId));
      setShowUpdateDialog(false);
      setAnnouncement(localize('com_ui_link_refreshed'));
      setTimeout(() => {
        setAnnouncement('');
      }, 1000);
    } catch (error) {
      console.error('Failed to update shared link:', error);
      showPublicationError(error);
    } finally {
      setIsPublishing(false);
    }
  };

  const createShareLink = async () => {
    setIsPublishing(true);
    try {
      const share = await publishWithTailRetry(resolvePublicationTarget, (resolvedTargetId) =>
        mutate({ conversationId, targetMessageId: resolvedTargetId, snapshotFiles }),
      );
      setSharedLink(generateShareLink(share.shareId));
    } catch (error) {
      console.error('Failed to create shared link:', error);
      showPublicationError(error);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDelete = async () => {
    if (!shareId) {
      return;
    }

    try {
      await deleteMutation.mutateAsync({ shareId });
      setShowDeleteDialog(false);
      setSharedLink('');
      showToast({
        message: localize('com_ui_shared_link_delete_success'),
        severity: NotificationSeverity.SUCCESS,
      });
    } catch (error) {
      console.error('Failed to delete shared link:', error);
      showToast({
        message: localize('com_ui_share_delete_error'),
        severity: NotificationSeverity.ERROR,
      });
    }
  };

  const handleNativeShare = async () => {
    if (!canNativeShare || !sharedLink) {
      return;
    }

    try {
      await navigator.share({
        title: localize('com_ui_share_link_to_chat'),
        url: sharedLink,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return;
      }

      showToast({
        message: localize('com_ui_share_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  };

  const hasAccessToShareLinks = useHasAccess({
    permissionType: PermissionTypes.SHARED_LINKS,
    permission: Permissions.SHARE,
  });

  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.SHARED_LINK,
    share?._id || '',
  );

  const canManageAccess =
    hasAccessToShareLinks &&
    !permissionsLoading &&
    hasPermission(PermissionBits.SHARE) &&
    !!share?._id;

  const qrCodeLabel = showQR ? localize('com_ui_hide_qr') : localize('com_ui_show_qr');

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        {!shareId && (
          <Button
            type="button"
            disabled={isCreateLoading || isPublishing}
            variant="submit"
            onClick={createShareLink}
            className="ml-auto min-w-28"
          >
            {!isCreateLoading && !isPublishing && localize('com_ui_create_link')}
            {(isCreateLoading || isPublishing) && <Spinner className="size-4" />}
          </Button>
        )}
        {shareId && (
          <>
            {canManageAccess && (
              <GenericGrantAccessDialog
                resourceType={ResourceType.SHARED_LINK}
                resourceDbId={share?._id}
                resourceName={share?.shareId ?? undefined}
              >
                <TooltipAnchor
                  description={localize('com_ui_shared_link_manage_access')}
                  render={(props) => (
                    <Button
                      {...props}
                      type="button"
                      size="icon"
                      variant="outline"
                      className="size-9 sm:size-10"
                      aria-label={localize('com_ui_shared_link_manage_access')}
                    >
                      <Users className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                />
              </GenericGrantAccessDialog>
            )}

            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
              {isSmallScreen && canNativeShare && (
                <TooltipAnchor
                  description={localize('com_ui_share')}
                  render={(props) => (
                    <Button
                      {...props}
                      type="button"
                      onClick={handleNativeShare}
                      variant="outline"
                      size="icon"
                      className="size-9 sm:size-10"
                      aria-label={localize('com_ui_share')}
                    >
                      <Share className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                />
              )}

              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {announcement}
              </span>
              <TooltipAnchor
                description={localize('com_ui_update_shared_link')}
                render={(props) => (
                  <Button
                    {...props}
                    ref={updateButtonRef}
                    type="button"
                    onClick={() => setShowUpdateDialog(true)}
                    variant="outline"
                    size="icon"
                    className="size-9 sm:size-10"
                    disabled={isUpdateLoading || isPublishing}
                    aria-label={localize('com_ui_update_shared_link')}
                  >
                    <RotateCw
                      key={refreshAnimationId}
                      className={
                        refreshAnimationId > 0
                          ? 'animate-refresh-link-spin size-4 motion-reduce:animate-none'
                          : 'size-4'
                      }
                      aria-hidden="true"
                    />
                  </Button>
                )}
              />

              <TooltipAnchor
                description={qrCodeLabel}
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    onClick={() => setShowQR(!showQR)}
                    variant="outline"
                    size="icon"
                    className="size-9 sm:size-10"
                    aria-pressed={showQR}
                    aria-label={qrCodeLabel}
                  >
                    <QrCode className="size-4" aria-hidden="true" />
                  </Button>
                )}
              />

              <TooltipAnchor
                description={localize('com_ui_delete_link')}
                render={(props) => (
                  <Button
                    {...props}
                    ref={deleteButtonRef}
                    type="button"
                    onClick={() => setShowDeleteDialog(true)}
                    variant="destructive"
                    size="icon"
                    className="size-9 sm:size-10"
                    aria-label={localize('com_ui_delete_link')}
                  >
                    <Link2Off className="size-4" aria-hidden="true" />
                  </Button>
                )}
              />
            </div>
          </>
        )}

        <OGDialog
          open={showUpdateDialog}
          triggerRef={updateButtonRef}
          onOpenChange={setShowUpdateDialog}
        >
          <OGDialogContent className="w-11/12 max-w-md" showCloseButton={false}>
            <OGDialogHeader>
              <OGDialogTitle>{localize('com_ui_update_shared_link_confirm_title')}</OGDialogTitle>
              <OGDialogDescription className="text-text-secondary">
                {localize('com_ui_update_shared_link_confirm_description')}
              </OGDialogDescription>
            </OGDialogHeader>
            <div className="flex justify-end gap-2 pt-4">
              <OGDialogClose asChild>
                <Button variant="outline">{localize('com_ui_cancel')}</Button>
              </OGDialogClose>
              <Button
                type="button"
                variant="submit"
                onClick={updateSharedLink}
                disabled={isUpdateLoading || isPublishing}
              >
                {(isUpdateLoading || isPublishing) && <Spinner className="size-4" />}
                {localize('com_ui_update_shared_link')}
              </Button>
            </div>
          </OGDialogContent>
        </OGDialog>

        <OGDialog
          open={showDeleteDialog}
          triggerRef={deleteButtonRef}
          onOpenChange={setShowDeleteDialog}
        >
          <OGDialogContent
            role="alertdialog"
            className="w-11/12 max-w-[28.125rem]"
            showCloseButton={false}
          >
            <OGDialogHeader>
              <OGDialogTitle>{localize('com_ui_delete_shared_link_heading')}</OGDialogTitle>
            </OGDialogHeader>
            <div className="flex w-full flex-col items-center gap-2">
              <div className="grid w-full items-center gap-2">
                <Label htmlFor="dialog-confirm-delete" className="text-left text-sm font-medium">
                  <Trans
                    i18nKey="com_ui_delete_confirm_strong"
                    values={{ title: shareId }}
                    components={{ strong: <strong /> }}
                  />
                </Label>
              </div>
            </div>
            <div className="flex justify-end gap-4 pt-4">
              <OGDialogClose asChild>
                <Button variant="outline">{localize('com_ui_cancel')}</Button>
              </OGDialogClose>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isLoading}
              >
                {deleteMutation.isLoading ? (
                  <Spinner className="size-4" />
                ) : (
                  localize('com_ui_delete_link')
                )}
              </Button>
            </div>
          </OGDialogContent>
        </OGDialog>
      </div>
    </>
  );
}
