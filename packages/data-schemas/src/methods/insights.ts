import {
  INSIGHTS_MAX_RANGE_DAYS,
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
} from 'librechat-data-provider';
import type {
  TInsightsAgent,
  TInsightsChurnedUser,
  TInsightsConversation,
  TInsightsDailyPoint,
  TInsightsParams,
  TInsightsResponse,
  TInsightsUser,
} from 'librechat-data-provider';
import type { Model, PipelineStage } from 'mongoose';
import type { IConversation, IMessage, IUser } from '~/types';

export type InsightsOptions = TInsightsParams & {
  tenantId?: string;
  agents?: TInsightsAgent[];
};

export type InsightsResult = TInsightsResponse;

export type InsightsMethods = {
  getInsights: (options?: InsightsOptions) => Promise<InsightsResult>;
};

type CountResult = { total: number };
type ConversationDay = { date: string; conversations: number };
type DailyUsers = { date: string; users: number };
type UserMessageTotals = { messages: number };
type RecentConversation = { conversationId: string; agentId: string; date: Date; userId: string };
type MessageSummary = UserMessageTotals & { _id: string };
type ChurnedUserActivity = { _id: string; lastSeen: Date };
type ChurnedUserSummary = UserMessageTotals & {
  _id: string;
  conversations: number;
  firstSeen: Date;
};
type ConversationOwner = { conversationId: string; userId: string };
type ConversationMessageSummary = UserMessageTotals & {
  _id: ConversationOwner;
  totalTokens: number;
};
type UserConversationCount = { _id: string; conversations: number };
type MessageDay = { date: string; messages: number; totalTokens: number };
type FirstMessage = { _id: ConversationOwner; text: string };
type UserSummary = {
  _id: { toString(): string };
  name?: string;
  username?: string;
  email?: string;
};

const rangeDays = { '24h': 1, '7d': 7, '30d': 30 };
const defaultRange = '7d';
const churnedUserWindowDays = 28;
const churnedUserLimit = 8;
const dayMs = 24 * 60 * 60 * 1000;

function tenantMatch(tenantId?: string) {
  return tenantId ? { tenantId } : { tenantId: { $exists: false } };
}

function joinedTenantMatch(tenantId?: string) {
  return tenantId
    ? { 'insightsConversation.tenantId': tenantId }
    : { 'insightsConversation.tenantId': { $exists: false } };
}

function validTimeZone(timeZone?: string) {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function dateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function dateKeyValue(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function addCalendarDaysToKey(key: string, days: number) {
  const date = new Date(dateKeyValue(key));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDayDifference(startKey: string, endKey: string) {
  return Math.round((dateKeyValue(endKey) - dateKeyValue(startKey)) / dayMs);
}

function startOfZonedDate(key: string, timeZone: string) {
  const target = dateKeyValue(key);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  });

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Map(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.get('year')),
      Number(parts.get('month')) - 1,
      Number(parts.get('day')),
      Number(parts.get('hour')),
      Number(parts.get('minute')),
      Number(parts.get('second')),
    );
    instant += target - rendered;
  }
  return new Date(instant);
}

