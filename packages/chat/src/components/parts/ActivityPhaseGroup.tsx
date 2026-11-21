import { useId, useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { cn, useLocalize } from '@librechat/client';
import { Lightbulb, ChevronDown } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import type { CSSProperties, ReactNode } from 'react';
import type { RailHover } from './rail';
import {
  getLiveActivity,
  getSpanIconNames,
  LIVE_ACTIVITY_THROTTLE_MS,
  LIVE_REASONING_HOLD_MS,
} from './phase/activity';
import {
  FoldRail,
  RailGlyph,
  useFoldPath,
  useRailHover,
  revealFoldHeader,
  FoldHeaderContext,
} from './rail';
import { scheduleMessageContentLayoutReconcile } from '../../react/messages/messageLayout';
import { FailedRevealContext, FailedRevealPill, useFailedRevealTrigger } from './reveal';
import { getOutcomeStatus, isSpanFailed, summarizeSpan } from '../../core/parts/outcome';
import { FOLD_RAIL_CLASSES, ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from './rows';
import useExpandCollapse, { EXPAND_TRANSITION } from './useExpandCollapse';
import { GeneratedToolLabelContext } from '../../react/parts/disclosure';
import useLazyCollapseBody from '../../react/parts/useLazyCollapseBody';
import { getActivityLabelText } from '../../core/parts/activityLabels';
import { MessageSurfaceContext } from '../../react/messages/surface';
import useThrottledValue from '../../react/parts/useThrottledValue';
import PhaseMarker, { PhaseGlyph } from './phase/Marker';
import { mapAttachments } from '../../core/attachments';
import { useMessagePartsHost } from '../../react/host';
import useServerIcons from '../../react/parts/icons';
import StackedToolIcons from './StackedToolIcons';
import PackageLivePhaseHeader from './phase/Live';
import { HeaderActionSlotContext } from './slot';
import { AttachmentGroup } from './Attachment';
import { getSourceDomains } from './sources';
import SearchVerticals from './verticals';
import PhaseLabel from './PhaseLabel';
import { useFoldParts } from './fold';

type ActivityPhasePart = Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }> & {
  activity_label_type?: 'phase';
  activity_start_index?: number;
  activity_end_index?: number;
};

/**
 * Runs `callback` once the browser has painted the current styles. One frame
 * is not enough: React can flush passive effects before paint, and a start
 * value the compositor never saw produces an instant jump rather than a
 * transition. Returns a canceller for whichever frame is still pending.
 */
function schedulePostPaint(callback: () => void): () => void {
  let frameId: number | undefined;
  frameId = window.requestAnimationFrame(() => {
    frameId = window.requestAnimationFrame(() => {
      frameId = undefined;
      callback();
    });
  });
  return () => {
    if (frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = undefined;
    }
  };
}

/** Glyphs a span header shows: up to this many, of which at most `SPAN_SITES`
 *  are the sites a web search read. */
const SPAN_ICONS = 4;
const SPAN_SITES = 3;

/**
 * The settled header's glyph: what the span USED, not a bare check. A header
 * stands for the rows it hides, so it carries the most specific glyphs they
 * show (tool and MCP server icons, and the sites a web search read), and the
 * row keeps the icons it had while live instead of trading them for a tick.
 * Its own component so only a card that was handed its parts pays for the MCP
 * lookup. A phase whose every call failed shows the failure glyph instead:
 * status outranks identity only when nothing in the span succeeded.
 */
function SpanGlyph({
  parts,
  attachments,
}: {
  parts: ReadonlyArray<TMessageContentParts | undefined>;
  attachments?: TAttachment[];
}): React.JSX.Element {
  const { names: mcpServerNames, icons: mcpIconMap } = useServerIcons();
  const iconNames = useMemo(() => getSpanIconNames(parts), [parts]);
  const outcome = useMemo(
    () => summarizeSpan(parts, mapAttachments(attachments ?? [])),
    [parts, attachments],
  );
  const sourceDomains = useMemo(() => getSourceDomains(attachments, SPAN_SITES), [attachments]);
  if (iconNames.length === 0 && outcome.failed === 0 && outcome.cancelled === 0) {
    return <PhaseGlyph failed={false} />;
  }
  return (
    <span className={cn(ROW_GLYPH_SLOT, 'text-text-secondary')} aria-hidden="true">
      <StackedToolIcons
        toolNames={iconNames}
        mcpIconMap={mcpIconMap}
        mcpServerNames={mcpServerNames}
        maxIcons={SPAN_ICONS}
        sourceDomains={sourceDomains}
        status={getOutcomeStatus(outcome)}
      />
    </span>
  );
}

/**
 * The header of a span the run is still writing: the span's tool icons,
 * pulsing, in the slot the settled check takes over, beside the newest line.
 *
 * Its own component so only a live card pays for it — the localization and MCP
 * lookups, and the throttle. `liveParts` is rebuilt on every streamed delta;
 * tool activity repaints at most twice a second and a finished reasoning
 * sentence holds the line for at least a second.
 */
function LivePhaseHeader({
  parts,
  animate,
  expanded,
  lineId,
  comboId,
  detailId,
  attachments,
  onAnnounce,
  railHover,
}: {
  parts: ReadonlyArray<TMessageContentParts | undefined>;
  animate: boolean;
  /** The rows are on screen: title the span by its newest label rather than
   *  repeat a line the reader can see below. */
  expanded: boolean;
  lineId: string;
  comboId: string;
  detailId: string;
  attachments?: TAttachment[];
  onAnnounce: (text: string) => void;
  railHover: RailHover;
}): React.JSX.Element {
  const localize = useLocalize();
  const host = useMessagePartsHost();
  const { names: mcpServerNames, icons: mcpIconMap } = useServerIcons();
  const attachmentsById = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const activity = useMemo(
    () => getLiveActivity(parts, localize, mcpServerNames, attachmentsById, expanded),
    [parts, localize, mcpServerNames, attachmentsById, expanded],
  );
  /** A code card names its sandbox startup from events outside the content
   *  array. The row reads the same signal for its newest call, so the span
   *  never has to unfold for the card to say it. */
  const sandboxStarting = host.useSandboxStarting(activity.pendingToolCallId ?? '');
  const showSandboxStartup = sandboxStarting && activity.pendingToolCallId != null;
  const text = showSandboxStartup ? localize('com_ui_sandbox_starting') : activity.text;
  /** Startup describes this call, not the repeated tool. Throttle its text
   *  and suppressed count together so neither can paint with the old value. */
  const comboCount = showSandboxStartup ? 1 : activity.comboCount;
  const { source } = activity;
  const line = useMemo(
    () => ({ text, source, comboCount, isBackgroundTaskCheck: activity.isBackgroundTaskCheck }),
    [text, source, comboCount, activity.isBackgroundTaskCheck],
  );
  /** A thought's line is a finished sentence and holds for a beat; everything
   *  else repaints at the ordinary cadence. */
  const painted = useThrottledValue(
    line,
    source.startsWith('think:') ? LIVE_REASONING_HOLD_MS : LIVE_ACTIVITY_THROTTLE_MS,
  );
  const iconKey = activity.iconNames.join('|');
  const iconNames = useMemo(() => (iconKey ? iconKey.split('|') : []), [iconKey]);
  const sourceDomains = useMemo(() => getSourceDomains(attachments, SPAN_SITES), [attachments]);

  /** The span's verdict, separate from its newest line: an earlier call can
   *  fail while a later one runs, and the line alone would never say so. The
   *  hidden group header carries the same counts in the same words. */
  const { failed, cancelled } = activity.outcome;
  const total = activity.total;
  let combo = '';
  if (painted.comboCount > 1) {
    combo = painted.isBackgroundTaskCheck
      ? `· ${localize('com_ui_background_tasks_n_checks', { 0: String(painted.comboCount) })}`
      : `×${painted.comboCount}`;
  }
  const failedNote =
    failed > 0
      ? localize('com_ui_n_of_n_actions_failed', { 0: String(failed), 1: String(total) })
      : '';
  const cancelledNote =
    cancelled > 0
      ? localize(cancelled === 1 ? 'com_ui_one_action_cancelled' : 'com_ui_n_actions_cancelled', {
          0: String(cancelled),
        })
      : '';
  const detail = [failedNote, cancelledNote].filter(Boolean).join(' · ');

  /** Announcements have their own identity, apart from the ticker's. A line
   *  is spoken once, when it is left and therefore complete; an outcome is
   *  spoken the moment it changes, because `running → failed` on one call
   *  keeps its source and would otherwise wait for the next call to be heard. */
  const spokenRef = useRef({ source: painted.source, text: painted.text, detail: '' });
  useEffect(() => {
    const spoken = spokenRef.current;
    if (detail !== spoken.detail && detail) {
      onAnnounce(detail);
    } else if (painted.source !== spoken.source && spoken.text) {
      onAnnounce(spoken.text);
    }
    spokenRef.current = { source: painted.source, text: painted.text, detail };
  }, [painted, detail, onAnnounce]);

  return (
    <PackageLivePhaseHeader
      text={painted.text}
      source={painted.source}
      animate={animate}
      lineId={lineId}
      comboId={comboId}
      detailId={detailId}
      combo={combo}
      isBackgroundTaskCheck={painted.isBackgroundTaskCheck}
      failedNote={failedNote}
      cancelledNote={cancelledNote}
      railHover={railHover}
      glyph={
        iconNames.length === 0 ? (
          /** A span that is only reasoning so far has no tool to show; it takes
           *  the glyph the reasoning row itself uses. */
          <span
            className={cn(ROW_GLYPH_SLOT, 'text-text-primary animate-pulse')}
            aria-hidden="true"
            data-testid="live-phase-thinking"
          >
            <Lightbulb size={14} />
          </span>
        ) : (
          <span className={ROW_GLYPH_SLOT} aria-hidden="true">
            <StackedToolIcons
              toolNames={iconNames}
              mcpIconMap={mcpIconMap}
              mcpServerNames={mcpServerNames}
              maxIcons={SPAN_ICONS}
              sourceDomains={sourceDomains}
              status={getOutcomeStatus({ ...activity.outcome, total: activity.total })}
              isAnimating
            />
          </span>
        )
      }
    />
  );
}

export interface ActivityPhaseGroupProps {
  labelPart: ActivityPhasePart;
  children: ReactNode;
  hasContent: boolean;
  /** Files the phase produced, lifted out of the fold by the parent renderer.
   *  A summary card is collapsed the moment it settles, so anything rendered
   *  inside it is, for most readers, not rendered at all — and a chart the run
   *  spent its turn producing is exactly what the reader came for. They ride
   *  their own row under the header instead, where the fold cannot take
   *  them. */
  attachments?: TAttachment[];
  showCursor?: boolean;
  animateEntrance?: boolean;
  hasPendingApproval?: boolean;
  /** The span's parts while the run is still writing it. Present, the header
   *  reads the newest activity out of them — throttled — instead of a
   *  generated label, and renders as a live row rather than a settled one. */
  liveParts?: ReadonlyArray<TMessageContentParts | undefined>;
  /** The span's parts once settled, for the header's icon stack. */
  spanParts?: ReadonlyArray<TMessageContentParts | undefined>;
  onExpansionChange?: (expanded: boolean) => void;
  /** The app's embedded views for the phase's attachments, drawn under its files. */
  renderAppViews?: (attachments: TAttachment[]) => ReactNode;
}

export default function ActivityPhaseGroup({
  labelPart,
  children,
  hasContent,
  attachments,
  showCursor = false,
  animateEntrance = false,
  hasPendingApproval = false,
  liveParts,
  spanParts,
  onExpansionChange,
  renderAppViews,
}: ActivityPhaseGroupProps): React.JSX.Element {
  const messageSurface = useContext(MessageSurfaceContext);
  const isLive = liveParts != null;
  const label = getActivityLabelText(labelPart);
  /** Only a phase in which every call failed reads as failed in its header.
   *  A partial phase contains a mixture of outcomes; the count beside it and the failed
   *  rows inside say what went wrong without restyling the title. */
  const allFailed = labelPart.status === 'failed';
  const outcomeParts = spanParts ?? liveParts;
  const attachmentsById = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  /** The span's failed calls, for the peek under a collapsed header and the
   *  pill beside it. Read from the same parts the header's glyph and live
   *  line read, so the three can never disagree about the count. */
  const { failed: failedCount, total: toolCount } = useMemo(
    () =>
      outcomeParts == null ? { failed: 0, total: 0 } : summarizeSpan(outcomeParts, attachmentsById),
    [outcomeParts, attachmentsById],
  );

  /** One call and nothing else has no tree to draw, so it lays out like the
   *  same call without a title: no rail, no indent. */
  const [actionSlot, setActionSlot] = useState<HTMLSpanElement | null>(null);
  const soleCall =
    toolCount === 1 && !outcomeParts?.some((part) => part?.type === ContentTypes.THINK);

  const partialMarkerFallback =
    labelPart.status === 'partial' &&
    (!hasContent || failedCount === 0 || isSpanFailed(failedCount, toolCount));

  /** Already `smoothStreaming && !reducedMotion` — it owns the media query, so
   *  a second subscription here would install one `matchMedia` listener per
   *  phase card without changing the answer. */
  const smoothStreaming = useMessagePartsHost().useSmoothStreaming();
  /** Capture the marker's arrival state. The parent renderer records the new
   *  marker after this commit; a later sibling update must not cancel the
   *  already-scheduled fold before its first animation frame. */
  const [shouldAnimateEntrance] = useState(smoothStreaming && animateEntrance && label.length > 0);
  /** A filled phase marker lands on top of activity the reader is already
   *  looking at. The header therefore mounts at zero height with the panel
   *  open — the shape of what was there BEFORE it — and trades one for the
   *  other on the next painted frame. Growing the header while the panel
   *  collapses keeps the block's height strictly decreasing, so the content
   *  compresses upward instead of being shoved down by a header that appeared
   *  underneath it and then yanked back up. Those two grid rows are the ONLY
   *  properties in flight: the card chrome that used to fade in alongside
   *  them (border, background, padding, divider) is gone, and with it the
   *  sideways step its inset used to impose on every folded row. */
  const foldsIn = shouldAnimateEntrance && hasContent;
  const [isExpanded, setIsExpanded] = useState(foldsIn);
  const [isSettled, setIsSettled] = useState(!foldsIn);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFoldParts(rootRef, outcomeParts);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const railHover = useRailHover();
  const railScope = useMemo(() => ({ header: headerRef, expanded: isExpanded }), [isExpanded]);
  const panelId = useId();
  const lineId = useId();
  const comboId = useId();
  const detailId = useId();
  /** One polite region for the card's whole life. It sits outside the button,
   *  so it never joins the disclosure's name, and it outlives the live header:
   *  a region that mounts already holding text is not announced, so the
   *  generated summary is spoken through the region that was there before. */
  const [announcement, setAnnouncement] = useState('');
  const previousHeader = useRef({ isLive, label });
  useEffect(() => {
    const previous = previousHeader.current;
    previousHeader.current = { isLive, label };
    if (!isLive && label && (previous.isLive || previous.label !== label)) {
      setAnnouncement(label);
    }
  }, [isLive, label]);
  const cancelEntranceRef = useRef<(() => void) | null>(null);
  const cancelLayoutReconcileRef = useRef<(() => void) | null>(null);
  const previousIsExpandedRef = useRef(isExpanded);
  const userOverrideRef = useRef(false);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  /** A phase label can resolve while an approval card inside it is still
   *  pending (see ApprovalContext), and ToolApproval owns unsent local
   *  edit/respond/reason state — so a collapsed phase retains its body until
   *  every nested approval resolves, exactly like ToolCallGroup. */
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(
    isExpanded,
    hasPendingApproval,
  );
  useFoldPath(rootRef, shouldRenderBody);
  const { value: revealValue, requestReveal } = useFailedRevealTrigger(
    isExpanded && shouldRenderBody,
  );

  useEffect(() => {
    if (!foldsIn || userOverrideRef.current) {
      return;
    }
    cancelEntranceRef.current = schedulePostPaint(() => {
      cancelEntranceRef.current = null;
      if (userOverrideRef.current) {
        return;
      }
      setIsSettled(true);
      setIsExpanded(false);
    });
    return () => {
      cancelEntranceRef.current?.();
      cancelEntranceRef.current = null;
    };
  }, [foldsIn]);

  useEffect(() => {
    const wasExpanded = previousIsExpandedRef.current;
    previousIsExpandedRef.current = isExpanded;
    if (wasExpanded && !isExpanded) {
      cancelLayoutReconcileRef.current?.();
      cancelLayoutReconcileRef.current = scheduleMessageContentLayoutReconcile(rootRef.current);
    }
  }, [isExpanded]);

  useEffect(
    () => () => {
      cancelLayoutReconcileRef.current?.();
    },
    [],
  );

  const handleToggle = useCallback(() => {
    userOverrideRef.current = true;
    cancelEntranceRef.current?.();
    cancelEntranceRef.current = null;
    mountBody();
    setIsSettled(true);
    onExpansionChange?.(!isExpanded);
    setIsExpanded(!isExpanded);
  }, [mountBody, isExpanded, onExpansionChange]);

  /** The rail stays drawn while the panel animates shut, so a second click on
   *  it must not reopen what the first one closed. */
  const handleRailCollapse = useCallback(() => {
    if (!isExpanded) {
      return;
    }
    revealFoldHeader(rootRef.current, headerRef.current);
    handleToggle();
  }, [isExpanded, handleToggle]);

  /** One click to the error from a closed card: open the card the way a
   *  toggle would, then ask every failed row below to open its own panel. */
  const handleRevealFailed = useCallback(() => {
    userOverrideRef.current = true;
    cancelEntranceRef.current?.();
    cancelEntranceRef.current = null;
    mountBody();
    setIsSettled(true);
    if (!isExpanded) {
      onExpansionChange?.(true);
      setIsExpanded(true);
    }
    requestReveal();
  }, [mountBody, isExpanded, onExpansionChange, requestReveal]);

  /** An open card is titled by its stable label: the rows themselves carry
   *  the live line now, and a header that kept tickering above them would
   *  swap its text under a reader who is looking at the list. A live span
   *  with no label yet keeps the live line, which is all it has. */
  const showLiveHeader = isLive && (!isExpanded || label.length === 0);
  /** The live slot under a collapsed card alternates between this cursor and
   *  the next call's row for the rest of the run: a label fills, the row it
   *  headed folds into the card and the cursor takes its place; the next call
   *  starts and the cursor gives way to a row again. A cursor in a bare
   *  `Container` (20px, no margins) was 12px shorter than the tool row
   *  (`my-1.5 h-5`), so everything beneath the card stepped up on every
   *  absorb and back down on every call. The cursor takes the row's exact box,
   *  and the dot sits in the row's glyph slot. `.result-thinking` draws the
   *  dot as an absolutely positioned pseudo-element 11px above its line —
   *  right for the streaming-markdown cursor, wrong here — so `after:!static`
   *  puts that one pseudo-element back in flow for the slot to center; the
   *  `!` is what outranks the dot rule's three-class selector. */
  const cursor = showCursor ? (
    <div className={TOOL_ROW_CLASSES} data-testid="activity-phase-cursor">
      <span className={cn(ROW_GLYPH_SLOT, 'submitting')} aria-hidden="true">
        <span className="result-thinking block after:!static" />
      </span>
    </div>
  ) : null;
  /** `AttachmentGroup` drops `web_search` attachments, and the nested segment
   *  renders with `hideAttachments` so its own `WebSearch` row stands down
   *  for this hoist — so without `SearchVerticals` here a phase containing a
   *  search would swallow its images, products and places instead of lifting
   *  them out of the fold. Mirrors `ToolCallGroup`'s own hoist. */
  const media =
    attachments != null && attachments.length > 0 ? (
      <>
        <SearchVerticals attachments={attachments} />
        <AttachmentGroup attachments={attachments} />
        {renderAppViews?.(attachments)}
      </>
    ) : null;
  if (!label && !isLive) {
    return (
      <>
        {children}
        {media}
      </>
    );
  }
  const group = !hasContent ? (
    <PhaseMarker
      label={label}
      failed={allFailed}
      partial={partialMarkerFallback}
      animate={shouldAnimateEntrance}
    />
  ) : (
    /** No chrome. A phase summary is another row in the same list as the tool
     *  groups it stands for, so it carries the same geometry: 16px glyph, 8px
     *  gap, no inset. Boxing it was what put its text on a third left edge and
     *  forced every folded row 13px sideways as the box materialized. */
    <div
      className="mt-1 mb-2 w-full"
      ref={rootRef}
      data-testid="activity-phase-card"
      data-fold-root=""
    >
      <span className="sr-only" role="status" data-testid="activity-phase-announcer">
        {announcement}
      </span>
      <div
        ref={headerRef}
        /** Only the folding entrance drives the header off its natural height.
         *  History and reduced-motion render the plain, unstyled row. */
        style={
          foldsIn
            ? ({
                '--tool-expand-rows': isSettled ? '1fr' : '0fr',
                '--tool-expand-opacity': isSettled ? 1 : 0,
                '--tool-expand-transition': EXPAND_TRANSITION,
              } as CSSProperties)
            : undefined
        }
        /** Pinned while open, so a run long enough to scroll keeps its name
         *  at the top of the viewport. The containing block is this card, so
         *  the header stops pinning where its own rows end. */
        className={cn(
          foldsIn && 'tool-call-expand',
          isExpanded && 'sticky top-0 z-[1]',
          isExpanded && messageSurface,
        )}
      >
        <div className="relative flex items-center gap-2 overflow-hidden pe-6">
          <button
            type="button"
            /** `ring-inset` is not decoration: the clip above is permanent (the
             *  grid rows need it), so an outset ring would be drawn entirely
             *  outside the button's border box and clipped away, leaving
             *  keyboard users with no focus indicator. The ghost variant
             *  supplies it today; stating it here keeps the requirement with
             *  the element that depends on it. */
            className={cn(
              'text-text-secondary hover:text-text-primary focus-visible:ring-focus-subtle flex h-auto min-h-7 min-w-0 flex-1 items-center justify-start gap-2 rounded-none bg-transparent p-0 py-1 text-start font-medium hover:bg-transparent focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none focus-visible:ring-inset',
              /** The open card's title: the one semibold line in the fold, so the
               *  rows under it read as its contents. Its colour does not change. */
              isExpanded && 'font-semibold',
            )}
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-controls={panelId}
            data-fold-toggle=""
            /** A live header is named by its own content: the line it shows
             *  is resolved inside `LivePhaseHeader`, below this component. It
             *  is named by that line ALONE: the polite region beside it holds
             *  the previous line, and `sr-only` text still counts toward a
             *  button's computed name. */
            aria-label={showLiveHeader ? undefined : label}
            /** Unresolved ids are skipped, so one list covers a row with no
             *  multiplier and no outcome note as well as a row with both. */
            aria-labelledby={showLiveHeader ? `${lineId} ${comboId} ${detailId}` : undefined}
          >
            {showLiveHeader ? (
              <LivePhaseHeader
                parts={liveParts}
                animate={smoothStreaming}
                expanded={isExpanded}
                lineId={lineId}
                comboId={comboId}
                detailId={detailId}
                attachments={attachments}
                onAnnounce={setAnnouncement}
                railHover={railHover}
              />
            ) : (
              <>
                <RailGlyph hover={railHover}>
                  {outcomeParts != null && !allFailed && !partialMarkerFallback ? (
                    <SpanGlyph parts={outcomeParts} attachments={attachments} />
                  ) : (
                    <PhaseGlyph failed={allFailed} partial={partialMarkerFallback} />
                  )}
                </RailGlyph>
                <PhaseLabel text={label} animate={smoothStreaming} />
              </>
            )}
            <ChevronDown
              className={cn(
                'absolute end-0 size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
                isExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
          <FailedRevealPill count={failedCount} total={toolCount} onReveal={handleRevealFailed} />
          <span ref={setActionSlot} className="flex shrink-0 items-center empty:hidden" />
        </div>
      </div>
      <div
        id={panelId}
        className="tool-call-expand"
        style={
          {
            '--tool-expand-rows': expandStyle.gridTemplateRows,
            '--tool-expand-opacity': expandStyle.opacity,
            '--tool-expand-transition': expandStyle.transition,
          } as CSSProperties
        }
        onTransitionEnd={handleTransitionEnd}
        aria-hidden={!isExpanded}
        data-testid="activity-phase-panel"
      >
        {shouldRenderBody && (
          <div
            className={cn('min-h-0 overflow-hidden', !soleCall && FOLD_RAIL_CLASSES)}
            ref={expandRef}
            data-fold-panel=""
          >
            {!soleCall && (
              <FoldRail hover={railHover} expanded={isExpanded} onCollapse={handleRailCollapse} />
            )}
            <FoldHeaderContext.Provider value={railScope}>
              <HeaderActionSlotContext.Provider value={actionSlot}>
                <FailedRevealContext.Provider value={revealValue}>
                  <GeneratedToolLabelContext.Provider value={toolCount === 1 && label.length > 0}>
                    {children}
                  </GeneratedToolLabelContext.Provider>
                </FailedRevealContext.Provider>
              </HeaderActionSlotContext.Provider>
            </FoldHeaderContext.Provider>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <>
      {group}
      {media}
      {cursor}
    </>
  );
}
