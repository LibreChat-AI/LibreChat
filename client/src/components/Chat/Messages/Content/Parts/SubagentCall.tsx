import { useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { ChevronRight, Users } from 'lucide-react';
import { EModelEndpoint } from 'librechat-data-provider';
import type {
  PartMetadata,
  TAttachment,
  TMessage,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { SubagentTickerLine } from '~/utils/subagentContent';
import {
  activeSubagentPanel,
  subagentProgressKey,
  useSubagentProgress,
} from '~/components/Chat/Subagents/state';
import { adaptLivePersistedActivity } from '~/components/Chat/Subagents/adapters';
import { resolveSubagentAgentId } from '~/components/Chat/Subagents/identity';
import { useOpenSubagentPanel } from '~/components/Chat/Subagents/surface';
import { MessageContext } from '~/Providers/MessageContext';
import { useShareContext } from '~/Providers/ShareContext';
import MessageIcon from '~/components/Share/MessageIcon';
import { parseSubagentBackgroundHandle } from './handle';
import { isError } from '../ToolOutput/OutputRenderer';
import { useAgentsMapContext } from '~/Providers';
import { useMCPServerNames } from '~/hooks/MCP';
import { AttachmentGroup } from './Attachment';
import { useToolCallIntent } from './intent';
import { useFailedReveal } from '../reveal';
import { cn, parseToolName } from '~/utils';
import { useLocalize } from '~/hooks';

interface SubagentCallProps {
  toolCallId: string;
  initialProgress: number;
  /** True while the parent run is still streaming. Used — along with the
   *  tool_call's `progress` and any terminal subagent envelope — to decide
   *  whether the subagent is `running`, `cancelled`, or `finished`. */
  isSubmitting?: boolean;
  /** Terminal lifecycle status from `on_run_step_closed`, when the run
   *  emitted one. Authoritative over the `isSubmitting` inference. */
  runStepStatus?: PartMetadata['runStepStatus'];
  args?: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  /** Aggregated content parts the backend attached to the tool_call at
   *  message-save time. Takes precedence over the in-memory atom
   *  so a page refresh shows the same history the user saw live. Older
   *  runs recorded before the persistence path landed will not have this
   *  field; those fall back to the atom (or the raw `output` string). */
  persistedContent?: TMessageContentParts[];
  subagentIdentity?: PartMetadata['subagentIdentity'];
  hideAttachments?: boolean;
}

const TICKER_MAX_LINES = 3;
/** Trailing-edge refresh window for the live preview once the ticker has
 *  enough text to fill the row. Keeps long streaming lines from repainting
 *  every token while still letting the collapsed subagent UI feel responsive. */
export const SUBAGENT_TICKER_THROTTLE_MS = 400;
/** Below this live-buffer length we skip throttling entirely. Without
 *  this the user would see "Reasoning: I" for ~1s while the model
 *  streams the rest of the sentence — the pass-through lets early
 *  tokens appear right away, and throttling only kicks in once the
 *  preview is long enough to "fill the container". */
const TICKER_PASSTHROUGH_CHARS = 120;

/**
 * Trailing-edge throttle. Forwards `value` at most once per `intervalMs`
 * when `enabled` is true; pass-through when false so the final frame
 * lands without waiting out the interval.
 *
 * Uses refs + `useReducer` for the re-render trigger instead of
 * `useState(value)`: storing the throttled value as state would drive
 * an infinite update loop whenever the upstream `value` is a new
 * reference each render (e.g. a `useMemo` whose deps are stable by
 * content but not by identity), because `setState` with a new-reference
 * input always schedules another render.
 *
 * Ref mutations happen during render (idempotent — same value on
 * re-invoke under Strict/Concurrent rendering), but `setTimeout` is
 * confined to a `useEffect` so discarded renders don't leave orphan
 * timers firing against stale trees.
 */
function useThrottledValue<T>(value: T, intervalMs: number, enabled: boolean): T {
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const throttledRef = useRef<T>(value);
  const latestValueRef = useRef<T>(value);
  /** Negative-infinity sentinel so the very first render always falls
   *  through the "past the window" branch and the caller sees the
   *  initial value synchronously — no dead 1.2s while the first frame
   *  sits in the throttle. */
  const lastFireAtRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestValueRef.current = value;

  /** Render-time computation: pick the value the caller should see, and
   *  commit refs if we're past the throttle window. Ref writes are
   *  idempotent under Strict Mode double-invoke. No `setTimeout` here —
   *  that lives in the effect below so replayed renders don't strand
   *  timers. */
  let effectiveValue: T;
  if (!enabled) {
    effectiveValue = value;
  } else {
    const now = performance.now();
    const sinceLast = now - lastFireAtRef.current;
    if (sinceLast >= intervalMs) {
      throttledRef.current = value;
      lastFireAtRef.current = now;
      effectiveValue = value;
    } else {
      effectiveValue = throttledRef.current;
    }
  }

  /** Schedule the trailing-edge timer after commit. Runs whenever the
   *  throttled frame is stale relative to the latest value; the timer
   *  callback fires `forceUpdate` so the next render's render-time
   *  check commits the now-latest value. */
  useEffect(() => {
    if (!enabled) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (Object.is(throttledRef.current, latestValueRef.current)) return;
    if (timerRef.current != null) return;
    const sinceLast = performance.now() - lastFireAtRef.current;
    const delay = Math.max(0, intervalMs - sinceLast);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      forceUpdate();
    }, delay);
  }, [value, intervalMs, enabled]);

  /** Cleanup on unmount. */
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  return effectiveValue;
}

