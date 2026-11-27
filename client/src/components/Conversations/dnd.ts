import { useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import {
  useAssignConversationToProjectMutation,
  usePinConversationMutation,
} from '~/data-provider';
import { getPendingAssignment } from '~/data-provider/Projects/mutations';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

export const CONVERSATION_DRAG_TYPE = 'conversation-item';

/** Which kind of target the pointer was over most recently.
 *
 *  `monitor.didDrop()` alone cannot tell a reorder from a filing action that
 *  was refused: dropping a chat on the project it already belongs to is
 *  rejected, so no target handles it and the drop looks exactly like one that
 *  landed inside the pinned list, even though the rows it crossed on the way
 *  moved only incidentally. Tracking who was last under the pointer also allows
 *  for a drag that strays over a project and comes back to reorder after all. */
let lastHoverWasExternal = false;

/** Called by the pinned rows, whose hover is what reorders the list. */
export const markPinnedHover = (): void => {
  lastHoverWasExternal = false;
};

/** Called by the project rows and the Chats section, accepted or refused. */
export const markExternalHover = (): void => {
  lastHoverWasExternal = true;
};

export const beginPinnedDrag = (): void => {
  lastHoverWasExternal = false;
};

export const endedOverExternalTarget = (): boolean => lastHoverWasExternal;

export type ConversationDragItem = {
  conversationId: string;
  chatProjectId: string | null;
  pinned: boolean;
};

/**
 * The project a conversation belongs to for the purpose of accepting a drop.
 *
 * A drag item carries whatever the list that rendered its row believed, which
 * goes stale the moment an assignment is accepted, and the same conversation
 * can be rendered by several lists that refresh independently. So the pending
 * write wins if there is one, then the conversation cache the mutation writes
 * synchronously on success, and only then the row's own value.
 */
export const useEffectiveProjectId = () => {
  const queryClient = useQueryClient();
  return useCallback(
    (item: ConversationDragItem): string | null => {
      if (!item.conversationId) {
        return item.chatProjectId;
      }
      const pending = getPendingAssignment(item.conversationId);
      if (pending) {
        return pending.projectId;
      }
      const cached = queryClient.getQueryData<TConversation>([
        QueryKeys.conversation,
        item.conversationId,
      ]);
      /* A cache miss falls through to the row, but a cached `null` is a real
       * answer: it means the chat was confirmed out of every project. */
      if (cached) {
        return cached.chatProjectId ?? null;
      }
      return item.chatProjectId;
    },
    [queryClient],
  );
};

/** Files a dropped conversation, resolving to whether it now sits where the
 *  drop asked. */
export type AssignDroppedConversation = (
  item: ConversationDragItem,
  projectId: string | null,
) => Promise<boolean>;

/** Unpins a dropped conversation, if it was pinned at all. */
export type UnpinDroppedConversation = (item: ConversationDragItem) => void;

/** Files a dragged conversation into a project, or back into the root chats
 *  list on `projectId: null`. The mutation owns every cache invalidation
 *  (chats, pinned rows, project stats); this adds the toast feedback the
 *  options-menu path already shows for the same action.
 *
 *  Resolves to whether the chat now sits where the drop asked: `true` for a
 *  drop that had nothing to file, `false` while another write is still on its
 *  way there. A caller with a second half to apply can therefore wait for this
 *  one instead of racing it. */
export const useAssignDroppedConversation = (): AssignDroppedConversation => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const assignConversation = useAssignConversationToProjectMutation();

  return useCallback(
    (item: ConversationDragItem, projectId: string | null): Promise<boolean> => {
      const conversationId = item.conversationId;
      if (!conversationId) {
        return Promise.resolve(false);
      }
      /* No local short-circuit. Every answer this side could give about where
       * the chat already sits is a guess: a pending write is a request rather
       * than an outcome, a cached project can be a snapshot another tab has
       * moved on from, and the drag item's own copy is older still. A drop that
       * acted on any of them could unpin a chat that stayed in its project,
       * leaving it out of both lists. So the write always goes, and the server's
       * answer is what the drop acts on; repeating an assignment the chat
       * already has is the no-op update it looks like, and the mutation queues
       * writes per conversation so it lands after any already out.
       *
       * The success notice still belongs to a move that happened, which is why
       * it reads the two project ids the response carries rather than the fact
       * that a request was sent. */
      return assignConversation.mutateAsync({ conversationId, projectId }).then(
        (result) => {
          if (result.previousProjectId !== result.projectId) {
            showToast({
              message: localize('com_ui_project_updated'),
              severity: NotificationSeverity.SUCCESS,
              showIcon: true,
            });
          }
          return true;
        },
        () => {
          showToast({
            message: localize('com_ui_project_update_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
          return false;
        },
      );
    },
    [assignConversation, localize, showToast],
  );
};

/** Unpins a dragged conversation, for a drop on the plain Chats list: a chat
 *  landing there is being asked to be an ordinary chat, which a pinned one is
 *  not. Silent on success — the row leaving the pinned section is the feedback
 *  — and reports only the failure, as the row badge does. */
export const useUnpinDroppedConversation = (): UnpinDroppedConversation => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const pinConversation = usePinConversationMutation();

  return useCallback(
    (item: ConversationDragItem) => {
      const conversationId = item.conversationId;
      if (!conversationId || item.pinned !== true) {
        return;
      }
      pinConversation.mutate(
        { conversationId, pinned: false },
        {
          onError: () =>
            showToast({
              message: localize('com_ui_unpin_error'),
              severity: NotificationSeverity.ERROR,
              showIcon: true,
            }),
        },
      );
    },
    [pinConversation, localize, showToast],
  );
};

/** Whether a hover should reorder yet. Rows only swap once the pointer crosses
 *  the hovered row's midpoint: without the threshold a shorter dragged row
 *  keeps re-entering the taller row it just displaced, and the list oscillates
 *  under a cursor that never moved. */
export const shouldSwapOnHover = ({
  dragIndex,
  hoverIndex,
  pointerY,
  hoverTop,
  hoverBottom,
}: {
  dragIndex: number;
  hoverIndex: number;
  pointerY: number;
  hoverTop: number;
  hoverBottom: number;
}): boolean => {
  if (dragIndex < 0 || hoverIndex < 0 || dragIndex === hoverIndex) {
    return false;
  }
  const middleY = (hoverBottom - hoverTop) / 2;
  const offsetY = pointerY - hoverTop;
  if (dragIndex < hoverIndex) {
    return offsetY >= middleY;
  }
  return offsetY <= middleY;
};

/** Which group of the Pinned section a stored key belongs to. The section
 *  orders its two kinds independently, so a merge has to know them apart. */
const keyKind = (key: string): 'convo' | 'favorite' =>
  key.startsWith('convo:') ? 'convo' : 'favorite';

/**
 * Rewrites only the slots the visible keys occupy in the stored order, so a
 * reorder performed while a filter hides part of the list keeps every hidden
 * key exactly where it was instead of dropping it. Visible keys the stored
 * order does not know about append after their own kind.
 *
 * The stored order is grouped first, because that is how the section reads it
 * back, and each kind is then substituted within its own run. An order saved
 * before the kinds were kept apart can interleave them, and merging across that
 * interleaving let a reorder of two visible chats carry a hidden chat between
 * them across a favorite — moving a row nobody had touched once the rest of the
 * pinned list finally arrived.
 */
export const mergeVisibleOrder = (stored: string[], visible: string[]): string[] => {
  const visibleSet = new Set(visible);
  const kinds: Array<'favorite' | 'convo'> = ['favorite', 'convo'];
  return kinds.flatMap((kind) => {
    const slots = stored.filter((key) => keyKind(key) === kind);
    const incoming = visible.filter((key) => keyKind(key) === kind);
    const merged: string[] = [];
    let next = 0;
    for (const key of slots) {
      if (!visibleSet.has(key)) {
        merged.push(key);
        continue;
      }
      if (next < incoming.length) {
        merged.push(incoming[next]);
        next += 1;
      }
    }
    /* Keys the stored order never held, such as a row pinned since it was
     * written. */
    for (; next < incoming.length; next += 1) {
      merged.push(incoming[next]);
    }
    return merged;
  });
};
