import { useMemo } from 'react';
import { FEEDBACK_TAGS } from 'librechat-data-provider';
import type { TInsightsFeedback } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { formatExactValue } from './format';
import { useLocalize } from '~/hooks';
import { Panel } from './Panel';

export default function FeedbackCategories({
  categories,
  locale,
}: {
  categories: TInsightsFeedback['categories'];
  locale: string;
}) {
  const localize = useLocalize();
  const recorded = useMemo(() => {
    const counts = new Map(categories.map(({ key, count }) => [key, count]));
    return FEEDBACK_TAGS.map(({ key, label }) => ({
      key,
      label,
      count: counts.get(key) ?? 0,
    })).filter(({ count }) => count > 0);
  }, [categories]);

  return (
    <Panel className="mt-3">
      <h3 className="mb-3 text-sm font-semibold">{localize('com_insights_feedback_categories')}</h3>
      {recorded.length === 0 ? (
        <p className="text-text-secondary text-sm">
          {localize('com_insights_no_feedback_categories')}
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {recorded.map(({ key, label, count }) => (
            <div key={key} className="flex items-start justify-between gap-4 text-sm">
              <dt>{localize(label as TranslationKeys)}</dt>
              <dd className="font-semibold tabular-nums">{formatExactValue(count, locale)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}
