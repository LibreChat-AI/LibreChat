import { Fragment, useId, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  Button,
  Collapsible,
  MeterSwatch,
  SegmentedMeter,
  CollapsibleContent,
  CollapsibleTrigger,
  useLocalize,
  cn,
} from '@librechat/client';
import type { MeterSegment } from '@librechat/client';
import type { CurrencyConfig, TokenUsageView } from '../../../core/usage';
import {
  groupToolTokens,
  formatTokens,
  formatCost,
  normalizeTokenCount,
} from '../../../core/usage';
import Usage from './Usage';

interface RowProps {
  label: string;
  value: number;
  /** Present only when the row corresponds to real estate in the meter */
  segment?: Pick<MeterSegment, 'slot' | 'hatched' | 'outlined'>;
  /** The free-space remainder, keyed to the bare track rather than a series */
  track?: boolean;
  /** Meter segment this row keys; hovering it highlights its slice of the bar */
  id?: string;
  activeId?: string | null;
  onHoverChange?: (id: string | null) => void;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
}

function Row({
  label,
  value,
  segment,
  track,
  id,
  activeId,
  onHoverChange,
  onClick,
  expanded,
  controls,
}: RowProps) {
  const safeValue = normalizeTokenCount(value);
  const highlightClass = cn(
    'transition-opacity duration-150 motion-reduce:transition-none',
    activeId != null && id != null && activeId !== id && 'opacity-70',
  );
  const content = (
    <>
      <span className={cn('flex min-w-0 items-center gap-2', highlightClass)}>
        {segment != null && <MeterSwatch segment={segment} />}
        {track === true && (
          <span
            aria-hidden="true"
            className="bg-surface-tertiary ring-border-medium size-2 flex-none rounded-sm ring-1 ring-inset"
          />
        )}
        <span className="text-text-primary min-w-0 break-words">{label}</span>
      </span>
      <span
        className={cn(
          'text-text-primary shrink-0 font-medium whitespace-nowrap tabular-nums',
          highlightClass,
        )}
      >
        {formatTokens(safeValue)}
      </span>
    </>
  );
  const className = cn(
    'flex w-full items-center justify-between gap-2 text-start text-sm tabular-nums',
  );
  const handlers = {
    onPointerEnter: id != null ? () => onHoverChange?.(id) : undefined,
    onPointerLeave: id != null ? () => onHoverChange?.(null) : undefined,
  };
  return onClick != null ? (
    <Button
      variant="ghost"
      size="bare"
      type="button"
      className="w-full justify-between text-start"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      {...handlers}
    >
      {content}
    </Button>
  ) : (
    <div className={className} {...handlers}>
      {content}
    </div>
  );
}

