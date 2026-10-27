import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import type {
  TInsightsAggregateResponse,
  TInsightsFeedback,
  TInsightsResponse,
} from 'librechat-data-provider';

function toAggregateFeedback(feedback: TInsightsFeedback): TInsightsFeedback {
  const counts = new Map(feedback.categories.map(({ key, count }) => [key, count]));
  return {
    thumbsUp: feedback.thumbsUp,
    thumbsDown: feedback.thumbsDown,
    categories: FEEDBACK_REASON_KEYS.map((key) => ({ key, count: counts.get(key) ?? 0 })),
  };
}

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
      feedback: toAggregateFeedback(insights.summary.feedback),
      spendUSD: insights.summary.spendUSD,
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
      feedback: toAggregateFeedback(day.feedback),
      spendUSD: day.spendUSD,
    })),
  };
}
