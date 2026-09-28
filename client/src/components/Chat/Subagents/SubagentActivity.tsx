import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Button } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import { CSSTransition } from 'react-transition-group';
import { CheckCircle2, Clock3, Maximize2, Minimize2, XCircle } from 'lucide-react';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ChildActivity, ChildActivityItem } from './adapters';
import type { TranslationKeys } from '~/hooks';
import {
  isAbnormalTerminalStatus,
  isLiveSubagentStatus,
  subagentStatusIcon,
  subagentStatusLabelKey,
} from './status';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import ContentParts from '~/components/Chat/Messages/Content/ContentParts';
import Container from '~/components/Chat/Messages/Content/Container';
import { EmptyText } from '~/components/Chat/Messages/Content/Parts';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { showThinkingAtom } from '~/store/showThinking';
import { useChatSurface } from './surface';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AT_BOTTOM_THRESHOLD_PX = 120;
const CONTROL_ACTION_LABELS = {
  steer: 'com_ui_subagent_control_steer',
  queue: 'com_ui_subagent_control_queue',
  interrupt: 'com_ui_subagent_control_interrupt',
  cancel: 'com_ui_subagent_control_cancel',
  cancel_message: 'com_ui_subagent_control_cancel_message',
} as const satisfies Record<string, TranslationKeys>;
const CONTROL_STATUS_LABELS = {
  submitted: 'com_ui_subagent_control_status_submitted',
  accepted: 'com_ui_subagent_control_status_accepted',
  applied: 'com_ui_subagent_control_status_applied',
  rejected: 'com_ui_subagent_control_status_rejected',
  failed: 'com_ui_subagent_control_status_failed',
} as const satisfies Record<string, TranslationKeys>;
const CONTROL_REASON_LABELS: Record<string, TranslationKeys> = {
  control_not_found: 'com_ui_subagent_control_reason_control_not_found',
  invalid_command: 'com_ui_subagent_control_reason_invalid_command',
  owner_unavailable: 'com_ui_subagent_control_reason_owner_unavailable',
  task_inaccessible: 'com_ui_subagent_control_reason_task_inaccessible',
  task_cancelled: 'com_ui_subagent_control_reason_task_cancelled',
  task_completed: 'com_ui_subagent_control_reason_task_completed',
  task_failed: 'com_ui_subagent_control_reason_task_failed',
  task_not_running: 'com_ui_subagent_control_reason_task_not_running',
  withdrawn: 'com_ui_subagent_control_reason_withdrawn',
};