export interface BreakdownProps {
  view: TokenUsageView;
  showCost: boolean;
  currency?: CurrencyConfig;
  langfuseSessionUrl?: string;
  /** The host owns the disclosure preference so it survives remounts. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export default function Breakdown({
  view,
  showCost,
  currency,
  langfuseSessionUrl,
  expanded,
  onExpandedChange,
}: BreakdownProps): React.JSX.Element {
  const localize = useLocalize();
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const toolBreakdownId = useId();
  const usedTokens = normalizeTokenCount(view.usedTokens);
  const maxTokens = view.maxTokens != null ? normalizeTokenCount(view.maxTokens) : undefined;
  let percent =
    maxTokens != null && maxTokens > 0 ? Math.min((usedTokens / maxTokens) * 100, 100) : 0;
  if (typeof view.percent === 'number' && Number.isFinite(view.percent)) {
    percent = Math.min(Math.max(view.percent, 0), 100);
  }
  const { snapshot, snapshotActive, branchUsage, hasUsage } = view;

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
  /** Context pressure drives the warning line at the soft (80%) and hard (95%) thresholds. */
  let pressure: 'danger' | 'warn' | 'none' = 'none';
  if (percent >= 95) {
    pressure = 'danger';
  } else if (percent >= 80) {
    pressure = 'warn';
  }
  const dynamicInstructionTokens = normalizeTokenCount(breakdown?.dynamicInstructionTokens);
  /** Result counts are a subset of the tool-call share; invocation overhead remains unassigned. */
  const toolBreakdown = useMemo(() => {
    const counts = view.toolMessageTokenCounts;
    if (counts == null) {
      return [];
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
    return candidates;
  }, [toolCallTokens, view.toolMessageTokenCounts]);
  const hasToolCounts = toolBreakdown.length > 0;
  const groups =
    breakdown?.toolTokenCounts != null
      ? groupToolTokens(breakdown.toolTokenCounts, breakdown.deferredToolNames)
      : null;

  /** Single source of truth for both the meter and its legend: a row carries a
   *  swatch if and only if it is a segment, so the two can never disagree.
   *  Deferred tools keep their family's slot and are hatched, same identity,
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
      : segments.some(
          (segment) =>
            segment.id === id &&
            (segment.value > 0 || (id === 'tool-calls' && toolCallTokens != null)),
        );
  if (hoveredSegment != null && !hoverIsValid(hoveredSegment)) {
    setHoveredSegment(null);
  }
  const activeSegment =
    hoveredSegment != null && hoverIsValid(hoveredSegment) ? hoveredSegment : null;

  return (
    <div className="@container w-full" role="region" aria-label={localize('com_ui_context_usage')}>
      <div
        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        data-usage-stage="heading"
      >
        <h3 className="text-text-secondary flex items-baseline gap-2 text-sm">
          {localize('com_ui_context_window')}
          {maxTokens != null && (
            <span className="text-text-primary font-semibold tabular-nums">
              {Math.round(percent)}%
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-text-secondary text-sm tabular-nums">
            {maxTokens != null
              ? `${formatTokens(usedTokens)} / ${formatTokens(maxTokens)}`
              : formatTokens(usedTokens)}
          </span>
        </div>
      </div>

      <SegmentedMeter
        className="mt-3"
        data-usage-stage="meter"
        segments={maxTokens != null ? meterSegments : []}
        max={maxTokens ?? 1}
        highlightId={activeSegment}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={maxTokens != null ? Math.round(percent) : undefined}
        aria-label={localize('com_ui_context_usage')}
      />

      <div className="mt-4 space-y-3" data-testid="context-details" data-usage-stage="details">
        {pressure !== 'none' && (
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
        )}
        <div
          className="grid grid-cols-2 gap-x-4 gap-y-2"
          data-testid={breakdown ? 'context-breakdown' : 'context-estimate'}
        >
          {breakdown ? (
            <>
              {segments.map(({ id, label, value, ...segment }) => {
                const shouldRender = value > 0 || (id === 'tool-calls' && toolCallTokens != null);
                if (!shouldRender) {
                  return null;
                }
                return (
                  <Fragment key={id}>
                    {id === 'tool-calls' && hasToolCounts ? (
                      <Row
                        label={label}
                        value={value}
                        segment={segment}
                        id={id}
                        activeId={activeSegment}
                        onHoverChange={setHoveredSegment}
                        onClick={() => setToolsExpanded((open) => !open)}
                        expanded={toolsExpanded}
                        controls={toolsExpanded ? toolBreakdownId : undefined}
                      />
                    ) : (
                      <Row
                        label={label}
                        value={value}
                        segment={segment}
                        id={id}
                        activeId={activeSegment}
                        onHoverChange={setHoveredSegment}
                      />
                    )}
                    {id === 'tool-calls' && toolsExpanded && hasToolCounts && (
                      <div id={toolBreakdownId} className="col-span-2 space-y-1 ps-6">
                        <p className="text-text-tertiary text-xs font-medium">
                          {localize('com_ui_context_tool_breakdown')}
                        </p>
                        {toolBreakdown.map((tool) => (
                          <Row
                            key={tool.name}
                            label={tool.name}
                            value={tool.tokens}
                            id="tool-calls"
                            activeId={activeSegment}
                            onHoverChange={setHoveredSegment}
                          />
                        ))}
                      </div>
                    )}
                    {id === 'system' && dynamicInstructionTokens > 0 && (
                      <div className="col-span-2 ps-6">
                        <Row
                          label={localize('com_ui_context_dynamic_instructions')}
                          value={dynamicInstructionTokens}
                          id="system"
                          activeId={activeSegment}
                          onHoverChange={setHoveredSegment}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
              {freeTokens != null && (
                <Row
                  label={localize('com_ui_context_free')}
                  value={freeTokens}
                  track
                  id="free"
                  activeId={activeSegment}
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
                />
              )}
              {view.messagesPruned ? (
                /** Over-window: the per-category split no longer describes what's
                 *  sent, so show the pruned message total (incl. in-flight). */
                <Row
                  label={localize('com_ui_context_messages')}
                  value={view.messageTokens + view.liveTokens}
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
               *  subtotal, as a peer row the visible rows would sum past
               *  `usedTokens`. The snapshot path instead subtracts it from
               *  Messages, which is exact there; here the counted Input/Output
               *  rows are provider counts and this share is a char estimate, so
               *  subtracting it would corrupt them. */}
              {normalizeTokenCount(view.toolCallTokens) > 0 && (
                <div className="col-span-2 ps-6">
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
                <p className="text-text-secondary text-xs">{localize('com_ui_context_unknown')}</p>
              )}
              <p className="text-text-secondary text-xs italic">{localize('com_ui_estimated')}</p>
            </>
          )}
        </div>
        {hasUsage && (
          <div className="border-border-light border-t pt-3">
            <Collapsible open={expanded} onOpenChange={onExpandedChange}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="disclosure"
                  size="bare"
                  className="group w-full justify-between"
                  data-testid="context-breakdown-toggle"
                >
                  {localize('com_ui_context_conversation_usage')}
                  {showCost && branchUsage.costKnown && Number.isFinite(view.branchCost) && (
                    <span className="ms-auto tabular-nums" data-testid="usage-cost">
                      <span className="sr-only">{localize('com_ui_context_cost')}: </span>
                      {formatCost(view.branchCost, currency)}
                    </span>
                  )}
                  <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent motion="height" className="overflow-hidden">
                <div className="space-y-3 pt-3">
                  {hasUsage && (
                    <Usage
                      disclosure={false}
                      hideHeading
                      title={localize('com_ui_context_conversation_usage')}
                      usage={branchUsage}
                      costLabel={localize('com_ui_context_cost')}
                      currency={currency}
                      testId="token-usage-totals"
                    />
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {langfuseSessionUrl && (
          <>
            <div className="border-border-light border-t" role="separator" />
            <Button asChild variant="link" size="bare" className="w-full justify-between">
              <a href={langfuseSessionUrl} target="_blank" rel="noopener noreferrer">
                <span>{localize('com_ui_langfuse_view_session')}</span>
                <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              </a>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
