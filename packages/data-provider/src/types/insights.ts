import type { TFeedbackRating, TFeedbackTagKey } from '../feedback';

export type InsightsRange = '24h' | '7d' | '30d' | 'custom';

export const INSIGHTS_MAX_RANGE_DAYS = 30;
export const INSIGHTS_COMMENT_LIMIT = 20;
export const INSIGHTS_COMMENT_LIMIT_MAX = 100;
export const INSIGHTS_SEARCH_MIN_LENGTH = 3;
export const INSIGHTS_SEARCH_MAX_LENGTH = 200;
export const INSIGHTS_AGENT_ID_MAX_LENGTH = 256;
export type TInsightsParams = {
  range?: InsightsRange;
  fromTimestamp?: string;
  toTimestamp?: string;
  timeZone?: string;
  search?: string;
  agentIds?: string[];
  allAgents?: boolean;
  page?: number;
  pageSize?: number;
};

export type TInsightsAgent = {
  id: string;
  name: string;
};

export type TInsightsAgentVersion = {
  agentId: string;
  version: number;
  savedAt: string | null;
  active: boolean;
};

export type TInsightsResponseOutcomes = {
  completedResponses: number;
  failedResponses: number;
  interruptedResponses: number;
};

export type TInsightsFeedback = {
  thumbsUp: number;
  thumbsDown: number;
  categories: { key: TFeedbackTagKey; count: number }[];
};

export type TInsightsDailyPoint = TInsightsResponseOutcomes & {
  date: string;
  conversations: number;
  users: number;
  messages: number;
  totalTokens: number;
  responses: number;
  feedback: TInsightsFeedback;
  spendUSD: number | null;
};

export type TInsightsUser = {
  userId: string;
  name: string;
  email: string;
  conversations: number;
  messages: number;
};

export type TInsightsChurnedUser = TInsightsUser & {
  firstSeen: string;
  lastSeen: string;
};

export type TInsightsConversation = {
  conversationId: string;
  agentId: string;
  agentName: string;
  date: string;
  userId: string;
  name: string;
  email: string;
  firstMessage: string;
  messages: number;
  totalTokens: number;
};

export type TInsightsSummary = TInsightsResponseOutcomes & {
  totalUsers: number;
  totalConversations: number;
  totalMessages: number;
  totalTokens: number;
  totalResponses: number;
  lastUsed: string | null;
  feedback: TInsightsFeedback;
  spendUSD: number | null;
};

export type TInsightsModel = TInsightsResponseOutcomes & {
  model: string | null;
  responses: number;
  thumbsUp: number;
  thumbsDown: number;
  usageTokens: number;
  spendUSD: number | null;
};

export type TInsightsComment = {
  agentId: string;
  agentName: string;
  date: string;
  rating: TFeedbackRating;
  tag: TFeedbackTagKey | null;
  text: string;
};

export type TInsightsSelectionResponse = {
  selectionRequired: true;
  agents: TInsightsAgent[];
};

export type TInsightsAggregateResponse = {
  agents: TInsightsAgent[];
  summary: TInsightsSummary;
  daily: TInsightsDailyPoint[];
  models: TInsightsModel[];
  comments?: TInsightsComment[];
  agentVersions?: TInsightsAgentVersion[];
};

type TInsightsDetailSections = {
  topUsers: TInsightsUser[];
  churnedUsers: TInsightsChurnedUser[];
  latest: {
    conversations: TInsightsConversation[];
    page: number;
    pageSize: number;
    pages: number;
  };
};

export type TInsightsResponse = TInsightsAggregateResponse & Partial<TInsightsDetailSections>;

export type TInsightsAccessResponse = {
  access: boolean;
};
