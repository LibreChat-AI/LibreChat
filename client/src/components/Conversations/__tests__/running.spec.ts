import type { TConversation } from 'librechat-data-provider';
import type { ConversationGroupOptions } from '~/utils/convos';
import {
  unlistedRunningIds,
  RUNNING_CHATS_GROUP,
  groupConversationsWithRunning as partitionGroups,
} from '../running';
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

describe('running chats the loaded rows do not hold', () => {
  const projectChat = (conversationId: string, daysAgo: number): TConversation =>
    ({ ...convo(conversationId, daysAgo), chatProjectId: 'project-1' }) as TConversation;

  it('names only the running chats the groups do not already list', () => {
    const dated = groupConversations([convo('listed', 1), convo('idle', 2)], newestFirst);
    expect(unlistedRunningIds(dated, new Set(['listed', 'in-project']))).toEqual(['in-project']);
  });

  it('returns one shared empty list when nothing is missing', () => {
    const dated = groupConversations([convo('listed', 1)], newestFirst);
    const none = unlistedRunningIds(dated, new Set());
    expect(none).toEqual([]);
    expect(unlistedRunningIds(dated, new Set(['listed']))).toBe(none);
  });

  it('lists a running project chat above the date groups without touching them', () => {
    const dated = groupConversations([convo('newer', 0), convo('older', 40)], newestFirst);
    const inProject = projectChat('in-project', 10);

    const groups = partitionGroups(dated, new Set(['in-project']), newestFirst, [inProject]);

    expect(groups[0]).toEqual([RUNNING_CHATS_GROUP, [inProject]]);
    expect(groups.slice(1)).toEqual(dated);
    expect(groups[1]).toBe(dated[0]);
  });

  it('merges unlisted and loaded running chats newest first', () => {
    const dated = groupConversations([convo('idle', 0), convo('loaded-running', 30)], newestFirst);
    const recentProject = projectChat('recent-project', 5);
    const oldPinned = convo('old-pinned', 60, true);

    const groups = partitionGroups(
      dated,
      new Set(['loaded-running', 'recent-project', 'old-pinned']),
      newestFirst,
      [oldPinned, recentProject],
    );

    expect(groups[0][0]).toBe(RUNNING_CHATS_GROUP);
    expect(groups[0][1].map((c) => c.conversationId)).toEqual([
      'recent-project',
      'loaded-running',
      'old-pinned',
    ]);
    expect(ids(groups.slice(1))).toEqual(['idle']);
  });

  it('drops unlisted rows whose run finished or that the groups already list', () => {
    const loaded = convo('loaded-running', 3);
    const dated = groupConversations([loaded], newestFirst);
    const finished = projectChat('finished', 1);
    const duplicate = { ...loaded, title: 'stale copy' } as TConversation;

    const groups = partitionGroups(dated, new Set(['loaded-running']), newestFirst, [
      finished,
      duplicate,
    ]);

    expect(groups).toEqual([[RUNNING_CHATS_GROUP, [loaded]]]);
  });

  it.each([{ isTemporary: true }, { expiredAt: '2026-12-31T00:00:00.000Z' }])(
    'leaves a temporary chat out while its run continues: %j',
    (retention) => {
      const dated = groupConversations([convo('idle', 0)], newestFirst);
      const temporary = { ...projectChat('temporary', 1), ...retention } as TConversation;

      expect(partitionGroups(dated, new Set(['temporary']), newestFirst, [temporary])).toBe(dated);
    },
  );

  it('keeps an explicitly non-temporary chat eligible even when it expires', () => {
    const dated = groupConversations([convo('idle', 0)], newestFirst);
    const expiring = {
      ...projectChat('expiring', 1),
      isTemporary: false,
      expiredAt: '2026-12-31T00:00:00.000Z',
    } as TConversation;

    expect(partitionGroups(dated, new Set(['expiring']), newestFirst, [expiring])[0]).toEqual([
      RUNNING_CHATS_GROUP,
      [expiring],
    ]);
  });

  it('leaves an archived chat out even while its run continues', () => {
    const dated = groupConversations([convo('idle', 0)], newestFirst);
    const archived = { ...projectChat('archived', 1), isArchived: true } as TConversation;

    expect(partitionGroups(dated, new Set(['archived']), newestFirst, [archived])).toBe(dated);
  });

  it.each([
    { field: 'createdAt' as const, direction: 'desc' as const },
    { ...newestFirst, includePinned: true },
  ])('adds nothing under $field $direction (includePinned: $includePinned)', (options) => {
    const dated = groupConversations([convo('idle', 0)], options);
    const unlisted = [projectChat('in-project', 1)];
    expect(partitionGroups(dated, new Set(['in-project']), options, unlisted)).toBe(dated);
  });
});
