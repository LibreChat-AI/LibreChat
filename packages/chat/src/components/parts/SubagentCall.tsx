import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { Button, cn } from '@librechat/client';
import { ChevronRight, Users } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { PartMetadata, TAttachment, TMessageContentParts } from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Agent } from 'librechat-data-provider';
import type { MessagePartMessage, MessagePartsHost, ToolCallChrome } from '../../react/host';
import type { SubagentContentPreview } from '../../react/subagents/state';
import {
  activeSubagentPanel,
  subagentProgressKey,
  useSubagentProgress,
} from '../../react/subagents/state';
import { isLiveSubagentStatus, subagentStatusLabelKey } from '../../react/subagents/status';
import { MessagePartsHostProvider, useMessagePartsHost } from '../../react/host';
import { isSelfSpawn as isSelfSpawnType } from '../../react/subagents/author';
import { pickTailIndex, pickTailPart } from '../../react/subagents/tail';
import { parseSubagentBackgroundHandle } from '../../core/parts/handle';
import { lastVisibleContentIdx } from '../../core/parts/activityLabels';
import { resolveSubagentAgentId } from '../../react/subagents/identity';
import { useOpenSubagentPanel } from '../../react/subagents/surface';
import { useParentSubagents } from '../../react/subagents/parents';
import { useThreadInterest } from '../../react/subagents/follows';
import { getSubagentPrompt } from '../../react/subagents/prompt';
import { PartsPreviewContext } from '../../react/parts/preview';
import { FailedRevealContext, useFailedReveal } from './reveal';
import { useToolCallIntent } from '../../react/parts/intent';
import { useBranchTailSelect } from '../../react/latest';
import { useToolPreparation } from './preparation';
import { isError } from '../../core/parts/output';
import { FOLD_GLYPH_CLASS } from './rows';

export interface SubagentCallProps {
  toolCallId: string;
  initialProgress: number;
  /** True while the parent run is still streaming. Used, along with the
   *  tool_call's `progress` and any terminal subagent envelope, to decide
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
  /** The server sent this call as a preview; the panel loads the stored part when opened. */
  contentPreview?: SubagentContentPreview;
  subagentIdentity?: PartMetadata['subagentIdentity'];
  hideAttachments?: boolean;
}

/** App subscriptions arrive as values; render callbacks contain no card behavior. */
export type SubagentCallContext = Pick<ToolCallChrome, 'localize' | 'renderAttachments'> &
  Pick<MessagePartsHost, 'renderAgentIcon'> & {
    message: Pick<MessagePartMessage, 'messageId' | 'conversationId' | 'partIndex'>;
    isSharedConvo?: boolean;
    shareId?: string;
    agentsMap?: Record<string, Agent | undefined>;
  };

/** Trailing-edge refresh window for the live preview once the ticker has
 *  enough text to fill the row. Keeps long streaming lines from repainting
 *  every token while still letting the collapsed subagent UI feel responsive. */
export const SUBAGENT_TICKER_THROTTLE_MS = 400;
/** Below this live-buffer length we skip throttling entirely. Without
 *  this the user would see "Reasoning: I" for ~1s while the model
 *  streams the rest of the sentence. The pass-through lets early
 *  tokens appear right away, and throttling only kicks in once the
 *  preview is long enough to "fill the container". */
const PREVIEW_PASSTHROUGH_CHARS = 120;

/**
 * Trailing-edge throttle for the ticker. Forwards `value` at most once per
 * `intervalMs` when `enabled` is true; pass-through when false so the final
 * frame lands without waiting out the interval.
 *
 * The shared `useThrottledValue` always throttles and stores the frame in
 * state. A ticker line array is a new reference whenever its text changes, and
 * storing that reference as state retriggers the effect. Refs plus
 * `useReducer` publish one frame per window instead.
 *
 * Ref mutations happen during render (idempotent, same value on
 * re-invoke under Strict/Concurrent rendering), but `setTimeout` is
 * confined to a `useEffect` so discarded renders don't leave orphan
 * timers firing against stale trees.
 */
