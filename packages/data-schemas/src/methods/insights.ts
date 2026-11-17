import _ from 'lodash';
import {
  FEEDBACK_TAGS,
  CREDITS_PER_USD,
  INSIGHTS_MAX_RANGE_DAYS,
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
} from 'librechat-data-provider';
import type {
  TInsightsAggregateResponse,
  TInsightsAgent,
  TInsightsAgentVersion,
  TInsightsChurnedUser,
  TInsightsConversation,
  TInsightsDailyPoint,
  TInsightsDetailedResponse,
  TInsightsFeedback,
  TInsightsModel,
  TInsightsParams,
  TInsightsResponse,
  TInsightsResponseOutcomes,
  TInsightsSummary,
  TInsightsUser,
} from 'librechat-data-provider';
import type { Model, PipelineStage } from 'mongoose';
import type { IAgent, IConversation, IMessage, IUser } from '~/types';
import type { ITransaction } from '~/schema/transaction';

export type InsightsOptions = TInsightsParams & {
  tenantId?: string;
  agents?: TInsightsAgent[];
  showDetails?: boolean;
};

export type InsightsResult = TInsightsResponse;

export type InsightsMethods = {
  getInsights(
    options?: InsightsOptions & { showDetails?: true },
  ): Promise<TInsightsDetailedResponse>;
  getInsights(
    options: InsightsOptions & { showDetails: false },
  ): Promise<TInsightsAggregateResponse>;
  getInsights(options?: InsightsOptions): Promise<InsightsResult>;
};

type CountResult = { total: number };
type ConversationDay = { date: string; conversations: number };
type ModelSpend = { date: string; model: unknown; credits: number; usageTokens: number };
type ReplyIdentity = { conversationId: string; user: string; messageId: string };
type ReplyModel = { _id: ReplyIdentity; model: unknown };
type ReplyOutcome = ReplyIdentity & {
  outcome: 'completed' | 'failed' | 'interrupted';
  rating?: unknown;
};
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
type MessageDay = TInsightsResponseOutcomes & {
  date: string;
  messages: number;
  totalTokens: number;
  responses: number;
  lastUsed: Date;
  feedback: TInsightsFeedback;
};
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
/** A reply's usage rows are recorded around its own creation time; looking this far past
 * the period edges keeps replies near a boundary attributed to their model. */
const replyUsageWindowMs = dayMs;
/** Usage recorded for the reply's own run. Title, summarization, memory and sub-agent usage
 * also carries the reply's messageId but comes from other models, so it only counts as spend. */
const replyUsageContexts = ['message', 'abort', 'incomplete', 'reasoning', null];

const responseRating = { $cond: [{ $eq: ['$isCreatedByUser', false] }, '$feedback.rating', null] };
const responseOutcome = {
  $cond: [
    { $eq: ['$isCreatedByUser', false] },
    {
      $cond: [
        {
          // Provider failures mid-answer are saved as an error content block with error: false.
          $or: [{ $eq: ['$error', true] }, { $in: ['error', { $ifNull: ['$content.type', []] }] }],
        },
        'failed',
        {
          $cond: [{ $eq: ['$unfinished', true] }, 'interrupted', 'completed'],
        },
      ],
    },
    null,
  ],
};
const outcomeCount = (outcome: string) => ({
  $sum: { $cond: [{ $eq: ['$insightsOutcome', outcome] }, 1, 0] },
});
const ratingCount = (rating: string) => ({
  $sum: { $cond: [{ $eq: ['$insightsFeedbackRating', rating] }, 1, 0] },
});

