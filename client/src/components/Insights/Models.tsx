import type { TInsightsModel } from 'librechat-data-provider';
import type { TranslationKeys, useLocalize } from '~/hooks';
import { EmptyState, TablePanel } from './Panel';
import { formatMetric } from './format';

const modelColumns: Array<{
  labelKey: TranslationKeys;
  value: (row: TInsightsModel) => number;
  format?: 'currency';
}> = [
  { labelKey: 'com_insights_responses', value: (row) => row.responses },
  { labelKey: 'com_insights_completed', value: (row) => row.completedResponses },
  { labelKey: 'com_insights_failed', value: (row) => row.failedResponses },
  { labelKey: 'com_insights_interrupted', value: (row) => row.interruptedResponses },
  { labelKey: 'com_insights_thumbs_up', value: (row) => row.thumbsUp },
  { labelKey: 'com_insights_thumbs_down', value: (row) => row.thumbsDown },
  { labelKey: 'com_insights_usage_tokens', value: (row) => row.usageTokens },
  { labelKey: 'com_insights_spend', value: (row) => row.spendUSD ?? 0, format: 'currency' },
];

export default function ModelsTable({
  rows,
  localize,
  locale,
}: {
  rows: TInsightsModel[];
  localize: ReturnType<typeof useLocalize>;
  locale: string;
}) {
  return (
    <TablePanel title={localize('com_insights_models')}>
      <p className="text-text-secondary -mt-1 mb-3 text-sm">
        {localize('com_insights_models_definition')}
      </p>
      {rows.length === 0 ? (
        <EmptyState message={localize('com_insights_no_data')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[50rem] text-left text-sm">
            <thead className="border-border-medium text-text-secondary border-b text-xs">
              <tr>
                <th className="px-2 py-2 font-medium">{localize('com_insights_model')}</th>
                {modelColumns.map(({ labelKey }) => (
                  <th key={labelKey} className="px-2 py-2 text-right font-medium">
                    {localize(labelKey)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border-light divide-y">
              {rows.map((row, index) => (
                <tr key={row.model ?? `unknown-${index}`} className="hover:bg-surface-hover">
                  <td className="max-w-[16rem] truncate px-2 py-3" title={row.model ?? undefined}>
                    {row.model ?? (
                      <span className="text-text-secondary">
                        {localize('com_insights_unknown_model')}
                      </span>
                    )}
                  </td>
                  {modelColumns.map(({ labelKey, value, format }) => (
                    <td key={labelKey} className="px-2 py-3 text-right tabular-nums">
                      {formatMetric(value(row), locale, format)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TablePanel>
  );
}