function SubagentControlHistory({
  controls,
  onCancelControl,
}: {
  controls: NonNullable<ChildActivity['controls']>;
  onCancelControl?: (controlId: string) => void;
}) {
  const localize = useLocalize();
  if (controls.length === 0) return null;
  /** Storage keeps actionable accepted receipts ahead of bounded terminal history.
   * Presentation restores chronology without changing that retention priority. */
  const chronologicalControls = controls
    .map((control, index) => ({ control, index }))
    .sort(
      (left, right) =>
        left.control.createdAt.localeCompare(right.control.createdAt) || left.index - right.index,
    )
    .map(({ control }) => control);
  return (
    <section aria-label={localize('com_ui_subagent_control_history')} className="mb-3 space-y-2">
      {chronologicalControls.map((control) => {
        const pending = control.status === 'submitted' || control.status === 'accepted';
        let StatusIcon = XCircle;
        if (pending) StatusIcon = Clock3;
        if (control.status === 'applied') StatusIcon = CheckCircle2;
        return (
          <div
            key={control.invocationId}
            className="rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusIcon size={14} aria-hidden className="shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 font-medium">
                {localize(CONTROL_ACTION_LABELS[control.action])}
              </span>
              <span className="ml-auto shrink-0 text-xs text-text-secondary" aria-live="polite">
                {localize(CONTROL_STATUS_LABELS[control.status])}
              </span>
              {control.status === 'accepted' &&
                control.controlId != null &&
                onCancelControl != null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => onCancelControl(control.controlId as string)}
                  >
                    {localize('com_ui_subagent_control_withdraw')}
                  </Button>
                )}
            </div>
            {control.message != null && control.message !== '' && (
              <div className="mt-1 break-words text-text-secondary">
                {control.message}
                {control.messageTruncated === true && (
                  <span className="ml-1 text-xs italic">
                    {localize('com_ui_subagent_control_message_truncated')}
                  </span>
                )}
              </div>
            )}
            {control.reason != null && (
              <div className="mt-1 text-xs text-status-error">
                {localize(
                  CONTROL_REASON_LABELS[control.reason] ??
                    'com_ui_subagent_control_reason_invalid_command',
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function SubagentActivityScrollSurface({
  children,
  padded = true,
  headerInset = false,
}: {
  children: React.ReactNode;
  padded?: boolean;
  /** Clears the panel's overlay header, which floats above this surface so the
   *  thread scrolls under it rather than starting below a solid bar. */
  headerInset?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollButtonRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isSettled, setIsSettled] = useState(false);
  const { showScrollButton: scrollButtonPreference, maximizeChatSpace } = useChatSurface();

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll == null || content == null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (isAtBottom) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [isAtBottom]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setIsAtBottom(
      element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_THRESHOLD_PX,
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setIsAtBottom(true);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn('min-h-0 flex-1 overflow-y-auto', padded && 'px-4 py-4')}
        data-subagent-activity-scroll-surface
      >
        <div ref={contentRef} className={cn(headerInset && 'pt-[52px]')}>
          {children}
        </div>
      </div>
      <CSSTransition
        in={!isAtBottom && scrollButtonPreference}
        timeout={{ enter: 300, exit: 180 }}
        classNames="scroll-animation"
        unmountOnExit={true}
        appear={true}
        nodeRef={scrollButtonRef}
        onEntered={() => setIsSettled(true)}
        onExit={() => setIsSettled(false)}
      >
        <ScrollToBottom
          ref={scrollButtonRef}
          scrollHandler={scrollToBottom}
          maximizeChatSpace={maximizeChatSpace}
          interactive={isSettled}
        />
      </CSSTransition>
    </div>
  );
}

const toContentPart = (item: ChildActivityItem): TMessageContentParts => {
  if (item.type === 'writing') {
    return {
      type: ContentTypes.TEXT,
      text: item.text,
      ...(item.phase == null ? {} : { phase: item.phase }),
    } as TMessageContentParts;
  }
  if (item.type === 'reasoning') {
    if (item.text == null || item.text === '') {
      return {
        type: ContentTypes.THINK,
        think: '',
        reasoning_unavailable: true,
        ...(item.label == null ? {} : { reasoning_label: item.label }),
      } as TMessageContentParts;
    }
    return {
      type: ContentTypes.THINK,
      think: item.text,
      ...(item.label == null ? {} : { reasoning_label: item.label }),
    } as TMessageContentParts;
  }
  if (item.type === 'activity_label') {
    return {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: item.label,
      ...(item.labelType == null ? {} : { activity_label_type: item.labelType }),
      ...(item.toolCallIds == null ? {} : { tool_call_ids: item.toolCallIds }),
      ...(item.activityStartIndex == null ? {} : { activity_start_index: item.activityStartIndex }),
      ...(item.activityEndIndex == null ? {} : { activity_end_index: item.activityEndIndex }),
      ...(item.activityCount == null ? {} : { activity_count: item.activityCount }),
      ...(item.agentIds == null ? {} : { agent_ids: item.agentIds }),
      ...(item.status == null ? {} : { status: item.status }),
      ...(item.pending == null ? {} : { pending: item.pending }),
    } as TMessageContentParts;
  }
  return {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: item.toolCallId,
      name: item.name,
      args: item.input ?? '',
      output: item.output ?? '',
      progress: item.status === 'running' ? 0.1 : 1,
      ...(item.status === 'running' ? {} : { runStepStatus: item.status }),
      ...(item.inputValidationError === true ? { inputValidationError: true } : {}),
      ...(item.approval == null ? {} : { approval: item.approval }),
    },
  } as TMessageContentParts;
};

function SubagentPrompt({ prompt }: { prompt: string }) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const contentId = useId();
  const toggleLabel = expanded ? localize('com_ui_collapse') : localize('com_ui_expand');
  return (
    <section
      aria-labelledby={headingId}
      className="mb-3 shrink-0 overflow-hidden rounded-lg border border-border-light bg-surface-secondary text-text-primary"
    >
      <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b border-border-light px-3 py-2">
        <h3 id={headingId} className="text-sm font-medium text-text-primary">
          {localize('com_ui_prompt')}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="h-8 gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary transition hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary"
        >
          {expanded ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          <span className="hidden sm:inline">{toggleLabel}</span>
        </Button>
      </div>
      <div
        id={contentId}
        className={cn(
          'relative min-w-0 px-4 py-3',
          expanded ? 'overflow-visible' : 'max-h-32 overflow-hidden',
        )}
      >
        <div className="markdown prose prose-sm message-content light dark:prose-invert w-full max-w-none break-words text-text-primary">
          <MarkdownLite content={prompt} codeExecution={false} />
        </div>
        {!expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-secondary to-transparent"
            aria-hidden
          />
        )}
      </div>
    </section>
  );
}

export function SubagentActivityContent({
  activity,
  activityId,
  state = 'ready',
  showPrompt = true,
  conversationId = null,
  underHeaderIcon = false,
  onCancelControl,
}: {
  activity: ChildActivity;
  activityId?: string;
  state?: 'ready' | 'loading' | 'error';
  showPrompt?: boolean;
  conversationId?: string | null;
  /** Set when this body sits directly beneath a `MessageRow` author header, so
   *  the streaming dot centers on the header icon's axis as it does in main
   *  chat (see `EmptyTextPart`). */
  underHeaderIcon?: boolean;
  onCancelControl?: (controlId: string) => void;
}) {
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const isSubmitting = isLiveSubagentStatus(activity.status);
  const parts = useMemo(() => activity.items.map(toContentPart), [activity.items]);

  let body: React.ReactNode;
  if (state === 'loading') {
    body = (
      <Container>
        <EmptyText underHeaderIcon={underHeaderIcon} />
      </Container>
    );
  } else if (state === 'error') {
    body = (
      <div className="rounded-lg border border-status-error-border bg-status-error-subtle p-3 text-sm text-status-error">
        {localize('com_ui_subagent_thread_load_error')}
      </div>
    );
  } else if (activity.items.length === 0) {
    body = isSubmitting ? (
      <Container>
        <EmptyText underHeaderIcon={underHeaderIcon} />
      </Container>
    ) : null;
  } else {
    body = (
      <ContentParts
        content={parts}
        messageId={activityId ?? 'subagent-activity-panel'}
        conversationId={conversationId}
        isCreatedByUser={false}
        isLast
        isSubmitting={isSubmitting}
        showThinking={showThinking}
        isLatestMessage={isSubmitting}
        foldLiveActivity={false}
      />
    );
  }

  return (
    <div className="flex max-w-full flex-col gap-0">
      {showPrompt && activity.prompt != null && <SubagentPrompt prompt={activity.prompt} />}
      <SubagentControlHistory
        controls={activity.controls ?? []}
        onCancelControl={onCancelControl}
      />
      {activity.controlsTruncated === true && (
        <div className="mb-3 text-xs italic text-text-secondary">
          {localize('com_ui_subagent_control_history_truncated')}
        </div>
      )}
      {body}
    </div>
  );
}

export function SubagentStatus({ activity }: { activity: ChildActivity }) {
  const localize = useLocalize();
  const StatusIcon = subagentStatusIcon(activity.status);
  return (
    <div
      className={cn(
        'flex items-center gap-1 text-xs text-text-secondary',
        activity.status === 'failed' || activity.status === 'interrupted'
          ? 'text-status-error'
          : '',
      )}
      aria-live="polite"
    >
      <StatusIcon size={13} aria-hidden />
      <span>{localize(subagentStatusLabelKey(activity.status))}</span>
    </div>
  );
}

export default function SubagentActivity({
  activity,
  activityId,
  state = 'ready',
  embedded = false,
  showPrompt = true,
  headerInset = false,
  onCancelControl,
}: {
  activity: ChildActivity;
  activityId?: string;
  state?: 'ready' | 'loading' | 'error';
  embedded?: boolean;
  showPrompt?: boolean;
  headerInset?: boolean;
  onCancelControl?: (controlId: string) => void;
}) {
  const statusHeader = isAbnormalTerminalStatus(activity.status) ? (
    <div className="shrink-0 border-b border-border-light px-4 py-2">
      <SubagentStatus activity={activity} />
    </div>
  ) : null;
  const content = (
    <SubagentActivityContent
      activity={activity}
      activityId={activityId}
      state={state}
      showPrompt={showPrompt}
      onCancelControl={onCancelControl}
    />
  );

  if (embedded) {
    return (
      <section className="border-b border-border-light last:border-b-0" data-subagent-thread-turn>
        {statusHeader}
        <div className="px-4 py-4">{content}</div>
      </section>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {statusHeader}
      <SubagentActivityScrollSurface headerInset={headerInset}>
        {content}
      </SubagentActivityScrollSurface>
    </div>
  );
}
