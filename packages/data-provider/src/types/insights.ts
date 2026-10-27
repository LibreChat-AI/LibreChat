import type { TFeedbackTagKey } from '../feedback';

export type InsightsRange = '24h' | '7d' | '30d' | 'custom';

export const INSIGHTS_MAX_RANGE_DAYS = 30;
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
  page?: number;
  pageSize?: number;
};

export type TInsightsAgent = {
  id: string;
  name: string;
};

export type TInsightsResponseOutcomes = {
  completedResponses: number;
  failedResponses: number;
  /** Responses marked unfinished, including cancellations and partial responses. */
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
  /** Latest eligible message creation timestamp in the selected reporting period. */
  lastUsed: string | null;
  feedback: TInsightsFeedback;
};

export type TInsightsAggregateResponse = {
  agents: TInsightsAgent[];
  summary: TInsightsSummary;
  daily: TInsightsDailyPoint[];
};

export type TInsightsDetailSections = {
  topUsers: TInsightsUser[];
  churnedUsers: TInsightsChurnedUser[];
  latest: {
    conversations: TInsightsConversation[];
    page: number;
    pageSize: number;
    pages: number;
  };
};

export type TInsightsDetailedResponse = TInsightsAggregateResponse & TInsightsDetailSections;
export type TInsightsResponse = TInsightsAggregateResponse & Partial<TInsightsDetailSections>;

export type TInsightsAccessResponse = {
  access: boolean;
};
