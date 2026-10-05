import { useState, useRef, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { useNavigate } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
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
  useGetConvoIdQuery,
  useArchiveConvoMutation,
  usePinConversationMutation,
  useDuplicateConversationMutation,
  useAssignConversationToProjectMutation,
} from '~/data-provider';
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
}: {
  isSharedButtonEnabled: boolean;
  closeMenu: () => void;
}): UseChatOptionsResult {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const { announcePolite } = useLiveAnnouncer();
  const { newConversation } = useNewConvo();
  const { setConversation } = useChatContext();
  const { navigateToConvo } = useNavigateToConvo(0);
  const exportShare = useExportShare({ isSharedButtonEnabled });
  const conversation = useRecoilValue(store.conversationByIndex(0));

  const conversationId = conversation?.conversationId ?? '';
  /** Pin and project changes land in the query cache, not in the chat's own state. */
  const { data: cached } = useGetConvoIdQuery(conversationId, { enabled: false });
  const current = cached ?? conversation;
  const isPinned = current?.pinned === true;
  const isArchived = current?.isArchived === true;
  const chatProjectId = current?.chatProjectId ?? null;
  const title = current?.title ?? '';

  const renameRef = useRef<HTMLButtonElement>(null);
  const projectRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const [showRename, setShowRename] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

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
          /** An archived chat leaves the list, so the open one is replaced; a restored one stays. */
          if (!isArchived) {
            newConversation();
            navigate('/c/new', { replace: true });
          }
        },
        onError: () => showError(isArchived ? 'com_ui_unarchive_error' : 'com_ui_archive_error'),
      },
    );
  };

  const items: t.MenuItemProps[] = [
    ...exportShare.items,
    { separate: true },
    {
      label: localize('com_ui_rename'),
      onClick: () => setShowRename(true),
      icon: <Pen className={iconClass} aria-hidden="true" />,
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: renameRef,
      render: (props) => <button {...props} />,
    },
    {
      label: localize(isPinned ? 'com_ui_unpin' : 'com_ui_pin'),
      onClick: togglePin,
      icon: <Pin className={iconClass} aria-hidden="true" />,
    },
    {
      label: localize('com_ui_change_project'),
      onClick: () => setShowProject(true),
      icon: <FolderInput className={iconClass} aria-hidden="true" />,
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: projectRef,
      render: (props) => <button {...props} />,
    },
    {
      label: localize('com_ui_remove_from_project'),
      onClick: removeFromProject,
      show: chatProjectId != null,
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
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: deleteRef,
      render: (props) => <button {...props} />,
    },
  ];

  return {
    show: exportShare.show,
    items,
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
            setMenuOpen={closeMenu}
            conversationId={conversationId}
            showDeleteDialog={showDelete}
            setShowDeleteDialog={setShowDelete}
          />
        )}
      </>
    ) : null,
  };
}
