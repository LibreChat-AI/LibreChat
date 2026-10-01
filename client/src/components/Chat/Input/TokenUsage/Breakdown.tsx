import { Fragment, useId, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { ChevronDown, ExternalLink, Info, TriangleAlert } from 'lucide-react';
import {
  Button,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  Collapsible,
  MeterSwatch,
  SegmentedMeter,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@librechat/client';
import type { MeterSegment } from '@librechat/client';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import type { CurrencyConfig } from '~/utils';
import { groupToolTokens, formatTokens, formatCost, normalizeTokenCount, cn } from '~/utils';
import { contextBreakdownExpandedAtom } from '~/store/usage';
import { useLocalize } from '~/hooks';

interface RowProps {
  label: string;
  value: number;
  max?: number;
  /** Present only when the row corresponds to real estate in the meter */
  segment?: Pick<MeterSegment, 'slot' | 'hatched' | 'outlined'>;
  /** The free-space remainder, keyed to the bare track rather than a series */
  track?: boolean;
  /** Meter segment this row keys; hovering it highlights its slice of the bar */
  id?: string;
  onHoverChange?: (id: string | null) => void;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
}

function Row({
  label,
  value,
  max,
  segment,
  track,
  id,
  onHoverChange,
  onClick,
  expanded,
  controls,
}: RowProps) {
  const safeValue = normalizeTokenCount(value);
  const safeMax = max != null ? normalizeTokenCount(max) : 0;
  const percent = safeMax > 0 ? Math.min((safeValue / safeMax) * 100, 100) : null;
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {segment != null && <MeterSwatch segment={segment} />}
        {track === true && (
          <span
            aria-hidden="true"
            className="bg-surface-tertiary ring-border-medium size-2 flex-none rounded-sm ring-1 ring-inset"
          />
        )}
        <span className="text-text-secondary min-w-0 break-words">{label}</span>
      </span>
      <span className="text-text-primary shrink-0 font-medium whitespace-nowrap">
        {formatTokens(safeValue)}
        {percent != null && (
          <span className="text-text-secondary ml-1 text-xs" aria-hidden="true">
            ({Math.round(percent)}%)
          </span>
        )}
      </span>
    </>
  );
  const className = cn(
    'flex w-full items-center justify-between gap-4 text-left text-sm',
    onClick != null &&
      'rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary',
  );
  const handlers = {
    onPointerEnter: id != null ? () => onHoverChange?.(id) : undefined,
    onPointerLeave: id != null ? () => onHoverChange?.(null) : undefined,
  };
  return onClick != null ? (
    <button
      type="button"
      className={className}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      {...handlers}
    >
      {content}
    </button>
  ) : (
    <div className={className} {...handlers}>
      {content}
    </div>
  );
}

interface BreakdownProps {
  view: TokenUsageView;
  showCost: boolean;
  compactionAvailable?: boolean;
  currency?: CurrencyConfig;
  langfuseSessionUrl?: string;
}

export default function Breakdown({
  view,
  showCost,
  compactionAvailable = false,
  currency,
  langfuseSessionUrl,
}: BreakdownProps) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useAtom(contextBreakdownExpandedAtom);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const insightsId = useId();
  const toolBreakdownId = useId();
  const usedTokens = normalizeTokenCount(view.usedTokens);
  const maxTokens = view.maxTokens != null ? normalizeTokenCount(view.maxTokens) : undefined;
  let percent =
    maxTokens != null && maxTokens > 0 ? Math.min((usedTokens / maxTokens) * 100, 100) : 0;
  if (typeof view.percent === 'number' && Number.isFinite(view.percent)) {
    percent = Math.min(Math.max(view.percent, 0), 100);
  }
  const { snapshot, snapshotActive, branchUsage, hasUsage } = view;
  /** Token differences are visible independently of cost display/coverage;
   *  only compare costs when both sides are complete to avoid an apparent
   *  all-branches total made from partially priced history. */
  const showTotal =
    view.totalUsage.input !== branchUsage.input ||
    view.totalUsage.output !== branchUsage.output ||
    view.totalUsage.cacheRead !== branchUsage.cacheRead ||
    view.totalUsage.cacheWrite !== branchUsage.cacheWrite ||
    (view.totalUsage.costKnown &&
      branchUsage.costKnown &&
      Number.isFinite(view.totalCost) &&
      Number.isFinite(view.branchCost) &&
      view.totalCost - view.branchCost > 1e-9);

  /** Every normalized bucket of the subagent calls: a cached call reports its
   *  prompt under `cacheRead`/`cacheWrite`, so summing input+output alone
   *  under-reports it — and hides a fully cached call with no output entirely,
   *  while the Totals rows above still count its cache traffic. */
  const subagentTokens =
    normalizeTokenCount(view.subagentUsage?.input) +
    normalizeTokenCount(view.subagentUsage?.output) +
    normalizeTokenCount(view.subagentUsage?.cacheRead) +
    normalizeTokenCount(view.subagentUsage?.cacheWrite);

  const breakdown = snapshotActive ? snapshot?.breakdown : undefined;
  const instructionTokens = normalizeTokenCount(
    snapshot?.effectiveInstructionTokens ?? breakdown?.instructionTokens,
  );
  const systemTokens =
    normalizeTokenCount(breakdown?.systemMessageTokens) +
    normalizeTokenCount(breakdown?.dynamicInstructionTokens);
  /** Summary and tool calls have their own rows, so exclude both (they're part
   *  of `usedTokens`) to avoid double-counting them inside the Messages row.
   *  `toolMessageTokens` is absent on older SDK snapshots, keeping the row
   *  unsplit. */
  const summaryTokens = normalizeTokenCount(breakdown?.summaryTokens);
  const retainedToolTokens = normalizeTokenCount(snapshot?.retainedToolTokens);
  const messageBudget = Math.max(0, usedTokens - instructionTokens - summaryTokens);
  /** `toolMessageTokens` is a subset of pre-invoke messages, while retained
   *  tool results sit outside that total. Widen both sides of the split by the
   *  retained count, then bound the share by the current used-token remainder. */
  const rawToolCallTokens =
    breakdown?.toolMessageTokens != null
      ? normalizeTokenCount(breakdown.toolMessageTokens)
      : undefined;
  const toolCallTokens =
    rawToolCallTokens != null
      ? Math.min(
          rawToolCallTokens + retainedToolTokens,
          normalizeTokenCount(breakdown?.messageTokens) + retainedToolTokens,
          messageBudget,
        )
      : undefined;
  const messageTokens = Math.max(0, messageBudget - (toolCallTokens ?? 0));
  const freeTokens = maxTokens != null ? Math.max(0, maxTokens - usedTokens) : null;
  /** Context pressure: the gauge percent against soft (80%) and hard (95%)
   * thresholds, driving the warning line's tint and the offender/runway hints. */
  let pressure: 'danger' | 'warn' | 'none' = 'none';
  if (percent >= 95) {
    pressure = 'danger';
  } else if (percent >= 80) {
    pressure = 'warn';
  }
  const dynamicInstructionTokens = normalizeTokenCount(breakdown?.dynamicInstructionTokens);
  /** Keep the largest tool for the pressure insight, but retain every named
   *  result in the disclosure. Result counts are a subset of the tool-call
   *  share; any invocation overhead in that share remains unassigned. */
  const { largestTool, toolBreakdown } = useMemo(() => {
    const counts = view.toolMessageTokenCounts;
    if (counts == null) {
      return {
        largestTool: null,
        toolBreakdown: [] as Array<{ name: string; tokens: number }>,
      };
    }
    const candidates: Array<{ name: string; tokens: number }> = [];
    for (const name in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, name)) {
        continue;
      }
      candidates.push({ name, tokens: normalizeTokenCount(counts[name]) });
    }
    candidates.sort((a, b) => b.tokens - a.tokens);

    /** Keep displayed results within the reported tool-call share even when a
     * malformed snapshot overstates one or more per-tool counts. Do not drop
     * names after the share is exhausted: a known zero is different from an
     * unavailable result count. */
    let remaining = toolCallTokens ?? Number.MAX_SAFE_INTEGER;
    for (const candidate of candidates) {
      candidate.tokens = Math.min(candidate.tokens, remaining);
      remaining -= candidate.tokens;
    }
    return {
      largestTool: candidates[0]?.tokens > 0 ? candidates[0] : null,
      toolBreakdown: candidates,
    };
  }, [toolCallTokens, view.toolMessageTokenCounts]);
  const hasToolCounts = toolBreakdown.length > 0;
  /** Insights shown on hovering the ⓘ button: largest tool, runway, and what a
   *  summarization could reclaim. */
  const insights: string[] = [];
  if (largestTool != null) {
    insights.push(
      localize('com_ui_context_largest_tool', {
        0: largestTool.name,
        1: formatTokens(largestTool.tokens),
      }),
    );
  }
  const runwayTurns =
    typeof view.runwayTurns === 'number' && Number.isFinite(view.runwayTurns)
      ? Math.max(0, Math.floor(view.runwayTurns))
      : null;
  if (runwayTurns != null && runwayTurns <= 25) {
    insights.push(localize('com_ui_context_runway', { 0: String(runwayTurns) }));
  }
  const compactionReclaim = normalizeTokenCount(view.compactionReclaim);
  if (compactionAvailable && compactionReclaim > 0) {
    insights.push(localize('com_ui_context_compaction', { 0: formatTokens(compactionReclaim) }));
  }

  const groups =
    breakdown?.toolTokenCounts != null
      ? groupToolTokens(breakdown.toolTokenCounts, breakdown.deferredToolNames)
      : null;

  /** Single source of truth for both the meter and its legend: a row carries a
   *  swatch if and only if it is a segment, so the two can never disagree.
   *  Deferred tools keep their family's slot and are hatched — same identity,
   *  held out of the active set. */
  const segments: Array<MeterSegment & { label: string }> =
    breakdown == null
      ? []
      : [
          {
            id: 'messages',
            label: localize('com_ui_context_messages'),
            value: messageTokens,
            slot: 1,
          },
          {
            id: 'tool-calls',
            label: localize('com_ui_context_tool_calls'),
            value: toolCallTokens ?? 0,
            slot: 2,
          },
          { id: 'system', label: localize('com_ui_context_system'), value: systemTokens, slot: 3 },
          ...(groups == null
            ? [
                {
                  id: 'tools',
                  label: localize('com_ui_context_tools'),
                  value: normalizeTokenCount(breakdown.toolSchemaTokens),
                  slot: 4,
                },
              ]
            : [
                {
                  id: 'tools-system',
                  label: localize('com_ui_context_tools_system'),
                  value: groups.system,
                  slot: 4,
                },
                {
                  id: 'tools-system-deferred',
                  label: localize('com_ui_context_tools_system_deferred'),
                  value: groups.systemDeferred,
                  slot: 4,
                  hatched: true,
                },
                {
                  id: 'tools-mcp',
                  label: localize('com_ui_context_tools_mcp'),
                  value: groups.mcp,
                  slot: 5,
                },
                {
                  id: 'tools-mcp-deferred',
                  label: localize('com_ui_context_tools_mcp_deferred'),
                  value: groups.mcpDeferred,
                  slot: 5,
                  hatched: true,
                },
                { id: 'skills', label: localize('com_ui_skills'), value: groups.skills, slot: 6 },
                {
                  id: 'subagents',
                  label: localize('com_ui_context_subagents'),
                  value: groups.subagents,
                  slot: 7,
                },
              ]),
          {
            id: 'summary',
            label: localize('com_ui_context_summary'),
            value: normalizeTokenCount(breakdown.summaryTokens),
            slot: 8,
          },
        ];
  /** The estimate path knows the total but not the composition, so it keeps a
   *  single unsegmented fill and its rows carry no swatches. */
  const meterSegments: MeterSegment[] =
    segments.length > 0 ? segments : [{ id: 'used', value: usedTokens, slot: 1 }];

  /** A hovered row can vanish mid-hover (live snapshot update, or the view
   *  falling back to the estimate path, whose rows carry no hover pairing);
   *  without its pointerleave a stale id would dim every segment. Clear the
   *  state rather than masking it, so a stale highlight cannot return if the
   *  row reappears with the pointer elsewhere. Render-phase reset: React
   *  re-renders immediately and never commits the stale highlight. */
  const hoverIsValid = (id: string): boolean =>
    id === 'free'
      ? breakdown != null && freeTokens != null
      : meterSegments.some((segment) => segment.id === id && segment.value > 0);
  if (hoveredSegment != null && !hoverIsValid(hoveredSegment)) {
    setHoveredSegment(null);
  }
  const activeSegment =
    hoveredSegment != null && hoverIsValid(hoveredSegment) ? hoveredSegment : null;

  return (
    <div className="w-72" role="region" aria-label={localize('com_ui_context_usage')}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          focusOutline="hidden"
          className="group focus-visible:ring-text-primary flex w-full items-center justify-between gap-2 rounded-sm focus-visible:ring-2"
          data-testid="context-breakdown-toggle"
        >
          <span className="text-text-primary text-sm font-medium whitespace-nowrap">
            {localize('com_ui_context_window')}
          </span>
          <span className="text-text-secondary flex items-center gap-1 text-xs font-medium whitespace-nowrap">
            {maxTokens != null
              ? `${formatTokens(usedTokens)} / ${formatTokens(maxTokens)} (${Math.round(percent)}%)`
              : formatTokens(usedTokens)}
            <ChevronDown
              aria-hidden="true"
              className="text-text-tertiary size-3.5 shrink-0 transition-transform duration-300 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </span>
        </CollapsibleTrigger>

        <SegmentedMeter
          className="mt-3"
          segments={maxTokens != null ? meterSegments : []}
          max={maxTokens ?? 1}
          highlightId={activeSegment}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={maxTokens != null ? Math.round(percent) : undefined}
          aria-label={localize('com_ui_context_usage')}
        />

        {/* The gap to the meter lives INSIDE the animated element (mt-3 below),
            so it collapses with the height. On the parent it would be a margin
            outside the animation, and unmounting the content would drop it in a
            single 12px jump after the height reached zero. */}
        <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none">
          <div className="mt-3 space-y-3">
            {(pressure !== 'none' || insights.length > 0) && (
              <div className="relative flex items-center justify-between gap-2">
                {pressure !== 'none' ? (
                  <p
                    className={cn(
                      'flex min-w-0 items-center gap-1.5 text-xs',
                      pressure === 'danger' ? 'text-text-destructive' : 'text-text-warning',
                    )}
                  >
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                    {localize(
                      pressure === 'danger'
                        ? 'com_ui_context_pressure_danger'
                        : 'com_ui_context_pressure_warn',
                    )}
                  </p>
                ) : (
                  <span />
                )}
                {insights.length > 0 && (
                  <HoverCard open={insightsOpen} onOpenChange={setInsightsOpen}>
                    <HoverCardTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={localize('com_ui_context_insights')}
                        aria-expanded={insightsOpen}
                        aria-controls={insightsOpen ? insightsId : undefined}
                        data-testid="context-insights-toggle"
                        className="text-text-secondary size-6"
                        onFocus={() => setInsightsOpen(true)}
                        onBlur={() => setInsightsOpen(false)}
                        onClick={() => setInsightsOpen(true)}
                      >
                        <Info className="size-3.5" aria-hidden="true" />
                      </Button>
                    </HoverCardTrigger>
                    <HoverCardPortal>
                      <HoverCardContent
                        id={insightsId}
                        role="region"
                        aria-label={localize('com_ui_context_insights')}
                        data-testid="context-hints"
                        className="max-w-[calc(100vw-2rem)] motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none"
                        align="end"
                      >
                        {insights.map((insight, index) => (
                          <p className="text-text-secondary text-xs break-words" key={index}>
                            {insight}
                          </p>
                        ))}
                      </HoverCardContent>
                    </HoverCardPortal>
                  </HoverCard>
                )}
              </div>
            )}
            <div
              className="space-y-1.5"
              data-testid={breakdown ? 'context-breakdown' : 'context-estimate'}
            >
              {breakdown ? (
                <>
                  {segments.map(({ id, label, value, ...segment }) => {
                    const shouldRender =
                      value > 0 || (id === 'tool-calls' && toolCallTokens != null);
                    if (!shouldRender) {
                      return null;
                    }
                    return (
                      <Fragment key={id}>
                        {id === 'tool-calls' && hasToolCounts ? (
                          <Row
                            label={label}
                            value={value}
                            max={maxTokens}
                            segment={segment}
                            id={id}
                            onHoverChange={setHoveredSegment}
                            onClick={() => setToolsExpanded((open) => !open)}
                            expanded={toolsExpanded}
                            controls={toolsExpanded ? toolBreakdownId : undefined}
                          />
                        ) : (
                          <Row
                            label={label}
                            value={value}
                            max={maxTokens}
                            segment={segment}
                            id={id}
                            onHoverChange={setHoveredSegment}
                          />
                        )}
                        {id === 'tool-calls' && toolsExpanded && hasToolCounts && (
                          <div id={toolBreakdownId} className="space-y-1 pl-6">
                            <p className="text-text-tertiary text-xs font-medium">
                              {localize('com_ui_context_tool_breakdown')}
                            </p>
                            {toolBreakdown.map((tool) => (
                              <Row key={tool.name} label={tool.name} value={tool.tokens} />
                            ))}
                          </div>
                        )}
                        {id === 'system' && dynamicInstructionTokens > 0 && (
                          <div className="pl-6">
                            <Row
                              label={localize('com_ui_context_dynamic_instructions')}
                              value={dynamicInstructionTokens}
                            />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                  {/** The reconciling call's cached prompt share is already inside
                   *  the segments above (reconciliation counted it in `usedTokens`),
                   *  so it renders indented, like the estimate path's tool-call
                   *  share — as peer rows a fully cached prompt would show its
                   *  tokens twice and the visible rows would sum past the meter. */}
                  {(normalizeTokenCount(view.cacheRead) > 0 ||
                    normalizeTokenCount(view.cacheWrite) > 0) && (
                    <div className="space-y-1.5 pl-6">
                      <p className="text-text-tertiary text-xs font-medium">
                        {localize('com_ui_context_cache_last_call')}
                      </p>
                      {normalizeTokenCount(view.cacheRead) > 0 && (
                        <Row
                          label={localize('com_ui_context_cached')}
                          value={normalizeTokenCount(view.cacheRead)}
                          max={maxTokens}
                        />
                      )}
                      {normalizeTokenCount(view.cacheWrite) > 0 && (
                        <Row
                          label={localize('com_ui_context_cache_write')}
                          value={normalizeTokenCount(view.cacheWrite)}
                          max={maxTokens}
                        />
                      )}
                    </div>
                  )}
                  {freeTokens != null && (
                    <Row
                      label={localize('com_ui_context_free')}
                      value={freeTokens}
                      max={maxTokens}
                      track
                      id="free"
                      onHoverChange={setHoveredSegment}
                    />
                  )}
                </>
              ) : (
                <>
                  {normalizeTokenCount(view.branchTotals.summaryBaseline) > 0 && (
                    <Row
                      label={localize('com_ui_context_summary')}
                      value={view.branchTotals.summaryBaseline}
                      max={maxTokens}
                    />
                  )}
                  {view.messagesPruned ? (
                    /** Over-window: the per-category split no longer describes what's
                     *  sent, so show the pruned message total (incl. in-flight). */
                    <Row
                      label={localize('com_ui_context_messages')}
                      value={view.messageTokens + view.liveTokens}
                      max={maxTokens}
                    />
                  ) : (
                    <>
                      <Row label={localize('com_ui_input')} value={view.branchTotals.input} />
                      <Row
                        label={localize('com_ui_output')}
                        value={view.branchTotals.output + view.liveTokens}
                      />
                      {normalizeTokenCount(view.estimatedTokens) > 0 && (
                        <Row
                          label={localize('com_ui_context_estimated')}
                          value={view.estimatedTokens}
                        />
                      )}
                    </>
                  )}
                  {/** Retained tool traffic is already inside the message rows above
                   *  (their clamped tool-content share), so it renders as an indented
                   *  subtotal — as a peer row the visible rows would sum past
                   *  `usedTokens`. The snapshot path instead subtracts it from
                   *  Messages, which is exact there; here the counted Input/Output
                   *  rows are provider counts and this share is a char estimate, so
                   *  subtracting it would corrupt them. */}
                  {normalizeTokenCount(view.toolCallTokens) > 0 && (
                    <div className="pl-6">
                      <Row
                        label={localize('com_ui_context_tool_calls')}
                        value={normalizeTokenCount(view.toolCallTokens)}
                      />
                    </div>
                  )}
                  {view.overheadTokens > 0 && (
                    <Row label={localize('com_ui_context_system')} value={view.overheadTokens} />
                  )}
                  {maxTokens == null && (
                    <p className="text-text-secondary text-xs">
                      {localize('com_ui_context_unknown')}
                    </p>
                  )}
                  <p className="text-text-secondary text-xs italic">
                    {localize('com_ui_estimated')}
                  </p>
                </>
              )}
            </div>

            <div className="border-border-light border-t" role="separator" />
            <div className="space-y-1.5" data-testid="token-usage-last-turn">
              <h3 className="text-text-tertiary text-xs font-semibold tracking-wider uppercase">
                {view.turnInProgress
                  ? localize('com_ui_context_current_turn')
                  : localize('com_ui_context_last_turn')}
              </h3>
              {view.lastTurnUsage != null ? (
                <>
                  <Row
                    label={localize('com_ui_context_uncached_input')}
                    value={view.lastTurnUsage.input}
                  />
                  <Row label={localize('com_ui_cache_read')} value={view.lastTurnUsage.cacheRead} />
                  <Row
                    label={localize('com_ui_cache_write')}
                    value={view.lastTurnUsage.cacheWrite}
                  />
                  <Row label={localize('com_ui_output')} value={view.lastTurnUsage.output} />
                </>
              ) : (
                <p className="text-text-secondary text-xs">
                  {view.turnInProgress
                    ? localize('com_ui_context_waiting_usage')
                    : localize('com_ui_context_unavailable_usage')}
                </p>
              )}
            </div>

            {hasUsage && (
              <>
                <div className="border-border-light border-t" role="separator" />
                <div className="space-y-1.5" data-testid="token-usage-totals">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-text-tertiary text-xs font-semibold tracking-wider uppercase">
                      {localize('com_ui_context_totals')}
                    </h3>
                    <span className="text-text-tertiary text-xs">
                      {localize('com_ui_context_this_branch')}
                    </span>
                  </div>
                  <Row
                    label={localize('com_ui_context_uncached_input')}
                    value={branchUsage.input}
                  />
                  <Row label={localize('com_ui_output')} value={branchUsage.output} />
                  {normalizeTokenCount(branchUsage.cacheRead) > 0 && (
                    <Row label={localize('com_ui_cache_read')} value={branchUsage.cacheRead} />
                  )}
                  {normalizeTokenCount(branchUsage.cacheWrite) > 0 && (
                    <Row label={localize('com_ui_cache_write')} value={branchUsage.cacheWrite} />
                  )}
                  {/** Subagent calls are accumulated per conversation for the session
                   *  and are not attributed to a response; label them all-branches. */}
                  {subagentTokens > 0 && (
                    <Row label={localize('com_ui_context_subagents_all')} value={subagentTokens} />
                  )}
                </div>
              </>
            )}
            {showTotal && (
              <div
                className="border-border-light space-y-1.5 border-t pt-2"
                data-testid="token-usage-all-branches"
              >
                <h3 className="text-text-tertiary text-xs font-semibold tracking-wider uppercase">
                  {localize('com_ui_context_cost_total')}
                </h3>
                <Row
                  label={localize('com_ui_context_uncached_input')}
                  value={view.totalUsage.input}
                />
                <Row label={localize('com_ui_output')} value={view.totalUsage.output} />
                {normalizeTokenCount(view.totalUsage.cacheRead) > 0 && (
                  <Row label={localize('com_ui_cache_read')} value={view.totalUsage.cacheRead} />
                )}
                {normalizeTokenCount(view.totalUsage.cacheWrite) > 0 && (
                  <Row label={localize('com_ui_cache_write')} value={view.totalUsage.cacheWrite} />
                )}
              </div>
            )}

            {showCost &&
              (view.lastTurnUsage?.costKnown === true ||
                (hasUsage && branchUsage.costKnown) ||
                (showTotal && view.totalUsage.costKnown)) && (
                <>
                  <div className="border-border-light border-t" role="separator" />
                  <div className="space-y-1.5" data-testid="token-usage-cost">
                    {view.lastTurnUsage?.costKnown === true && (
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-text-secondary">
                          {localize(
                            view.turnInProgress
                              ? 'com_ui_context_cost_current_turn'
                              : 'com_ui_context_cost_last_turn',
                          )}
                        </span>
                        <span className="text-text-primary font-medium">
                          {formatCost(view.lastTurnUsage.cost, currency)}
                        </span>
                      </div>
                    )}
                    {hasUsage && branchUsage.costKnown && (
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-text-secondary">
                          {showTotal
                            ? localize('com_ui_context_cost_branch')
                            : localize('com_ui_context_cost')}
                        </span>
                        <span className="text-text-primary font-medium">
                          {formatCost(view.branchCost, currency)}
                        </span>
                      </div>
                    )}
                    {showTotal && view.totalUsage.costKnown && (
                      <div className="flex items-center justify-between gap-4 text-xs">
                        <span className="text-text-secondary">
                          {localize('com_ui_context_cost_total')}
                        </span>
                        <span className="text-text-secondary">
                          {formatCost(view.totalCost, currency)}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}

            {langfuseSessionUrl && (
              <>
                <div className="border-border-light border-t" role="separator" />
                <Button asChild variant="link" className="h-auto w-full justify-between gap-2 p-0">
                  <a href={langfuseSessionUrl} target="_blank" rel="noopener noreferrer">
                    <span>{localize('com_ui_langfuse_view_session')}</span>
                    <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                  </a>
                </Button>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
