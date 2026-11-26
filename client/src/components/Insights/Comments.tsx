import { useMemo } from 'react';
import { ThumbDownIcon, ThumbUpIcon } from '@librechat/client';
import type { TInsightsComment } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { Panel } from './Panel';

export default function FeedbackComments({
  comments,
  locale,
}: {
  comments: TInsightsComment[];
  locale: string;
}) {
  const localize = useLocalize();
  const dates = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale]);

  return (
    <Panel className="mt-3">
      <h3 className="mb-3 text-sm font-semibold">{localize('com_insights_feedback_comments')}</h3>
      {comments.length === 0 ? (
        <p className="text-text-secondary text-sm">
          {localize('com_insights_no_feedback_comments')}
        </p>
      ) : (
        <ul className="divide-border-light divide-y">
          {comments.map(({ agentName, date, rating, text }, index) => {
            const positive = rating === 'thumbsUp';
            const Icon = positive ? ThumbUpIcon : ThumbDownIcon;
            const details = [agentName, dates.format(new Date(date))].filter(Boolean);
            return (
              <li key={`${date}-${index}`} className="flex gap-3 py-3 text-sm first:pt-0 last:pb-0">
                <span
                  role="img"
                  aria-label={localize(
                    positive ? 'com_ui_feedback_positive' : 'com_ui_feedback_negative',
                  )}
                  className="text-text-secondary mt-0.5 shrink-0"
                >
                  <Icon size="1rem" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words whitespace-pre-wrap">{text}</p>
                  <p className="text-text-secondary mt-1 text-xs">{details.join(' · ')}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
