import { useId, useRef, useMemo, useState, useEffect, useCallback, useDeferredValue } from 'react';
import axios from 'axios';
import { useAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService, resolveTraceViewerConfig } from 'librechat-data-provider';
import { Button, Spinner, EmptyState, FilterInput, buttonVariants } from '@librechat/client';
import {
  X,
  Clock,
  Layers,
  ZoomIn,
  ZoomOut,
  RefreshCw,
  ExternalLink,
  ChevronsUpDown,
  ChevronsDownUp,
  TriangleAlert,
  ChartNoAxesGantt,
} from 'lucide-react';
import type {
  TMessage,
  TTraceRecord,
  TTraceErrorCode,
  TTraceErrorResponse,
} from 'librechat-data-provider';
import type { KeyboardEvent } from 'react';
import type { TraceNode, TraceWindow } from './model';
import type { TranslationKeys } from '~/hooks';
import {
  keepNewestTracePage,
  useGetStartupConfig,
  useGetLangfuseSessionLinkQuery,
  useConversationTraceRecordsQuery,
} from '~/data-provider';
import {
  boundsOf,
  ZOOM_STEP,
  zoomWindow,
  flattenRows,
  minimumSpan,
  rebaseWindow,
  buildTraceModel,
  collapsibleKeys,
} from './model';
import { alignTurns, buildPreviews, buildPreviewIndex, buildActivityIndex } from './preview';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { traceModeAtom, traceScaleAtom } from './store';
import { presentTool, presentRecord } from './present';
import { appearanceOf, STATUS_LABEL } from './kinds';
import { useAgentsMapContext } from '~/Providers';
import { useTraceFormat } from './format';
import { useLocalize } from '~/hooks';
import Inspector from './Inspector';
import Timeline from './Timeline';
import Summary from './Summary';
import Ledger from './Ledger';
import { cn } from '~/utils';

const ERROR_MESSAGES: Partial<Record<TTraceErrorCode, TranslationKeys>> = {
  invalid_request: 'com_ui_trace_error_changed',
  not_found: 'com_ui_trace_error_not_found',
  rate_limited: 'com_ui_trace_error_rate_limited',
  timeout: 'com_ui_trace_error_timeout',
  unauthorized: 'com_ui_trace_error_unauthorized',
  unsupported: 'com_ui_trace_error_unsupported',
};

const PRESSED = 'bg-surface-active-alt';
/** A response's header quotes the question it answered; the row truncates what does not fit. */
const ASKED_LENGTH = 120;

function errorCodeOf(error: unknown): TTraceErrorCode | undefined {
  return axios.isAxiosError<TTraceErrorResponse>(error)
    ? error.response?.data?.errorCode
    : undefined;
}

function errorMessageKey(error: unknown): TranslationKeys {
  const code = errorCodeOf(error);
  return (code != null ? ERROR_MESSAGES[code] : undefined) ?? 'com_ui_trace_error_generic';
}

/**
 * The conversation trace: a summary, a pinned overview of every loaded record,
 * the record ledger and an inspector. It covers the chat surface and returns
 * focus to whatever opened it when it closes.
 */
