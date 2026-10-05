import type { TMediaInsights } from 'librechat-data-provider';
import { mediaOperationLabels } from '~/components/Media/labels';
import { formatExactValue, formatMoney } from './format';
import { PaginationFooter } from './Pagination';
import { Panel, EmptyState } from './Panel';
import { useLocalize } from '~/hooks';

export default function MediaInsights({
  data,
  isFetching,
  onPage,
  locale,
}: {
  data: TMediaInsights;
  locale: string;
  isFetching: boolean;
  onPage(page: number): void;
}) {
  const localize = useLocalize();
  const totals = [
    ['com_insights_media_submitted', data.summary.submitted],
    ['com_insights_media_completed', data.summary.completed],
    ['com_insights_media_failed', data.summary.failed],
    ['com_insights_media_cancelled', data.summary.cancelled],
    ['com_insights_media_uncertain', data.summary.uncertain],
    ['com_insights_media_active', data.summary.active],
  ] as const;
  return (
    <Panel aria-labelledby="media-insights-title">
      <h2 id="media-insights-title" className="text-base font-semibold">
        {localize('com_insights_media_title')}
      </h2>
      <p className="text-text-secondary mt-1 text-sm">{localize('com_insights_media_scope')}</p>
      <dl className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {totals.map(([key, value]) => (
          <div key={key}>
            <dt className="text-text-secondary text-sm">{localize(key)}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {formatExactValue(value, locale)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-text-secondary mb-3 text-sm">
        {localize('com_insights_media_cost_summary', {
          provider: formatMoney(data.summary.providerCostUSD, locale),
          tokens: formatMoney(data.summary.tokenCostUSD, locale),
          estimate: formatMoney(data.summary.estimatedCostUSD, locale),
          operator: formatMoney(data.summary.operatorCostUSD, locale),
          unclassified: formatMoney(data.summary.unclassifiedCostUSD, locale),
          unknown: formatExactValue(data.summary.unknownCostJobs, locale),
        })}
      </p>
      {data.summary.balanceCostJobs > 0 && (
        <p className="text-text-secondary mb-3 text-sm">
          {localize('com_insights_media_credits_summary', {
            credits: formatExactValue(data.summary.creditsCharged, locale),
          })}
        </p>
      )}
      {data.summary.unbilledJobs > 0 && (
        <p className="text-text-secondary mb-3 text-sm">
          {localize('com_insights_media_unbilled', { count: data.summary.unbilledJobs })}
        </p>
      )}
      {data.summary.submitted === 0 ? (
        <EmptyState message={localize('com_insights_no_data')} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{localize('com_insights_media_title')}</caption>
              <thead className="border-border-medium text-text-secondary border-b">
                <tr>
                  {(
                    [
                      'com_insights_media_provider',
                      'com_insights_media_model',
                      'com_insights_media_operation',
                      'com_insights_media_submitted',
                      'com_insights_media_completed',
                      'com_insights_media_failed',
                      'com_insights_media_cancelled',
                      'com_insights_media_active',
                      'com_insights_media_uncertain',
                      'com_insights_media_provider_cost',
                      'com_insights_media_token_cost',
                      'com_insights_media_credits',
                      'com_insights_media_operator_cost',
                      'com_insights_media_estimated_cost',
                      'com_insights_media_legacy_cost',
                      'com_insights_media_unknown_cost',
                    ] as const
                  ).map((key) => (
                    <th
                      scope="col"
                      key={key}
                      className={`px-2 py-2 font-medium whitespace-nowrap ${['com_insights_media_provider', 'com_insights_media_model', 'com_insights_media_operation'].includes(key) ? '' : 'text-right'}`}
                    >
                      {localize(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-border-light divide-y">
                {data.offerings.map((row) => (
                  <tr key={JSON.stringify([row.provider, row.model, row.operation])}>
                    <td className="px-2 py-3">{row.provider}</td>
                    <td className="px-2 py-3">{row.model}</td>
                    <td className="px-2 py-3 whitespace-nowrap">
                      {localize(mediaOperationLabels[row.operation])}
                    </td>
                    {[
                      row.submitted,
                      row.completed,
                      row.failed,
                      row.cancelled,
                      row.active,
                      row.uncertain,
                    ].map((value, index) => (
                      <td key={index} className="px-2 py-3 text-right tabular-nums">
                        {formatExactValue(value, locale)}
                      </td>
                    ))}
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.providerCostUSD, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.tokenCostUSD, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatExactValue(row.creditsCharged, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.operatorCostUSD, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.estimatedCostUSD, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.unclassifiedCostUSD, locale)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatExactValue(row.unknownCostJobs, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationFooter
            page={data.page}
            pages={data.pages}
            isFetching={isFetching}
            onPage={onPage}
          />
        </>
      )}
    </Panel>
  );
}