function useTickerThrottle<T>(value: T, intervalMs: number, enabled: boolean): T {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const throttledRef = useRef<T>(value);
  const latestValueRef = useRef<T>(value);
  /** Negative-infinity sentinel so the very first render always falls
   *  through the "past the window" branch and the caller sees the
   *  initial value synchronously. No dead frame while the first
   *  value sits in the throttle. */
  const lastFireAtRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestValueRef.current = value;

  /** Render-time computation: pick the value the caller should see, and
   *  commit refs if we're past the throttle window. Ref writes are
   *  idempotent under Strict Mode double-invoke. No `setTimeout` here.
   *  That lives in the effect below so replayed renders don't strand
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
 * status lines (streaming text/reasoning previews plus tool-call lifecycle
 * markers) built from the `SubagentUpdateEvent` stream. Clicking opens an
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
  contentPreview,
  subagentIdentity,
  hideAttachments = false,
  message,
  isSharedConvo,
  shareId,
  localize,
  agentsMap,
  renderAgentIcon,
  renderAttachments,
}: SubagentCallProps & SubagentCallContext): ReactNode {
  const parentMessageId = message.messageId?.trim() ?? '';
  const partIndex = message.partIndex ?? 0;
  const progress = useSubagentProgress(subagentProgressKey(parentMessageId, toolCallId, partIndex));
  const setSelectedSubagent = useSetAtom(activeSubagentPanel);
  const openPanel = useOpenSubagentPanel();
  const backgroundHandle = useMemo(
    () => parseSubagentBackgroundHandle(output, args),
    [output, args],
  );
  const parentConversationId = message.conversationId?.trim() ?? '';
  const canOpenDurablePanel =
    isSharedConvo !== true && backgroundHandle != null && parentConversationId !== '';

  const subagentType = progress?.subagentType ?? extractSubagentType(args);
  const isSelfSpawn = isSelfSpawnType(
    subagentType,
    progress?.subagentKind ?? subagentIdentity?.subagentKind,
  );
  /** A detached child's identity as the parent's index reports it, once the parent's own stream
   *  that named it is gone. */
  const { byThreadId } = useParentSubagents();
  const indexedChild =
    backgroundHandle == null ? undefined : byThreadId.get(backgroundHandle.subagent_thread_id);
  const subagentAgentId =
    resolveSubagentAgentId(progress, subagentIdentity) ?? indexedChild?.agentId;
  const subagentAgent = subagentAgentId ? agentsMap?.[subagentAgentId] : undefined;
  /**
   * Tri-state status resolution, aligned with `ToolCall.tsx`:
   *
   * - `finished`: the tool_call's own progress reached 1 (backend wrote a
   *   result) OR the subagent explicitly emitted a `stop` / `error` phase.
   * - `cancelled`: the stream has ended (`!isSubmitting`) before either
   *   condition was met, for example a user stop, a dropped connection, or a
   *   backend crash. Without this check, an interrupted run would render as
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

  /** The child's newest part: the row it is on right now. */
  const tailPart = useMemo(() => {
    const parts = (progress?.contentParts ?? []) as TMessageContentParts[];
    const index = lastVisibleContentIdx(parts);
    return index < 0 ? undefined : { part: parts[index], index };
  }, [progress?.contentParts]);

  const preview = useThrottledRow(tailPart, running);
  const showPreview = running && preview != null;

  const prompt = getSubagentPrompt(args);

  /** Base verb-only label ("Running agent" / "Ran agent"). The agent name
   *  is rendered separately as a muted sub-label so "agent" stays a
   *  constant visual anchor regardless of name length. */
  /** Model-authored live label (subagent carries `intent` natively); wins
   *  over the generic verb, never over error/cancellation framing. */
  const intent = useToolCallIntent(args);
  const preparationText = useToolPreparation();
  const getHeaderText = () => {
    if (hasError) return localize('com_ui_subagent_errored');
    if (cancelled) return localize('com_ui_subagent_cancelled');
    if (detachedStatusUnknown) return localize('com_ui_subagent_activity');
    if (running && preparationText != null) return preparationText;
    if (intent != null) return intent;
    if (running) return localize('com_ui_subagent_running');
    return localize('com_ui_subagent_complete');
  };
  const headerText = getHeaderText();
  /** A named subagent leads with its own name and face, the way its turns read
   *  in main chat, and the verb or status follows it muted. Self-spawns keep
   *  the verb alone (the name would be the agent this card already sits
   *  under), as do agents the map cannot resolve. */
  const subagentNameLabel = !isSelfSpawn && subagentAgent?.name ? subagentAgent.name : '';

  const cardLabel = subagentNameLabel ? `${subagentNameLabel}: ${headerText}` : headerText;

  const canOpenDetails = useMemo(() => {
    const hasParentContext = parentConversationId !== '' && parentMessageId !== '';
    if (openPanel == null || !hasParentContext) return false;
    if (canOpenDurablePanel || (isSharedConvo !== true && backgroundHandle == null)) return true;
    return (
      persistedContent?.some((part) => {
        if (part == null) return false;
        if (part.type === ContentTypes.ACTIVITY_LABEL) return Boolean(part.activity_label?.trim());
        if (part.type === ContentTypes.TEXT) {
          return typeof part.text === 'string' ? part.text.length > 0 : Boolean(part.text?.value);
        }
        return true;
      }) === true ||
      (backgroundHandle == null && output != null && output !== '')
    );
  }, [
    backgroundHandle,
    openPanel,
    canOpenDurablePanel,
    isSharedConvo,
    output,
    parentConversationId,
    parentMessageId,
    persistedContent,
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
      ...(attachments == null ? {} : { attachments }),
      ...(contentPreview == null ? {} : { contentPreview }),
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
      attachments,
      backgroundHandle,
      canOpenDurablePanel,
      contentPreview,
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
      current?.host === panelSelection.host &&
      current.shareId === panelSelection.shareId &&
      current.parentConversationId === parentConversationId &&
      current.parentMessageId === parentMessageId &&
      current.toolCallId === toolCallId &&
      current.partIndex === partIndex &&
      (current.durable == null ||
        (current.durable.threadId === panelSelection.durable?.threadId &&
          current.durable.taskId === panelSelection.durable?.taskId))
        ? panelSelection
        : current,
    );
  }, [
    panelSelection,
    parentConversationId,
    parentMessageId,
    partIndex,
    setSelectedSubagent,
    toolCallId,
  ]);

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
      <div className={cn('relative my-2', PREVIEW_ROOM)}>
        <Button
          variant="activity-card"
          data-running={running && !detachedStatusUnknown}
          onClick={openDetails}
          disabled={!canOpenDetails}
          data-subagent-thread={
            canOpenDurablePanel ? backgroundHandle?.subagent_thread_id : undefined
          }
          data-subagent-tool-call={toolCallId}
          data-subagent-parent-message={parentMessageId}
          data-subagent-part-index={partIndex}
          className={cn(canOpenDetails && 'group')}
          aria-label={detachedStatusUnknown ? undefined : cardLabel}
        >
          <div className="text-text-primary flex w-full min-w-0 items-center gap-2 text-sm font-medium">
            <div
              className={cn(
                FOLD_GLYPH_CLASS,
                'flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full',
                running &&
                  !subagentAgent &&
                  'text-text-primary animate-pulse motion-reduce:animate-none',
              )}
              aria-hidden="true"
            >
              {subagentAgent ? renderAgentIcon(subagentAgent) : <Users size={14} />}
            </div>
            {subagentNameLabel ? (
              <>
                <span
                  className="max-w-[50%] min-w-0 shrink truncate font-semibold"
                  title={subagentNameLabel}
                >
                  {subagentNameLabel}
                </span>
                <span
                  className="text-text-secondary min-w-0 flex-1 truncate font-normal"
                  title={detachedStatusUnknown ? undefined : headerText}
                >
                  {detachedStatusUnknown && backgroundHandle != null ? (
                    <DetachedTaskStatus
                      threadId={backgroundHandle.subagent_thread_id}
                      taskId={backgroundHandle.background_task_id}
                      fallback={headerText}
                      localize={localize}
                    />
                  ) : (
                    headerText
                  )}
                </span>
              </>
            ) : (
              <>
                <span
                  className="min-w-0 truncate"
                  title={detachedStatusUnknown ? undefined : headerText}
                >
                  {detachedStatusUnknown && backgroundHandle != null ? (
                    <DetachedTaskStatus
                      threadId={backgroundHandle.subagent_thread_id}
                      taskId={backgroundHandle.background_task_id}
                      fallback={headerText}
                      localize={localize}
                    />
                  ) : (
                    headerText
                  )}
                </span>
                <span className="flex-1" />
              </>
            )}
            {canOpenDetails && (
              <ChevronRight
                size={14}
                className="text-text-secondary shrink-0 transition group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                aria-hidden="true"
              />
            )}
          </div>

          {!showPreview && running ? (
            <div className="text-text-secondary w-full truncate text-sm opacity-70">
              {localize('com_ui_subagent_waiting')}
            </div>
          ) : null}
        </Button>
        {showPreview ? (
          <SubagentPreview
            key={preview.index}
            part={preview.part}
            messageId={`${parentMessageId}:${toolCallId}:${partIndex}:preview`}
          />
        ) : null}
        {!showPreview && canOpenDurablePanel && backgroundHandle != null ? (
          <DetachedPreview
            threadId={backgroundHandle.subagent_thread_id}
            taskId={backgroundHandle.background_task_id}
          />
        ) : null}
      </div>

      {!hideAttachments && attachments != null && attachments.length > 0
        ? renderAttachments(attachments)
        : null}
    </>
  );
}

