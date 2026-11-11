import { useRef, useCallback, useLayoutEffect } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import type { MouseEvent, MutableRefObject } from 'react';
import type { TMessage } from 'librechat-data-provider';
import {
  useDeleteConversationMutation,
  useArchiveConvoMutation,
  usePinConversationMutation,
  useMarkConversationUnreadMutation,
} from '~/data-provider';
import { useChatContext, useLiveAnnouncer } from '~/Providers';
import { useLocalize, useNewConvo } from '~/hooks';
import { NotificationSeverity } from '~/common';

export type ConvoMenuHandlers = {
  pin: () => void;
  markUnread: () => void;
  archive: (e?: MouseEvent) => void;
  instantDelete: (e: MouseEvent) => void;
};

export type ConvoMenuLoading = {
  pin: boolean;
  archive: boolean;
  delete: boolean;
};

/**
 * The part of a row's overflow menu that costs something: four mutations, the route, the
 * chat context and the new-conversation machinery. The menu's trigger stays mounted on every
 * row the pointer reaches, so it cannot carry these; they mount here only once the menu is
 * used and publish their handlers through `handlersRef` for the trigger's items to call.
 */
function ConvoMenuController({
  conversationId,
  isPinned,
  isArchived,
  retainView,
  setIsPopoverActive,
  handlersRef,
  onLoadingChange,
}: {
  conversationId: string | null;
  isPinned: boolean;
  isArchived: boolean;
  retainView: () => void;
  setIsPopoverActive: (open: boolean) => void;
  handlersRef: MutableRefObject<ConvoMenuHandlers | null>;
  onLoadingChange: (loading: ConvoMenuLoading) => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { setConversation } = useChatContext();
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

  const archiveConvoMutation = useArchiveConvoMutation();
  const pinConvoMutation = usePinConversationMutation();
  const markUnreadMutation = useMarkConversationUnreadMutation();

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

  const instantDelete = useCallback(
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

  const archive = useCallback(
    (e?: MouseEvent) => {
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

  const pin = useCallback(() => {
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

  const markUnread = useCallback(() => {
    const convoId = conversationId ?? '';
    if (!convoId) {
      return;
    }
    markUnreadMutation.mutate(
      { conversationId: convoId },
      {
        onSuccess: () => setIsPopoverActive(false),
        onError: () => {
          showToast({
            message: localize('com_ui_mark_unread_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  }, [conversationId, markUnreadMutation, setIsPopoverActive, showToast, localize]);

  handlersRef.current = { pin, markUnread, archive, instantDelete };

  const pinLoading = pinConvoMutation.isLoading;
  const archiveLoading = archiveConvoMutation.isLoading;
  const deleteLoading = deleteMutation.isLoading;
  useLayoutEffect(() => {
    onLoadingChange({ pin: pinLoading, archive: archiveLoading, delete: deleteLoading });
  }, [onLoadingChange, pinLoading, archiveLoading, deleteLoading]);

  return null;
}

export default ConvoMenuController;
