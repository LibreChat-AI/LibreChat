import type { TConversation, GroupedConversations } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';
import { isTemporaryConversation } from '~/utils/conversation';

export const RUNNING_CHATS_GROUP = 'com_ui_running_chats';

const noUnlistedIds: string[] = [];

function showsRunningGroup(
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
): boolean {
  return (
    !options.includePinned &&
    options.field === 'updatedAt' &&
    options.direction === 'desc' &&
    activeJobIds.size > 0
  );
}

function newestFirst(a: TConversation, b: TConversation): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

/** Running chats the grouped rows do not hold: chats filed in a project, pinned chats,
 *  which the date groups leave to their own section, and chats past the loaded pages. */
export function unlistedRunningIds(
  groups: GroupedConversations,
  activeJobIds: ReadonlySet<string>,
): string[] {
  if (activeJobIds.size === 0) {
    return noUnlistedIds;
  }
  const unlisted = new Set(activeJobIds);
  for (const [, conversations] of groups) {
    for (const conversation of conversations) {
      if (conversation.conversationId) {
        unlisted.delete(conversation.conversationId);
      }
    }
  }
  return unlisted.size === 0 ? noUnlistedIds : [...unlisted];
}

/**
 * Partition the existing server-ordered groups without re-sorting them on every job update.
 * `unlisted` adds running chats those groups never held, so the Running group lists every
 * running chat; the date groups are still built only from the rows they were given.
 */
export function groupConversationsWithRunning(
  groups: GroupedConversations,
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
  unlisted: readonly TConversation[] = [],
): GroupedConversations {
  if (!showsRunningGroup(activeJobIds, options)) {
    return groups;
  }

  const running: TConversation[] = [];
  const runningIds = new Set<string>();
  const remaining: GroupedConversations = [];
  for (const [groupName, conversations] of groups) {
    const idle: TConversation[] = [];
    for (const conversation of conversations) {
      const id = conversation.conversationId;
      if (id && activeJobIds.has(id)) {
        running.push(conversation);
        runningIds.add(id);
      } else {
        idle.push(conversation);
      }
    }
    if (idle.length > 0) {
      remaining.push([groupName, idle]);
    }
  }

  const added = unlisted.filter((conversation) => {
    const id = conversation.conversationId;
    if (
      !id ||
      conversation.isArchived === true ||
      isTemporaryConversation(conversation) ||
      !activeJobIds.has(id) ||
      runningIds.has(id)
    ) {
      return false;
    }
    runningIds.add(id);
    return true;
  });

  if (running.length === 0 && added.length === 0) {
    return groups;
  }
  const runningGroup = added.length === 0 ? running : [...running, ...added].sort(newestFirst);
  return [[RUNNING_CHATS_GROUP, runningGroup], ...(running.length === 0 ? groups : remaining)];
}