function resolveRange(options: InsightsOptions) {
  const now = new Date();
  const range = options.range ?? defaultRange;

  if (range === 'custom' && options.fromTimestamp && options.toTimestamp) {
    const customFrom = new Date(options.fromTimestamp);
    const customTo = new Date(options.toTimestamp);
    if (Number.isFinite(customFrom.getTime()) && Number.isFinite(customTo.getTime())) {
      const [start, end] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
      const timeZone = validTimeZone(options.timeZone);
      const startKey = dateKey(start, timeZone);
      const endKey = dateKey(end, timeZone);
      if (calendarDayDifference(startKey, endKey) < INSIGHTS_MAX_RANGE_DAYS) {
        return { from: start, to: end };
      }
      const firstAllowedKey = addCalendarDaysToKey(endKey, -(INSIGHTS_MAX_RANGE_DAYS - 1));
      return { from: startOfZonedDate(firstAllowedKey, timeZone), to: end };
    }
  }

  const days = rangeDays[range as keyof typeof rangeDays] ?? rangeDays[defaultRange];
  return { from: new Date(now.getTime() - days * dayMs), to: now };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const conversationOwnerKey = ({ conversationId, userId }: ConversationOwner): string =>
  JSON.stringify([conversationId, userId]);
const conversationOwnerMatch = ({ conversationId, userId }: ConversationOwner) => ({
  conversationId,
  user: userId,
});

function conversationScope(match: Record<string, unknown>, agentIds: string[]): PipelineStage[] {
  return [
    {
      $match: {
        ...match,
        $or: [
          { initial_agent_id: { $in: agentIds } },
          { initial_agent_id: { $exists: false }, agent_id: { $in: agentIds } },
        ],
      },
    },
    { $addFields: { insightsAgentId: { $ifNull: ['$initial_agent_id', '$agent_id'] } } },
  ];
}

function messageScope(
  match: Record<string, unknown>,
  agentIds: string[],
  tenantId?: string,
): PipelineStage[] {
  const attributedMatch =
    match.isCreatedByUser === true
      ? match
      : {
          $and: [
            match,
            {
              $or: [
                { isCreatedByUser: true },
                { isCreatedByUser: { $ne: true }, model: { $in: agentIds } },
              ],
            },
          ],
        };
  return [
    { $match: attributedMatch },
    {
      $lookup: {
        from: 'conversations',
        localField: 'conversationId',
        foreignField: 'conversationId',
        as: 'insightsConversation',
      },
    },
    { $unwind: '$insightsConversation' },
    {
      $addFields: {
        insightsOwnerMatches: { $eq: ['$user', '$insightsConversation.user'] },
      },
    },
    {
      $match: {
        ...joinedTenantMatch(tenantId),
        'insightsConversation.isTemporary': { $ne: true },
        'insightsConversation.subagentThread': { $exists: false },
        'insightsConversation.user': { $nin: [null, ''] },
        insightsOwnerMatches: true,
        $or: [
          { isCreatedByUser: true, 'insightsConversation.initial_agent_id': { $in: agentIds } },
          {
            isCreatedByUser: true,
            'insightsConversation.initial_agent_id': { $exists: false },
            'insightsConversation.agent_id': { $in: agentIds },
          },
          {
            isCreatedByUser: { $ne: true },
            model: { $in: agentIds },
            $or: [
              {
                'insightsConversation.initial_agent_id': {
                  $exists: true,
                  $nin: [null, ''],
                },
              },
              {
                'insightsConversation.initial_agent_id': { $exists: false },
                'insightsConversation.agent_id': { $exists: true, $nin: [null, ''] },
              },
            ],
          },
        ],
      },
    },
  ];
}

const addDay = (days: Map<string, TInsightsDailyPoint>, date: string): TInsightsDailyPoint => {
  const current = days.get(date) ?? {
    date,
    conversations: 0,
    users: 0,
    messages: 0,
    totalTokens: 0,
  };
  days.set(date, current);
  return current;
};

const toUser = (
  userId: string,
  conversations: number,
  users: Map<string, UserSummary>,
  messageSummary: UserMessageTotals | undefined,
): TInsightsUser => {
  const user = users.get(userId);
  return {
    userId,
    name: user?.name || user?.username || '',
    email: user?.email ?? '',
    conversations,
    messages: messageSummary?.messages ?? 0,
  };
};

export function createInsightsMethods(mongoose: typeof import('mongoose')): InsightsMethods {
  async function getInsights(options: InsightsOptions = {}): Promise<InsightsResult> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const Message = mongoose.models.Message as Model<IMessage>;
    const User = mongoose.models.User as Model<IUser>;
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(options.pageSize ?? 10)));
    const agentIds = [...new Set(options.agentIds ?? [])].sort((a, b) => a.localeCompare(b));
    const { from, to } = resolveRange(options);
    const timeZone = validTimeZone(options.timeZone);
    const churnedCutoff = new Date(to.getTime() - churnedUserWindowDays * dayMs);
    const churnedActivityFrom = new Date(from.getTime() - churnedUserWindowDays * dayMs);
    const tenant = tenantMatch(options.tenantId);
    const conversationMatch = {
      ...tenant,
      isTemporary: { $ne: true },
      subagentThread: { $exists: false },
      user: { $nin: [null, ''] },
      createdAt: { $gte: from, $lte: to },
    };
    const messageMatch = {
      ...tenant,
      user: { $nin: [null, ''] },
      isTemporary: { $ne: true },
      createdAt: { $gte: from, $lte: to },
    };
    const conversationPipeline = conversationScope(conversationMatch, agentIds);
    const messagePipeline = messageScope(messageMatch, agentIds, options.tenantId);

    const requestedSearch = options.search?.trim().slice(0, INSIGHTS_SEARCH_MAX_LENGTH) ?? '';
    const search = requestedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH ? requestedSearch : '';
    const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : undefined;
    const searchedConversationPipeline: PipelineStage[] = searchRegex
      ? [
          ...conversationPipeline,
          {
            $addFields: {
              insightsUserId: {
                $convert: { input: '$user', to: 'objectId', onError: null, onNull: null },
              },
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: 'insightsUserId',
              foreignField: '_id',
              as: 'matchedIdentity',
            },
          },
          {
            $match: {
              $or: [
                { conversationId: searchRegex },
                { user: searchRegex },
                {
                  matchedIdentity: {
                    $elemMatch: {
                      ...tenant,
                      $or: [
                        { name: searchRegex },
                        { username: searchRegex },
                        { email: searchRegex },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ]
      : conversationPipeline;

    const [
      conversationDays,
      latestRows,
      searchedConversationCount,
      messageDays,
      userCount,
      dailyUsers,
      topMessageUsers,
      churnedUserRows,
    ] = await Promise.all([
      Conversation.aggregate<ConversationDay>([
        ...conversationPipeline,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } },
            conversations: { $sum: 1 },
          },
        },
        { $project: { _id: 0, date: '$_id', conversations: 1 } },
        { $sort: { date: 1 } },
      ]),
      Conversation.aggregate<RecentConversation>([
        ...searchedConversationPipeline,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            _id: 0,
            conversationId: 1,
            agentId: '$insightsAgentId',
            date: '$createdAt',
            userId: '$user',
          },
        },
      ]),
      searchRegex
        ? Conversation.aggregate<CountResult>([
            ...searchedConversationPipeline,
            { $count: 'total' },
          ])
        : Promise.resolve([] as CountResult[]),
      Message.aggregate<MessageDay>([
        ...messagePipeline,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } },
            messages: { $sum: 1 },
            totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
          },
        },
        { $project: { _id: 0, date: '$_id', messages: 1, totalTokens: 1 } },
        { $sort: { date: 1 } },
      ]),
      Message.aggregate<CountResult>([
        ...messagePipeline,
        { $group: { _id: '$user' } },
        { $count: 'total' },
      ]),
      Message.aggregate<DailyUsers>([
        ...messagePipeline,
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone },
              },
              user: '$user',
            },
          },
        },
        { $group: { _id: '$_id.date', users: { $sum: 1 } } },
        { $project: { _id: 0, date: '$_id', users: 1 } },
        { $sort: { date: 1 } },
      ]),
      Message.aggregate<MessageSummary>([
        ...messagePipeline,
        { $group: { _id: '$user', messages: { $sum: 1 } } },
        { $sort: { messages: -1, _id: 1 } },
        { $limit: 8 },
      ]),
      Message.aggregate<ChurnedUserActivity>([
        ...messageScope(
          {
            ...tenant,
            isTemporary: { $ne: true },
            isCreatedByUser: true,
            user: { $nin: [null, ''] },
            createdAt: { $gte: churnedActivityFrom, $lte: to },
          },
          agentIds,
          options.tenantId,
        ),
        { $group: { _id: '$user', lastSeen: { $max: '$createdAt' } } },
        { $match: { lastSeen: { $gte: churnedActivityFrom, $lte: churnedCutoff } } },
        { $sort: { lastSeen: -1, _id: 1 } },
        { $limit: churnedUserLimit },
      ]),
    ]);

    const latestConversationOwners = latestRows
      .filter(
        (row): row is RecentConversation & { userId: string } =>
          isNonEmptyString(row.conversationId) && isNonEmptyString(row.userId),
      )
      .map(({ conversationId, userId }) => ({ conversationId, userId }));
    const latestConversationIds = [
      ...new Set(latestConversationOwners.map(({ conversationId }) => conversationId)),
    ];
    const latestConversationMatches = latestConversationOwners.map(conversationOwnerMatch);
    const topUserIds = topMessageUsers.map(({ _id }) => _id);
    const churnedUserIds = churnedUserRows.map(({ _id }) => _id);
    const userIds = new Set<string>([
      ...topUserIds,
      ...churnedUserIds,
      ...latestRows.map(({ userId }) => userId).filter(isNonEmptyString),
    ]);

    const [
      latestMessageSummaries,
      firstMessages,
      topConversationCounts,
      churnedUserSummaries,
      userRows,
    ] = await Promise.all([
      latestConversationMatches.length === 0
        ? Promise.resolve([] as ConversationMessageSummary[])
        : Message.aggregate<ConversationMessageSummary>([
            ...messageScope(
              {
                ...messageMatch,
                conversationId: { $in: latestConversationIds },
                $or: latestConversationMatches,
              },
              agentIds,
              options.tenantId,
            ),
            {
              $group: {
                _id: { conversationId: '$conversationId', userId: '$user' },
                messages: { $sum: 1 },
                totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
              },
            },
          ]),
      latestConversationMatches.length === 0
        ? Promise.resolve([] as FirstMessage[])
        : Message.aggregate<FirstMessage>([
            ...messageScope(
              {
                ...tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                conversationId: { $in: latestConversationIds },
                $or: latestConversationMatches,
              },
              agentIds,
              options.tenantId,
            ),
            { $sort: { createdAt: 1, _id: 1 } },
            {
              $group: {
                _id: { conversationId: '$conversationId', userId: '$user' },
                text: { $first: { $ifNull: ['$text', ''] } },
              },
            },
          ]),
      topUserIds.length === 0
        ? Promise.resolve([] as UserConversationCount[])
        : Message.aggregate<UserConversationCount>([
            ...messageScope(
              { ...messageMatch, user: { $in: topUserIds } },
              agentIds,
              options.tenantId,
            ),
            { $group: { _id: { user: '$user', conversationId: '$conversationId' } } },
            { $group: { _id: '$_id.user', conversations: { $sum: 1 } } },
          ]),
      churnedUserIds.length === 0
        ? Promise.resolve([] as ChurnedUserSummary[])
        : Message.aggregate<ChurnedUserSummary>([
            ...messageScope(
              {
                ...tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                user: { $in: churnedUserIds },
                createdAt: { $lte: to },
              },
              agentIds,
              options.tenantId,
            ),
            {
              $group: {
                _id: { user: '$user', conversationId: '$conversationId' },
                messages: { $sum: 1 },
                firstSeen: { $min: '$createdAt' },
              },
            },
            {
              $group: {
                _id: '$_id.user',
                conversations: { $sum: 1 },
                messages: { $sum: '$messages' },
                firstSeen: { $min: '$firstSeen' },
              },
            },
          ]),
      userIds.size === 0
        ? Promise.resolve([] as UserSummary[])
        : User.find({ ...tenant, _id: { $in: [...userIds] } })
            .select('_id name username email')
            .lean<UserSummary[]>(),
    ]);

    const users = new Map(userRows.map((user) => [user._id.toString(), user]));
    const agentNames = new Map((options.agents ?? []).map((agent) => [agent.id, agent.name]));
    const latestSummaries = new Map(
      latestMessageSummaries.map((summary) => [conversationOwnerKey(summary._id), summary]),
    );
    const firstByConversation = new Map(
      firstMessages.map((message) => [conversationOwnerKey(message._id), message.text]),
    );
    const days = new Map<string, TInsightsDailyPoint>();
    const firstDay = dateKey(from, timeZone);
    const lastDay = dateKey(to, timeZone);
    for (let key = firstDay; key <= lastDay; key = addCalendarDaysToKey(key, 1)) {
      addDay(days, key);
    }
    for (const row of conversationDays) addDay(days, row.date).conversations = row.conversations;
    for (const row of messageDays) {
      const day = addDay(days, row.date);
      day.messages = row.messages;
      day.totalTokens = row.totalTokens;
    }
    for (const row of dailyUsers) addDay(days, row.date).users = row.users;

    const totalConversations = conversationDays.reduce(
      (total, row) => total + row.conversations,
      0,
    );
    const matchingConversations = searchRegex
      ? (searchedConversationCount[0]?.total ?? 0)
      : totalConversations;
    const topConversationCountsByUser = new Map(
      topConversationCounts.map((summary) => [summary._id, summary.conversations]),
    );
    const churnedSummariesByUser = new Map(
      churnedUserSummaries.map((summary) => [summary._id, summary]),
    );

    return {
      agents: options.agents ?? [],
      summary: {
        totalUsers: userCount[0]?.total ?? 0,
        totalConversations,
        totalMessages: messageDays.reduce((total, row) => total + row.messages, 0),
        totalTokens: messageDays.reduce((total, row) => total + row.totalTokens, 0),
      },
      daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      topUsers: topMessageUsers.map((row) =>
        toUser(row._id, topConversationCountsByUser.get(row._id) ?? 0, users, row),
      ),
      churnedUsers: churnedUserRows.map((row): TInsightsChurnedUser => {
        const user = users.get(row._id);
        const summary = churnedSummariesByUser.get(row._id);
        return {
          userId: row._id,
          name: user?.name || user?.username || '',
          email: user?.email ?? '',
          conversations: summary?.conversations ?? 0,
          messages: summary?.messages ?? 0,
          firstSeen: summary?.firstSeen.toISOString() ?? row.lastSeen.toISOString(),
          lastSeen: row.lastSeen.toISOString(),
        };
      }),
      latest: {
        conversations: latestRows.map((row): TInsightsConversation => {
          const userId = isNonEmptyString(row.userId) ? row.userId : '';
          const user = userId ? users.get(userId) : undefined;
          const ownerKey = conversationOwnerKey({ conversationId: row.conversationId, userId });
          const summary = latestSummaries.get(ownerKey);
          return {
            ...row,
            agentName: agentNames.get(row.agentId) ?? row.agentId,
            userId,
            date: row.date.toISOString(),
            name: user?.name || user?.username || '',
            email: user?.email ?? '',
            firstMessage: firstByConversation.get(ownerKey) ?? '',
            messages: summary?.messages ?? 0,
            totalTokens: summary?.totalTokens ?? 0,
          };
        }),
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(matchingConversations / pageSize)),
      },
    };
  }

  return { getInsights };
}