/**
 * Renders the parent's `subagent` tool call as a compact "what the child is
 * doing right now" ticker. The collapsed view shows short, user-readable
 * status lines — streaming text/reasoning previews plus tool-call lifecycle
 * markers — built from the `SubagentUpdateEvent` stream. Clicking opens a
 * artifacts-style panel that renders the child's aggregated activity through
 * the shared child-activity module, so every subagent mode uses one deep view.
 *
 * Progress is sourced from the `subagentProgressByToolCallId` atom
 * family, populated by `useStepHandler` as `ON_SUBAGENT_UPDATE` SSE
 * envelopes arrive. The atom is keyed by the parent message and
 * `tool_call_id`, since providers may reuse tool IDs across turns.
 */
export default function SubagentCall({
  toolCallId,
  initialProgress,
  isSubmitting = false,
  runStepStatus,
  args,
  output,
  attachments,
  persistedContent,
  subagentIdentity,
  hideAttachments = false,
}: SubagentCallProps) {
  const localize = useLocalize();
  const { isSharedConvo, shareId } = useShareContext();
  const parentMessageContext = useContext(MessageContext);
  const parentMessageId = parentMessageContext.messageId?.trim() ?? '';
  const partIndex = parentMessageContext.partIndex ?? 0;
  const progress = useSubagentProgress(subagentProgressKey(parentMessageId, toolCallId, partIndex));
  const setSelectedSubagent = useSetAtom(activeSubagentPanel);
  const openPanel = useOpenSubagentPanel();
  const agentsMap = useAgentsMapContext();
  const backgroundHandle = useMemo(
    () => parseSubagentBackgroundHandle(output, args),
    [output, args],
  );
  const parentConversationId = parentMessageContext.conversationId?.trim() ?? '';
  const canOpenDurablePanel =
    isSharedConvo !== true && backgroundHandle != null && parentConversationId !== '';

  const subagentType = progress?.subagentType ?? extractSubagentType(args);
  const isSelfSpawn = subagentType === 'self';
  const subagentAgentId = resolveSubagentAgentId(progress, subagentIdentity);
  const subagentAgent = subagentAgentId ? agentsMap?.[subagentAgentId] : undefined;
  /**
   * Tri-state status resolution, aligned with `ToolCall.tsx`:
   *
   * - `finished`: the tool_call's own progress reached 1 (backend wrote a
   *   result) OR the subagent explicitly emitted a `stop` / `error` phase.
   * - `cancelled`: the stream has ended (`!isSubmitting`) before either
   *   condition was met — e.g. user stop, dropped connection, backend
   *   crash. Without this check, an interrupted run would render as
   *   permanently "working…".
   * - `running`: the parent is still streaming and no terminal signal has
   *   arrived yet.
   */
  /**
   * A closed run step resolves the tri-state directly. It is the only signal
   * that distinguishes "this subagent was stopped" from "the parent stream
   * ended for some other reason", which the `!isSubmitting` inference below
   * cannot tell apart. That inference stays as the fallback for messages
   * saved before `on_run_step_closed` and endpoints that do not emit it.
   */
  const isClosed = runStepStatus != null;
  /**
   * An explicit `cancelled` close outranks a live `error` phase: aborting a
   * child can surface through its execution as an error, and the run's own
   * status is the authority on why it stopped.
   */
  const hasError =
    runStepStatus !== 'cancelled' &&
    (progress?.status === 'error' ||
      runStepStatus === 'failed' ||
      (typeof output === 'string' && isError(output)));
  const finished = isClosed
    ? runStepStatus !== 'cancelled'
    : initialProgress >= 1 || progress?.status === 'stop' || hasError;
  const cancelled = isClosed ? runStepStatus === 'cancelled' : !isSubmitting && !finished;
  const running = !finished && !cancelled;
  const detachedStatusUnknown = backgroundHandle != null && progress == null && !isSubmitting;

  /** Last `TICKER_MAX_LINES` lines from the atom's incrementally-built
   *  ticker state, so history isn't lost to any event trimming. */
  const tickerLines = useMemo<SubagentTickerLine[]>(() => {
    const lines = progress?.tickerState?.lines ?? [];
    return lines.slice(-TICKER_MAX_LINES);
  }, [progress?.tickerState?.lines]);

  /** Only throttle once the running buffer is wide enough to "fill the
   *  container" — pre-threshold updates pass through so the user sees
   *  early tokens immediately, not a static "Reasoning: I" while more
   *  text piles up behind the throttle. */
  const shouldThrottleTicker = useMemo(() => {
    if (!running) return false;
    const liveBody = tickerLines.reduce((max, line) => {
      if (line.kind === 'writing' || line.kind === 'reasoning') {
        return Math.max(max, line.body.length);
      }
      return max;
    }, 0);
    return liveBody >= TICKER_PASSTHROUGH_CHARS;
  }, [running, tickerLines]);

  const displayedTickerLines = useThrottledValue(
    tickerLines,
    SUBAGENT_TICKER_THROTTLE_MS,
    shouldThrottleTicker,
  );

  const prompt = typeof args === 'string' ? tryPrompt(args) : extractPrompt(args);

  /** Base verb-only label ("Running agent" / "Ran agent"). The agent name
   *  is rendered separately as a muted sub-label so "agent" stays a
   *  constant visual anchor regardless of name length. */
  /** Model-authored live label (subagent carries `intent` natively); wins
   *  over the generic verb, never over error/cancellation framing. */
  const intent = useToolCallIntent(args);
  const getHeaderText = () => {
    if (hasError) return localize('com_ui_subagent_errored');
    if (cancelled) return localize('com_ui_subagent_cancelled');
    if (detachedStatusUnknown) return localize('com_ui_subagent_activity');
    if (intent != null) return intent;
    if (running) return localize('com_ui_subagent_running');
    return localize('com_ui_subagent_complete');
  };
  const headerText = getHeaderText();
  /** Muted sub-label shown to the right of the base label: the
   *  configured agent name for named subagents. Self-spawns omit it
   *  (redundant — the header already says "agent") as do cases where
   *  the name isn't resolvable (agent map miss). */
  const subagentNameLabel = !isSelfSpawn && subagentAgent?.name ? subagentAgent.name : '';

  const canOpenDetails = useMemo(() => {
    const fallbackActivity = adaptLivePersistedActivity({
      title: '',
      progress: null,
      persistedContent,
      legacyOutput: backgroundHandle == null ? output : undefined,
      initialProgress,
      isSubmitting: false,
      runStepStatus,
      approvalVisibility: 'hidden',
    });
    const hasRenderableFallback = fallbackActivity.items.some(
      (item) =>
        (item.type !== 'writing' || item.text.length > 0) &&
        (item.type !== 'activity_label' || item.label.length > 0),
    );
    const hasParentContext = parentConversationId !== '' && parentMessageId !== '';
    const canOpenLiveForeground =
      isSharedConvo !== true && backgroundHandle == null && hasParentContext;
    return (
      /** No host, no panel to open — a search result renders this same card. */
      openPanel != null &&
      hasParentContext &&
      (canOpenDurablePanel || canOpenLiveForeground || hasRenderableFallback)
    );
  }, [
    backgroundHandle,
    openPanel,
    canOpenDurablePanel,
    initialProgress,
    isSharedConvo,
    output,
    parentConversationId,
    parentMessageId,
    persistedContent,
    runStepStatus,
  ]);

  const panelSelection = useMemo(
    () => ({
      host: isSharedConvo === true ? ('share' as const) : ('conversation' as const),
      ...(isSharedConvo === true && shareId != null ? { shareId } : {}),
      parentConversationId,
      parentMessageId,
      toolCallId,
      partIndex,
      subagentType,
      subagentIdentity,
      ...(prompt == null ? {} : { prompt }),
      ...(backgroundHandle == null ? { legacyOutput: output } : {}),
      ...(persistedContent == null ? {} : { persistedContent }),
      initialProgress,
      isSubmitting,
      ...(runStepStatus == null ? {} : { runStepStatus }),
      ...(backgroundHandle != null && canOpenDurablePanel
        ? {
            durable: {
              threadId: backgroundHandle.subagent_thread_id,
              taskId: backgroundHandle.background_task_id,
            },
          }
        : {}),
    }),
    [
      backgroundHandle,
      canOpenDurablePanel,
      initialProgress,
      isSharedConvo,
      isSubmitting,
      output,
      parentConversationId,
      parentMessageId,
      partIndex,
      persistedContent,
      prompt,
      runStepStatus,
      shareId,
      subagentType,
      subagentIdentity,
      toolCallId,
    ],
  );

  useEffect(() => {
    setSelectedSubagent((current) =>
      current?.parentMessageId === parentMessageId &&
      current.toolCallId === toolCallId &&
      current.partIndex === partIndex
        ? panelSelection
        : current,
    );
  }, [panelSelection, parentMessageId, partIndex, setSelectedSubagent, toolCallId]);

  const openDetails = useCallback(() => {
    if (!canOpenDetails || openPanel == null) return;
    openPanel(panelSelection);
  }, [canOpenDetails, openPanel, panelSelection]);
  const revealFailure = useCallback(
    (claimFocus: () => boolean) => {
      if (claimFocus()) {
        openDetails();
      }
    },
    [openDetails],
  );
  useFailedReveal(hasError && canOpenDetails, revealFailure);

  return (
    <>
      <button
        type="button"
        onClick={openDetails}
        disabled={!canOpenDetails}
        data-subagent-thread={
          canOpenDurablePanel ? backgroundHandle?.subagent_thread_id : undefined
        }
        data-subagent-tool-call={toolCallId}
        data-subagent-parent-message={parentMessageId}
        data-subagent-part-index={partIndex}
        className={cn(
          'border-border-light bg-surface-secondary my-2 flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition',
          canOpenDetails ? 'group hover:bg-surface-tertiary' : 'cursor-default opacity-80',
          running && !detachedStatusUnknown && 'animate-pulse-slow',
        )}
        aria-label={headerText}
      >
        <div className="text-text-primary flex items-center gap-2 text-sm font-medium">
          <div
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full',
              running && !subagentAgent && 'text-text-primary animate-pulse',
            )}
            aria-hidden="true"
          >
            {subagentAgent ? (
              <MessageIcon
                message={
                  {
                    endpoint: EModelEndpoint.agents,
                    isCreatedByUser: false,
                  } as TMessage
                }
                agent={subagentAgent}
              />
            ) : (
              <Users size={14} />
            )}
          </div>
          <span className="min-w-0 truncate" title={headerText}>
            {headerText}
          </span>
          {subagentNameLabel ? (
            <span
              className="text-text-secondary min-w-0 flex-1 truncate font-normal"
              title={subagentNameLabel}
            >
              {subagentNameLabel}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {canOpenDetails && (
            <ChevronRight
              size={14}
              className="text-text-secondary shrink-0 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          )}
        </div>

        <ul className="text-text-secondary w-full space-y-0.5 pl-5 font-mono text-xs">
          {displayedTickerLines.length === 0 && running ? (
            <li className="truncate opacity-70">{localize('com_ui_subagent_waiting')}</li>
          ) : null}
          {displayedTickerLines.map((line, i) => (
            <TickerLineView key={`${i}-${tickerLineKey(line)}`} line={line} />
          ))}
        </ul>
      </button>

      {!hideAttachments && attachments && attachments.length > 0 && (
        <AttachmentGroup attachments={attachments} />
      )}
    </>
  );
}

function extractSubagentType(args: SubagentCallProps['args']): string {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as { subagent_type?: string };
      return parsed?.subagent_type ?? 'agent';
    } catch {
      return 'agent';
    }
  }
  const a = args as { subagent_type?: string } | undefined;
  return a?.subagent_type ?? 'agent';
}

