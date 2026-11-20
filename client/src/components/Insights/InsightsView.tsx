import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, Info, Minus, Search } from 'lucide-react';
import { Button, Input, MultiSelect, Spinner, TooltipAnchor } from '@librechat/client';
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
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import { useGetStartupConfig, useInsightsQuery } from '~/data-provider';
import { EmptyState, LoadingState, Panel, TablePanel } from './Panel';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { getVersionDays, getVersionMarks } from './versions';
import { LocalizedDateRangePicker } from '~/components/ui';
import { formatExactValue, formatValue } from './format';
import { getRollingDateRange } from './dateRange';
import FeedbackCategories from './Feedback';
import { getMetricCards } from './metrics';
import ModelsTable from './Models';
import { KpiCard } from './Card';
import { cn } from '~/utils';

type ShortcutRange = Exclude<InsightsRange, 'custom'>;
type Localize = ReturnType<typeof useLocalize>;
type CustomDateRange = { startDate: Date; endDate: Date };

const ranges: Array<{ value: ShortcutRange; labelKey: TranslationKeys; days: number }> = [
  { value: '24h', labelKey: 'com_insights_range_24_hours', days: 1 },
  { value: '7d', labelKey: 'com_insights_range_7_days', days: 7 },
  { value: '30d', labelKey: 'com_insights_range_30_days', days: 30 },
];
const dateRangeSelectionDelayMs = 350;
const searchDelayMs = 350;

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
  const response = insights.data;
  const selectionRequired = response != null && 'selectionRequired' in response;
  const data = selectionRequired ? undefined : response;
  const insightsStatus = responseStatus(insights.error);
  const isRecoveringAgentFilters = shouldRecoverAgentFilters(insightsStatus, selectedAgentIds);
  const agentItems = useMemo(() => {
    if (!response) {
      return [];
    }
    const duplicateNames = new Map<string, number>();
    for (const agent of response.agents) {
      duplicateNames.set(agent.name, (duplicateNames.get(agent.name) ?? 0) + 1);
    }
    return response.agents.map((agent) => ({
      value: agent.id,
      label:
        (duplicateNames.get(agent.name) ?? 0) > 1
          ? `${agent.name} (${agent.id.slice(-6)})`
          : agent.name,
    }));
  }, [response]);
  const effectiveAgentIds = useMemo(() => {
    if (selectedAgentIds.length > 0) return selectedAgentIds;
    if (selectionRequired) return [];
    return agentItems.map((agent) => agent.value);
  }, [agentItems, selectedAgentIds, selectionRequired]);
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

  const versionDays = useMemo(() => {
    if (!data?.agentVersions || effectiveAgentIds.length !== 1) return undefined;
    const versions = data.agentVersions.filter(({ agentId }) => agentId === effectiveAgentIds[0]);
    if (versions.length === 0) return undefined;
    return getVersionDays(data.daily, versions, timeZone);
  }, [data, effectiveAgentIds, timeZone]);

  const versionMarks = useMemo(
    () => (versionDays ? getVersionMarks(versionDays, localize) : undefined),
    [localize, versionDays],
  );
  const { kpiCards, outcomeCards, feedbackCards } = useMemo(
    () => getMetricCards(data, localize),
    [data, localize],
  );

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
    if (!response) {
      return;
    }
    if (agentIds.length === 0) {
      setPendingAgentIds([]);
      return;
    }
    setPendingAgentIds(null);
    const normalizedIds = [...new Set(agentIds)].sort();
    const allAgentIds = response.agents.map((agent) => agent.id).sort();
    const nextParams = clearAgentFilters(urlSearchParams);
    const everyAgent =
      allAgentIds.length > 1 &&
      normalizedIds.length === allAgentIds.length &&
      normalizedIds.every((agentId, index) => agentId === allAgentIds[index]);
    if (everyAgent) {
      nextParams.set('allAgents', 'true');
    } else {
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
          {response && (
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
          {selectionRequired && !insights.isPreviousData && (
            <Panel>
              <p className="text-text-secondary text-sm">
                {localize('com_insights_select_agents_to_load')}
              </p>
            </Panel>
          )}
          {data && !insights.isPreviousData && (
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
                <FeedbackCategories categories={data.summary.feedback.categories} locale={locale} />
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
