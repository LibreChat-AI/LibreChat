import type { TConversation, GroupedConversations } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';
import { isTemporaryConversation } from '~/utils/conversation';
import { isConversationUnseen } from '~/utils/convos';

export const RUNNING_CHATS_GROUP = 'com_ui_running_chats';
export const FINISHED_CHATS_GROUP = 'com_ui_finished_chats';

/** Groups that hold chats by what they are doing rather than by date; their headings
 *  carry a count. */
export const isStatusGroup = (groupName: string): boolean =>
  groupName === RUNNING_CHATS_GROUP || groupName === FINISHED_CHATS_GROUP;

const noUnlistedIds: string[] = [];

/** Status groups only make sense over the newest-first list: under any other order a
 *  chat lifted to the top would read as the first by title or by creation. */
function showsStatusGroups(options: ConversationGroupOptions): boolean {
  return !options.includePinned && options.field === 'updatedAt' && options.direction === 'desc';
}

/** A reply that landed while the user was elsewhere. "Mark as unread" sets the same
 *  stamp as a reminder, not as a finished run, so that chat keeps its date. */
function isFinishedUnseen(conversation: TConversation): boolean {
  return (
    conversation.isMarkedUnread !== true &&
    conversation.lastResponseIsManual !== true &&
    isConversationUnseen(conversation)
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
 * Running chats lead; chats whose reply arrived unseen follow as Finished, so a run that
 * ends while the user is elsewhere stays near the top until it is opened. `unlisted` adds
 * running chats those groups never held, so the Running group lists every running chat;
 * the date groups are still built only from the rows they were given.
 */
export function groupConversationsByStatus(
  groups: GroupedConversations,
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
  unlisted: readonly TConversation[] = [],
): GroupedConversations {
  if (!showsStatusGroups(options)) {
    return groups;
  }

  const running: TConversation[] = [];
  const finished: TConversation[] = [];
  const runningIds = new Set<string>();
  const remaining: GroupedConversations = [];
  for (const [groupName, conversations] of groups) {
    const idle: TConversation[] = [];
    for (const conversation of conversations) {
      const id = conversation.conversationId;
      if (id && activeJobIds.has(id)) {
        running.push(conversation);
        runningIds.add(id);
      } else if (isFinishedUnseen(conversation)) {
        finished.push(conversation);
      } else {
        idle.push(conversation);
      }
    }
    if (idle.length > 0) {
      remaining.push([groupName, idle]);
    }
  }

  const added =
    activeJobIds.size === 0
      ? []
      : unlisted.filter((conversation) => {
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

  if (running.length === 0 && finished.length === 0 && added.length === 0) {
    return groups;
  }
  const statusGroups: GroupedConversations = [];
  if (running.length > 0 || added.length > 0) {
    const runningGroup = added.length === 0 ? running : [...running, ...added].sort(newestFirst);
    statusGroups.push([RUNNING_CHATS_GROUP, runningGroup]);
  }
  if (finished.length > 0) {
    statusGroups.push([FINISHED_CHATS_GROUP, finished]);
  }
  const pulled = running.length > 0 || finished.length > 0;
  return [...statusGroups, ...(pulled ? remaining : groups)];
}
