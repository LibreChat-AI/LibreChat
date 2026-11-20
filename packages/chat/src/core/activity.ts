import type { TMessage } from 'librechat-data-provider';

/**
 * The messages whose background activity a thread row shows after itself, or none.
 *
 * Activity may be persisted against the user request that launched it. Once that request has a
 * reply, the activity shows after the reply instead of between the request and the reply, so a
 * user row anchors activity only while it has no children, and a reply anchors its own activity
 * and its request's. A row whose anchor is being edited shows none, so the editor stands alone.
 */
export function activityParentMessageIds(
  message: Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>,
  hasChildren: boolean,
  currentEditId: string | number | null | undefined,
): string[] {
  let ids: string[] = [];
  if (message.isCreatedByUser) {
    ids = hasChildren ? [] : [message.messageId];
  } else {
    ids = [message.messageId, message.parentMessageId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
  }
  if (typeof currentEditId === 'string' && ids.includes(currentEditId)) {
    return [];
  }
  return ids;
}
