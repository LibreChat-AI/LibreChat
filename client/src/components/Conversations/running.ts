import type { TConversation, GroupedConversations } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';
import { groupConversations } from '~/utils';

export const RUNNING_CHATS_GROUP = 'com_ui_running_chats';

/** The server owns the paged order; only lift running rows already present in this view. */
export function groupConversationsWithRunning(
  conversations: TConversation[],
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
): GroupedConversations {
  if (
    options.includePinned ||
    options.field !== 'updatedAt' ||
    options.direction !== 'desc' ||
    activeJobIds.size === 0
  ) {
    return groupConversations(conversations, options);
  }

  const running: TConversation[] = [];
  const remaining: TConversation[] = [];
  const seenRunning = new Set<string>();
  for (const conversation of conversations) {
    const id = conversation.conversationId;
    if (!conversation.pinned && id && activeJobIds.has(id)) {
      if (!seenRunning.has(id)) {
        seenRunning.add(id);
        running.push(conversation);
      }
    } else {
      remaining.push(conversation);
    }
  }

  const groups = groupConversations(remaining, options);
  return running.length === 0 ? groups : [[RUNNING_CHATS_GROUP, running], ...groups];
}
