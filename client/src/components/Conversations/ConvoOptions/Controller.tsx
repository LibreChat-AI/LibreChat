import { useRef, useCallback, useLayoutEffect } from 'react';
import { useStore, useSetAtom } from 'jotai';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { QueryKeys, dataService, isAssistantsEndpoint } from 'librechat-data-provider';
import { sideChatAtom, sideChatBesideAtom, sideChatRequestAtom } from '@librechat/chat/react';
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
  openBeside: () => void;
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
  toggleNav,
  setIsPopoverActive,
  handlersRef,
  onLoadingChange,
}: {
  conversationId: string | null;
  isPinned: boolean;
  isArchived: boolean;
  retainView: () => void;
  /** Leaves the sidebar the way selecting a conversation does; see `ConvoOptions`. */
  toggleNav?: (afterSlide?: () => void) => void;
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

  /**
   * Opens the conversation beside the chat on screen. A side chat builds its turns from the
   * conversation's full record, which a sidebar row does not hold, so the record is read first.
   */
  const store = useStore();
  const setSideChat = useSetAtom(sideChatAtom);
  /** Called when the record lands, which can be after this row was drawn again. */
  const leaveSidebar = useRef(toggleNav);
  leaveSidebar.current = toggleNav;
  const openBeside = useCallback(() => {
    const convoId = conversationId ?? '';
    if (!convoId) {
      return;
    }
    /** The chat this was asked beside; another by the time the record is in means the reader left. */
    const beside = store.get(sideChatBesideAtom);
    if (beside == null) {
      return;
    }
    setIsPopoverActive(false);
    /** The reader's newest ask: one made after it, or a side chat opened meanwhile, replaces it. */
    const request = {};
    store.set(sideChatRequestAtom, request);
    const refuse = (message: string) =>
      showToast({ message, severity: NotificationSeverity.ERROR, showIcon: true });
    /**
     * Whether this is still what the reader wants, asked at every step that waits: after the
     * record is read, and again after the sidebar has got out of the way. It is while no newer
     * ask or other panel has taken its token, and the chat on screen is the one it was asked
     * beside and not the conversation itself.
     */
    const wanted = (): boolean =>
      store.get(sideChatRequestAtom) === request &&
      store.get(sideChatBesideAtom) === beside &&
      beside.conversationId !== convoId;
    /** Ends this request, leaving alone a newer one that has taken its place. */
    const settle = (): void => {
      if (store.get(sideChatRequestAtom) === request) {
        store.set(sideChatRequestAtom, null);
      }
    };
    queryClient
      .fetchQuery([QueryKeys.conversation, convoId], () => dataService.getConversationById(convoId))
      .then(
        (conversation) => {
          if (!wanted()) {
            settle();
            return;
          }
          /** Assistants conversations run over their own routes, which a side chat does not drive. */
          if (conversation == null || isAssistantsEndpoint(conversation.endpoint)) {
            settle();
            refuse(localize('com_ui_side_chat_unsupported'));
            return;
          }
          const open = () => {
            const stillWanted = wanted();
            settle();
            if (stillWanted) {
              setSideChat({ conversation });
            }
          };
          /**
           * On a small screen the sidebar is a drawer over the chat, so it gets out of the way
           * first, the way it does when a conversation is selected; on a wide one this opens
           * at once. The drawer takes a few frames to leave, so the request stays the reader's
           * newest until then and is asked about once more.
           */
          if (leaveSidebar.current == null) {
            open();
            return;
          }
          leaveSidebar.current(open);
        },
        () => {
          if (store.get(sideChatRequestAtom) !== request) {
            return;
          }
          settle();
          refuse(localize('com_ui_side_chat_load_error'));
        },
      );
  }, [conversationId, queryClient, setIsPopoverActive, setSideChat, showToast, localize, store]);

  handlersRef.current = { openBeside, pin, markUnread, archive, instantDelete };

  const pinLoading = pinConvoMutation.isLoading;
  const archiveLoading = archiveConvoMutation.isLoading;
  const deleteLoading = deleteMutation.isLoading;
  useLayoutEffect(() => {
    onLoadingChange({ pin: pinLoading, archive: archiveLoading, delete: deleteLoading });
  }, [onLoadingChange, pinLoading, archiveLoading, deleteLoading]);

  return null;
}

export default ConvoMenuController;
