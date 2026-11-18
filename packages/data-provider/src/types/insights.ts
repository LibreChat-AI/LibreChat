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
  /** All agents the viewer may see: a flag, since thousands of IDs exceed the URL length. */
  allAgents?: boolean;
  page?: number;
  pageSize?: number;
};

export type TInsightsAgent = {
  id: string;
  name: string;
};

/** Existing saved version metadata, without configuration snapshots or editor identities. */
export type TInsightsAgentVersion = {
  agentId: string;
  version: number;
  savedAt: string | null;
  /** The version whose settings match the agent's current ones, as the version panel marks it. */
  active: boolean;
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
  /** Recorded usage spend; null when no eligible usage transactions exist. */
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
  /** Latest eligible message creation timestamp in the selected reporting period. */
  lastUsed: string | null;
  feedback: TInsightsFeedback;
  /** Recorded usage spend; null when no eligible usage transactions exist. */
  spendUSD: number | null;
};

/** Activity of the selected agents by the LLM model recorded on usage transactions. */
export type TInsightsModel = TInsightsResponseOutcomes & {
  /** Model name from usage transactions; null for replies or usage without a known model. */
  model: string | null;
  /** Replies counted once, under the model of their last completion usage row. */
  responses: number;
  thumbsUp: number;
  thumbsDown: number;
  /** Prompt (including cached prompt) and completion tokens recorded on usage transactions. */
  usageTokens: number;
  /** Recorded usage spend; null when no eligible usage transactions exist for the model. */
  spendUSD: number | null;
};

export type TInsightsAggregateResponse = {
  /** False when the viewer must choose agents before statistics load. */
  autoSelectAllAgents?: boolean;
  selectionRequired?: boolean;
  agents: TInsightsAgent[];
  summary: TInsightsSummary;
  daily: TInsightsDailyPoint[];
  models: TInsightsModel[];
  agentVersions?: TInsightsAgentVersion[];
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
