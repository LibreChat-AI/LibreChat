import type { TConversation, GroupedConversations } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';

export const RUNNING_CHATS_GROUP = 'com_ui_running_chats';

/** Partition the existing server-ordered groups without re-sorting them on every job update. */
export function groupConversationsWithRunning(
  groups: GroupedConversations,
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
): GroupedConversations {
  if (
    options.includePinned ||
    options.field !== 'updatedAt' ||
    options.direction !== 'desc' ||
    activeJobIds.size === 0
  ) {
    return groups;
  }

  const running: TConversation[] = [];
  const remaining: GroupedConversations = [];
  for (const [groupName, conversations] of groups) {
    const idle: TConversation[] = [];
    for (const conversation of conversations) {
      const id = conversation.conversationId;
      if (id && activeJobIds.has(id)) {
        running.push(conversation);
      } else {
        idle.push(conversation);
      }
    }
    if (idle.length > 0) {
      remaining.push([groupName, idle]);
    }
  }

  return running.length === 0 ? groups : [[RUNNING_CHATS_GROUP, running], ...remaining];
}