/**
 * A detached child's status as the parent's subagent index last reported it.
 * Its own leaf so an index refresh re-renders this text alone, never the card
 * or the message around it; with no indexed answer the card keeps its neutral
 * label rather than guessing.
 */
function DetachedTaskStatus({
  threadId,
  taskId,
  fallback,
  localize,
}: {
  localize: ToolCallChrome['localize'];
  threadId: string;
  taskId: string;
  fallback: string;
}): ReactNode {
  const status = useDetachedStatus(threadId, taskId);
  return <>{status == null ? fallback : localize(subagentStatusLabelKey(status))}</>;
}

/** A detached task's status in the parent's subagent index, when the index has one. */
function useDetachedStatus(threadId: string, taskId: string) {
  const { byThreadId, discover } = useParentSubagents();
  const child = byThreadId.get(threadId);
  /** A child dispatched after the index was last read is not in it; the index is told. */
  useEffect(() => {
    if (child == null) {
      discover(threadId);
    }
  }, [child, discover, threadId]);
  return (
    child?.tasks.find((task) => task.taskId === taskId)?.status ??
    (child?.latestTaskId === taskId ? child.status : undefined)
  );
}

/**
 * A detached child's row, read from its thread's messages wherever something is following that
 * thread. Its own leaf, so a streamed token re-renders this row alone and never the card.
 */
