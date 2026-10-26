import { useCallback, useEffect, useId, useMemo, useContext, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button } from '@librechat/client';
import { Maximize2, Minimize2 } from 'lucide-react';
import { CSSTransition } from 'react-transition-group';
import { ContentTypes, QueryKeys, dataService } from 'librechat-data-provider';
import type { SearchResultData, TMessageContentParts } from 'librechat-data-provider';
import type { ToolContentQuery } from '~/components/Chat/Messages/Content/disclosure';
import type { SteerReceiptState } from '~/components/Chat/Steering/Receipt';
import type { TaskContentScope } from '~/data-provider/Subagents/content';
import type { ChildActivity, ChildActivityItem } from './adapters';
import type { TranslationKeys } from '~/hooks';
import {
  isAbnormalTerminalStatus,
  isLiveSubagentStatus,
  subagentStatusIcon,
  subagentStatusLabelKey,
} from './status';
import { ToolContentQueryContext } from '~/components/Chat/Messages/Content/disclosure';
import MessageTimestamp from '~/components/Chat/Messages/ui/MessageTimestamp';
import { TaskContentScopeContext } from '~/data-provider/Subagents/content';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import ContentParts from '~/components/Chat/Messages/Content/ContentParts';
import SteerPart from '~/components/Chat/Messages/Content/Parts/SteerPart';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import Container from '~/components/Chat/Messages/Content/Container';
import { EmptyText } from '~/components/Chat/Messages/Content/Parts';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
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

type ControlMessageProps = {
  control: NonNullable<ChildActivity['controls']>[number];
  receiptState: SteerReceiptState | null;
  pending: boolean;
};

