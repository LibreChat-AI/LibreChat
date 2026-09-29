import { useState, useId, useRef, memo, useCallback, useMemo } from 'react';
import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { QueryKeys, PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  DropdownPopup,
  Spinner,
  buttonVariants,
  useToastContext,
  useMediaQuery,
} from '@librechat/client';
import {
  Ellipsis,
  Share2,
  CopyPlus,
  Archive,
  ArchiveRestore,
  FolderInput,
  FolderX,
  Pen,
  Pin,
  Trash,
} from 'lucide-react';
import type { TMessage } from 'librechat-data-provider';
import type { MouseEvent } from 'react';
import {
  useDuplicateConversationMutation,
  useAssignConversationToProjectMutation,
  useDeleteConversationMutation,
  useGetStartupConfig,
  useArchiveConvoMutation,
  usePinConversationMutation,
} from '~/data-provider';
import { useHasAccess, useLocalize, useNavigateToConvo, useNewConvo } from '~/hooks';
import { useChatContext, useLiveAnnouncer } from '~/Providers';
import { NotificationSeverity } from '~/common';
import ProjectButton from './ProjectButton';
import DeleteButton from './DeleteButton';
import ShareButton from './ShareButton';
import { cn } from '~/utils';
/** The overflow menu and the shift-held quick action show the same archive control in two
 *  sizes, and must never disagree about which direction it moves the conversation. */
function renderArchiveIcon(isLoading: boolean, isArchived: boolean, className: string) {
  if (isLoading) {
    return <Spinner className="size-4" />;
  }
  if (isArchived) {
    return <ArchiveRestore className={className} aria-hidden="true" />;
  }
  return <Archive className={className} aria-hidden="true" />;
}

