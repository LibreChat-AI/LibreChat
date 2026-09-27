import {
  memo,
  useId,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';
import { useAtomValue } from 'jotai';
import { Button } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import { Check, Lightbulb, ChevronDown, TriangleAlert } from 'lucide-react';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import {
  useLocalize,
  useExpandCollapse,
  useLazyCollapseBody,
  scheduleMessageContentLayoutReconcile,
  EXPAND_TRANSITION,
} from '~/hooks';
import {
  getFailedLines,
  getLiveActivity,
  getSpanIconNames,
  LIVE_ACTIVITY_THROTTLE_MS,
} from './live';
import { FailedRevealContext, FailedRevealPill, useFailedRevealTrigger } from './reveal';
import { FOLD_RAIL_CLASSES, ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from './rows';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import useThrottledValue from '~/hooks/Messages/useThrottledValue';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { getActivityLabelText } from '~/utils/activityLabels';
import { getOutcomeStatus, summarizeSpan } from './outcome';
import { sandboxStartingByToolCallId } from '~/store';
import { StackedToolIcons } from './ToolOutput';
import { getSourceDomains } from './sources';
import { mapAttachments } from '~/utils/map';
import SearchVerticals from './verticals';
import { AttachmentGroup } from './Parts';
import { cn } from '~/utils';

/** Matches `EXPAND_TRANSITION` so the panel and the label ticker resolve on
 *  the same curve — two properties animating on two different easings is what
 *  makes a fold read as two separate movements.
 *
 *  Written as an arbitrary PROPERTY, not `ease-[…]`: `tailwindcss-animate`
 *  registers its own `ease` utility for `animation-timing-function` alongside
 *  Tailwind's `transition-timing-function` one, so an arbitrary value matches
 *  both, and Tailwind resolves that ambiguity by emitting NOTHING. The class
 *  this replaces had been inert since the plugin landed — the curve it names
 *  never reached the fold. */
const FOLD_EASING = 'duration-300 [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]';

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

/** The header's icon slot. Its only job is geometric: every other row in the
 *  transcript opens with the same glyph slot and an 8px gap, so a summary
 *  rendered without one sits to the left of the rows it replaces — the fold
 *  then moves its own text sideways at the moment the reader is trying to
 *  follow it. */
function PhaseGlyph({ failed }: { failed: boolean }) {
  const Icon = failed ? TriangleAlert : Check;
  return (
    <span
      className={cn(ROW_GLYPH_SLOT, failed ? 'text-text-warning' : 'text-text-secondary')}
      aria-hidden="true"
    >
      <Icon size={14} />
    </span>
  );
}

/**
 * The phase header is a ticker, not a title. A client-synthesized card
 * re-titles itself every time it absorbs another finished block, and swapping
 * that text instantly is what makes the absorbed row look like it simply
 * vanished from under the reader. The retired line rises out of the clipped
 * row while the new summary comes up from below, so the work visibly moves
 * into the line that now stands for it.
 */
/**
 * The shimmering text of a live line, on its own element. `.shimmer` declares
 * `animation`, `position` and `display`, so sharing an element with the ticker
 * would replace the slide with the sweep — the retired line would never leave,
 * and would sit inline beside its successor. `align-top` keeps the inline box
 * from adding descender space, which made a live row 2px taller than the
 * settled row it becomes.
 */
function LiveLine({ text, previewRef }: { text: string; previewRef?: RefObject<HTMLSpanElement> }) {
  return (
    <span ref={previewRef} className="shimmer max-w-full truncate align-top">
      {text}
    </span>
  );
}

const PhaseLabel = memo(function PhaseLabel({
  text,
  animate,
  failed,
  source,
  live = false,
  grow = true,
  lineId,
  previewRef,
}: {
  text: string;
  animate: boolean;
  failed: boolean;
  /** Identity of what produced `text`. A streamed sentence keeps its source
   *  while it grows, and sliding a line out to bring a longer copy of itself
   *  in would read as flicker — so an unchanged source extends in place. */
  source?: string;
  live?: boolean;
  /** Claim the row's free space, the default. Cleared when something has to
   *  sit immediately after the text — the box then measures the line itself,
   *  so its neighbour reads as part of it instead of drifting to the margin. */
  grow?: boolean;
  /** Id for the current line, so a live disclosure can be named by it alone. */
  lineId?: string;
  previewRef?: RefObject<HTMLSpanElement>;
}) {
  const [lines, setLines] = useState<{
    current: string;
    retired: string | null;
    entered: boolean;
    source?: string;
  }>({ current: text, retired: null, entered: false, source });

  /** Adjusted during render rather than in an effect. A passive effect runs
   *  after paint, so a swap with no animation would leave the previous summary
   *  on screen for a frame while the button's `aria-label` already carried the
   *  new one. React re-renders this component immediately instead. */
  if (lines.current !== text || lines.source !== source) {
    const moved = source == null || source !== lines.source;
    const swaps = animate && lines.current.length > 0 && moved;
    setLines({
      current: text,
      retired: swaps ? lines.current : null,
      entered: swaps || (lines.entered && source != null && source === lines.source),
      source,
    });
  }

  /** Clears only the retired line. `entered` outlives it on purpose: dropping
   *  the incoming line's animation class the moment its partner's
   *  `animationend` fires would snap a still-running slide back to its resting
   *  position. The class is inert once the animation has finished, and the
   *  element is keyed by its text, so it cannot replay. */
  const clearRetired = useCallback(() => {
    setLines((previous) => (previous.retired == null ? previous : { ...previous, retired: null }));
  }, []);

  return (
    <span
      className={cn(
        'tool-status-text relative block min-w-0 overflow-hidden text-left',
        grow && 'flex-1',
      )}
      title={text}
    >
      {lines.retired != null && (
        <span
          key={`retired-${lines.retired}`}
          className={cn(
            'absolute inset-x-0 top-0 block truncate',
            'animate-out fade-out-0 slide-out-to-top-5 fill-mode-forwards',
            FOLD_EASING,
            failed && 'text-text-warning',
          )}
          /** The sweep on the inner span loops forever and its `animationend`
           *  never comes; only this element's own slide may clear the line. */
          onAnimationEnd={(event) => event.target === event.currentTarget && clearRetired()}
          aria-hidden="true"
        >
          {live ? <LiveLine text={lines.retired} /> : lines.retired}
        </span>
      )}
      <span
        /** Keyed by source while live, so a growing sentence updates one
         *  element instead of remounting — and replaying its slide — per paint. */
        key={`current-${source ?? lines.current}`}
        id={lineId}
        className={cn(
          'block truncate',
          lines.entered && `animate-in fade-in-0 slide-in-from-bottom-5 ${FOLD_EASING}`,
          failed && 'text-text-warning',
        )}
      >
        {live ? <LiveLine text={lines.current} previewRef={previewRef} /> : lines.current}
      </span>
    </span>
  );
});

/** Glyphs a span header shows: up to this many, of which at most `SPAN_SITES`
 *  are the sites a web search read. */
const SPAN_ICONS = 4;
const SPAN_SITES = 3;

/**
 * The settled header's glyph: what the span USED, not a bare check. A header
 * stands for the rows it hides, so it carries the most specific glyphs they
 * show — tool and MCP server icons, and the sites a web search read — and the
 * row keeps the icons it had while live instead of trading them for a tick.
 * Its own component so only a card that was handed its parts pays for the MCP
 * lookup. A failed phase keeps the warning glyph: status outranks identity.
 */
function SpanGlyph({
  parts,
  attachments,
}: {
  parts: ReadonlyArray<TMessageContentParts | undefined>;
  attachments?: TAttachment[];
}) {
  const mcpIconMap = useMCPIconMap();
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
 * full reasoning lines and tool activity repaint at most twice a second.
 * Short reasoning sentences stream freely until they fill the available row.
 */
function LivePhaseHeader({
  parts,
  animate,
  lineId,
  comboId,
  detailId,
  attachments,
  onAnnounce,
}: {
  parts: ReadonlyArray<TMessageContentParts | undefined>;
  animate: boolean;
  lineId: string;
  comboId: string;
  detailId: string;
  attachments?: TAttachment[];
  onAnnounce: (text: string) => void;
}) {
  const localize = useLocalize();
  const mcpIconMap = useMCPIconMap();
  const mcpServerNames = useMCPServerNames();
  const attachmentsById = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const activity = useMemo(
    () => getLiveActivity(parts, localize, mcpServerNames, attachmentsById),
    [parts, localize, mcpServerNames, attachmentsById],
  );
  /** A code card names its sandbox startup from events outside the content
   *  array. The row reads the same signal for its newest call, so the span
   *  never has to unfold for the card to say it. */
  const sandboxStarting = useAtomValue(
    sandboxStartingByToolCallId(activity.pendingToolCallId ?? ''),
  );
  const showSandboxStartup = sandboxStarting && activity.pendingToolCallId != null;
  const text = showSandboxStartup ? localize('com_ui_sandbox_starting') : activity.text;
  /** Startup describes this call, not the repeated tool. Throttle its text
   *  and suppressed count together so neither can paint with the old value. */
  const comboCount = showSandboxStartup ? 1 : activity.comboCount;
  const { source } = activity;
  const line = useMemo(() => ({ text, source, comboCount }), [text, source, comboCount]);
  const previewRef = useRef<HTMLSpanElement>(null);
  /** The full width the line may occupy, which is the flex track rather than
   *  the label box: the box shrinks to its text whenever the multiplier rides
   *  beside it, and measuring that would call every line full. */
  const lineRowRef = useRef<HTMLSpanElement>(null);
  const [isPreviewFull, setIsPreviewFull] = useState(false);
  const painted = useThrottledValue(
    line,
    source.startsWith('think:') && !isPreviewFull ? 0 : LIVE_ACTIVITY_THROTTLE_MS,
  );
  const measurePreview = useCallback(() => {
    const preview = previewRef.current;
    const width = lineRowRef.current?.clientWidth ?? 0;
    setIsPreviewFull(width > 0 && (preview?.scrollWidth ?? 0) >= width);
  }, []);

  /** Measure the painted sentence, not the accumulated reasoning or the next
   *  queued line: a newly displayed short sentence must fill before it waits. */
  useLayoutEffect(measurePreview, [measurePreview, painted.text, painted.source]);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const row = lineRowRef.current;
    if (!preview || !row || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measurePreview);
    observer.observe(row);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [measurePreview, painted.source]);
  const iconKey = activity.iconNames.join('|');
  const iconNames = useMemo(() => (iconKey ? iconKey.split('|') : []), [iconKey]);
  const sourceDomains = useMemo(() => getSourceDomains(attachments, SPAN_SITES), [attachments]);

  /** The span's verdict, separate from its newest line: an earlier call can
   *  fail while a later one runs, and the line alone would never say so. The
   *  hidden group header carries the same counts in the same words. */
  const { failed, cancelled } = activity.outcome;
  const combo = painted.comboCount > 1 ? `×${painted.comboCount}` : '';
  const failedNote =
    failed > 0
      ? localize(failed === 1 ? 'com_ui_one_action_failed' : 'com_ui_n_actions_failed', {
          0: String(failed),
        })
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
    <>
      {iconNames.length === 0 ? (
        /** A span that is only reasoning so far has no tool to show; it takes
         *  the glyph the reasoning row itself uses. */
        <span
          className={cn(ROW_GLYPH_SLOT, 'animate-pulse text-text-primary')}
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
            maxIcons={SPAN_ICONS}
            sourceDomains={sourceDomains}
            status={getOutcomeStatus(activity.outcome)}
            isAnimating
          />
        </span>
      )}
      {/** The multiplier counts the line it is printed next to, so it travels
       *  with that line instead of sitting out at the row's right edge beside
       *  the chevron, where it read as a property of the row. `Create File ×2`
       *  in the unfolded group is the same phrase in the same order. It is a
       *  separate element rather than part of the line's text so the
       *  disclosure's name keeps a space before it and the ticker still
       *  animates one sentence at a time. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5" ref={lineRowRef}>
        <PhaseLabel
          text={painted.text}
          source={painted.source}
          failed={false}
          animate={animate}
          live
          grow={combo === ''}
          lineId={lineId}
          previewRef={previewRef}
        />
        {combo !== '' && (
          <span
            id={comboId}
            className="shrink-0 text-xs font-normal text-text-secondary"
            data-testid="live-phase-combo"
          >
            {combo}
          </span>
        )}
      </span>
      {detail !== '' && (
        <span
          id={detailId}
          className="shrink-0 text-xs font-normal text-text-warning"
          data-testid="live-phase-outcome"
        >
          {/** The failure count is spoken here, as part of the header's name,
           *  and SHOWN by the pill beside the header, which is also the way to
           *  the failed rows. Only a stop count has no pill and stays visible.
           *  The verdict is the span's, not the newest line's, so it keeps its
           *  own separator from whatever the row happens to be saying. */}
          {failedNote !== '' && <span className="sr-only">· {failedNote}</span>}
          {cancelledNote !== '' && (
            <>
              <span className="mr-1 text-text-secondary">·</span>
              <span>{cancelledNote}</span>
            </>
          )}
        </span>
      )}
    </>
  );
}

