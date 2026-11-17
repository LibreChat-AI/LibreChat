import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, Info, Minus, Search } from 'lucide-react';
import { Button, Input, MultiSelect, Spinner, TooltipAnchor } from '@librechat/client';
import {
  FEEDBACK_REASON_KEYS,
  INSIGHTS_MAX_RANGE_DAYS,
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
} from 'librechat-data-provider';
import type {
  InsightsRange,
  TInsightsChurnedUser,
  TInsightsConversation,
  TInsightsModel,
  TInsightsParams,
  TInsightsUser,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { clearAgentFilters, shouldRecoverAgentFilters } from './agentFilters';
import { useGetStartupConfig, useInsightsQuery } from '~/data-provider';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { LocalizedDateRangePicker } from '~/components/ui';
import { getRollingDateRange } from './dateRange';
import { getVersionDays } from './versions';
import { cn } from '~/utils';

type ShortcutRange = Exclude<InsightsRange, 'custom'>;
type Localize = ReturnType<typeof useLocalize>;
type SparklinePoint = { date: string; value: number };
/** One entry per sparkline point: the agent version label for that day, and whether one was saved. */
type VersionMark = { label: string | null; saved: boolean; tag?: string };
type CustomDateRange = { startDate: Date; endDate: Date };

type KpiCardData = {
  id: string;
  title: string;
  description?: string;
  value: number;
  format?: 'currency';
  sparkline: SparklinePoint[];
};

const ranges: Array<{ value: ShortcutRange; labelKey: TranslationKeys; days: number }> = [
  { value: '24h', labelKey: 'com_insights_range_24_hours', days: 1 },
  { value: '7d', labelKey: 'com_insights_range_7_days', days: 7 },
  { value: '30d', labelKey: 'com_insights_range_30_days', days: 30 },
];
const dateRangeSelectionDelayMs = 350;
const searchDelayMs = 350;

function formatValue(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatExactValue(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatSpend(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    ...(value !== 0 && Math.abs(value) < 0.01
      ? { maximumSignificantDigits: 6 }
      : { maximumFractionDigits: 4 }),
  }).format(value);
}

function formatMetric(value: number, locale: string, format?: 'currency', compact = false) {
  if (format === 'currency') return formatSpend(value, locale);
  return compact ? formatValue(value, locale) : formatExactValue(value, locale);
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function formatRecentChatDate(value: string, locale: string) {
  const date = new Date(value);
  const now = new Date();
  const elapsedMinutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });

  if (elapsedMinutes < 1) {
    return relativeTime.format(0, 'minute');
  }
  if (elapsedMinutes < 60) {
    return relativeTime.format(-elapsedMinutes, 'minute');
  }
  if (elapsedMinutes < 24 * 60) {
    return relativeTime.format(-Math.floor(elapsedMinutes / 60), 'hour');
  }
  if (elapsedMinutes < 7 * 24 * 60) {
    return relativeTime.format(-Math.floor(elapsedMinutes / (24 * 60)), 'day');
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

function displayUserName(name: string, localize: Localize) {
  return name || localize('com_insights_unknown_user');
}

function responseStatus(error: unknown) {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function getShortcutDateRange(range: ShortcutRange) {
  const days = ranges.find((item) => item.value === range)?.days ?? 7;
  return getRollingDateRange(new Date(), days);
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        /** Click UI gives dashboard widgets their own surface and stroke, a step lighter
         *  than the page in dark mode; in light they match the page surface and light rule. */
        'border-chart-widget-stroke bg-chart-widget-surface min-w-0 rounded-lg border p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-text-secondary flex min-h-40 items-center justify-center text-sm">
      {message}
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <Panel className="flex min-h-52 flex-col items-center justify-center gap-3">
      <Spinner tone="secondary" className="size-7" />
      <span className="text-text-secondary text-sm">{message}</span>
    </Panel>
  );
}

/** Keeps a version tag inside the card when its line sits near either edge. */
function tagAlignment(position: number) {
  if (position < 8) return '';
  if (position > 92) return '-translate-x-full';
  return '-translate-x-1/2';
}

function Sparkline({
  values,
  label,
  locale,
  format,
  versionMarks,
}: {
  values: SparklinePoint[];
  label: string;
  locale: string;
  format?: 'currency';
  versionMarks?: VersionMark[];
}) {
  const patternId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState<number>();
  const points = useMemo(() => {
    if (values.length < 2) {
      return [];
    }
    const maximum = Math.max(0, ...values.map((point) => point.value)) || 1;
    return values.map((point, index) => ({
      ...point,
      x: (index / (values.length - 1)) * 300,
      y: 52 - (point.value / maximum) * 46,
    }));
  }, [values]);

  if (points.length < 2) {
    return <div className="h-14" />;
  }

  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `M 0 56 L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L 300 56 Z`;
  const activePoint = activeIndex == null ? undefined : points[activeIndex];
  const activeVersion = activeIndex == null ? undefined : versionMarks?.[activeIndex]?.label;
  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const savedVersions = points.flatMap((point, index) => {
    const mark = versionMarks?.[index];
    return mark?.saved && mark.label
      ? [
          {
            x: point.x,
            tag: mark.tag,
            description: `${formatter.format(new Date(point.date))}: ${mark.label}`,
          },
        ]
      : [];
  });

  return (
    <div
      dir="ltr"
      className={cn(
        'text-status-info relative h-14 w-full outline-hidden',
        savedVersions.length > 0 ? 'mt-7' : 'mt-2',
      )}
      role="img"
      tabIndex={0}
      aria-label={[label, ...savedVersions.map(({ description }) => description)].join('. ')}
      onFocus={() => setActiveIndex(points.length - 1)}
      onBlur={() => setActiveIndex(undefined)}
      onMouseLeave={() => setActiveIndex(undefined)}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        setActiveIndex(Math.round(ratio * (points.length - 1)));
      }}
    >
      <svg
        className="h-full w-full overflow-visible"
        viewBox="0 0 300 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse">
            <path
              d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5"
              stroke="currentColor"
              strokeWidth="0.8"
              opacity="0.22"
            />
          </pattern>
        </defs>
        <path d={area} fill={`url(#${patternId})`} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {savedVersions.map(({ x }) => (
          <line
            key={x}
            data-testid="insights-version-marker"
            className="text-text-secondary"
            x1={x}
            x2={x}
            y1={0}
            y2={56}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {savedVersions.map(({ x, tag }) => {
        const position = (x / 300) * 100;
        return tag ? (
          <span
            key={x}
            aria-hidden="true"
            className={cn(
              'text-text-secondary pointer-events-none absolute bottom-full mb-1 text-xs whitespace-nowrap',
              tagAlignment(position),
            )}
            style={{ left: `${position}%` }}
          >
            {tag}
          </span>
        ) : null;
      })}
      {activePoint && (
        <>
          <span
            className="bg-border-medium pointer-events-none absolute top-0 h-full w-px"
            style={{ left: `${(activePoint.x / 300) * 100}%` }}
          />
          <span
            className="bg-status-info ring-surface-primary pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{
              left: `${(activePoint.x / 300) * 100}%`,
              top: `${(activePoint.y / 56) * 100}%`,
            }}
          />
          <span
            className="border-border-light bg-surface-primary text-text-primary pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-lg border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg"
            style={{ left: `${Math.max(14, Math.min(86, (activePoint.x / 300) * 100))}%` }}
          >
            {formatter.format(new Date(activePoint.date))}{' '}
            <strong>{formatMetric(activePoint.value, locale, format)}</strong>
            {activeVersion && <span className="text-text-secondary block">{activeVersion}</span>}
          </span>
        </>
      )}
    </div>
  );
}

function KpiCard({
  card,
  locale,
  headingLevel: Heading = 'h2',
  versionMarks,
}: {
  card: KpiCardData;
  locale: string;
  headingLevel?: 'h2' | 'h3';
  versionMarks?: VersionMark[];
}) {
  const localize = useLocalize();
  return (
    <Panel>
      <Heading className="text-text-muted inline-flex items-center gap-1.5 text-sm font-normal">
        {card.title}
        {card.description && (
          <TooltipAnchor
            description={card.description}
            render={
              <button
                type="button"
                aria-label={card.description}
                className="text-text-muted hover:text-text-secondary"
              >
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
        )}
      </Heading>
      <div className="text-text-primary mt-3 text-4xl leading-none font-semibold break-words tabular-nums">
        {formatMetric(card.value, locale, card.format, true)}
      </div>
      <Sparkline
        values={card.sparkline}
        label={localize('com_insights_sparkline_accessibility', { label: card.title })}
        locale={locale}
        format={card.format}
        versionMarks={versionMarks}
      />
    </Panel>
  );
}

function TablePanel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Panel className="overflow-hidden">
      <h2 className="text-text-primary mb-3 text-base font-semibold">{title}</h2>
      {children}
    </Panel>
  );
}