function RetainedControlMessage({
  control,
  receiptState,
  pending,
  scope,
}: ControlMessageProps & { scope: TaskContentScope }) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);
  const reveal = useCallback(() => setExpanded(true), []);
  const query = useQuery(
    [
      QueryKeys.subagentControlReceipt,
      scope.parentConversationId,
      scope.threadId,
      scope.taskId,
      control.invocationId,
    ],
    async () => {
      const response = await dataService.getSubagentControlReceipt(
        scope.parentConversationId,
        scope.threadId,
        scope.taskId,
        control.invocationId,
      );
      if (response.receipt.invocationId !== control.invocationId)
        throw new Error('subagent_control_identity_mismatch');
      return response;
    },
    { enabled: expanded, retry: 1, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  return (
    <>
      <SteerPart
        steer={query.data?.receipt.message ?? control.message ?? ''}
        steerId={control.controlId ?? control.invocationId}
        createdAt={Date.parse(control.createdAt)}
        receiptState={receiptState}
        isSubmitting={pending}
        hasMore={query.data == null}
        onExpand={reveal}
      />
      {query.isFetching && <span role="status">{localize('com_ui_loading')}</span>}
      {query.isError && (
        <Alert variant="error">
          <span>{localize('com_ui_conversation_load_error')}</span>
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
    </>
  );
}

function ControlMessage(props: ControlMessageProps) {
  const scope = useContext(TaskContentScopeContext);
  if (props.control.messageTruncated === true && scope != null)
    return <RetainedControlMessage {...props} scope={scope} />;
  return (
    <SteerPart
      steer={props.control.message ?? ''}
      steerId={props.control.controlId ?? props.control.invocationId}
      createdAt={Date.parse(props.control.createdAt)}
      receiptState={props.receiptState}
      isSubmitting={props.pending}
    />
  );
}

function SubagentControlHistory({
  controls,
  onCancelControl,
  content,
}: {
  content: TMessageContentParts[];
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
  const legacyGuidance = new Map<string, number>();
  const appliedIds = new Set<string>();
  for (const part of content) {
    if (part?.type !== ContentTypes.STEER) continue;
    if (part.steerId != null) appliedIds.add(part.steerId);
    if (part.clientSteerId != null) appliedIds.add(part.clientSteerId);
    if (part.steerId == null) {
      legacyGuidance.set(part.steer, (legacyGuidance.get(part.steer) ?? 0) + 1);
    }
  }
  const representedControls = new Set<string>();
  for (let index = chronologicalControls.length - 1; index >= 0; index--) {
    const control = chronologicalControls[index];
    if (control.action !== 'steer' && control.action !== 'queue' && control.action !== 'interrupt')
      continue;
    if (
      appliedIds.has(control.invocationId) ||
      (control.controlId != null && appliedIds.has(control.controlId))
    ) {
      representedControls.add(control.invocationId);
      continue;
    }
    if (control.status !== 'applied' || control.message == null) continue;
    const remaining = legacyGuidance.get(control.message) ?? 0;
    if (remaining > 0) {
      representedControls.add(control.invocationId);
      legacyGuidance.set(control.message, remaining - 1);
    }
  }
  return (
    <section aria-label={localize('com_ui_subagent_control_history')} className="mb-3 space-y-2">
      {chronologicalControls.map((control) => {
        const represented = representedControls.has(control.invocationId);
        if (
          represented &&
          (appliedIds.has(control.invocationId) ||
            (control.controlId != null && appliedIds.has(control.controlId)))
        )
          return null;
        const legacyInlineGuidance = represented;
        const pending = control.status === 'submitted' || control.status === 'accepted';
        let receiptState: SteerReceiptState | undefined;
        if (control.action !== 'cancel' && control.action !== 'cancel_message') {
          if (control.status === 'submitted') receiptState = 'sending';
          else if (control.status === 'accepted')
            receiptState = control.action === 'interrupt' ? 'interrupting' : 'delivered';
          else if (control.status === 'applied') receiptState = 'applied';
        }
        return (
          <div
            key={control.invocationId}
            className={cn('group flex flex-col items-end text-sm', pending && 'opacity-60')}
          >
            {!legacyInlineGuidance && control.message != null && control.message !== '' && (
              <ControlMessage
                control={control}
                receiptState={receiptState ?? null}
                pending={pending}
              />
            )}
            <div className="text-text-secondary flex flex-wrap items-center justify-end gap-2 text-xs">
              <span className={control.message ? 'sr-only' : undefined}>
                {localize(CONTROL_ACTION_LABELS[control.action])}
              </span>
              {(legacyInlineGuidance || !control.message) && (
                <MessageTimestamp value={control.createdAt} className="ms-0" />
              )}
              <span className={receiptState == null ? undefined : 'sr-only'} aria-live="polite">
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
            {control.reason != null && (
              <div className="text-status-error mt-1 text-xs">
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
        <div ref={contentRef} className={cn(headerInset && 'pt-13')}>
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
  if (item.type === 'steer') {
    return {
      type: ContentTypes.STEER,
      steer: item.steer,
      steerId: item.steerId,
      clientSteerId: item.clientSteerId,
      createdAt: item.createdAt,
    };
  }
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
      ...(item.toolPreparationStartedAt == null
        ? {}
        : { toolPreparationStartedAt: item.toolPreparationStartedAt }),
      ...(item.toolDispatchedAt == null ? {} : { toolDispatchedAt: item.toolDispatchedAt }),
      ...(item.toolPreparationDurationMs == null
        ? {}
        : { toolPreparationDurationMs: item.toolPreparationDurationMs }),
      ...(item.toolExecutionDurationMs == null
        ? {}
        : { toolExecutionDurationMs: item.toolExecutionDurationMs }),
      ...(item.inputValidationError === true ? { inputValidationError: true } : {}),
      ...(item.approval == null ? {} : { approval: item.approval }),
    },
  } as TMessageContentParts;
};

export const getActivityContent = (activity: ChildActivity): TMessageContentParts[] =>
  activity.content ?? activity.items.map(toContentPart);

function SubagentPrompt({ prompt }: { prompt: string }) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const contentId = useId();
  const toggleLabel = expanded ? localize('com_ui_collapse') : localize('com_ui_expand');
  return (
    <section
      aria-labelledby={headingId}
      className="border-border-light bg-surface-secondary text-text-primary mb-3 shrink-0 overflow-hidden rounded-lg border"
    >
      <div className="border-border-inset flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-3 py-2">
        <h3 id={headingId} className="text-text-primary text-sm font-medium">
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
          className="text-text-secondary hover:bg-surface-tertiary focus:ring-text-primary h-8 gap-1.5 rounded-md px-2 text-xs font-medium transition focus:ring-2"
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
        <div className="markdown prose prose-sm message-content light text-text-primary w-full max-w-none break-words">
          <MarkdownLite content={prompt} codeExecution={false} />
        </div>
        {!expanded && (
          <div
            className="from-surface-secondary pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent"
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
  content,
  authorHeader,
  searchResults,
  toolContentQuery,
}: {
  toolContentQuery?: ToolContentQuery;
  authorHeader?: React.ReactNode;
  searchResults?: Record<string, SearchResultData>;
  content?: TMessageContentParts[];
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
  const host = useMessagePartsHost();
  const showThinking = host.useShowThinking();
  const isSubmitting = isLiveSubagentStatus(activity.status);
  const parts = useMemo(() => content ?? getActivityContent(activity), [content, activity]);
  const errorNotice = (
    <Alert variant="error" role="alert">
      {localize('com_ui_conversation_load_error')}
    </Alert>
  );

  let body: React.ReactNode;
  if (state === 'loading' && parts.length === 0) {
    body = (
      <Container>
        <EmptyText underHeaderIcon={underHeaderIcon} />
      </Container>
    );
  } else if (state === 'error' && parts.length === 0) {
    body = errorNotice;
  } else if (parts.length === 0) {
    body = isSubmitting ? (
      <Container>
        <EmptyText underHeaderIcon={underHeaderIcon} />
      </Container>
    ) : null;
  } else {
    body = (
      <ToolContentQueryContext.Provider value={toolContentQuery ?? null}>
        <ContentParts
          content={parts}
          messageId={activity.messageId ?? activityId ?? 'subagent-activity-panel'}
          conversationId={conversationId}
          attachments={activity.attachments}
          searchResults={searchResults}
          authorHeader={authorHeader}
          isCreatedByUser={false}
          isLast
          isSubmitting={isSubmitting}
          showThinking={showThinking}
          isLatestMessage={isSubmitting}
        />
      </ToolContentQueryContext.Provider>
    );
  }

  return (
    <div className="flex max-w-full flex-col gap-0">
      {showPrompt && activity.prompt != null && <SubagentPrompt prompt={activity.prompt} />}
      {state === 'error' && parts.length > 0 && errorNotice}
      {body}
      {activity.content == null &&
        activity.activityTruncated !== true &&
        activity.items.some((item) => {
          if (item.type === 'tool')
            return item.inputTruncated === true || item.outputTruncated === true;
          if (item.type === 'activity_label') return item.labelTruncated === true;
          return item.textTruncated === true;
        }) && (
          <div role="status" className="text-text-secondary mt-2 text-xs">
            {localize('com_ui_subagent_activity_details_unavailable')}
          </div>
        )}
      <SubagentControlHistory
        controls={activity.controls ?? []}
        content={parts}
        onCancelControl={onCancelControl}
      />
      {activity.controlsTruncated === true && (
        <div className="text-text-secondary mb-3 text-xs italic">
          {localize('com_ui_subagent_control_history_truncated')}
        </div>
      )}
    </div>
  );
}

export function SubagentStatus({ activity }: { activity: ChildActivity }) {
  const localize = useLocalize();
  const StatusIcon = subagentStatusIcon(activity.status);
  return (
    <div
      className={cn(
        'text-text-secondary flex items-center gap-1 text-xs',
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
  notice,
}: {
  activity: ChildActivity;
  activityId?: string;
  state?: 'ready' | 'loading' | 'error';
  embedded?: boolean;
  showPrompt?: boolean;
  headerInset?: boolean;
  notice?: React.ReactNode;
  onCancelControl?: (controlId: string) => void;
}) {
  const statusHeader = isAbnormalTerminalStatus(activity.status) ? (
    <div className="border-border-light shrink-0 border-b px-4 py-2">
      <SubagentStatus activity={activity} />
    </div>
  ) : null;
  const content = (
    <>
      {notice}
      <SubagentActivityContent
        activity={activity}
        activityId={activityId}
        state={state}
        showPrompt={showPrompt}
        onCancelControl={onCancelControl}
      />
    </>
  );

  if (embedded) {
    return (
      <section className="border-border-light border-b last:border-b-0" data-subagent-thread-turn>
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