function DetachedPreview({ threadId, taskId }: { threadId: string; taskId: string }): ReactNode {
  const status = useDetachedStatus(threadId, taskId);
  const live = status != null && isLiveSubagentStatus(status);
  /**
   * A running child is followed for its row; the page follows it once, with or without a panel.
   * Its messages outlive the following: a child the page has no room to preview keeps what was
   * last read for it, which is not what it is doing now, so its row is shown only while it is
   * being followed.
   */
  const followed = useThreadInterest(threadId, { live: true, enabled: live, passive: true });
  const part = useBranchTailSelect(threadId, threadId, pickTailPart);
  const index = useBranchTailSelect(threadId, threadId, pickTailIndex);
  const row = useMemo(
    () => (part == null || index == null ? undefined : { part, index }),
    [part, index],
  );
  const shown = useThrottledRow(row, live && followed);
  if (shown == null || !live || !followed) {
    return null;
  }
  return (
    <SubagentPreview
      key={shown.index}
      part={shown.part}
      messageId={`${threadId}:${taskId}:preview`}
    />
  );
}

type PreviewRow = { part: TMessageContentParts; index: number };

/**
 * A child's row at the pace the card redraws it. Short text passes straight through, so the
 * first tokens appear at once; once the live text is long enough to fill the row it refreshes on
 * the throttle, wherever the row comes from, instead of on every token.
 */
