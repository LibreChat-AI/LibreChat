import type { TConversation } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';
import { groupConversationsWithRunning as partitionGroups, RUNNING_CHATS_GROUP } from '../running';
import { groupConversations } from '~/utils/convos';

const convo = (conversationId: string, daysAgo: number, pinned = false): TConversation =>
  ({
    conversationId,
    title: conversationId,
    updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    pinned,
  }) as TConversation;

const ids = (groups: ReturnType<typeof groupConversations>) =>
  groups.flatMap(([, conversations]) => conversations.map((c) => c.conversationId));

const newestFirst = { field: 'updatedAt' as const, direction: 'desc' as const };
const groupConversationsWithRunning = (
  conversations: TConversation[],
  activeJobIds: ReadonlySet<string>,
  options: ConversationGroupOptions,
) => partitionGroups(groupConversations(conversations, options), activeJobIds, options);

describe('groupConversationsWithRunning', () => {
  it('returns the same date groups when the polled jobs do not affect loaded rows', () => {
    const dated = groupConversations([convo('idle', 1)], newestFirst);
    expect(partitionGroups(dated, new Set(), newestFirst)).toBe(dated);
    expect(partitionGroups(dated, new Set(['not-loaded']), newestFirst)).toBe(dated);
  });
  it('lifts loaded running chats above newer idle chats without changing the server rows', () => {
    const newer = convo('newer', 0);
    const running = convo('running', 45);
    const older = convo('older', 60);
    const conversations = [newer, running, older];
    const snapshot = JSON.stringify(conversations);

    const groups = groupConversationsWithRunning(
      conversations,
      new Set(['running', 'not-loaded']),
      newestFirst,
    );

    expect(groups[0]).toEqual([RUNNING_CHATS_GROUP, [running]]);
    expect(ids(groups)).toEqual(['running', 'newer', 'older']);
    expect(JSON.stringify(conversations)).toBe(snapshot);
  });

  it('keeps multiple running chats in their fetched order and deduplicates overlapping pages', () => {
    const older = convo('older', 70);
    const recent = convo('recent', 2);
    const pinned = convo('pinned', 1, true);
    const groups = groupConversationsWithRunning(
      [recent, pinned, older, recent, older],
      new Set(['older', 'recent', 'pinned']),
      newestFirst,
    );

    expect(groups).toEqual([[RUNNING_CHATS_GROUP, [recent, older]]]);
    expect(ids(groups)).toEqual(['recent', 'older']);
  });

  it('restores date grouping as soon as a run finishes', () => {
    const conversations = [convo('newer', 0), convo('running', 50)];
    const running = groupConversationsWithRunning(conversations, new Set(['running']), newestFirst);
    const finished = groupConversationsWithRunning(conversations, new Set(), newestFirst);

    expect(running[0][0]).toBe(RUNNING_CHATS_GROUP);
    expect(finished).toEqual(groupConversations(conversations, newestFirst));
    expect(ids(finished)).toEqual(['newer', 'running']);
  });

  it.each([
    { field: 'updatedAt' as const, direction: 'asc' as const },
    { field: 'createdAt' as const, direction: 'desc' as const },
    { field: 'title' as const, direction: 'asc' as const },
  ])('respects the explicit $field $direction sort', (options) => {
    const conversations = [convo('newer', 0), convo('running', 50)];
    expect(groupConversationsWithRunning(conversations, new Set(['running']), options)).toEqual(
      groupConversations(conversations, options),
    );
  });

  it('keeps archive grouping untouched, including archived pinned rows', () => {
    const conversations = [convo('newer', 0), convo('pinned', 50, true)];
    const options = { ...newestFirst, includePinned: true };
    expect(groupConversationsWithRunning(conversations, new Set(['pinned']), options)).toEqual(
      groupConversations(conversations, options),
    );
  });
});