function ConvoOptions({
  conversationId,
  chatProjectId,
  title,
  isPinned = false,
  isArchived = false,
  retainView,
  renameHandler,
  isPopoverActive,
  setIsPopoverActive,
  isActiveConvo,
  isShiftHeld = false,
}: {
  conversationId: string | null;
  chatProjectId?: string | null;
  title: string | null;
  isPinned?: boolean;
  /** This row's own archive state, which the sidebar filter does not stand in for. */
  isArchived?: boolean;
  retainView: () => void;
  renameHandler: (e: MouseEvent) => void;
  isPopoverActive: boolean;
  setIsPopoverActive: (open: boolean) => void;
  isActiveConvo: boolean;
  isShiftHeld?: boolean;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { index, setConversation } = useChatContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { navigateToConvo } = useNavigateToConvo(index);
  const { showToast } = useToastContext();
  /* Archiving or restoring removes the row from the list that held it, unmounting this
     menu: the announcement has to come from a live region that outlives the row. */
  const { announcePolite } = useLiveAnnouncer();

  const navigate = useNavigate();
  const { conversationId: currentConvoId } = useParams();
  /* A mutation callback outlives the click that made it: the route it should compare
     against is whichever chat is open when the request resolves, not the one that was
     open when the menu item was pressed. */
  const openConvoIdRef = useRef(currentConvoId);
  openConvoIdRef.current = currentConvoId;
  const { newConversation } = useNewConvo();

  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const projectButtonRef = useRef<HTMLButtonElement>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showProjectDialog, setShowProjectDialog] = useState(false);

  const canCreateSharedLinks = useHasAccess({
    permissionType: PermissionTypes.SHARED_LINKS,
    permission: Permissions.CREATE,
  });

  const archiveConvoMutation = useArchiveConvoMutation();
  const assignConversationToProject = useAssignConversationToProjectMutation();
  const pinConvoMutation = usePinConversationMutation();

  const deleteMutation = useDeleteConversationMutation({
    onSuccess: () => {
      if (currentConvoId === conversationId || currentConvoId === 'new') {
        newConversation();
        navigate('/c/new', { replace: true });
      }
      retainView();
      showToast({
        message: localize('com_ui_convo_delete_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_convo_delete_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    },
  });

  const duplicateConversation = useDuplicateConversationMutation({
    onSuccess: (data) => {
      navigateToConvo(data.conversation);
      showToast({
        message: localize('com_ui_duplication_success'),
        status: 'success',
      });
      setIsPopoverActive(false);
    },
    onMutate: () => {
      showToast({
        message: localize('com_ui_duplication_processing'),
        status: 'info',
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_duplication_error'),
        status: 'error',
      });
    },
  });

  const isDuplicateLoading = duplicateConversation.isLoading;
  const isArchiveLoading = archiveConvoMutation.isLoading;
  const isPinLoading = pinConvoMutation.isLoading;
  const isDeleteLoading = deleteMutation.isLoading;

  const shareHandler = useCallback(() => {
    setShowShareDialog(true);
  }, []);

  const deleteHandler = useCallback(() => {
    setShowDeleteDialog(true);
  }, []);

  const projectHandler = useCallback(() => {
    setShowProjectDialog(true);
  }, []);

  const removeProjectHandler = useCallback(() => {
    const convoId = conversationId ?? '';
    if (!convoId) {
      return;
    }
    assignConversationToProject.mutate(
      { conversationId: convoId, projectId: null },
      {
        onSuccess: () => {
          setIsPopoverActive(false);
          showToast({
            message: localize('com_ui_project_updated'),
            severity: NotificationSeverity.SUCCESS,
            showIcon: true,
          });
        },
        onError: () => {
          showToast({
            message: localize('com_ui_project_update_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  }, [assignConversationToProject, conversationId, localize, setIsPopoverActive, showToast]);

  const handleInstantDelete = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const convoId = conversationId ?? '';
      if (!convoId) {
        return;
      }
      const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, convoId]);
      const thread_id = messages?.[messages.length - 1]?.thread_id;
      const endpoint = messages?.[messages.length - 1]?.endpoint;
      deleteMutation.mutate({ conversationId: convoId, thread_id, endpoint, source: 'button' });
    },
    [conversationId, deleteMutation, queryClient],
  );

  const handleArchiveClick = useCallback(
    async (e?: MouseEvent) => {
      e?.stopPropagation();
      const convoId = conversationId ?? '';
      if (!convoId) {
        return;
      }

      archiveConvoMutation.mutate(
        { conversationId: convoId, isArchived: !isArchived },
        {
          onSuccess: () => {
            /* The request outlives the row: by the time it resolves the user may have opened
               another chat, so the open conversation is identified at commit time rather than
               from the one this callback closed over. */
            setConversation((prev) =>
              prev?.conversationId === convoId ? { ...prev, isArchived: !isArchived } : prev,
            );
            announcePolite({
              message: localize(isArchived ? 'com_ui_convo_unarchived' : 'com_ui_convo_archived'),
              isStatus: true,
            });
            const openConvoId = openConvoIdRef.current;
            if (!isArchived && (openConvoId === convoId || openConvoId === 'new')) {
              newConversation();
              navigate('/c/new', { replace: true });
            }
            retainView();
            setIsPopoverActive(false);
          },
          onError: () => {
            showToast({
              message: localize(isArchived ? 'com_ui_unarchive_error' : 'com_ui_archive_error'),
              severity: NotificationSeverity.ERROR,
              showIcon: true,
            });
          },
        },
      );
    },
    [
      conversationId,
      isArchived,
      setConversation,
      archiveConvoMutation,
      navigate,
      newConversation,
      retainView,
      setIsPopoverActive,
      announcePolite,
      showToast,
      localize,
    ],
  );

  const handlePinClick = useCallback(() => {
    const convoId = conversationId ?? '';
    if (!convoId) {
      return;
    }
    pinConvoMutation.mutate(
      { conversationId: convoId, pinned: !isPinned },
      {
        onSuccess: () => setIsPopoverActive(false),
        onError: () => {
          showToast({
            message: localize(isPinned ? 'com_ui_unpin_error' : 'com_ui_pin_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  }, [conversationId, isPinned, pinConvoMutation, setIsPopoverActive, showToast, localize]);

  const handleDuplicateClick = useCallback(() => {
    duplicateConversation.mutate({
      conversationId: conversationId ?? '',
    });
  }, [conversationId, duplicateConversation]);

  const dropdownItems = useMemo(
    () => [
      {
        label: localize('com_ui_share'),
        onClick: shareHandler,
        icon: <Share2 className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        show: startupConfig && startupConfig.sharedLinksEnabled && canCreateSharedLinks,
        ariaHasPopup: 'dialog' as const,
        ariaControls: 'share-conversation-dialog',
        /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
        hideOnClick: false,
        ref: shareButtonRef,
        render: (props) => <button {...props} />,
      },
      {
        label: localize(isPinned ? 'com_ui_unpin' : 'com_ui_pin'),
        onClick: handlePinClick,
        hideOnClick: false,
        icon: isPinLoading ? (
          <Spinner className="size-4" />
        ) : (
          <Pin className="icon-sm mr-2 text-text-primary" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_rename'),
        onClick: renameHandler,
        icon: <Pen className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
      },
      {
        label: localize('com_ui_duplicate'),
        onClick: handleDuplicateClick,
        hideOnClick: false,
        icon: isDuplicateLoading ? (
          <Spinner className="size-4" />
        ) : (
          <CopyPlus className="icon-sm mr-2 text-text-primary" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_change_project'),
        onClick: projectHandler,
        icon: <FolderInput className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        ariaControls: 'project-conversation-dialog',
        hideOnClick: false,
        ref: projectButtonRef,
        render: (props) => <button {...props} />,
      },
      {
        label: localize('com_ui_remove_from_project'),
        onClick: removeProjectHandler,
        show: Boolean(chatProjectId),
        hideOnClick: false,
        icon: assignConversationToProject.isLoading ? (
          <Spinner className="size-4" />
        ) : (
          <FolderX className="icon-sm mr-2 text-text-primary" aria-hidden="true" />
        ),
      },
      {
        label: localize(isArchived ? 'com_ui_unarchive' : 'com_ui_archive'),
        onClick: handleArchiveClick,
        hideOnClick: false,
        icon: renderArchiveIcon(isArchiveLoading, isArchived, 'icon-sm mr-2 text-text-primary'),
      },
      {
        label: localize('com_ui_delete'),
        onClick: deleteHandler,
        icon: <Trash className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        ariaControls: 'delete-conversation-dialog',
        /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
        hideOnClick: false,
        ref: deleteButtonRef,
        render: (props) => <button {...props} />,
      },
    ],
    [
      localize,
      isPinned,
      isPinLoading,
      shareHandler,
      startupConfig,
      renameHandler,
      deleteHandler,
      isArchiveLoading,
      isArchived,
      isDuplicateLoading,
      handlePinClick,
      handleArchiveClick,
      canCreateSharedLinks,
      handleDuplicateClick,
      projectHandler,
      removeProjectHandler,
      chatProjectId,
      assignConversationToProject.isLoading,
    ],
  );

  const buttonClassName = cn(
    /** The same shared row action the unpin badge beside it uses, rather than a
     *  second copy of that recipe. */
    buttonVariants({ variant: 'row-action', size: 'icon-xs' }),
    'text-text-secondary',
    /** Touch has no hover, so a reveal-on-hover trigger is simply invisible there. */
    isActiveConvo === true || isPopoverActive || isSmallScreen
      ? 'opacity-100'
      : 'opacity-0 focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[open]:opacity-100',
  );

  if (isShiftHeld && isActiveConvo && !isPopoverActive && !showShareDialog && !showDeleteDialog) {
    return (
      <div className="flex items-center gap-0.5">
        <button
          aria-label={localize(isArchived ? 'com_ui_unarchive' : 'com_ui_archive')}
          className={buttonClassName}
          onClick={handleArchiveClick}
          disabled={isArchiveLoading}
        >
          {renderArchiveIcon(isArchiveLoading, isArchived, 'icon-md text-text-secondary')}
        </button>
        <button
          aria-label={localize('com_ui_delete')}
          className={buttonClassName}
          onClick={handleInstantDelete}
          disabled={isDeleteLoading}
        >
          {isDeleteLoading ? (
            <Spinner className="size-4" />
          ) : (
            <Trash className="icon-md text-text-secondary" aria-hidden={true} />
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      <DropdownPopup
        /**
         * Must portal: the row sits inside the nav's `overflow-hidden` and a
         * virtualized list, and on mobile inside a transformed drawer that
         * would become the containing block. Portaling escapes all three.
         * The drawer cannot occlude it — the drawer's z-index only ranks it
         * within `Root`'s `relative z-0` stacking context, while this lands on
         * `document.body` outside it.
         */
        portal={true}
        menuId={menuId}
        focusLoop={true}
        className="z-[125]"
        unmountOnHide={true}
        isOpen={isPopoverActive}
        setIsOpen={setIsPopoverActive}
        trigger={
          <Ariakit.MenuButton
            ref={menuButtonRef}
            id={`conversation-menu-${conversationId}`}
            aria-label={localize('com_nav_convo_menu_options')}
            aria-expanded={isPopoverActive}
            /** Shared with the shift-held variant so both obey the same reveal rules. */
            className={cn(
              buttonClassName,
              'gap-2',
              /** The hover fill persists while the menu is open, even once the
               *  pointer moves into the dropdown. */
              isPopoverActive && 'bg-surface-active text-text-primary',
            )}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
            }}
            onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
              }
            }}
          >
            <Ellipsis className="icon-md" aria-hidden={true} />
          </Ariakit.MenuButton>
        }
        items={dropdownItems}
      />
      {showShareDialog && (
        <ShareButton
          conversationId={conversationId ?? ''}
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          triggerRef={shareButtonRef}
        />
      )}
      {showDeleteDialog && (
        <DeleteButton
          title={title ?? ''}
          retainView={retainView}
          triggerRef={deleteButtonRef}
          setMenuOpen={setIsPopoverActive}
          showDeleteDialog={showDeleteDialog}
          conversationId={conversationId ?? ''}
          setShowDeleteDialog={setShowDeleteDialog}
        />
      )}
      {showProjectDialog && (
        <ProjectButton
          conversationId={conversationId ?? ''}
          chatProjectId={chatProjectId}
          setMenuOpen={setIsPopoverActive}
          triggerRef={menuButtonRef}
          showProjectDialog={showProjectDialog}
          setShowProjectDialog={setShowProjectDialog}
        />
      )}
    </>
  );
}

export default memo(ConvoOptions, (prevProps, nextProps) => {
  return (
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.title === nextProps.title &&
    prevProps.chatProjectId === nextProps.chatProjectId &&
    prevProps.isPinned === nextProps.isPinned &&
    prevProps.isArchived === nextProps.isArchived &&
    prevProps.isPopoverActive === nextProps.isPopoverActive &&
    prevProps.isActiveConvo === nextProps.isActiveConvo &&
    prevProps.isShiftHeld === nextProps.isShiftHeld
  );
});