function useThrottledRow(row: PreviewRow | undefined, running: boolean): PreviewRow | undefined {
  const throttled = useMemo(() => {
    if (!running || row == null) return false;
    const { part } = row;
    let text: unknown = '';
    if (part.type === ContentTypes.TEXT) text = part.text;
    else if (part.type === ContentTypes.THINK) text = part.think;
    return typeof text === 'string' && text.length >= PREVIEW_PASSTHROUGH_CHARS;
  }, [running, row]);
  return useTickerThrottle(row, SUBAGENT_TICKER_THROTTLE_MS, throttled);
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

const PREVIEW_ROW_HEIGHT = 'h-8';
/** No request to reveal a failure reaches a picture, and it claims no focus. */
const NO_REVEAL = { tick: 0, claimFocus: null };
/** A tool artifact is always some other row's: a picture never draws it and never takes it. */
const PICTURE_CLAIM: [string | null, Dispatch<SetStateAction<string | null>>] = [
  'subagent-preview',
  () => undefined,
];
const useNoClaim = (): [string | null, Dispatch<SetStateAction<string | null>>] => PICTURE_CLAIM;
/**
 * The line above the row dissolves at the top edge instead of being cut through. A mask stencil,
 * not paint: only its alpha is read, so it is not a theme color.
 */
const PREVIEW_FADE =
  '[mask-image:linear-gradient(to_bottom,transparent,rgb(var(--black)/1)_0.625rem)]';
/** Room under the header for the row, kept by the card only while a row is drawn over it. */
const PREVIEW_ROOM = '[&:has([data-subagent-preview])>button]:pb-11';
/** `inert` as an attribute: React 18's types do not know it. */
const INERT: Record<string, string> = { inert: '' };

/**
 * The row the child is on right now, drawn by the renderer the thread itself uses and shown one
 * row at a time: the same tool row, reasoning row or text a reader sees after opening the child,
 * held to the card's last line. It is a picture of that row, not a control: it sits over the
 * card instead of inside its button, takes no pointer or focus, and is hidden from assistive
 * technology, which reads the card's label.
 */
function SubagentPreview({
  part,
  messageId,
}: {
  part: TMessageContentParts;
  messageId: string;
}): ReactNode {
  const host = useMessagePartsHost();
  const content = useMemo(() => [part], [part]);
  const pictureHost = useMemo(() => ({ ...host, useToolArtifactClaim: useNoClaim }), [host]);
  return (
    <div
      {...INERT}
      aria-hidden="true"
      data-subagent-preview
      className={cn(
        'pointer-events-none absolute inset-x-[calc(0.75rem+1px)] bottom-[calc(0.5rem+1px)] overflow-hidden',
        PREVIEW_ROW_HEIGHT,
        PREVIEW_FADE,
      )}
    >
      {/* Held to its last line: what the child wrote most recently is the part in view. */}
      <div className="absolute inset-x-0 bottom-0">
        {/* A picture of the child's row and nothing more: the row itself registers what it
            holds with the app, owns its artifacts and answers a request to reveal a failure. */}
        <PartsPreviewContext.Provider value={true}>
          <FailedRevealContext.Provider value={NO_REVEAL}>
            <MessagePartsHostProvider host={pictureHost}>
              {host.renderContentParts({
                content,
                messageId,
                conversationId: null,
                isCreatedByUser: false,
                showThinking: false,
                isSubmitting: true,
                isLast: true,
                /** The row is live: a renderer told otherwise draws a tool still running as
                 *  stopped. */
                isLatestMessage: true,
              })}
            </MessagePartsHostProvider>
          </FailedRevealContext.Provider>
        </PartsPreviewContext.Provider>
      </div>
    </div>
  );
}
