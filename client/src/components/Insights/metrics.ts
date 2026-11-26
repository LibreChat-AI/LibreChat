import type { TInsightsDailyPoint, TInsightsResponse } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';
import type { KpiCardData } from './Card';

type MetricCards = Record<'kpiCards' | 'outcomeCards' | 'feedbackCards', KpiCardData[]>;

export function getMetricCards(
  data: TInsightsResponse | undefined,
  localize: ReturnType<typeof useLocalize>,
): MetricCards {
  if (!data) {
    return { kpiCards: [], outcomeCards: [], feedbackCards: [] };
  }
  const daily = (value: (row: TInsightsDailyPoint) => number) =>
    data.daily.map((row) => ({ date: row.date, value: value(row) }));
  return {
    kpiCards: [
      {
        id: 'conversations',
        title: localize('com_insights_total_conversations'),
        description: localize('com_insights_conversations_definition'),
        value: data.summary.totalConversations,
        sparkline: daily((row) => row.conversations),
      },
      {
        id: 'users',
        title: localize('com_insights_total_users'),
        value: data.summary.totalUsers,
        sparkline: daily((row) => row.users),
      },
      {
        id: 'messages',
        title: localize('com_insights_messages'),
        value: data.summary.totalMessages,
        sparkline: daily((row) => row.messages),
      },
      {
        id: 'tokens',
        title: localize('com_insights_total_tokens'),
        value: data.summary.totalTokens,
        sparkline: daily((row) => row.totalTokens),
      },
      {
        id: 'responses',
        title: localize('com_insights_responses'),
        value: data.summary.totalResponses,
        sparkline: daily((row) => row.responses),
      },
      {
        id: 'spend',
        title: localize('com_insights_spend'),
        description: localize('com_insights_spend_definition'),
        value: data.summary.spendUSD ?? 0,
        format: 'currency',
        sparkline: daily((row) => row.spendUSD ?? 0),
      },
    ],
    outcomeCards: [
      {
        id: 'completed',
        title: localize('com_insights_completed'),
        description: localize('com_insights_completed_definition'),
        value: data.summary.completedResponses,
        sparkline: daily((row) => row.completedResponses),
      },
      {
        id: 'failed',
        title: localize('com_insights_failed'),
        description: localize('com_insights_failed_definition'),
        value: data.summary.failedResponses,
        sparkline: daily((row) => row.failedResponses),
      },
      {
        id: 'interrupted',
        title: localize('com_insights_interrupted'),
        description: localize('com_insights_interrupted_definition'),
        value: data.summary.interruptedResponses,
        sparkline: daily((row) => row.interruptedResponses),
      },
    ],
    feedbackCards: [
      {
        id: 'thumbs-up',
        title: localize('com_insights_thumbs_up'),
        value: data.summary.feedback.thumbsUp,
        sparkline: daily((row) => row.feedback.thumbsUp),
      },
      {
        id: 'thumbs-down',
        title: localize('com_insights_thumbs_down'),
        value: data.summary.feedback.thumbsDown,
        sparkline: daily((row) => row.feedback.thumbsDown),
      },
    ],
  };
}
