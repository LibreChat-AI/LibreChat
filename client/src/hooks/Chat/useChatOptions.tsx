import { useState, useRef, useEffect, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { supportsConversationTitleOwnership } from 'librechat-data-provider';
import {
  Pen,
  Pin,
  Trash,
  Archive,
  FolderX,
  CopyPlus,
  FolderInput,
  ArchiveRestore,
} from 'lucide-react';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type * as t from '~/common';
import {
  useActiveJobs,
  useGetConvoIdQuery,
  useGetStartupConfig,
  useArchiveConvoMutation,
  usePinConversationMutation,
  useDuplicateConversationMutation,
  useAssignConversationToProjectMutation,
} from '~/data-provider';
import { findConvoInAllQueries, isTemporaryConversation, hasRealTitle } from '~/utils';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import { ProjectButton } from '~/components/Conversations/ConvoOptions';
import { useLocalize, useNavigateToConvo, useNewConvo } from '~/hooks';
import { useChatContext, useLiveAnnouncer } from '~/Providers';
import { NotificationSeverity } from '~/common';
import useExportShare from './useExportShare';
import Rename from '~/components/Chat/Rename';
import store from '~/store';

export type UseChatOptionsResult = {
  show: boolean;
  items: t.MenuItemProps[];
  hasSharedLink: boolean;
  /** Rendered by the surface that owns the menu, next to its trigger. */
  dialogs: ReactNode;
};

type DialogKind = 'rename' | 'project' | 'delete';

const iconClass = 'size-4 text-text-secondary';
const noop = () => {};

/**
 * Everything the sidebar row's overflow menu does to a chat, for the chat that is open,
 * grouped for the header: share and export first, then organizing, then the two actions
 * that remove it from view. Mark unread is left out because the open chat is read by definition.
 */
export default function useChatOptions({
  isSharedButtonEnabled,
  closeMenu,
  readOnly = false,
}: {
  isSharedButtonEnabled: boolean;
  closeMenu: () => void;
  /** A durable subagent thread is a canonical record of its parent's run: only share and export apply. */
  readOnly?: boolean;
}): UseChatOptionsResult {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const { announcePolite } = useLiveAnnouncer();
  const { newConversation } = useNewConvo();
  const { setConversation } = useChatContext();
  const { navigateToConvo } = useNavigateToConvo(0);
  const { data: startupConfig } = useGetStartupConfig();
  const { data: activeJobs } = useActiveJobs();
  const { conversationId: routeConversationId } = useParams();
  /** A request outlives the click: the route that matters is the one open when it resolves. */
  const openConvoIdRef = useRef(routeConversationId);
  openConvoIdRef.current = routeConversationId;
  const exportShare = useExportShare({ isSharedButtonEnabled });
  const conversation = useRecoilValue(store.conversationByIndex(0));

  const conversationId = conversation?.conversationId ?? '';
  const queryClient = useQueryClient();
  /** Pin and project changes land in the query cache, not in the chat's own state. The observer
   *  re-renders on a change to the point entry; the freshest copy across it and the lists is read
   *  here, because a revisited chat's point entry can predate an edit the lists already hold. */
  const { data: cached } = useGetConvoIdQuery(conversationId, { enabled: false });
  const freshest = conversationId ? findConvoInAllQueries(queryClient, conversationId) : undefined;
  const base = cached ?? conversation;
  const current = freshest ? { ...base, ...freshest } : base;
  const isPinned = current?.pinned === true;
  const isArchived = current?.isArchived === true;
  const chatProjectId = current?.chatProjectId ?? null;
  const title = current?.title ?? '';
  const isTemporary = isTemporaryConversation(current);
  const isGenerating = activeJobs?.activeJobIds?.includes(conversationId) === true;
  /** The sidebar's rule: a running chat can only be renamed where the deployment can protect
   *  the manual title from the pending generated one. */
  const canRename =
    supportsConversationTitleOwnership(startupConfig) ||
    (!isGenerating && (current?.titleSetByUser === true || hasRealTitle(title)));

  const renameRef = useRef<HTMLButtonElement>(null);
  const projectRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  /** ChatView stays mounted across a route change, so a dialog is tied to the chat it was opened
   *  for rather than to whichever chat is open when it renders. */
  const [openDialog, setOpenDialog] = useState<{ kind: DialogKind; id: string } | null>(null);
  /** The route moves before the chat state does, and the menu and dialogs are portaled outside the
   *  hidden pane, so they are dismissed on either change rather than left aimed at the old chat. */
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;
  const scopeRef = useRef(`${conversationId}|${routeConversationId}|${readOnly}`);
  useEffect(() => {
    const scope = `${conversationId}|${routeConversationId}|${readOnly}`;
    if (scopeRef.current === scope) {
      return;
    }
    scopeRef.current = scope;
    setOpenDialog(null);
    closeMenuRef.current();
  }, [conversationId, routeConversationId, readOnly]);
  const isDialogOpen = (kind: DialogKind) =>
    !readOnly &&
    openDialog?.kind === kind &&
    openDialog.id === conversationId &&
    (routeConversationId == null || routeConversationId === conversationId);
  const showRename = isDialogOpen('rename');
  const showProject = isDialogOpen('project');
  const showDelete = isDialogOpen('delete');
  /** A close only clears the dialog it belongs to: a delete that settles after another chat
   *  opened its own dialog must not take that one down. */
  const toggleDialog = (kind: DialogKind) => (open: boolean) =>
    setOpenDialog((prev) => {
      if (open) {
        return { kind, id: conversationId };
      }
      return prev?.kind === kind && prev.id === conversationId ? null : prev;
    });
  const setShowRename = toggleDialog('rename');
  const setShowProject = toggleDialog('project');
  const setShowDelete = toggleDialog('delete');

  const pinMutation = usePinConversationMutation();
  const archiveMutation = useArchiveConvoMutation();
  const assignMutation = useAssignConversationToProjectMutation();
  const duplicateMutation = useDuplicateConversationMutation({
    onSuccess: (data) => {
      navigateToConvo(data.conversation);
      showToast({ message: localize('com_ui_duplication_success'), status: 'success' });
    },
    onMutate: () => {
      showToast({ message: localize('com_ui_duplication_processing'), status: 'info' });
    },
    onError: () => {
      showToast({ message: localize('com_ui_duplication_error'), status: 'error' });
    },
  });

  const showError = useCallback(
    (key: Parameters<typeof localize>[0]) =>
      showToast({ message: localize(key), severity: NotificationSeverity.ERROR, showIcon: true }),
    [localize, showToast],
  );

  /** The request outlives the click, so the open chat is matched at commit time. The query cache
   *  only carries the change when its entry exists, and this state is what the menu falls back to. */
  const mirrorToOpenChat = (patch: Partial<TConversation>) =>
    setConversation((prev) =>
      prev?.conversationId === conversationId ? { ...prev, ...patch } : prev,
    );

  const togglePin = () => {
    pinMutation.mutate(
      { conversationId, pinned: !isPinned },
      {
        onSuccess: () => mirrorToOpenChat({ pinned: !isPinned }),
        onError: () => showError(isPinned ? 'com_ui_unpin_error' : 'com_ui_pin_error'),
      },
    );
  };

  const removeFromProject = () => {
    assignMutation.mutate(
      { conversationId, projectId: null },
      {
        onSuccess: () => {
          mirrorToOpenChat({ chatProjectId: null });
          showToast({
            message: localize('com_ui_project_updated'),
            severity: NotificationSeverity.SUCCESS,
            showIcon: true,
          });
        },
        onError: () => showError('com_ui_project_update_error'),
      },
    );
  };

  const toggleArchive = () => {
    archiveMutation.mutate(
      { conversationId, isArchived: !isArchived },
      {
        onSuccess: () => {
          mirrorToOpenChat({ isArchived: !isArchived });
          announcePolite({
            message: localize(isArchived ? 'com_ui_convo_unarchived' : 'com_ui_convo_archived'),
            isStatus: true,
          });
          /** An archived chat leaves the list, so the open one is replaced; a restored one stays.
           *  Another chat opened since the click is left alone. */
          const openConvoId = openConvoIdRef.current;
          if (!isArchived && (openConvoId === conversationId || openConvoId === 'new')) {
            newConversation();
            navigate('/c/new', { replace: true });
          }
        },
        onError: () => showError(isArchived ? 'com_ui_unarchive_error' : 'com_ui_archive_error'),
      },
    );
  };

  /** A temporary chat is excluded from the history, pinned, archived and project lists, so
   *  organizing it would report success and show nowhere. */
  const canOrganize = !isTemporary;

  const items: t.MenuItemProps[] = [
    ...exportShare.items,
    { separate: true },
    {
      label: localize('com_ui_rename'),
      onClick: () => setShowRename(true),
      icon: <Pen className={iconClass} aria-hidden="true" />,
      disabled: !canRename,
      ariaHasPopup: 'dialog',
      ariaControls: 'rename-conversation-dialog',
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: renameRef,
      render: (props) => <button {...props} />,
    },
    {
      label: localize(isPinned ? 'com_ui_unpin' : 'com_ui_pin'),
      onClick: togglePin,
      show: canOrganize,
      icon: <Pin className={iconClass} aria-hidden="true" />,
    },
    {
      label: localize('com_ui_change_project'),
      onClick: () => setShowProject(true),
      show: canOrganize,
      icon: <FolderInput className={iconClass} aria-hidden="true" />,
      ariaHasPopup: 'dialog',
      ariaControls: 'project-conversation-dialog',
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: projectRef,
      render: (props) => <button {...props} />,
    },
    {
      label: localize('com_ui_remove_from_project'),
      onClick: removeFromProject,
      show: canOrganize && chatProjectId != null,
      icon: <FolderX className={iconClass} aria-hidden="true" />,
    },
    {
      label: localize('com_ui_duplicate'),
      onClick: () => duplicateMutation.mutate({ conversationId }),
      icon: <CopyPlus className={iconClass} aria-hidden="true" />,
    },
    { separate: true },
    {
      label: localize(isArchived ? 'com_ui_unarchive' : 'com_ui_archive'),
      onClick: toggleArchive,
      show: canOrganize,
      icon: isArchived ? (
        <ArchiveRestore className={iconClass} aria-hidden="true" />
      ) : (
        <Archive className={iconClass} aria-hidden="true" />
      ),
    },
    {
      label: localize('com_ui_delete'),
      onClick: () => setShowDelete(true),
      icon: <Trash className={iconClass} aria-hidden="true" />,
      ariaHasPopup: 'dialog',
      ariaControls: 'delete-conversation-dialog',
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: deleteRef,
      render: (props) => <button {...props} />,
    },
  ];

  return {
    show: exportShare.show,
    items: readOnly ? exportShare.items : items,
    hasSharedLink: exportShare.hasSharedLink,
    dialogs: exportShare.show ? (
      <>
        {exportShare.dialogs}
        {showRename && (
          <Rename
            open={showRename}
            onOpenChange={setShowRename}
            conversationId={conversationId}
            title={title}
            titleSetByUser={current?.titleSetByUser === true}
            triggerRef={renameRef}
          />
        )}
        {showProject && (
          <ProjectButton
            conversationId={conversationId}
            chatProjectId={chatProjectId}
            setMenuOpen={closeMenu}
            triggerRef={projectRef}
            onAssigned={(projectId) => mirrorToOpenChat({ chatProjectId: projectId })}
            showProjectDialog={showProject}
            setShowProjectDialog={setShowProject}
          />
        )}
        {showDelete && (
          <DeleteButton
            title={title}
            retainView={noop}
            triggerRef={deleteRef}
            getCurrentConversationId={() => openConvoIdRef.current}
            setMenuOpen={() => {
              /** A delete that settles after another chat opened must not close that chat's menu. */
              if (openConvoIdRef.current === conversationId) {
                closeMenu();
              }
            }}
            conversationId={conversationId}
            showDeleteDialog={showDelete}
            setShowDeleteDialog={setShowDelete}
          />
        )}
      </>
    ) : null,
  };
}
