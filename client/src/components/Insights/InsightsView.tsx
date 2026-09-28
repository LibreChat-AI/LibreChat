import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, Info, Minus, Search } from 'lucide-react';
import {
  Button,
  Input,
  MultiSelect,
  Spinner,
  TooltipAnchor,
  useMediaQuery,
} from '@librechat/client';
import {
  INSIGHTS_MAX_RANGE_DAYS,
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
} from 'librechat-data-provider';
import type {
  InsightsRange,
  TInsightsChurnedUser,
  TInsightsConversation,
  TInsightsParams,
  TInsightsUser,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { clearAgentFilters, shouldRecoverAgentFilters } from './agentFilters';
import { useGetStartupConfig, useInsightsQuery } from '~/data-provider';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { LocalizedDateRangePicker } from '~/components/ui';
import { getRollingDateRange } from './dateRange';
import { cn } from '~/utils';

type ShortcutRange = Exclude<InsightsRange, 'custom'>;
type Localize = ReturnType<typeof useLocalize>;
type SparklinePoint = { date: string; value: number };
type CustomDateRange = { startDate: Date; endDate: Date };

type KpiCardData = {
  id: 'conversations' | 'users' | 'messages' | 'tokens';
  title: string;
  description?: string;
  value: number;
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
        'min-w-0 rounded-lg border border-border-light bg-surface-primary p-5',
        /** Dark mode only: Click UI gives dashboard widgets their own surface and
         *  stroke, a step lighter than the page behind them. Light mode keeps the
         *  shared surface/border tokens. */
        'dark:border-chart-widget-stroke dark:bg-chart-widget-surface',
        className,
      )}
    >
      {children}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center text-sm text-text-secondary">
      {message}
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <Panel className="flex min-h-52 flex-col items-center justify-center gap-3">
      <Spinner className="size-7 text-text-secondary" />
      <span className="text-sm text-text-secondary">{message}</span>
    </Panel>
  );
}

function Sparkline({
  values,
  label,
  locale,
}: {
  values: SparklinePoint[];
  label: string;
  locale: string;
}) {
  const patternId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState<number>();
  const points = useMemo(() => {
    if (values.length < 2) {
      return [];
    }
    const maximum = Math.max(1, ...values.map((point) => point.value));
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
  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div
      className="relative mt-2 h-14 w-full text-status-info outline-none"
      role="img"
      tabIndex={0}
      aria-label={label}
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
      </svg>
      {activePoint && (
        <>
          <span
            className="pointer-events-none absolute top-0 h-full w-px bg-border-medium"
            style={{ left: `${(activePoint.x / 300) * 100}%` }}
          />
          <span
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-status-info ring-2 ring-surface-primary"
            style={{
              left: `${(activePoint.x / 300) * 100}%`,
              top: `${(activePoint.y / 56) * 100}%`,
            }}
          />
          <span
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border-light bg-surface-primary px-2.5 py-1.5 text-xs text-text-primary shadow-lg"
            style={{ left: `${Math.max(14, Math.min(86, (activePoint.x / 300) * 100))}%` }}
          >
            {formatter.format(new Date(activePoint.date))}{' '}
            <strong>{formatExactValue(activePoint.value, locale)}</strong>
          </span>
        </>
      )}
    </div>
  );
}

function KpiCard({ card, locale }: { card: KpiCardData; locale: string }) {
  const localize = useLocalize();
  return (
    <Panel>
      <h2 className="inline-flex items-center gap-1.5 text-sm font-normal text-text-muted">
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
      </h2>
      <div className="mt-3 text-4xl font-semibold tabular-nums leading-none text-text-primary">
        {formatValue(card.value, locale)}
      </div>
      <Sparkline
        values={card.sparkline}
        label={localize('com_insights_sparkline_accessibility', { label: card.title })}
        locale={locale}
      />
    </Panel>
  );
}

function TablePanel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Panel className="overflow-hidden">
      <h2 className="mb-3 text-base font-semibold text-text-primary">{title}</h2>
      {children}
    </Panel>
  );
}