function UserCell({ name, email, localize }: { name: string; email: string; localize: Localize }) {
  return (
    <div className="min-w-0">
      <div className="text-text-primary truncate">{displayUserName(name, localize)}</div>
      <div className="text-text-secondary truncate text-xs">{email}</div>
    </div>
  );
}

function TopUsersTable({
  rows,
  localize,
  locale,
}: {
  rows: TInsightsUser[];
  localize: Localize;
  locale: string;
}) {
  return (
    <TablePanel title={localize('com_insights_top_users')}>
      {rows.length === 0 ? (
        <EmptyState message={localize('com_insights_no_data')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26.25rem] text-start text-sm">
            <thead className="border-border-medium text-text-secondary border-b text-xs">
              <tr>
                <th className="px-2 py-2 font-medium">{localize('com_insights_user')}</th>
                <th className="px-2 py-2 text-end font-medium">
                  {localize('com_insights_messages')}
                </th>
                <th className="px-2 py-2 text-end font-medium">{localize('com_insights_chats')}</th>
              </tr>
            </thead>
            <tbody className="divide-border-light divide-y">
              {rows.map((entry) => (
                <tr key={entry.userId} className="hover:bg-surface-hover">
                  <td className="px-2 py-3">
                    <UserCell {...entry} localize={localize} />
                  </td>
                  <td className="px-2 py-3 text-end tabular-nums">
                    {formatExactValue(entry.messages, locale)}
                  </td>
                  <td className="px-2 py-3 text-end tabular-nums">
                    {formatExactValue(entry.conversations, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TablePanel>
  );
}

const modelColumns: Array<{
  labelKey: TranslationKeys;
  value: (row: TInsightsModel, locale: string) => string;
}> = [
  { labelKey: 'com_insights_responses', value: (row, l) => formatExactValue(row.responses, l) },
  {
    labelKey: 'com_insights_completed',
    value: (row, l) => formatExactValue(row.completedResponses, l),
  },
  { labelKey: 'com_insights_failed', value: (row, l) => formatExactValue(row.failedResponses, l) },
  {
    labelKey: 'com_insights_interrupted',
    value: (row, l) => formatExactValue(row.interruptedResponses, l),
  },
  { labelKey: 'com_insights_thumbs_up', value: (row, l) => formatExactValue(row.thumbsUp, l) },
  { labelKey: 'com_insights_thumbs_down', value: (row, l) => formatExactValue(row.thumbsDown, l) },
  {
    labelKey: 'com_insights_usage_tokens',
    value: (row, l) => formatExactValue(row.usageTokens, l),
  },
  { labelKey: 'com_insights_spend', value: (row, l) => formatSpend(row.spendUSD ?? 0, l) },
];

function ModelsTable({
  rows,
  localize,
  locale,
}: {
  rows: TInsightsModel[];
  localize: Localize;
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
                  {modelColumns.map(({ labelKey, value }) => (
                    <td key={labelKey} className="px-2 py-3 text-right tabular-nums">
                      {value(row, locale)}
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

function ChurnedUsersTable({
  rows,
  localize,
  locale,
}: {
  rows: TInsightsChurnedUser[];
  localize: Localize;
  locale: string;
}) {
  const definition = localize('com_insights_churned_users_definition');
  return (
    <TablePanel
      title={
        <span className="inline-flex items-center gap-1.5">
          {localize('com_insights_churned_users')}
          <TooltipAnchor
            description={definition}
            render={
              <button
                type="button"
                aria-label={definition}
                className="text-text-secondary hover:text-text-primary"
              >
                <Info className="size-4" aria-hidden="true" />
              </button>
            }
          />
        </span>
      }
    >
      {rows.length === 0 ? (
        <EmptyState message={localize('com_insights_no_data')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[35rem] table-fixed text-start text-sm">
            <thead className="border-border-medium text-text-secondary border-b text-xs">
              <tr>
                <th className="w-[34%] px-2 py-2 font-medium">{localize('com_insights_user')}</th>
                <th className="w-[12%] px-2 py-2 text-end font-medium">
                  {localize('com_insights_messages')}
                </th>
                <th className="w-[12%] px-2 py-2 text-end font-medium">
                  {localize('com_insights_chats')}
                </th>
                <th className="w-[21%] px-2 py-2 text-end font-medium">
                  {localize('com_insights_first_seen')}
                </th>
                <th className="w-[21%] px-2 py-2 text-end font-medium">
                  {localize('com_insights_last_seen')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-border-light divide-y">
              {rows.map((entry) => (
                <tr key={entry.userId} className="hover:bg-surface-hover">
                  <td className="overflow-hidden px-2 py-3">
                    <UserCell {...entry} localize={localize} />
                  </td>
                  <td className="px-2 py-3 text-end tabular-nums">
                    {formatExactValue(entry.messages, locale)}
                  </td>
                  <td className="px-2 py-3 text-end tabular-nums">
                    {formatExactValue(entry.conversations, locale)}
                  </td>
                  <td className="text-text-secondary px-2 py-3 text-end whitespace-nowrap">
                    {formatDate(entry.firstSeen, locale)}
                  </td>
                  <td className="text-text-secondary px-2 py-3 text-end whitespace-nowrap">
                    {formatDate(entry.lastSeen, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TablePanel>
  );
}

function LatestConversations({
  rows,
  search,
  activeSearch,
  page,
  pages,
  isFetching,
  setPage,
  setSearch,
  localize,
  locale,
}: {
  rows: TInsightsConversation[];
  search: string;
  activeSearch: string;
  page: number;
  pages: number;
  isFetching: boolean;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  localize: Localize;
  locale: string;
}) {
  return (
    <Panel className="overflow-hidden">
      <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">
            {localize('com_insights_latest_conversations')}
          </h2>
          {isFetching && <Spinner tone="secondary" className="size-4" />}
        </div>
        <div className="relative w-full sm:max-w-md">
          <Search
            className="text-text-secondary pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            aria-label={localize('com_insights_search_placeholder')}
            className="pl-9"
            maxLength={INSIGHTS_SEARCH_MAX_LENGTH}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={localize('com_insights_search_placeholder')}
            value={search}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56.25rem] table-fixed text-start text-sm">
          <thead className="border-border-medium text-text-secondary border-b text-xs">
            <tr>
              <th className="w-[7.5rem] px-2 py-2 font-medium">{localize('com_insights_date')}</th>
              <th className="w-[12rem] px-2 py-2 font-medium">{localize('com_insights_user')}</th>
              <th className="w-[10rem] px-2 py-2 font-medium">{localize('com_insights_agent')}</th>
              <th className="px-2 py-2 font-medium">{localize('com_insights_first_message')}</th>
              <th className="w-20 px-2 py-2 text-end font-medium">
                {localize('com_insights_messages')}
              </th>
              <th className="w-20 px-2 py-2 text-end font-medium">
                {localize('com_insights_total_tokens')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-border-light divide-y">
            {rows.map((conversation) => (
              <tr
                key={`${conversation.conversationId}:${conversation.userId}`}
                className="hover:bg-surface-hover"
              >
                <td className="text-text-secondary px-2 py-3 whitespace-nowrap">
                  {formatRecentChatDate(conversation.date, locale)}
                </td>
                <td className="px-2 py-3">
                  <UserCell {...conversation} localize={localize} />
                </td>
                <td className="text-text-secondary truncate px-2 py-3">{conversation.agentName}</td>
                <td className="max-w-xl px-2 py-3">
                  <span className="line-clamp-2">
                    {conversation.firstMessage || localize('com_insights_no_message')}
                  </span>
                </td>
                <td className="px-2 py-3 text-end tabular-nums">
                  {formatExactValue(conversation.messages, locale)}
                </td>
                <td className="px-2 py-3 text-end tabular-nums">
                  {formatValue(conversation.totalTokens, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <EmptyState
          message={
            activeSearch
              ? localize('com_insights_no_search_results')
              : localize('com_insights_no_data')
          }
        />
      )}
      <div className="border-border-light text-text-secondary mt-3 flex items-center justify-between gap-3 border-t pt-3 text-sm">
        <span>{localize('com_insights_page_of', { page, pages })}</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching || page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            {localize('com_ui_prev')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching || page >= pages}
            onClick={() => setPage((value) => value + 1)}
          >
            {localize('com_ui_next')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export default function InsightsView() {
  const localize = useLocalize();
  const sectionId = useId();
  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { user } = useAuthContext();
  const { data: startupConfig, isLoading: configLoading } = useGetStartupConfig();
  const [range, setRange] = useState<ShortcutRange>('7d');
  const [customDateRange, setCustomDateRange] = useState<CustomDateRange>();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pendingAgentIds, setPendingAgentIds] = useState<string[] | null>(null);
  const dateRangeSelectionTimeout = useRef<number>();
  const isSmallScreen = useDrawerViewport();
  const insightsFeatureEnabled = startupConfig?.insightsEnabled === true;
  const selectedAgentIds = useMemo(
    () => [...new Set(urlSearchParams.getAll('agentIds').filter(Boolean))].sort(),
    [urlSearchParams],
  );
  /** All agents chosen explicitly while admins start with nothing selected. */
  const allAgentsChosen = urlSearchParams.get('allAgents') === 'true';
  const insightsParams = useMemo<TInsightsParams>(() => {
    const params: TInsightsParams = { page, pageSize: 10, search, timeZone };
    if (selectedAgentIds.length > 0) {
      params.agentIds = selectedAgentIds;
    } else if (allAgentsChosen) {
      params.allAgents = true;
    }
    if (customDateRange) {
      return {
        ...params,
        range: 'custom',
        fromTimestamp: customDateRange.startDate.toISOString(),
        toTimestamp: customDateRange.endDate.toISOString(),
      };
    }
    return { ...params, range };
  }, [allAgentsChosen, customDateRange, page, range, search, selectedAgentIds, timeZone]);
  const displayDateRange = useMemo(
    () => customDateRange ?? getShortcutDateRange(range),
    [customDateRange, range],
  );
  const insights = useInsightsQuery(insightsParams, {
    enabled: !!user && insightsFeatureEnabled,
    retry: false,
  });
  const data = insights.data;
  const insightsStatus = responseStatus(insights.error);
  const isRecoveringAgentFilters = shouldRecoverAgentFilters(insightsStatus, selectedAgentIds);
  const agentItems = useMemo(() => {
    if (!data) {
      return [];
    }
    const duplicateNames = new Map<string, number>();
    for (const agent of data.agents) {
      duplicateNames.set(agent.name, (duplicateNames.get(agent.name) ?? 0) + 1);
    }
    return data.agents.map((agent) => ({
      value: agent.id,
      label:
        (duplicateNames.get(agent.name) ?? 0) > 1
          ? `${agent.name} (${agent.id.slice(-6)})`
          : agent.name,
    }));
  }, [data]);
  const effectiveAgentIds = useMemo(() => {
    if (selectedAgentIds.length > 0) return selectedAgentIds;
    if (data?.autoSelectAllAgents === false && !allAgentsChosen) return [];
    return agentItems.map((agent) => agent.value);
  }, [agentItems, allAgentsChosen, selectedAgentIds, data?.autoSelectAllAgents]);
  const displayedAgentIds = pendingAgentIds ?? effectiveAgentIds;

  useDocumentTitle(`${localize('com_insights_title')} | LibreChat`);

  useEffect(
    () => () => {
      if (dateRangeSelectionTimeout.current != null) {
        window.clearTimeout(dateRangeSelectionTimeout.current);
      }
    },
    [],
  );

  useEffect(() => {
    const trimmedSearch = searchInput.trim().slice(0, INSIGHTS_SEARCH_MAX_LENGTH);
    const nextSearch = trimmedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH ? trimmedSearch : '';
    if (nextSearch === search) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setSearch(nextSearch);
      setPage(1);
    }, searchDelayMs);
    return () => window.clearTimeout(timeout);
  }, [search, searchInput]);

  useEffect(() => {
    if (!isRecoveringAgentFilters) {
      return;
    }
    setUrlSearchParams(clearAgentFilters(urlSearchParams), { replace: true });
    setPage(1);
  }, [isRecoveringAgentFilters, setUrlSearchParams, urlSearchParams]);

  /** Version numbers only mean something within one agent, so marks need a single agent. */
  const versionDays = useMemo(() => {
    if (!data?.agentVersions || effectiveAgentIds.length !== 1) return undefined;
    const versions = data.agentVersions.filter(({ agentId }) => agentId === effectiveAgentIds[0]);
    if (versions.length === 0) return undefined;
    return getVersionDays(data.daily, versions, timeZone);
  }, [data, effectiveAgentIds, timeZone]);

  const versionMarks = useMemo<VersionMark[] | undefined>(() => {
    if (!versionDays) return undefined;
    return versionDays.map(({ inUse, saved, restored }) => {
      if (saved.length > 0) {
        return {
          saved: true,
          label: localize('com_insights_version_saved_marker', { versions: saved.join(', ') }),
          tag: saved
            .map((versionNumber) => localize('com_insights_version_tag', { versionNumber }))
            .join(', '),
        };
      }
      if (inUse == null) return { saved: false, label: null };
      return {
        saved: false,
        label: restored
          ? localize('com_insights_version_restored', { versionNumber: inUse })
          : localize('com_ui_agent_version_title', { versionNumber: inUse }),
      };
    });
  }, [localize, versionDays]);

  const kpiCards = useMemo<KpiCardData[]>(() => {
    if (!data) {
      return [];
    }
    return [
      {
        id: 'conversations',
        title: localize('com_insights_total_conversations'),
        description: localize('com_insights_conversations_definition'),
        value: data.summary.totalConversations,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.conversations })),
      },
      {
        id: 'users',
        title: localize('com_insights_total_users'),
        value: data.summary.totalUsers,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.users })),
      },
      {
        id: 'messages',
        title: localize('com_insights_messages'),
        value: data.summary.totalMessages,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.messages })),
      },
      {
        id: 'tokens',
        title: localize('com_insights_total_tokens'),
        value: data.summary.totalTokens,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.totalTokens })),
      },
      {
        id: 'responses',
        title: localize('com_insights_responses'),
        value: data.summary.totalResponses,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.responses })),
      },
      {
        id: 'spend',
        title: localize('com_insights_spend'),
        description: localize('com_insights_spend_definition'),
        value: data.summary.spendUSD ?? 0,
        format: 'currency',
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.spendUSD ?? 0 })),
      },
    ];
  }, [data, localize]);

  const outcomeCards = useMemo<KpiCardData[]>(() => {
    if (!data) return [];
    return [
      {
        id: 'completed',
        title: localize('com_insights_completed'),
        description: localize('com_insights_completed_definition'),
        value: data.summary.completedResponses,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.completedResponses })),
      },
      {
        id: 'failed',
        title: localize('com_insights_failed'),
        description: localize('com_insights_failed_definition'),
        value: data.summary.failedResponses,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.failedResponses })),
      },
      {
        id: 'interrupted',
        title: localize('com_insights_interrupted'),
        description: localize('com_insights_interrupted_definition'),
        value: data.summary.interruptedResponses,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.interruptedResponses })),
      },
    ];
  }, [data, localize]);

  const feedbackCards = useMemo<KpiCardData[]>(() => {
    if (!data) return [];
    return [
      {
        id: 'thumbs-up',
        title: localize('com_insights_thumbs_up'),
        value: data.summary.feedback.thumbsUp,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.feedback.thumbsUp })),
      },
      {
        id: 'thumbs-down',
        title: localize('com_insights_thumbs_down'),
        value: data.summary.feedback.thumbsDown,
        sparkline: data.daily.map((row) => ({ date: row.date, value: row.feedback.thumbsDown })),
      },
    ];
  }, [data, localize]);

  const feedbackCategories = useMemo(() => {
    const counts = new Map(data?.summary.feedback.categories.map(({ key, count }) => [key, count]));
    return FEEDBACK_REASON_KEYS.map((key) => ({ key, count: counts.get(key) ?? 0 })).filter(
      ({ count }) => count > 0,
    );
  }, [data]);

  const handleSelectDateRange = (startDate: Date, endDate: Date) => {
    if (dateRangeSelectionTimeout.current != null) {
      window.clearTimeout(dateRangeSelectionTimeout.current);
    }
    dateRangeSelectionTimeout.current = window.setTimeout(() => {
      setCustomDateRange({ startDate: new Date(startDate), endDate: new Date(endDate) });
      setPage(1);
      dateRangeSelectionTimeout.current = undefined;
    }, dateRangeSelectionDelayMs);
  };

  const handleAgentSelection = (agentIds: string[]) => {
    if (!data) {
      return;
    }
    if (agentIds.length === 0) {
      setPendingAgentIds([]);
      return;
    }
    setPendingAgentIds(null);
    const normalizedIds = [...new Set(agentIds)].sort();
    const allAgentIds = data.agents.map((agent) => agent.id).sort();
    const nextParams = clearAgentFilters(urlSearchParams);
    const everyAgent =
      allAgentIds.length > 1 &&
      normalizedIds.length === allAgentIds.length &&
      normalizedIds.every((agentId, index) => agentId === allAgentIds[index]);
    if (!everyAgent) {
      for (const agentId of normalizedIds) {
        nextParams.append('agentIds', agentId);
      }
    } else if (data.autoSelectAllAgents === false) {
      // An empty selection means "none" here, so All agents is a flag rather than every ID.
      nextParams.set('allAgents', 'true');
    }
    setUrlSearchParams(nextParams, { replace: true });
    setPage(1);
  };
  const allAgentsDisplayed =
    agentItems.length > 0 && displayedAgentIds.length === agentItems.length;
  const someAgentsDisplayed = displayedAgentIds.length > 0;

  if (
    configLoading ||
    (insightsFeatureEnabled && (insights.isLoading || isRecoveringAgentFilters))
  ) {
    return (
      <div className="bg-surface-primary-alt h-full w-full p-4">
        <LoadingState message={localize('com_insights_loading')} />
      </div>
    );
  }
  if (!insightsFeatureEnabled) {
    return <Navigate to="/c/new" replace />;
  }

  return (
    <div className="bg-surface-primary-alt text-text-primary flex h-full w-full min-w-0 flex-col">
      <header className="bg-surface-primary-alt z-20 flex min-h-14 w-full shrink-0 flex-col gap-3 px-4 py-3 sm:px-5 md:flex-row md:items-center md:justify-between md:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          {isSmallScreen && <OpenSidebar />}
          <h1 className="text-base font-semibold">{localize('com_insights_title')}</h1>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2 md:flex-nowrap">
          {data && (
            <MultiSelect
              placeholder={localize('com_ui_agents')}
              items={agentItems}
              selectedValues={displayedAgentIds}
              setSelectedValues={handleAgentSelection}
              onOpenChange={(open) => {
                if (!open) {
                  setPendingAgentIds(null);
                }
              }}
              disabled={agentItems.length <= 1 && displayedAgentIds.length > 0}
              showSelectedValues
              showItemCheckboxes
              virtualized={agentItems.length > 10}
              searchPlaceholder={
                agentItems.length > 10 ? localize('com_insights_search_agents') : undefined
              }
              searchEmptyText={localize('com_insights_no_agents_found')}
              className="w-full min-w-0 sm:w-72"
              selectClassName="h-8 w-full rounded border border-border-medium bg-surface-tertiary px-3 py-1 shadow-none hover:border-border-heavy data-[state=open]:border-border-heavy dark:hover:bg-chart-widget-stroke dark:data-[state=open]:bg-chart-widget-stroke"
              itemClassName="rounded-none px-4 py-1.5"
              popoverClassName="max-h-80 rounded border-border-medium px-0 py-2"
              surface="widget"
              renderSelectedValues={(values) => {
                if (values.length === 0) {
                  return localize('com_insights_no_agents_selected');
                }
                if (values.length === agentItems.length && agentItems.length > 1) {
                  return localize('com_insights_all_agents', { count: agentItems.length });
                }
                if (values.length === 1) {
                  return agentItems.find((agent) => agent.value === values[0])?.label ?? values[0];
                }
                return localize('com_insights_agents_selected', { count: values.length });
              }}
              popoverHeader={
                <div className="border-border-light border-b">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={
                      displayedAgentIds.length > 0
                        ? localize('com_ui_clear_all')
                        : localize('com_insights_select_all_agents')
                    }
                    className="text-text-primary h-10 w-full justify-start rounded-none px-4 font-medium"
                    onClick={() =>
                      handleAgentSelection(
                        displayedAgentIds.length > 0 ? [] : agentItems.map((agent) => agent.value),
                      )
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'border-border-xheavy flex size-4 shrink-0 items-center justify-center rounded-sm border',
                        displayedAgentIds.length > 0 && 'bg-surface-inverted text-text-inverted',
                      )}
                    >
                      {allAgentsDisplayed && <Check className="size-3.5" strokeWidth={2} />}
                      {someAgentsDisplayed && !allAgentsDisplayed && (
                        <Minus className="size-3.5" strokeWidth={2} />
                      )}
                    </span>
                    <span>{localize('com_insights_all_agents_label')}</span>
                    {displayedAgentIds.length > 0 &&
                      displayedAgentIds.length < agentItems.length && (
                        <span className="text-text-secondary">({displayedAgentIds.length})</span>
                      )}
                  </Button>
                </div>
              }
            />
          )}
          <div className="border-border-light inline-flex rounded-lg border p-0.5">
            {ranges.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant="ghost"
                aria-pressed={!customDateRange && range === item.value}
                className={cn(
                  'h-8 rounded-md',
                  !customDateRange && range === item.value && 'bg-surface-active-alt',
                )}
                onClick={() => {
                  if (dateRangeSelectionTimeout.current != null) {
                    window.clearTimeout(dateRangeSelectionTimeout.current);
                    dateRangeSelectionTimeout.current = undefined;
                  }
                  setRange(item.value);
                  setCustomDateRange(undefined);
                  setPage(1);
                }}
              >
                {localize(item.labelKey)}
              </Button>
            ))}
          </div>
          <div className="w-full min-w-0 sm:w-[21.25rem]">
            <LocalizedDateRangePicker
              endDate={displayDateRange.endDate}
              futureDatesDisabled
              labels={{
                apply: localize('com_ui_done'),
                cancel: localize('com_ui_cancel'),
                endDate: localize('com_insights_end_date'),
                invalidRange: localize('com_insights_invalid_date_range', {
                  days: INSIGHTS_MAX_RANGE_DAYS,
                }),
                startDate: localize('com_insights_start_date'),
              }}
              locale={locale}
              maxRangeLength={INSIGHTS_MAX_RANGE_DAYS}
              onSelectDateRange={handleSelectDateRange}
              placeholder={localize('com_insights_date_range_placeholder')}
              startDate={displayDateRange.startDate}
            />
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="flex w-full min-w-0 flex-col gap-3 px-8 pt-8 pb-4">
          {insights.isFetching && <LoadingState message={localize('com_insights_loading')} />}
          {insights.isError && (
            <Panel className="flex items-center gap-2">
              <AlertCircle className="text-status-error size-4" />
              <span className="text-sm">
                {insightsStatus === 403
                  ? localize('com_insights_forbidden')
                  : localize('com_insights_load_error')}
              </span>
            </Panel>
          )}
          {data?.selectionRequired && !insights.isPreviousData && (
            <Panel>
              <p className="text-text-secondary text-sm">
                {localize('com_insights_select_agents_to_load')}
              </p>
            </Panel>
          )}
          {data && !data.selectionRequired && !insights.isPreviousData && (
            <>
              <p className="text-text-secondary text-sm">
                {localize('com_insights_last_used')}{' '}
                {data.summary.lastUsed == null ? (
                  <span>{localize('com_insights_no_activity')}</span>
                ) : (
                  <time dateTime={data.summary.lastUsed}>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone,
                    }).format(new Date(data.summary.lastUsed))}
                  </time>
                )}
              </p>
              <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {kpiCards.map((card) => (
                  <KpiCard key={card.id} card={card} locale={locale} versionMarks={versionMarks} />
                ))}
              </div>
              <section aria-labelledby={`${sectionId}-outcomes`}>
                <h2 id={`${sectionId}-outcomes`} className="mb-3 text-base font-semibold">
                  {localize('com_insights_response_outcomes')}
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {outcomeCards.map((card) => (
                    <KpiCard
                      key={card.id}
                      card={card}
                      locale={locale}
                      headingLevel="h3"
                      versionMarks={versionMarks}
                    />
                  ))}
                </div>
              </section>
              <section aria-labelledby={`${sectionId}-feedback`}>
                <h2 id={`${sectionId}-feedback`} className="mb-3 text-base font-semibold">
                  {localize('com_insights_feedback')}
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {feedbackCards.map((card) => (
                    <KpiCard
                      key={card.id}
                      card={card}
                      locale={locale}
                      headingLevel="h3"
                      versionMarks={versionMarks}
                    />
                  ))}
                </div>
                <Panel className="mt-3">
                  <h3 className="mb-3 text-sm font-semibold">
                    {localize('com_insights_feedback_categories')}
                  </h3>
                  {feedbackCategories.length === 0 ? (
                    <p className="text-text-secondary text-sm">
                      {localize('com_insights_no_feedback_categories')}
                    </p>
                  ) : (
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                      {feedbackCategories.map(({ key, count }) => (
                        <div key={key} className="flex items-start justify-between gap-4 text-sm">
                          <dt>{localize(`com_ui_feedback_tag_${key}`)}</dt>
                          <dd className="font-semibold tabular-nums">
                            {formatExactValue(count, locale)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </Panel>
              </section>
              <ModelsTable rows={data.models} localize={localize} locale={locale} />
              {(data.topUsers || data.churnedUsers) && (
                <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,36.25rem),1fr))] gap-3">
                  {data.topUsers && (
                    <TopUsersTable rows={data.topUsers} localize={localize} locale={locale} />
                  )}
                  {data.churnedUsers && (
                    <ChurnedUsersTable
                      rows={data.churnedUsers}
                      localize={localize}
                      locale={locale}
                    />
                  )}
                </div>
              )}
              {data.latest && (
                <LatestConversations
                  rows={data.latest.conversations}
                  search={searchInput}
                  activeSearch={search}
                  page={data.latest.page}
                  pages={data.latest.pages}
                  isFetching={insights.isFetching}
                  setPage={setPage}
                  setSearch={setSearchInput}
                  localize={localize}
                  locale={locale}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