export default function Viewer({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const format = useTraceFormat();
  const headingId = useId();
  const searchId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const { data: startupConfig } = useGetStartupConfig();
  const settings = resolveTraceViewerConfig(startupConfig?.interface?.traceViewer);
  const showCost = startupConfig?.interface?.contextCost === true;
  const currency = startupConfig?.interface?.currency;

  const recordsQuery = useConversationTraceRecordsQuery(conversationId, true);
  const { data: langfuseSession } = useGetLangfuseSessionLinkQuery(
    conversationId,
    startupConfig?.langfuseConnectionAccess === true,
  );
  /** The chat's own messages, already loaded underneath the trace; they are only read, never fetched here. */
  const { data: messages } = useQuery<TMessage[]>(
    [QueryKeys.messages, conversationId],
    () => dataService.getMessagesByConvoId(conversationId),
    { enabled: false },
  );

  const [mode, setMode] = useAtom(traceModeAtom);
  const [scale, setScale] = useAtom(traceScaleAtom);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [view, setView] = useState<TraceWindow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<'refresh' | 'older'>('refresh');
  /** Rereads only the newest page; older pages cannot change and reload on demand. */
  const refresh = useCallback(() => {
    setLastRead('refresh');
    keepNewestTracePage(queryClient, conversationId);
    recordsQuery.refetch();
    /** An open record may have finished or finished ingesting since its detail loaded. */
    queryClient.invalidateQueries([QueryKeys.conversationTraceRecord, conversationId]);
  }, [queryClient, conversationId, recordsQuery]);
  const loadOlder = useCallback(() => {
    setLastRead('older');
    recordsQuery.fetchNextPage();
  }, [recordsQuery]);
  const deferredQuery = useDeferredValue(query);

  const pages = recordsQuery.data?.pages;
  const records = useMemo(() => pages?.flatMap((page) => page.records) ?? [], [pages]);
  const recordSources = useMemo(() => {
    const sources = new Map<string, string>();
    for (const page of pages ?? []) {
      for (const record of page.records) {
        if (page.sourceId != null) {
          sources.set(record.id, page.sourceId);
        }
      }
    }
    return sources;
  }, [pages]);
  /** The session link opens one project; offer it only when that project served every loaded page. */
  const langfuseUrl =
    langfuseSession?.url != null &&
    langfuseSession.destinationId != null &&
    pages != null &&
    pages.length > 0 &&
    pages.every((page) => page.sourceId === langfuseSession.destinationId)
      ? langfuseSession.url
      : undefined;
  const hasOlder = recordsQuery.hasNextPage === true;
  const model = useMemo(() => buildTraceModel(records, mode, hasOlder), [records, mode, hasOlder]);
  const bounds = useMemo(() => boundsOf(model, scale), [model, scale]);
  const minSpan = minimumSpan(bounds, scale);
  const previews = useMemo(() => buildPreviews(messages), [messages]);
  /** Pages split a response at the oldest loaded turn, whose earlier steps are still unloaded;
   *  its rounds cannot be numbered against the message until they are. */
  const partialMessageId =
    recordsQuery.hasNextPage === true ? model.turns[0]?.messageId : undefined;
  const alignments = useMemo(
    () => alignTurns(model, previews, partialMessageId),
    [model, previews, partialMessageId],
  );
  const previewIndex = useMemo(
    () => buildPreviewIndex(model, previews, partialMessageId, alignments),
    [model, previews, partialMessageId, alignments],
  );
  const previewOf = useCallback(
    (node: TraceNode) => previewIndex.get(node.record.id),
    [previewIndex],
  );
  const activity = useMemo(
    () => buildActivityIndex(model, previews, partialMessageId, alignments),
    [model, previews, partialMessageId, alignments],
  );
  const agentsMap = useAgentsMapContext();
  const mcpIconMap = useMCPIconMap();
  const mcpServerNames = useMCPServerNames();
  const agentOf = useCallback((agentId: string) => agentsMap?.[agentId], [agentsMap]);
  const presentFor = useMemo(() => {
    const sources = { localize, activity, previewOf, mcpServerNames, agentOf };
    const presented = new Map<string, ReturnType<typeof presentRecord>>();
    return (node: TraceNode) => {
      const cached = presented.get(node.record.id);
      if (cached != null) {
        return cached;
      }
      const presentation = presentRecord(node, sources);
      presented.set(node.record.id, presentation);
      return presentation;
    };
  }, [localize, activity, previewOf, mcpServerNames, agentOf]);
  const toolFor = useCallback(
    (name: string) => presentTool(name, { localize, mcpServerNames }),
    [localize, mcpServerNames],
  );
  const toolTitleFor = useCallback((name: string) => toolFor(name).title, [toolFor]);
  /** The user message each response answered: what tells one response from another in the ledger. */
  const askedByResponse = useMemo(() => {
    const textById = new Map<string, string>();
    const asked = new Map<string, string>();
    for (const message of messages ?? []) {
      if (message.isCreatedByUser) {
        textById.set(message.messageId, message.text);
      }
    }
    for (const message of messages ?? []) {
      const text = message.isCreatedByUser
        ? undefined
        : textById.get(message.parentMessageId ?? '')?.trim();
      if (text) {
        asked.set(message.messageId, text.replace(/\s+/g, ' ').slice(0, ASKED_LENGTH));
      }
    }
    return asked;
  }, [messages]);
  const askedFor = useCallback(
    (messageId: string) => askedByResponse.get(messageId),
    [askedByResponse],
  );
  const labelsFor = useCallback(
    (record: TTraceRecord) => {
      const node = model.nodes.get(record.id);
      const presentation = node != null ? presentFor(node) : undefined;
      return [
        localize(appearanceOf(record).label),
        localize(STATUS_LABEL[record.status]),
        ...[presentation?.title, presentation?.caption, presentation?.preview].filter(
          (label): label is string => label != null,
        ),
      ];
    },
    [localize, model, presentFor],
  );
  const rows = useMemo(
    () => flattenRows(model, { collapsed, query: deferredQuery, window: view, scale, labelsFor }),
    [model, collapsed, deferredQuery, view, scale, labelsFor],
  );
  /** A refresh or a settled run trims the cache to its newest page, an older page renumbers the
   *  sequence, and a mode change hides records. A selection or interval on records no longer
   *  listed would leave an inspector on nothing, or hide every row, so both follow the records. */
  const previousModel = useRef(model);
  useEffect(() => {
    const previous = previousModel.current;
    previousModel.current = model;
    /** An agent is opened from its response's header, which lists it whether or not the mode does. */
    setSelectedId((id) => {
      const node = id != null ? model.nodes.get(id) : undefined;
      return node != null && (node.shown || node.record.role === 'agent') ? id : null;
    });
    setView((current) =>
      current != null ? rebaseWindow(current, previous, model, scale) : current,
    );
  }, [model, scale]);
  /** Positions mean something else on the other scale or with other records shown. */
  useEffect(() => {
    setView(null);
  }, [scale, mode]);
  /** Older responses arrive folded to their summary; the newest one opens, since it is what the user just ran. */
  const seenTurns = useRef(new Set<string>());
  useEffect(() => {
    const newest = model.turns[model.turns.length - 1]?.key;
    const fold = model.turns
      .filter((turn) => !seenTurns.current.has(turn.key) && turn.key !== newest)
      .map((turn) => turn.key);
    for (const turn of model.turns) {
      seenTurns.current.add(turn.key);
    }
    if (fold.length > 0) {
      setCollapsed((current) => new Set([...current, ...fold]));
    }
  }, [model]);
  const selectedNode = selectedId != null ? model.nodes.get(selectedId) : undefined;
  const selectedTurnStart =
    model.turns.find((turn) => turn.messageId === selectedNode?.record.messageId)?.start ??
    model.start;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      /** Only reclaim focus the trace took with it; a close caused by navigating
       *  elsewhere leaves focus wherever that navigation put it. */
      const active = document.activeElement;
      if (active != null && active !== document.body) {
        return;
      }
      const target = opener?.isConnected ? opener : document.getElementById('header-menu-button');
      target?.focus();
    };
  }, []);

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const closeInspector = useCallback(() => {
    setSelectedId(null);
    /** A filter that matches nothing unmounts the tree; the search field is what is left to return to. */
    (treeRef.current ?? document.getElementById(searchId))?.focus();
  }, [searchId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    if (selectedId != null) {
      closeInspector();
      return;
    }
    onClose();
  };

  const refreshButton = (
    <Button
      size="icon-sm"
      variant="outline"
      aria-label={localize('com_ui_trace_refresh')}
      disabled={recordsQuery.isFetching}
      onClick={refresh}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn(
          'size-4',
          recordsQuery.isFetching && 'animate-spin motion-reduce:animate-none',
        )}
      />
    </Button>
  );

  const selectionText = () => {
    if (view == null) {
      return null;
    }
    if (scale === 'sequence') {
      return localize('com_ui_trace_selection_records', {
        0: String(Math.floor(view.start) + 1),
        1: String(Math.ceil(view.end)),
      });
    }
    return localize('com_ui_trace_selection', {
      0: format.duration(view.start - model.start),
      1: format.duration(view.end - model.start),
    });
  };

  const renderBody = () => {
    if (recordsQuery.isLoading) {
      return (
        <div role="status" className="flex flex-1 items-center justify-center gap-2">
          <Spinner className="size-5 text-text-secondary" />
          <span className="sr-only">{localize('com_ui_trace_loading')}</span>
        </div>
      );
    }

    if (recordsQuery.isError && recordsQuery.data == null) {
      return (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={TriangleAlert}
            title={localize('com_ui_trace_error_title')}
            description={localize(errorMessageKey(recordsQuery.error))}
            action={
              <Button size="sm" variant="outline" onClick={refresh}>
                {localize('com_ui_retry')}
              </Button>
            }
          />
        </div>
      );
    }

    if (model.nodes.size === 0 && recordsQuery.hasNextPage !== true) {
      return (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={ChartNoAxesGantt}
            title={localize('com_ui_trace_empty_title')}
            description={localize('com_ui_trace_empty_description')}
            action={
              <Button size="sm" variant="outline" onClick={refresh}>
                {localize('com_ui_trace_refresh')}
              </Button>
            }
          />
        </div>
      );
    }

    /** A refresh or an older page failed while earlier results stay on screen. */
    const cachedReadFailed = recordsQuery.isError && recordsQuery.data != null;
    return (
      <>
        <div className="flex flex-col gap-3 border-b border-border-light px-3 py-3 md:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Summary
              summary={model.summary}
              unrecordedCalls={activity.unrecordedCalls}
              showCost={showCost}
              currency={currency}
            />
            {recordsQuery.hasNextPage === true && (
              <p className="text-xs text-text-secondary">
                {localize('com_ui_trace_partial', { 0: String(records.length) })}
              </p>
            )}
          </div>
          <Timeline model={model} scale={scale} view={view} onViewChange={setView} />
          <div className="flex flex-wrap items-center gap-2">
            <FilterInput
              inputId={searchId}
              label={localize('com_ui_trace_search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query !== '') {
                  event.preventDefault();
                  setQuery('');
                }
              }}
              containerClassName="min-w-[10rem] flex-1 md:max-w-xs"
            />
            <Button
              size="sm"
              variant="outline"
              aria-label={localize('com_ui_trace_expand_all')}
              onClick={() => setCollapsed(new Set())}
              disabled={collapsed.size === 0}
            >
              <ChevronsUpDown className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{localize('com_ui_trace_expand_all')}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={localize('com_ui_trace_collapse_all')}
              onClick={() => setCollapsed(new Set(collapsibleKeys(model)))}
            >
              <ChevronsDownUp className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{localize('com_ui_trace_collapse_all')}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={localize('com_ui_trace_scale_duration')}
              aria-pressed={scale === 'time'}
              title={localize('com_ui_trace_scale_duration_description')}
              className={cn(scale === 'time' && PRESSED)}
              onClick={() => setScale(scale === 'time' ? 'sequence' : 'time')}
            >
              <Clock className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{localize('com_ui_trace_scale_duration')}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={localize('com_ui_trace_all_spans')}
              aria-pressed={mode === 'full'}
              title={localize('com_ui_trace_all_spans_description')}
              className={cn(mode === 'full' && PRESSED)}
              onClick={() => setMode(mode === 'full' ? 'simple' : 'full')}
            >
              <Layers className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{localize('com_ui_trace_all_spans')}</span>
            </Button>
            <div className="ml-auto flex items-center gap-1">
              {view != null && (
                <span className="text-xs tabular-nums text-text-secondary" aria-live="polite">
                  {selectionText()}
                </span>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={localize('com_ui_zoom_out')}
                disabled={view == null}
                onClick={() => setView(zoomWindow(bounds, view, 1 / ZOOM_STEP, undefined, minSpan))}
              >
                <ZoomOut className="size-4" aria-hidden="true" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={localize('com_ui_zoom_in')}
                onClick={() => setView(zoomWindow(bounds, view, ZOOM_STEP, undefined, minSpan))}
              >
                <ZoomIn className="size-4" aria-hidden="true" />
              </Button>
              {view != null && (
                <Button size="sm" variant="ghost" onClick={() => setView(null)}>
                  {localize('com_ui_trace_clear_selection')}
                </Button>
              )}
            </div>
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {rows.length === 0 ? (
              <p role="status" className="p-4 text-sm text-text-secondary">
                {localize('com_ui_trace_no_matches')}
              </p>
            ) : (
              <Ledger
                rows={rows}
                model={model}
                scale={scale}
                view={view}
                selectedId={selectedId}
                treeRef={treeRef}
                presentFor={presentFor}
                askedFor={askedFor}
                toolTitleFor={toolTitleFor}
                agentOf={agentOf}
                unrecordedCalls={activity.unrecordedCalls}
                stepOffsets={activity.stepOffsets}
                mcpIconMap={mcpIconMap}
                showCost={showCost}
                currency={currency}
                onSelect={setSelectedId}
                onToggle={toggle}
              />
            )}
            {(recordsQuery.hasNextPage === true || cachedReadFailed) && (
              <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border-light p-2">
                {cachedReadFailed && (
                  <>
                    <span role="alert" className="text-xs text-status-error">
                      {localize(errorMessageKey(recordsQuery.error))}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={recordsQuery.isFetching}
                      onClick={
                        /** A continuation the trace no longer matches can only be reloaded from the newest page. */
                        lastRead === 'older' &&
                        errorCodeOf(recordsQuery.error) !== 'invalid_request'
                          ? loadOlder
                          : refresh
                      }
                    >
                      {localize('com_ui_retry')}
                    </Button>
                  </>
                )}
                {recordsQuery.hasNextPage === true && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recordsQuery.isFetchingNextPage}
                    onClick={loadOlder}
                  >
                    {recordsQuery.isFetchingNextPage && <Spinner className="size-3.5" />}
                    {localize('com_ui_trace_load_older')}
                  </Button>
                )}
              </div>
            )}
          </div>
          {selectedNode && (
            <Inspector
              node={selectedNode}
              presentation={presentFor(selectedNode)}
              mcpIconMap={mcpIconMap}
              toolFor={toolFor}
              turnStart={selectedTurnStart}
              sourceId={recordSources.get(selectedNode.record.id)}
              conversationId={conversationId}
              showContent={settings.showInputOutput}
              showCost={showCost}
              currency={currency}
              onClose={closeInspector}
            />
          )}
        </div>
      </>
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="trace-viewer"
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-20 flex flex-col bg-presentation text-text-primary"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border-light px-2 md:px-4">
        <h2 id={headingId} className="text-base font-semibold">
          {localize('com_ui_trace_title')}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {langfuseUrl != null && (
            <a
              href={langfuseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{localize('com_ui_trace_open_langfuse')}</span>
              <span className="sr-only sm:hidden">{localize('com_ui_trace_open_langfuse')}</span>
            </a>
          )}
          {refreshButton}
          <Button
            ref={closeRef}
            size="icon-sm"
            variant="outline"
            aria-label={localize('com_ui_trace_close')}
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {renderBody()}
    </section>
  );
}
