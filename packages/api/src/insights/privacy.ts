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
      totalResponses: insights.summary.totalResponses,
      completedResponses: insights.summary.completedResponses,
      failedResponses: insights.summary.failedResponses,
      interruptedResponses: insights.summary.interruptedResponses,
      lastUsed: insights.summary.lastUsed,
    },
    daily: insights.daily.map((day) => ({
      date: day.date,
      conversations: day.conversations,
      users: day.users,
      messages: day.messages,
      totalTokens: day.totalTokens,
      responses: day.responses,
      completedResponses: day.completedResponses,
      failedResponses: day.failedResponses,
      interruptedResponses: day.interruptedResponses,
    })),
  };
}
