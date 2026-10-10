import React, { memo, useId, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useDrag } from 'react-dnd';
import { Link2 } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { Spinner, useToastContext, useMediaQuery } from '@librechat/client';
import { Constants, supportsConversationTitleOwnership } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ConversationDragItem } from './dnd';
import {
  useGetStartupConfig,
  usePinConversationMutation,
  useUpdateConversationMutation,
} from '~/data-provider';
import { cn, logger, setDocumentTitle, isConversationUnseen, hasRealTitle } from '~/utils';
import { useNavigateToConvo, useLocalize, useShiftKey } from '~/hooks';
import ConversationEndpointIcon from './ConversationEndpointIcon';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { focusableInRow, resolveRowBeside } from './focus';
import { areConversationRenderPropsEqual } from './utils';
import { NotificationSeverity } from '~/common';
import { CONVERSATION_DRAG_TYPE } from './dnd';
import ProjectBadge from './ProjectBadge';
import ConvoActions from './ConvoActions';
import UnpinButton from './UnpinButton';
import RenameForm from './RenameForm';
import ConvoLink from './ConvoLink';
import store from '~/store';

interface ConversationProps {
  conversation: TConversation;
  retainView: () => void;
  toggleNav: (afterSlide?: () => void) => void;
  isGenerating?: boolean;
  /** Sidebar rows double as drag sources for filing the chat into a project;
   *  other surfaces leave this off. */
  draggable?: boolean;
  /** Lets a wrapper that owns its own drag source release it while the title is
   *  being edited, the way this row releases its own. */
  onRenamingChange?: (renaming: boolean) => void;
  /** Shortcuts an owning list handles for this row, declared on its focusable
   *  element so they are announced rather than left to be discovered. */
  keyShortcuts?: string;
  /** Names the chat's project on rows listed outside that project. */
  showProjectBadge?: boolean;
}