function UserCell({ name, email, localize }: { name: string; email: string; localize: Localize }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-text-primary">{displayUserName(name, localize)}</div>
      <div className="truncate text-xs text-text-secondary">{email}</div>
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
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead className="border-b border-border-medium text-xs text-text-secondary">
              <tr>
                <th className="px-2 py-2 font-medium">{localize('com_insights_user')}</th>
                <th className="px-2 py-2 text-right font-medium">
                  {localize('com_insights_messages')}
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  {localize('com_insights_chats')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light">
              {rows.map((entry) => (
                <tr key={entry.userId} className="hover:bg-surface-hover">
                  <td className="px-2 py-3">
                    <UserCell {...entry} localize={localize} />
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatExactValue(entry.messages, locale)}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">
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
          <table className="w-full min-w-[560px] table-fixed text-left text-sm">
            <thead className="border-b border-border-medium text-xs text-text-secondary">
              <tr>
                <th className="w-[34%] px-2 py-2 font-medium">{localize('com_insights_user')}</th>
                <th className="w-[12%] px-2 py-2 text-right font-medium">
                  {localize('com_insights_messages')}
                </th>
                <th className="w-[12%] px-2 py-2 text-right font-medium">
                  {localize('com_insights_chats')}
                </th>
                <th className="w-[21%] px-2 py-2 text-right font-medium">
                  {localize('com_insights_first_seen')}
                </th>
                <th className="w-[21%] px-2 py-2 text-right font-medium">
                  {localize('com_insights_last_seen')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light">
              {rows.map((entry) => (
                <tr key={entry.userId} className="hover:bg-surface-hover">
                  <td className="overflow-hidden px-2 py-3">
                    <UserCell {...entry} localize={localize} />
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatExactValue(entry.messages, locale)}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatExactValue(entry.conversations, locale)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right text-text-secondary">
                    {formatDate(entry.firstSeen, locale)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right text-text-secondary">
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
          {isFetching && <Spinner className="size-4 text-text-secondary" />}
        </div>
        <div className="relative w-full sm:max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
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
        <table className="w-full min-w-[900px] table-fixed text-left text-sm">
          <thead className="border-b border-border-medium text-xs text-text-secondary">
            <tr>
              <th className="w-[120px] px-2 py-2 font-medium">{localize('com_insights_date')}</th>
              <th className="w-[192px] px-2 py-2 font-medium">{localize('com_insights_user')}</th>
              <th className="w-[160px] px-2 py-2 font-medium">{localize('com_insights_agent')}</th>
              <th className="px-2 py-2 font-medium">{localize('com_insights_first_message')}</th>
              <th className="w-20 px-2 py-2 text-right font-medium">
                {localize('com_insights_messages')}
              </th>
              <th className="w-20 px-2 py-2 text-right font-medium">
                {localize('com_insights_total_tokens')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-light">
            {rows.map((conversation) => (
              <tr
                key={`${conversation.conversationId}:${conversation.userId}`}
                className="hover:bg-surface-hover"
              >
                <td className="whitespace-nowrap px-2 py-3 text-text-secondary">
                  {formatRecentChatDate(conversation.date, locale)}
                </td>
                <td className="px-2 py-3">
                  <UserCell {...conversation} localize={localize} />
                </td>
                <td className="truncate px-2 py-3 text-text-secondary">{conversation.agentName}</td>
                <td className="max-w-xl px-2 py-3">
                  <span className="line-clamp-2">
                    {conversation.firstMessage || localize('com_insights_no_message')}
                  </span>
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
                  {formatExactValue(conversation.messages, locale)}
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
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
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-light pt-3 text-sm text-text-secondary">
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
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const insightsFeatureEnabled = startupConfig?.insightsEnabled === true;
  const selectedAgentIds = useMemo(
    () => [...new Set(urlSearchParams.getAll('agentIds').filter(Boolean))].sort(),
    [urlSearchParams],
  );
  const insightsParams = useMemo<TInsightsParams>(() => {
    const params: TInsightsParams = {
      page,
      pageSize: 10,
      search,
      timeZone,
      ...(selectedAgentIds.length > 0 ? { agentIds: selectedAgentIds } : {}),
    };
    if (customDateRange) {
      return {
        ...params,
        range: 'custom',
        fromTimestamp: customDateRange.startDate.toISOString(),
        toTimestamp: customDateRange.endDate.toISOString(),
      };
    }
    return { ...params, range };
  }, [customDateRange, page, range, search, selectedAgentIds, timeZone]);
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
  const effectiveAgentIds = useMemo(
    () => (selectedAgentIds.length > 0 ? selectedAgentIds : agentItems.map((agent) => agent.value)),
    [agentItems, selectedAgentIds],
  );
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
    ];
  }, [data, localize]);

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
    const nextParams = new URLSearchParams(urlSearchParams);
    nextParams.delete('agentIds');
    if (
      normalizedIds.length !== allAgentIds.length ||
      normalizedIds.some((agentId, index) => agentId !== allAgentIds[index])
    ) {
      for (const agentId of normalizedIds) {
        nextParams.append('agentIds', agentId);
      }
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
      <div className="h-full w-full bg-presentation p-4">
        <LoadingState message={localize('com_insights_loading')} />
      </div>
    );
  }
  if (!insightsFeatureEnabled) {
    return <Navigate to="/c/new" replace />;
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-presentation text-text-primary">
      <header className="z-20 flex min-h-14 w-full flex-shrink-0 flex-col gap-3 border-b border-border-light bg-presentation px-4 py-3 sm:px-5 md:flex-row md:items-center md:justify-between md:px-6 lg:px-8">
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
              disabled={agentItems.length <= 1}
              showSelectedValues
              showItemCheckboxes
              searchPlaceholder={
                agentItems.length > 10 ? localize('com_insights_search_agents') : undefined
              }
              searchEmptyText={localize('com_insights_no_agents_found')}
              className="w-full min-w-0 sm:w-72"
              selectClassName="h-8 w-full rounded border border-border-medium bg-surface-tertiary px-3 py-1 shadow-none hover:border-border-heavy data-[state=open]:border-border-heavy dark:hover:bg-chart-widget-stroke dark:data-[state=open]:bg-chart-widget-stroke"
              itemClassName="rounded-none px-4 py-1.5"
              popoverClassName="max-h-80 rounded border-border-medium bg-surface-primary px-0 py-2 dark:bg-chart-widget-surface"
              renderSelectedValues={(values) => {
                if (values.length === 0) {
                  return localize('com_insights_no_agents_selected');
                }
                if (values.length === agentItems.length) {
                  return localize('com_insights_all_agents', { count: agentItems.length });
                }
                if (values.length === 1) {
                  return agentItems.find((agent) => agent.value === values[0])?.label ?? values[0];
                }
                return localize('com_insights_agents_selected', { count: values.length });
              }}
              popoverHeader={
                <div className="border-b border-border-light">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={
                      displayedAgentIds.length > 0
                        ? localize('com_ui_clear_all')
                        : localize('com_insights_select_all_agents')
                    }
                    className="h-10 w-full justify-start gap-2 rounded-none px-4 font-medium text-text-primary hover:bg-surface-hover"
                    onClick={() =>
                      handleAgentSelection(
                        displayedAgentIds.length > 0 ? [] : agentItems.map((agent) => agent.value),
                      )
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-xheavy',
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
          <div className="inline-flex rounded-lg border border-border-light p-0.5">
            {ranges.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant="ghost"
                aria-pressed={!customDateRange && range === item.value}
                className={cn(
                  'h-8 rounded-md px-3',
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
          <div className="w-full min-w-0 sm:w-[340px]">
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
      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex w-full min-w-0 flex-col gap-3 px-8 pb-4 pt-8">
          {insights.isLoading && <LoadingState message={localize('com_insights_loading')} />}
          {insights.isError && (
            <Panel className="flex items-center gap-2">
              <AlertCircle className="size-4 text-status-error" />
              <span className="text-sm">
                {insightsStatus === 403
                  ? localize('com_insights_forbidden')
                  : localize('com_insights_load_error')}
              </span>
            </Panel>
          )}
          {data && (
            <>
              {/** Use explicit responsive counts: one column on narrow screens,
               *  two through mid-range, and four at xl. This avoids auto-fit's
               *  three-plus-one orphan without making mobile cards too narrow. */}
              <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {kpiCards.map((card) => (
                  <KpiCard key={card.id} card={card} locale={locale} />
                ))}
              </div>
              <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,580px),1fr))] gap-3">
                <TopUsersTable rows={data.topUsers} localize={localize} locale={locale} />
                <ChurnedUsersTable rows={data.churnedUsers} localize={localize} locale={locale} />
              </div>
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
            </>
          )}
        </div>
      </main>
    </div>
  );
}
