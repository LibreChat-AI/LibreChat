import { useState, useId, useRef, memo, useMemo, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup, Spinner } from '@librechat/client';
import { Ellipsis, Archive, ArchiveRestore, Mail, Pen, Pin, Trash } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { ConvoMenuHandlers, ConvoMenuLoading } from './Controller';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { cn, rowActionClasses } from '~/utils';
import ConvoMenuController from './Controller';
import DeleteButton from './DeleteButton';
import { useLocalize } from '~/hooks';

const IDLE: ConvoMenuLoading = { pin: false, archive: false, delete: false };

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
  title,
  isPinned = false,
  isArchived = false,
  isUnseen = false,
  retainView,
  renameHandler,
  canRename = true,
  isPopoverActive,
  setIsPopoverActive,
  isActiveConvo,
  isShiftHeld = false,
  isGenerating = false,
  contextMenuPosition,
}: {
  conversationId: string | null;
  title: string | null;
  isPinned?: boolean;
  /** This row's own archive state, which the sidebar filter does not stand in for. */
  isArchived?: boolean;
  isUnseen?: boolean;
  retainView: () => void;
  renameHandler: (e: MouseEvent) => void;
  canRename?: boolean;
  isPopoverActive: boolean;
  setIsPopoverActive: (open: boolean) => void;
  isActiveConvo: boolean;
  isShiftHeld?: boolean;
  isGenerating?: boolean;
  contextMenuPosition?: { x: number; y: number };
}) {
  const localize = useLocalize();
  const isSmallScreen = useDrawerViewport();

  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  /* Every row the pointer reaches mounts this trigger and keeps it, so the trigger stays the
     same element across the row's hover. What the menu does is kept off it until the menu is
     first used: opened, shift-held for the quick actions, or asked to delete. From then on it
     stays, because a request it started has to land in the handlers that made it. */
  const showQuickActions = isShiftHeld && isActiveConvo && !isPopoverActive && !showDeleteDialog;
  const [armed, setArmed] = useState(false);
  if (!armed && (isPopoverActive || showDeleteDialog || showQuickActions)) {
    setArmed(true);
  }
  const handlersRef = useRef<ConvoMenuHandlers | null>(null);
  const [loading, setLoading] = useState<ConvoMenuLoading>(IDLE);

  const isArchiveLoading = loading.archive;
  const isPinLoading = loading.pin;
  const isDeleteLoading = loading.delete;

  const deleteHandler = useCallback(() => setShowDeleteDialog(true), []);
  const handleInstantDelete = useCallback(
    (e: MouseEvent) => handlersRef.current?.instantDelete(e),
    [],
  );
  const handleArchiveClick = useCallback((e?: MouseEvent) => handlersRef.current?.archive(e), []);
  const handlePinClick = useCallback(() => handlersRef.current?.pin(), []);
  const handleMarkUnreadClick = useCallback(() => handlersRef.current?.markUnread(), []);
  const controller = armed ? (
    <ConvoMenuController
      conversationId={conversationId}
      isPinned={isPinned}
      isArchived={isArchived}
      retainView={retainView}
      setIsPopoverActive={setIsPopoverActive}
      handlersRef={handlersRef}
      onLoadingChange={setLoading}
    />
  ) : null;

  const dropdownItems = useMemo(
    () => [
      {
        label: localize(isPinned ? 'com_ui_unpin' : 'com_ui_pin'),
        onClick: handlePinClick,
        hideOnClick: false,
        icon: isPinLoading ? (
          <Spinner className="size-4" />
        ) : (
          <Pin className="icon-sm text-text-primary mr-2" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_mark_unread'),
        onClick: handleMarkUnreadClick,
        /* The conversation on screen is definitionally read: its own seen triggers would
           clear the flag the moment it is set. */
        show: !isActiveConvo && !isUnseen,
        icon: <Mail className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
      },
      {
        label: localize('com_ui_rename'),
        onClick: renameHandler,
        disabled: !canRename,
        icon: <Pen className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
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
        icon: <Trash className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
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
      isUnseen,
      isActiveConvo,
      isPinLoading,
      renameHandler,
      canRename,
      deleteHandler,
      isArchiveLoading,
      isArchived,
      handlePinClick,
      handleMarkUnreadClick,
      handleArchiveClick,
    ],
  );

  const buttonClassName = rowActionClasses({
    visible: isActiveConvo === true || isPopoverActive || isSmallScreen || isGenerating,
  });

  if (showQuickActions) {
    /* The controller sits first in a fragment in both branches, so letting go of shift keeps
       it mounted and a request it started still reaches its callbacks. */
    return (
      <>
        {controller}
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
      </>
    );
  }

  return (
    <>
      {controller}
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
        getAnchorRect={
          contextMenuPosition ? () => ({ ...contextMenuPosition, width: 0, height: 0 }) : undefined
        }
        menuId={menuId}
        focusLoop={true}
        finalFocus={menuButtonRef}
        autoFocusOnShow={true}
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
    </>
  );
}

export default memo(ConvoOptions, (prevProps, nextProps) => {
  return (
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.title === nextProps.title &&
    prevProps.canRename === nextProps.canRename &&
    prevProps.isPinned === nextProps.isPinned &&
    prevProps.isArchived === nextProps.isArchived &&
    prevProps.isUnseen === nextProps.isUnseen &&
    prevProps.isPopoverActive === nextProps.isPopoverActive &&
    prevProps.isActiveConvo === nextProps.isActiveConvo &&
    prevProps.isShiftHeld === nextProps.isShiftHeld &&
    prevProps.isGenerating === nextProps.isGenerating &&
    prevProps.contextMenuPosition === nextProps.contextMenuPosition
  );
});
