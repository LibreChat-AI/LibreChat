import type { TInsightsAggregateResponse, TInsightsResponse } from 'librechat-data-provider';

/** Only these aggregate fields may cross the API boundary when inspection is disabled. */
export function toAggregateInsightsResponse(
  insights: TInsightsResponse,
): TInsightsAggregateResponse {
  return {
    agents: insights.agents.map(({ id, name }) => ({ id, name })),
    summary: {
      totalUsers: insights.summary.totalUsers,
      totalConversations: insights.summary.totalConversations,
      totalMessages: insights.summary.totalMessages,
      totalTokens: insights.summary.totalTokens,
    },
    daily: insights.daily.map(({ date, conversations, users, messages, totalTokens }) => ({
      date,
      conversations,
      users,
      messages,
      totalTokens,
    })),
  };
}