function extractPrompt(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['prompt', 'description', 'task', 'instructions']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function tryPrompt(args: string): string | undefined {
  try {
    return extractPrompt(JSON.parse(args) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Stable key for a ticker line — helps React reuse the DOM node across
 *  in-place updates to the same live `writing` / `reasoning` line, and
 *  gives tool-call lines a stable identity by tool name. */
function tickerLineKey(line: SubagentTickerLine): string {
  switch (line.kind) {
    case 'writing':
    case 'reasoning':
      return line.kind;
    case 'using_tool':
      return `using:${line.toolNames.join(',')}`;
    case 'tool_complete':
      return `done:${line.toolName}`;
    case 'error':
      return `error:${line.message ?? ''}`;
  }
}

/** Inline code-style tool-name badge. Matches the monospace styling of
 *  the ticker itself but with a subtle background so the tool identifier
 *  reads as a "code" token rather than plain prose. */
function ToolNameBadge({ name }: { name: string }): JSX.Element {
  return (
    <code className="bg-surface-tertiary text-text-primary shrink-0 rounded px-1">{name}</code>
  );
}

/** Render a single tool id as a compact JSX fragment: MCP tools split
 *  into `<server> · <code>toolName</code>`, native tools resolve their
 *  friendly name via `FRIENDLY_NAME_KEYS`, unknown ids fall back to a
 *  bare code badge of the raw name. */
function ToolIdentifier({
  rawName,
  localize,
  mcpServerNames,
}: {
  rawName: string;
  localize: ReturnType<typeof useLocalize>;
  mcpServerNames?: readonly string[];
}): JSX.Element {
  const parsed = parseToolName(rawName, mcpServerNames);
  if (parsed.mcpServer) {
    return (
      <span className="inline-flex min-w-0 shrink items-baseline gap-1">
        <span className="truncate">{parsed.mcpServer}</span>
        <span className="text-text-tertiary shrink-0">·</span>
        <ToolNameBadge name={parsed.toolName} />
      </span>
    );
  }
  if (parsed.friendlyKey) {
    return <span className="truncate">{localize(parsed.friendlyKey)}</span>;
  }
  return <ToolNameBadge name={parsed.toolName} />;
}

/**
 * Renderer for one ticker line. Writing is the default visible activity, so
 * it renders without a redundant prefix. Reasoning retains its semantic label.
 * Streaming bodies use `dir="rtl"` + `text-align: left` to push tail-side
 * ellipsis behavior (newest characters stay flush-right, oldest clip off the
 * left). The rtl trick is scoped to the body span so trailing punctuation on
 * non-streaming lines can't get flipped by bidi.
 *
 * Tool lines (`using_tool`, `tool_complete`) go through `ToolIdentifier`
 * so MCP-hosted tools render as `<server> · <tool>` badges and native
 * tools use their friendly names — matching the delimiter-aware
 * rendering the main tool UI already uses.
 */
function TickerLineView({ line }: { line: SubagentTickerLine }): JSX.Element {
  const localize = useLocalize();
  const mcpServerNames = useMCPServerNames();
  if (line.kind === 'writing') {
    return (
      <li className="text-text-primary flex w-full items-baseline overflow-hidden">
        <span
          dir="rtl"
          className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap"
        >
          {line.body}
        </span>
      </li>
    );
  }
  if (line.kind === 'reasoning') {
    return (
      <li className="text-text-primary flex w-full items-baseline gap-1 overflow-hidden">
        <span className="shrink-0">{localize('com_ui_subagent_ticker_reasoning')}:</span>
        <span
          dir="rtl"
          className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap"
        >
          {line.body}
        </span>
      </li>
    );
  }
  if (line.kind === 'using_tool') {
    const prefix = localize('com_ui_subagent_ticker_using');
    return (
      <li className="flex w-full items-baseline gap-1 overflow-hidden whitespace-nowrap">
        <span className="shrink-0">{prefix}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          {line.toolNames.map((name, i) => (
            <span key={`${i}-${name}`} className="flex min-w-0 items-baseline gap-1">
              {i > 0 && <span className="text-text-tertiary shrink-0">,</span>}
              <ToolIdentifier rawName={name} localize={localize} mcpServerNames={mcpServerNames} />
            </span>
          ))}
          {line.argsSnippet && (
            <span className="text-text-tertiary min-w-0 truncate">({line.argsSnippet})</span>
          )}
        </span>
      </li>
    );
  }
  if (line.kind === 'tool_complete') {
    return (
      <li className="flex w-full items-baseline gap-1 overflow-hidden whitespace-nowrap">
        <ToolIdentifier
          rawName={line.toolName}
          localize={localize}
          mcpServerNames={mcpServerNames}
        />
        <span className="text-text-tertiary shrink-0">→</span>
        <span
          dir="rtl"
          className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap"
        >
          {line.outputSnippet ?? localize('com_ui_subagent_ticker_tool_done')}
        </span>
      </li>
    );
  }
  /* error */
  const errorPrefix = localize('com_ui_subagent_ticker_error');
  return (
    <li className="text-text-warning flex w-full items-baseline gap-1 overflow-hidden">
      <span className="shrink-0">{errorPrefix}:</span>
      <span className="min-w-0 flex-1 truncate">{line.message ?? ''}</span>
    </li>
  );
}