/**
 * The first failed call of a collapsed card, on a row of its own beneath the
 * header, the way the cursor row peeks while streaming: the failure is
 * readable, and one click away, without unfolding. Its own component so only
 * a collapsed card with a failure pays for the line's lookups.
 */
function FailedPeek({
  parts,
  attachmentsById,
  count,
  onReveal,
}: {
  parts: ReadonlyArray<TMessageContentParts | undefined>;
  attachmentsById: Record<string, TAttachment[] | undefined>;
  count: number;
  onReveal: () => void;
}) {
  const localize = useLocalize();
  const mcpServerNames = useMCPServerNames();
  const first = useMemo(
    () => getFailedLines(parts, localize, mcpServerNames, attachmentsById)[0],
    [parts, localize, mcpServerNames, attachmentsById],
  );
  if (first == null) {
    return null;
  }
  return (
    <button
      type="button"
      className={cn(
        TOOL_ROW_CLASSES,
        'w-full pl-6 text-left text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-heavy',
      )}
      onClick={onReveal}
      data-testid="activity-phase-failed-peek"
    >
      <span className={cn(ROW_GLYPH_SLOT, 'text-status-error')} aria-hidden="true">
        <TriangleAlert size={14} />
      </span>
      <span className="tool-status-text flex min-w-0 items-center gap-2">
        <span className="min-w-0 max-w-full shrink-0 truncate font-medium text-status-error">
          {first.text}
        </span>
        {first.detail !== '' && (
          <span className="min-w-0 shrink truncate font-normal">{first.detail}</span>
        )}
      </span>
      {count > 1 && (
        <span className="shrink-0 text-xs font-normal">
          {localize('com_ui_plus_n_more', { 0: String(count - 1) })}
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs font-medium underline underline-offset-2">
        {localize('com_ui_show_error')}
      </span>
    </button>
  );
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
}: {
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
}) {
  const isLive = liveParts != null;
  const label = getActivityLabelText(labelPart);
  const hasFailure = labelPart.status === 'failed' || labelPart.status === 'partial';
  const outcomeParts = spanParts ?? liveParts;
  const attachmentsById = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  /** The span's failed calls, for the peek under a collapsed header and the
   *  pill beside it. Read from the same parts the header's glyph and live
   *  line read, so the three can never disagree about the count. */
  const failedCount = useMemo(
    () => (outcomeParts == null ? 0 : summarizeSpan(outcomeParts, attachmentsById).failed),
    [outcomeParts, attachmentsById],
  );

  /** Already `smoothStreaming && !reducedMotion` — it owns the media query, so
   *  a second subscription here would install one `matchMedia` listener per
   *  phase card without changing the answer. */
  const smoothStreaming = useSmoothStreaming();
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
  const peek =
    hasContent && !isExpanded && failedCount > 0 && outcomeParts != null ? (
      <FailedPeek
        parts={outcomeParts}
        attachmentsById={attachmentsById}
        count={failedCount}
        onReveal={handleRevealFailed}
      />
    ) : null;

  /** Only the folding entrance drives the header off its natural height.
   *  History and reduced-motion render the plain, unstyled row. */
  const headerStyle = useMemo<CSSProperties | undefined>(() => {
    if (!foldsIn) {
      return undefined;
    }
    return {
      display: 'grid',
      gridTemplateRows: isSettled ? '1fr' : '0fr',
      transition: EXPAND_TRANSITION,
      opacity: isSettled ? 1 : 0,
    };
  }, [foldsIn, isSettled]);

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
    <div
      className={cn(
        'mb-2 mt-1 flex min-h-7 w-full items-center gap-2 py-1 text-text-secondary',
        shouldAnimateEntrance && `animate-in fade-in-0 motion-reduce:animate-none ${FOLD_EASING}`,
      )}
      data-testid="activity-phase-card"
    >
      <PhaseGlyph failed={hasFailure} />
      <span
        className={cn(
          'tool-status-text min-w-0 flex-1 truncate text-left font-medium',
          hasFailure && 'text-text-warning',
        )}
        role="status"
        title={label}
      >
        {label}
      </span>
    </div>
  ) : (
    /** No chrome. A phase summary is another row in the same list as the tool
     *  groups it stands for, so it carries the same geometry: 16px glyph, 8px
     *  gap, no inset. Boxing it was what put its text on a third left edge and
     *  forced every folded row 13px sideways as the box materialized. */
    <div className="mb-2 mt-1 w-full" ref={rootRef} data-testid="activity-phase-card">
      <span className="sr-only" role="status" data-testid="activity-phase-announcer">
        {announcement}
      </span>
      <div
        style={headerStyle}
        /** Pinned while open, so a run long enough to scroll keeps its name
         *  at the top of the viewport. The containing block is this card, so
         *  the header stops pinning where its own rows end. */
        className={cn(isExpanded && 'sticky top-0 z-[1] bg-presentation')}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <Button
            variant="ghost"
            type="button"
            /** `ring-inset` is not decoration: the clip above is permanent (the
             *  grid rows need it), so an outset ring would be drawn entirely
             *  outside the button's border box and clipped away, leaving
             *  keyboard users with no focus indicator. The ghost variant
             *  supplies it today; stating it here keeps the requirement with
             *  the element that depends on it. */
            className={cn(
              'flex h-auto min-h-7 min-w-0 flex-1 items-center justify-start gap-2 rounded-none bg-transparent p-0 py-1 text-left font-medium text-text-secondary hover:bg-transparent hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-heavy focus-visible:ring-offset-0',
              /** The open card's title: the one semibold, primary-colour line
               *  in the fold, so the rows under it read as its contents. */
              isExpanded && 'font-semibold text-text-primary',
            )}
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-controls={panelId}
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
                lineId={lineId}
                comboId={comboId}
                detailId={detailId}
                attachments={attachments}
                onAnnounce={setAnnouncement}
              />
            ) : (
              <>
                {outcomeParts != null && !hasFailure ? (
                  <SpanGlyph parts={outcomeParts} attachments={attachments} />
                ) : (
                  <PhaseGlyph failed={hasFailure} />
                )}
                <PhaseLabel text={label} failed={hasFailure} animate={smoothStreaming} />
              </>
            )}
            <ChevronDown
              className={cn(
                'size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
                isExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </Button>
          <FailedRevealPill count={failedCount} onReveal={handleRevealFailed} />
        </div>
      </div>
      {peek}
      <div
        id={panelId}
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        aria-hidden={!isExpanded}
        data-testid="activity-phase-panel"
      >
        {shouldRenderBody && (
          <div className={cn('overflow-hidden', FOLD_RAIL_CLASSES)} ref={expandRef}>
            <FailedRevealContext.Provider value={revealValue}>
              {children}
            </FailedRevealContext.Provider>
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