function tenantMatch(tenantId?: string, prefix = '') {
  const field = `${prefix}tenantId`;
  return tenantId ? { [field]: tenantId } : { [field]: { $exists: false } };
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

function rootAgentMatch(agentIds: string[], prefix = '') {
  const initialField = `${prefix}initial_agent_id`;
  const currentField = `${prefix}agent_id`;
  return {
    $or: [
      { [initialField]: { $in: agentIds } },
      { [initialField]: { $exists: false }, [currentField]: { $in: agentIds } },
    ],
  };
}

/** Eligibility is independent of reporting dates and applies on either side of a join. */
function conversationEligibility(agentIds: string[], tenantId?: string, prefix = '') {
  return {
    ...tenantMatch(tenantId, prefix),
    [`${prefix}conversationId`]: { $exists: true, $nin: [null, ''] },
    [`${prefix}user`]: { $exists: true, $nin: [null, ''] },
    [`${prefix}isTemporary`]: { $ne: true },
    [`${prefix}subagentThread`]: { $exists: false },
    ...rootAgentMatch(agentIds, prefix),
  };
}

function conversationScope(
  agentIds: string[],
  tenantId?: string,
  createdAt?: { $gte: Date; $lte: Date },
): PipelineStage[] {
  return [
    {
      $match: {
        ...conversationEligibility(agentIds, tenantId),
        ...(createdAt ? { createdAt } : {}),
      },
    },
    { $addFields: { insightsAgentId: { $ifNull: ['$initial_agent_id', '$agent_id'] } } },
  ];
}

/** Records attributed to a selected root agent when they were saved. Eligibility (root agent,
 * owner, temporary and sub-agent chats) is decided at write time, so reads need no join. */
function messageScope(match: Record<string, unknown>, agentIds: string[]): PipelineStage[] {
  return [{ $match: { ...match, insightsAgentId: { $in: agentIds } } }];
}

/** Usage ledger rows of the selected root agents in the period. */
function transactionScope(
  agentIds: string[],
  tenantId: string | undefined,
  createdAt: { $gte: Date; $lte: Date },
  match: Record<string, unknown> = {},
): PipelineStage[] {
  return [
    {
      $match: {
        ...tenantMatch(tenantId),
        insightsAgentId: { $in: agentIds },
        createdAt,
        tokenType: { $in: ['prompt', 'completion'] },
        tokenValue: { $gte: -Number.MAX_VALUE, $lte: 0 },
        ...match,
      },
    },
    {
      $addFields: {
        insightsUsageEligible: {
          $and: [
            { $or: [{ $eq: ['$tokenType', 'prompt'] }, { $eq: ['$tokenType', 'completion'] }] },
            { $gte: ['$tokenValue', -Number.MAX_VALUE] },
            { $lte: ['$tokenValue', 0] },
          ],
        },
      },
    },
    { $match: { insightsUsageEligible: true } },
    {
      $project: {
        _id: 0,
        conversationId: 1,
        user: { $convert: { input: '$user', to: 'string', onError: null, onNull: null } },
        insightsTransaction: {
          _id: '$_id',
          createdAt: '$createdAt',
          model: '$model',
          messageId: '$messageId',
          tokenValue: '$tokenValue',
          rawAmount: '$rawAmount',
        },
      },
    },
  ];
}

const modelKey = (model: unknown): string | null =>
  typeof model === 'string' && model.trim() !== '' ? model : null;

const emptyModel = (model: string | null): TInsightsModel => ({
  model,
  responses: 0,
  completedResponses: 0,
  failedResponses: 0,
  interruptedResponses: 0,
  thumbsUp: 0,
  thumbsDown: 0,
  usageTokens: 0,
  spendUSD: null,
});

type VersionSettings = {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  instructionsPrompt?: unknown;
  artifacts?: unknown;
  edges?: unknown;
  tools?: unknown[];
  capabilities?: unknown[];
  updatedAt?: Date | string | null;
};

const sameSortedList = (left?: unknown[], right?: unknown[]) => {
  if (!left && !right) return true;
  if (!left || !right || left.length !== right.length) return false;
  const sortedRight = right.map(String).sort();
  return left
    .map(String)
    .sort()
    .every((value, index) => value === sortedRight[index]);
};

/** The agent builder's version panel (`isActiveVersion`) marks as active the newest saved version
 *  whose settings match the agent's current ones; Insights reports the same version. */
const matchesCurrentSettings = (version: VersionSettings, current: VersionSettings) =>
  version.name === current.name &&
  version.description === current.description &&
  version.instructions === current.instructions &&
  version.artifacts === current.artifacts &&
  _.isEqual(version.instructionsPrompt ?? null, current.instructionsPrompt ?? null) &&
  _.isEqual(version.edges ?? [], current.edges ?? []) &&
  sameSortedList(version.tools, current.tools) &&
  sameSortedList(version.capabilities, current.capabilities);

const comparedSettings = [
  'name',
  'description',
  'instructions',
  'instructionsPrompt',
  'artifacts',
  'edges',
  'tools',
  'capabilities',
] as const;

async function getSavedVersions(
  mongoose: typeof import('mongoose'),
  agentIds: string[],
  tenantId?: string,
): Promise<TInsightsAgentVersion[]> {
  const Agent = mongoose.models.Agent as Model<IAgent>;
  const agents = await Agent.find(
    { id: { $in: agentIds }, ...tenantMatch(tenantId) },
    {
      id: 1,
      _id: 0,
      'versions.updatedAt': 1,
      ...Object.fromEntries(
        comparedSettings.flatMap((field) => [
          [field, 1],
          [`versions.${field}`, 1],
        ]),
      ),
    },
  )
    .sort({ id: 1 })
    .lean<Array<VersionSettings & { id: string; versions?: VersionSettings[] }>>();
  return agents.flatMap((agent) => {
    const versions = agent.versions ?? [];
    let activeIndex = -1;
    for (let index = versions.length - 1; index >= 0; index--) {
      if (matchesCurrentSettings(versions[index] ?? {}, agent)) {
        activeIndex = index;
        break;
      }
    }
    return versions.map((snapshot, index) => {
      const date = snapshot?.updatedAt == null ? null : new Date(snapshot.updatedAt);
      return {
        agentId: agent.id,
        version: index + 1,
        savedAt: date != null && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
        active: index === activeIndex,
      };
    });
  });
}

const emptyFeedback = (): TInsightsFeedback => ({
  thumbsUp: 0,
  thumbsDown: 0,
  categories: FEEDBACK_TAGS.map(({ key }) => ({ key, count: 0 })),
});

const addDay = (days: Map<string, TInsightsDailyPoint>, date: string): TInsightsDailyPoint => {
  const current = days.get(date) ?? {
    date,
    conversations: 0,
    users: 0,
    messages: 0,
    totalTokens: 0,
    responses: 0,
    completedResponses: 0,
    failedResponses: 0,
    interruptedResponses: 0,
    feedback: emptyFeedback(),
    spendUSD: null,
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
  async function getInsights(
    options?: InsightsOptions & { showDetails?: true },
  ): Promise<TInsightsDetailedResponse>;
  async function getInsights(
    options: InsightsOptions & { showDetails: false },
  ): Promise<TInsightsAggregateResponse>;
  async function getInsights(options?: InsightsOptions): Promise<InsightsResult>;
  async function getInsights(options: InsightsOptions = {}): Promise<InsightsResult> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const User = mongoose.models.User as Model<IUser>;
    const Message = mongoose.models.Message as Model<IMessage>;
    const Transaction = mongoose.models.Transaction as Model<ITransaction>;
    const showDetails = options.showDetails !== false;
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(options.pageSize ?? 10)));
    const agentIds = [...new Set(options.agentIds ?? [])].sort((a, b) => a.localeCompare(b));
    const { from, to } = resolveRange(options);
    const timeZone = validTimeZone(options.timeZone);
    const churnedCutoff = new Date(to.getTime() - churnedUserWindowDays * dayMs);
    const churnedActivityFrom = new Date(from.getTime() - churnedUserWindowDays * dayMs);
    const tenant = tenantMatch(options.tenantId);
    const messageMatch = {
      ...tenant,
      user: { $nin: [null, ''] },
      isTemporary: { $ne: true },
      createdAt: { $gte: from, $lte: to },
    };
    const conversationPipeline = conversationScope(agentIds, options.tenantId, {
      $gte: from,
      $lte: to,
    });
    const messagePipeline = messageScope(messageMatch, agentIds);

    const requestedSearch = options.search?.trim().slice(0, INSIGHTS_SEARCH_MAX_LENGTH) ?? '';
    const search =
      showDetails && requestedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH ? requestedSearch : '';
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
      spendRows,
      replyModelRows,
      replyRows,
      agentVersions,
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
      showDetails
        ? Conversation.aggregate<RecentConversation>([
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
          ])
        : Promise.resolve([] as RecentConversation[]),
      searchRegex
        ? Conversation.aggregate<CountResult>([
            ...searchedConversationPipeline,
            { $count: 'total' },
          ])
        : Promise.resolve([] as CountResult[]),
      Message.aggregate<MessageDay>([
        ...messagePipeline,
        {
          $addFields: {
            insightsFeedbackRating: responseRating,
            insightsFeedbackTag: { $ifNull: ['$feedback.tag.key', '$feedback.tag'] },
            insightsOutcome: responseOutcome,
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } },
            messages: { $sum: 1 },
            totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
            responses: { $sum: { $cond: [{ $ne: ['$insightsOutcome', null] }, 1, 0] } },
            completedResponses: outcomeCount('completed'),
            failedResponses: outcomeCount('failed'),
            interruptedResponses: outcomeCount('interrupted'),
            lastUsed: { $max: '$createdAt' },
            feedbackThumbsUp: ratingCount('thumbsUp'),
            feedbackThumbsDown: ratingCount('thumbsDown'),
            ...Object.fromEntries(
              FEEDBACK_TAGS.map(({ key, direction }) => [
                `feedback_${key}`,
                {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$insightsFeedbackRating', direction] },
                          { $eq: ['$insightsFeedbackTag', key] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              ]),
            ),
          },
        },
        {
          $project: {
            _id: 0,
            date: '$_id',
            messages: 1,
            totalTokens: 1,
            responses: 1,
            completedResponses: 1,
            failedResponses: 1,
            interruptedResponses: 1,
            lastUsed: 1,
            feedback: {
              thumbsUp: '$feedbackThumbsUp',
              thumbsDown: '$feedbackThumbsDown',
              categories: FEEDBACK_TAGS.map(({ key }) => ({ key, count: `$feedback_${key}` })),
            },
          },
        },
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
      showDetails
        ? Message.aggregate<MessageSummary>([
            ...messagePipeline,
            { $group: { _id: '$user', messages: { $sum: 1 } } },
            { $sort: { messages: -1, _id: 1 } },
            { $limit: 8 },
          ])
        : Promise.resolve([] as MessageSummary[]),
      showDetails
        ? Message.aggregate<ChurnedUserActivity>([
            ...messageScope(
              {
                ...tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                user: { $nin: [null, ''] },
                createdAt: { $gte: churnedActivityFrom, $lte: to },
              },
              agentIds,
            ),
            { $group: { _id: '$user', lastSeen: { $max: '$createdAt' } } },
            { $match: { lastSeen: { $gte: churnedActivityFrom, $lte: churnedCutoff } } },
            { $sort: { lastSeen: -1, _id: 1 } },
            { $limit: churnedUserLimit },
          ])
        : Promise.resolve([] as ChurnedUserActivity[]),
      Transaction.aggregate<ModelSpend>([
        ...transactionScope(agentIds, options.tenantId, { $gte: from, $lte: to }),
        // Deduplicate ledger rows before daily totals, independently of conversation joins.
        {
          $group: {
            _id: '$insightsTransaction._id',
            createdAt: { $max: '$insightsTransaction.createdAt' },
            tokenValue: { $min: '$insightsTransaction.tokenValue' },
            rawAmount: { $min: '$insightsTransaction.rawAmount' },
            model: { $max: '$insightsTransaction.model' },
          },
        },
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone },
              },
              model: { $ifNull: ['$model', null] },
            },
            credits: { $sum: { $multiply: ['$tokenValue', -1] } },
            // Structured prompt rows already store input + cache write + cache read here.
            usageTokens: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
          },
        },
        {
          $project: {
            _id: 0,
            date: '$_id.date',
            model: '$_id.model',
            credits: 1,
            usageTokens: 1,
          },
        },
        { $sort: { date: 1, model: 1 } },
      ]),
      // Each reply counts once, under the model of its own run's last completion usage row.
      // The model and the reply are read separately and matched by message in code, so no
      // reply is looked up one by one in the messages collection.
      Transaction.aggregate<ReplyModel>([
        ...transactionScope(
          agentIds,
          options.tenantId,
          {
            $gte: new Date(from.getTime() - replyUsageWindowMs),
            $lte: new Date(to.getTime() + replyUsageWindowMs),
          },
          {
            tokenType: 'completion',
            context: { $in: replyUsageContexts },
            messageId: { $exists: true, $nin: [null, ''] },
          },
        ),
        {
          $project: {
            _id: 0,
            conversationId: 1,
            user: 1,
            transactionId: '$insightsTransaction._id',
            createdAt: '$insightsTransaction.createdAt',
            messageId: '$insightsTransaction.messageId',
            model: '$insightsTransaction.model',
          },
        },
        { $sort: { createdAt: 1, transactionId: 1 } },
        {
          $group: {
            _id: { conversationId: '$conversationId', user: '$user', messageId: '$messageId' },
            model: { $last: '$model' },
          },
        },
      ]),
      Message.aggregate<ReplyOutcome>([
        ...messageScope(messageMatch, agentIds),
        {
          $project: {
            _id: 0,
            conversationId: 1,
            user: 1,
            messageId: 1,
            outcome: responseOutcome,
            rating: responseRating,
          },
        },
        // Replies are kept after the projection: an `isCreatedByUser` filter in the first stage
        // makes MongoDB choose the model index, which reads every agent's replies.
        { $match: { outcome: { $ne: null } } },
      ]),
      agentIds.length > 0
        ? getSavedVersions(mongoose, agentIds, options.tenantId)
        : Promise.resolve(undefined),
    ]);

    const days = new Map<string, TInsightsDailyPoint>();
    const firstDay = dateKey(from, timeZone);
    const lastDay = dateKey(to, timeZone);
    for (let key = firstDay; key <= lastDay; key = addCalendarDaysToKey(key, 1)) {
      addDay(days, key);
    }
    for (const row of conversationDays) addDay(days, row.date).conversations = row.conversations;
    const summary: TInsightsSummary = {
      totalUsers: userCount[0]?.total ?? 0,
      totalConversations: conversationDays.reduce((total, row) => total + row.conversations, 0),
      totalMessages: 0,
      totalTokens: 0,
      totalResponses: 0,
      completedResponses: 0,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: null,
      feedback: emptyFeedback(),
      spendUSD: null,
    };
    let lastUsed: Date | null = null;
    for (const row of messageDays) {
      const day = addDay(days, row.date);
      day.messages = row.messages;
      day.totalTokens = row.totalTokens;
      day.responses = row.responses;
      day.completedResponses = row.completedResponses;
      day.failedResponses = row.failedResponses;
      day.interruptedResponses = row.interruptedResponses;
      day.feedback = row.feedback;
      summary.totalMessages += row.messages;
      summary.totalTokens += row.totalTokens;
      summary.totalResponses += row.responses;
      summary.completedResponses += row.completedResponses;
      summary.failedResponses += row.failedResponses;
      summary.interruptedResponses += row.interruptedResponses;
      summary.feedback.thumbsUp += row.feedback.thumbsUp;
      summary.feedback.thumbsDown += row.feedback.thumbsDown;
      for (const [index, category] of row.feedback.categories.entries()) {
        summary.feedback.categories[index].count += category.count;
      }
      if (lastUsed == null || row.lastUsed > lastUsed) lastUsed = row.lastUsed;
    }
    summary.lastUsed = lastUsed?.toISOString() ?? null;
    const creditsByDay = new Map<string, number>();
    const models = new Map<string | null, TInsightsModel>();
    const creditsByModel = new Map<string | null, number>();
    const modelRow = (model: unknown) => {
      const key = modelKey(model);
      const current = models.get(key) ?? emptyModel(key);
      models.set(key, current);
      return current;
    };
    for (const row of spendRows) {
      creditsByDay.set(row.date, (creditsByDay.get(row.date) ?? 0) + row.credits);
      const model = modelRow(row.model);
      model.usageTokens += row.usageTokens;
      creditsByModel.set(model.model, (creditsByModel.get(model.model) ?? 0) + row.credits);
    }
    for (const [date, credits] of [...creditsByDay].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const spendUSD = credits / CREDITS_PER_USD;
      addDay(days, date).spendUSD = spendUSD;
      summary.spendUSD = (summary.spendUSD ?? 0) + spendUSD;
    }
    for (const [key, credits] of creditsByModel) {
      const model = models.get(key);
      if (model) model.spendUSD = credits / CREDITS_PER_USD;
    }
    const replyKey = ({ conversationId, user, messageId }: ReplyIdentity) =>
      JSON.stringify([conversationId, user, messageId]);
    const replyModels = new Map(replyModelRows.map((row) => [replyKey(row._id), row.model]));
    const assigned = emptyModel(null);
    for (const reply of replyRows) {
      const key = replyKey(reply);
      if (!replyModels.has(key)) continue;
      for (const target of [modelRow(replyModels.get(key)), assigned]) {
        target.responses += 1;
        if (reply.outcome === 'completed') target.completedResponses += 1;
        if (reply.outcome === 'failed') target.failedResponses += 1;
        if (reply.outcome === 'interrupted') target.interruptedResponses += 1;
        if (reply.rating === 'thumbsUp') target.thumbsUp += 1;
        if (reply.rating === 'thumbsDown') target.thumbsDown += 1;
      }
    }
    /** Replies without a completion usage row stay countable, so models add up to the totals. */
    const unassigned = {
      responses: Math.max(0, summary.totalResponses - assigned.responses),
      completedResponses: Math.max(0, summary.completedResponses - assigned.completedResponses),
      failedResponses: Math.max(0, summary.failedResponses - assigned.failedResponses),
      interruptedResponses: Math.max(
        0,
        summary.interruptedResponses - assigned.interruptedResponses,
      ),
      thumbsUp: Math.max(0, summary.feedback.thumbsUp - assigned.thumbsUp),
      thumbsDown: Math.max(0, summary.feedback.thumbsDown - assigned.thumbsDown),
    };
    if (Object.values(unassigned).some((count) => count > 0)) {
      const unknown = modelRow(null);
      unknown.responses += unassigned.responses;
      unknown.completedResponses += unassigned.completedResponses;
      unknown.failedResponses += unassigned.failedResponses;
      unknown.interruptedResponses += unassigned.interruptedResponses;
      unknown.thumbsUp += unassigned.thumbsUp;
      unknown.thumbsDown += unassigned.thumbsDown;
    }
    for (const row of dailyUsers) addDay(days, row.date).users = row.users;
    const totalConversations = summary.totalConversations;
    const aggregate: TInsightsAggregateResponse = {
      agents: options.agents ?? [],
      summary,
      daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      ...(agentVersions !== undefined && { agentVersions }),
      models: [...models.values()].sort(
        (left, right) =>
          Number(left.model == null) - Number(right.model == null) ||
          right.responses - left.responses ||
          (right.spendUSD ?? 0) - (left.spendUSD ?? 0) ||
          (left.model ?? '').localeCompare(right.model ?? ''),
      ),
    };
    if (!showDetails) {
      return aggregate;
    }

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
            ...messageScope({ ...messageMatch, user: { $in: topUserIds } }, agentIds),
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
      ...aggregate,
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