function Conversation({
  conversation,
  retainView,
  toggleNav,
  isGenerating = false,
  draggable = false,
  onRenamingChange,
  keyShortcuts,
  showProjectBadge = false,
}: ConversationProps) {
  const params = useParams();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { navigateToConvo } = useNavigateToConvo();
  const currentConvoId = useMemo(() => params.conversationId, [params.conversationId]);
  const updateConvoMutation = useUpdateConversationMutation(currentConvoId ?? '');
  const unpinMutation = usePinConversationMutation();
  const activeConversationId = useRecoilValue(store.conversationIdByIndex(0));
  const isSmallScreen = useDrawerViewport();
  /* A deployment with shared links off leaves existing links in the database but stops
     serving them, so the row must not advertise one that no longer resolves. */
  const { data: startupConfig } = useGetStartupConfig();
  const sharedLinksEnabled = startupConfig?.sharedLinksEnabled === true;
  const isSharedBadgeVisible = conversation.isShared === true && sharedLinksEnabled;
  const projectLabelId = useId();
  const projectBadgeProjectId = showProjectBadge ? conversation.chatProjectId : undefined;
  const isUnseen = isConversationUnseen(conversation);
  const isShiftHeld = useShiftKey();
  const { conversationId, title = '' } = conversation;
  const canRename =
    supportsConversationTitleOwnership(startupConfig) ||
    (!isGenerating && (conversation.titleSetByUser === true || hasRealTitle(title)));

  const [titleInput, setTitleInput] = useState(title || '');
  const [renaming, setRenamingState] = useState(false);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number }>();
  const [isHovered, setIsHovered] = useState(false);
  // Lazy-load ConvoOptions to avoid running heavy hooks for all conversations
  const [hasInteracted, setHasInteracted] = useState(false);

  const previousTitle = useRef(title);
  const containerRef = useRef<HTMLDivElement>(null);

  const onRenamingChangeRef = useRef(onRenamingChange);
  onRenamingChangeRef.current = onRenamingChange;

  const setRenaming = useCallback((next: boolean) => {
    setRenamingState(next);
    onRenamingChangeRef.current?.(next);
  }, []);

  /* A row can be removed mid-rename, for instance by unpinning the same chat
   * from the project list that renders it too. Without this the owner would
   * keep treating the row as renaming and, once it came back, leave its drag
   * source released for the rest of the section's life. */
  useEffect(
    () => () => {
      onRenamingChangeRef.current?.(false);
    },
    [],
  );

  /* HTML5 drag needs a hover-capable pointer: connecting the source on touch
   * stamps `draggable="true"` on the row, and iOS Safari then hands taps to the
   * drag recognizer instead of synthesizing a click, so the row would only
   * select on the second tap. A `draggable` ancestor also swallows drag-select
   * inside the rename input, so the source is released while renaming. */
  const canHoverPointer = useMediaQuery('(hover: hover)');
  const [, dragConnector] = useDrag<ConversationDragItem, unknown, unknown>({
    type: CONVERSATION_DRAG_TYPE,
    item: () => ({
      conversationId: conversationId ?? '',
      chatProjectId: conversation.chatProjectId ?? null,
      pinned: conversation.pinned === true,
    }),
  });
  dragConnector(draggable && canHoverPointer && !renaming ? containerRef : null);

  useEffect(() => {
    if (title !== previousTitle.current) {
      setTitleInput(title as string);
      previousTitle.current = title;
    }
  }, [title]);

  const isActiveConvo = useMemo(() => {
    if (conversationId === Constants.NEW_CONVO) {
      return currentConvoId === Constants.NEW_CONVO;
    }

    if (currentConvoId !== Constants.NEW_CONVO) {
      return currentConvoId === conversationId;
    } else {
      return activeConversationId === conversationId;
    }
  }, [currentConvoId, conversationId, activeConversationId]);

  const handleRename = () => {
    if (!canRename) return;
    setIsPopoverActive(false);
    setContextMenuPosition(undefined);
    setTitleInput(title as string);
    setRenaming(true);
  };

  const handleRenameSubmit = async (newTitle: string) => {
    if (
      !canRename ||
      !conversationId ||
      (newTitle === title && conversation.titleSetByUser === true)
    ) {
      setRenaming(false);
      return;
    }

    try {
      await updateConvoMutation.mutateAsync({
        conversationId,
        title: newTitle.trim() || localize('com_ui_untitled'),
      });
      setRenaming(false);
    } catch (error) {
      logger.error('Error renaming conversation', error);
      setTitleInput(title as string);
      showToast({
        message: localize('com_ui_rename_failed'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
      setRenaming(false);
    }
  };

  const handleCancelRename = () => {
    setTitleInput(title as string);
    setRenaming(false);
  };

  /* One-way: a row that has been reached keeps its overflow control mounted for
   * as long as the row itself lives. Resetting this on leave unmounted the
   * control and remounted it on the next entry, one frame after the row's hover
   * had already revealed its slot — so the button arrived a frame late and
   * restarted its hover fill from transparent every time the pointer crossed
   * the row's edge, which reads as a flicker.
   *
   * The cost is what the row's own lifetime is: the chats list unmounts a row
   * as it scrolls out, while the Pinned section mounts every pinned row at
   * once, so there a pointer crossing the list leaves one `ConvoOptions` per
   * row it touched, standing until the section unmounts. That is bounded by
   * the pin count the user chose, and a control that unmounts instead is what
   * this comment's first paragraph describes. */
  const handleMouseEnter = useCallback(() => {
    setHasInteracted(true);
  }, []);

  /* Matches the favorites' row-level unpin: one click on the pin badge, no
   * menu digging. The row unmounts once the pinned refetch lands, so focus is
   * handed to a neighbouring row first. Where that row is has to be resolved
   * before the mutation, not in its callback: by then the refetch may already
   * have unmounted this row and cleared the ref the search starts from. */
  const unpinConvo = useCallback(() => {
    if (!conversationId) {
      return;
    }
    const row = containerRef.current;
    /* Outside the pinned list there is no successor, because the row stays put.
     * The pin badge that had focus does not, though, so focus moves to the
     * row's own link rather than falling to the document. */
    const successor =
      row?.contains(document.activeElement) === true
        ? (resolveRowBeside(row) ?? focusableInRow(row))
        : null;
    unpinMutation.mutate(
      { conversationId, pinned: false },
      {
        onSuccess: () => {
          const activeElement = document.activeElement;
          const focusInRow = row?.contains(activeElement) === true;
          const rowRemovedFocus =
            row?.isConnected === false &&
            (activeElement === document.body || activeElement === document.documentElement);
          if (successor?.isConnected && (focusInRow || rowRemovedFocus)) {
            successor.focus();
          }
        },
        onError: () => {
          showToast({
            message: localize('com_ui_unpin_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  }, [conversationId, unpinMutation, showToast, localize]);

  const handlePopoverOpenChange = useCallback((open: boolean) => {
    setIsPopoverActive(open);
    if (!open) {
      setContextMenuPosition(undefined);
    }
  }, []);

  const handleNavigation = (ctrlOrMetaKey: boolean) => {
    if (ctrlOrMetaKey && !isGenerating) {
      toggleNav();
      const baseUrl = window.location.origin;
      const path = `/c/${conversationId}`;
      window.open(baseUrl + path, '_blank');
      return;
    }

    if (currentConvoId === conversationId || isPopoverActive) {
      return;
    }

    /** The navigation rides `afterSlide`: run synchronously it flushes the
     * conversation-switch commit in the tap's task, stalling the drawer's
     * first frame — the exact delay the animated toggle exists to avoid. */
    toggleNav(() => {
      setDocumentTitle(title);

      navigateToConvo(conversation, {
        currentConvoId,
      });
    });
  };

  const convoOptionsProps = {
    title,
    isPinned: conversation.pinned,
    /* The row's own state, not the list's: the sidebar shows unarchived pins beside an
       archived list, and the previous page's rows stay on screen while the next loads. */
    isArchived: conversation.isArchived === true,
    retainView,
    renameHandler: handleRename,
    canRename,
    isActiveConvo,
    isUnseen,
    conversationId,
    isPopoverActive,
    isGenerating,
    contextMenuPosition,
    onOpenChange: handlePopoverOpenChange,
    isShiftHeld: isActiveConvo && !isGenerating ? isShiftHeld : false,
  };

  /* The slot takes its width from the row's hover, not from its content. The
   * overflow menu mounts a tick after the pointer arrives (see `ConvoActions`),
   * and a content-sized slot grew at that moment, pulling the unpin badge a
   * button's width leftwards out from under the pointer: the badge's fill,
   * already fading in, handed off to whichever control had slid into its place.
   * Reserving the width up front leaves every control where it was drawn. */
  let actionVisibilityClassName =
    'pointer-events-none w-0 scale-x-0 opacity-0 group-focus-within:pointer-events-auto group-focus-within:scale-x-100 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:scale-x-100 group-hover:opacity-100';
  let actionWidthClassName = isSmallScreen
    ? 'group-focus-within:w-9 group-hover:w-9'
    : 'group-focus-within:w-7 group-hover:w-7';
  if (isGenerating) {
    actionVisibilityClassName = 'pointer-events-auto scale-x-100 opacity-100';
    actionWidthClassName = isSmallScreen ? 'w-9' : 'w-7';
  } else if (isPopoverActive || isActiveConvo || isSmallScreen) {
    /** Touch has no hover, so a reveal-on-hover menu is unreachable there. */
    actionVisibilityClassName = 'pointer-events-auto scale-x-100 opacity-100';
    /** Shift over the active row swaps the menu for archive and delete. */
    if (!isPopoverActive && isActiveConvo && isShiftHeld) {
      actionWidthClassName = 'w-[3.75rem]';
    } else {
      actionWidthClassName = isSmallScreen ? 'w-9' : 'w-7';
    }
  }

  const actionContent = !renaming ? (
    <ConvoActions {...convoOptionsProps} hasInteracted={hasInteracted} />
  ) : null;

  return (
    <div
      ref={containerRef}
      data-conversation-id={conversationId}
      className={cn(
        'group focus-visible:ring-text-primary relative flex h-12 w-full items-center rounded-lg outline-hidden focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset md:h-9',
        isActiveConvo || isPopoverActive
          ? 'bg-surface-nav-selected before:bg-text-primary before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-full'
          : 'hover:bg-surface-nav-hover',
      )}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          setIsHovered(true);
        }
      }}
      onPointerLeave={() => setIsHovered(false)}
      onPointerCancel={() => setIsHovered(false)}
      onContextMenu={(event) => {
        if (
          renaming ||
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setContextMenuPosition({ x: event.clientX, y: event.clientY });
        setHasInteracted(true);
        setIsPopoverActive(true);
      }}
      onMouseEnter={handleMouseEnter}
      onFocus={handleMouseEnter}
      onClick={(e) => {
        if (renaming) {
          return;
        }
        if (e.button === 0) {
          handleNavigation(e.ctrlKey || e.metaKey);
        }
      }}
      style={{ cursor: renaming ? 'default' : 'pointer' }}
      data-testid="convo-item"
    >
      {renaming ? (
        <RenameForm
          titleInput={titleInput}
          setTitleInput={setTitleInput}
          onSubmit={handleRenameSubmit}
          onCancel={handleCancelRename}
          localize={localize}
        />
      ) : (
        <ConvoLink
          isActiveConvo={isActiveConvo}
          isPopoverActive={isPopoverActive}
          isHovered={isHovered}
          isSharedBadgeVisible={isSharedBadgeVisible}
          isUnseen={isUnseen}
          isGenerating={isGenerating}
          title={title}
          onRename={handleRename}
          isSmallScreen={isSmallScreen}
          localize={localize}
          keyShortcuts={keyShortcuts}
          describedBy={projectBadgeProjectId ? projectLabelId : undefined}
        >
          {/* Status sits on the avatar so the row's trailing edge stays free for its badges
              and menu. The ring is 2.125rem around the 1.25rem icon: offset by half the
              difference. Both are rem so the ring follows the icon box at any UI scale. */}
          <span className="relative flex size-5 shrink-0 items-center justify-center">
            <ConversationEndpointIcon conversation={conversation} size={20} context="menu-item" />
            {isGenerating && (
              <Spinner
                size={34}
                strokeWidth={1.9}
                bgOpacity={0.14}
                className="pointer-events-none absolute -top-[0.4375rem] -left-[0.4375rem] size-[2.125rem]"
              />
            )}
            {isUnseen && !isGenerating && (
              /* `ConvoLink`'s aria-label carries the text equivalent of the ring and the dot. */
              <span
                aria-hidden="true"
                className={cn(
                  'bg-status-info pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2',
                  isActiveConvo || isPopoverActive
                    ? 'ring-surface-nav-selected'
                    : 'ring-surface-primary-alt group-hover:ring-surface-nav-hover',
                )}
              />
            )}
          </span>
        </ConvoLink>
      )}
      {isSharedBadgeVisible && (
        <Link2 className="icon-sm text-text-secondary mr-1 shrink-0" aria-hidden="true" />
      )}
      {projectBadgeProjectId && (
        <ProjectBadge projectId={projectBadgeProjectId} labelId={projectLabelId} />
      )}
      {conversation.pinned === true && (
        <UnpinButton
          testId="convo-unpin-button"
          className="mr-1"
          keepVisible={isPopoverActive}
          onClick={(e) => {
            e.stopPropagation();
            unpinConvo();
          }}
        />
      )}
      <div
        className={cn(
          'mr-1 flex shrink-0 origin-left items-center justify-center',
          actionVisibilityClassName,
          actionWidthClassName,
        )}
        // Removing aria-hidden to fix accessibility issue: ARIA hidden element must not be focusable or contain focusable elements
        // but not sure what its original purpose was, so leaving the property commented out until it can be cleared safe to delete.
        // aria-hidden={!(isPopoverActive || isActiveConvo)}
      >
        {/* Only render ConvoOptions when user interacts (hover/focus) or for active conversation */}
        {actionContent}
      </div>
    </div>
  );
}

export default memo(Conversation, areConversationRenderPropsEqual);
