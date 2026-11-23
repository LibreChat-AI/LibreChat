import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, Button, useLocalize } from '@librechat/client';
import { ArrowUpRight, Check, CircleAlert } from 'lucide-react';
import type { ParentSubagentSummary, SubagentThreadStatus } from 'librechat-data-provider';
import type { TranslationKeys } from '@librechat/client';
import type { BackgroundTaskStatus, BackgroundTaskView } from '../../core/parts/background';
import {
  messageAuthor,
  resolveSubagentAuthor,
  findAgentAuthorMessage,
} from '../../react/subagents/author';
import { parseToolName, getToolDisplayLabel } from '../../core/parts/toolLabels';
import { backgroundTaskMessageKey, backgroundTaskNoteKey } from './guidance';
import { formatBackgroundCodeOutput } from '../../core/parts/background';
import { findSubagentDispatch } from '../../core/subagents/dispatch';
import { useSubagentTaskPanel } from '../../react/subagents/task';
import { getRunStepDurationLabels } from '../messages/duration';
import { getToolCallIntent } from '../../react/parts/intent';
import { useMessagesHost } from '../../react/messages/host';
import { useMessageContext } from '../../react/message';
import { useMessagePartsHost } from '../../react/host';
import ToolIcon, { getToolIconType } from './ToolIcon';
import { isDocumentId } from '../../core/documents';
import SubagentProgress from './SubagentProgress';
import OutputRenderer from './OutputRenderer';

const STATUS: Record<BackgroundTaskStatus, { label: TranslationKeys; dot: string }> = {
  dispatched: { label: 'com_ui_subagent_thread_status_dispatched', dot: 'bg-text-tertiary' },
  running: { label: 'com_ui_background_tasks_running', dot: 'bg-status-info' },
  stopping: { label: 'com_ui_background_tasks_stopping', dot: 'bg-status-warning' },
  accepted: { label: 'com_ui_background_tasks_control_queued', dot: 'bg-status-info' },
  claimed: { label: 'com_ui_background_tasks_result_claimed', dot: 'bg-text-tertiary' },
  not_running: { label: 'com_ui_background_tasks_not_running', dot: 'bg-status-warning' },
  control_not_found: {
    label: 'com_ui_background_tasks_control_not_found',
    dot: 'bg-status-warning',
  },
  completed: { label: 'com_ui_background_tasks_completed', dot: 'bg-status-success' },
  error: { label: 'com_ui_failed', dot: 'bg-status-error' },
  failed: { label: 'com_ui_failed', dot: 'bg-status-error' },
  interrupted: { label: 'com_ui_subagent_thread_status_interrupted', dot: 'bg-status-error' },
  cancelled: { label: 'com_ui_cancelled', dot: 'bg-status-warning' },
};

const FINISHED = new Set<BackgroundTaskStatus>(['completed', 'claimed']);
const FAILED = new Set<BackgroundTaskStatus>(['error', 'failed']);
const ENDED = new Set<SubagentThreadStatus>(['completed', 'failed', 'interrupted', 'cancelled']);

/** Wall-clock time of one ended task, from the parent index's dispatch and end records. */
export function endedTaskDurationMs(
  child: ParentSubagentSummary | undefined,
  taskId: string,
): number | undefined {
  const entry = child?.tasks.find((candidate) => candidate.taskId === taskId);
  if (entry?.startedAt == null || entry.createdAt == null || !ENDED.has(entry.status)) {
    return undefined;
  }
  const ms = Date.parse(entry.createdAt) - Date.parse(entry.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function SubagentStatus({
  status,
  durationMs,
}: {
  status: BackgroundTaskStatus;
  durationMs?: number;
}): React.JSX.Element {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const duration =
    durationMs == null ? undefined : getRunStepDurationLabels(durationMs, i18n.language);
  const elapsed = duration == null ? undefined : localize(duration.key, duration.values);
  if (FINISHED.has(status)) {
    return (
      <span className="text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs">
        <Check className="text-status-success size-3.5" aria-hidden="true" />
        {elapsed == null
          ? localize('com_ui_subagent_status_finished')
          : localize('com_ui_subagent_status_finished_in', { 0: elapsed })}
      </span>
    );
  }
  if (FAILED.has(status) || status === 'interrupted') {
    let label = localize(STATUS[status].label);
    if (elapsed != null && status !== 'interrupted') {
      label = localize('com_ui_subagent_status_failed_after', { 0: elapsed });
    }
    return (
      <span className="text-status-error inline-flex shrink-0 items-center gap-1.5 text-xs">
        <CircleAlert className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    );
  }
  const state = STATUS[status];
  return (
    <span className="text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs">
      <span
        className={cn(
          'size-1.5 rounded-full',
          state.dot,
          status === 'running' && 'ring-status-info-subtle ring-2',
        )}
        aria-hidden="true"
      />
      {localize(state.label)}
    </span>
  );
}

/**
 * Who the polled child is and what it was asked to do: the agent's own name and face, as
 * its turns read in the activity panel, and the dispatching call's one-line intent.
 */
function SubagentHeader({
  task,
  child,
  delivery,
  action,
}: {
  task: BackgroundTaskView;
  child: ParentSubagentSummary | undefined;
  delivery?: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  const localize = useLocalize();
  const { messageId } = useMessageContext();
  const messagesHost = useMessagesHost();
  const getMessages = messagesHost.useGetMessages();
  const agentsMap = messagesHost.useAgentsMap();
  const fallbackName = localize('com_ui_background_tasks_subagent');
  /** With neither the index nor the dispatch to say what kind of child this is, a stored
   *  agent id is an identifier, not a name: the generic label reads better than the id. */
  const readableType =
    task.subagentType != null && isDocumentId(task.subagentType) ? undefined : task.subagentType;
  const { author, intent } = useMemo(() => {
    const messages = getMessages();
    const dispatch = findSubagentDispatch(messages, task.threadId);
    const parent = messageAuthor(
      dispatch?.message ?? findAgentAuthorMessage(messages, messageId),
      agentsMap,
      fallbackName,
      dispatch?.agentId,
    );
    return {
      author: resolveSubagentAuthor(
        {
          subagentType: child?.subagentType ?? dispatch?.subagentType ?? readableType,
          subagentKind: child?.subagentKind ?? dispatch?.identity?.subagentKind,
          agentId: child?.agentId ?? dispatch?.identity?.subagentAgentId,
          title: child?.title,
        },
        parent,
        agentsMap,
        fallbackName,
      ),
      intent: getToolCallIntent(dispatch?.args),
    };
  }, [agentsMap, child, fallbackName, getMessages, messageId, readableType, task.threadId]);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span
        className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
        aria-hidden="true"
      >
        {author.icon}
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-text-primary truncate text-sm font-semibold" title={author.name}>
          {author.name}
        </div>
        {intent != null && (
          <div className="text-text-secondary truncate text-xs" title={intent}>
            {intent}
          </div>
        )}
        {delivery}
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <SubagentStatus status={task.status} durationMs={endedTaskDurationMs(child, task.taskId)} />
        {action}
      </div>
    </div>
  );
}

export default function BackgroundTaskCard({
  task,
  mcpIconMap,
  mcpServerNames,
}: {
  task: BackgroundTaskView;
  mcpIconMap?: Map<string, string>;
  mcpServerNames?: readonly string[];
}): React.JSX.Element {
  const localize = useLocalize();
  const { conversationId } = useMessagePartsHost().useMessage();
  const isSubagent = task.toolName === 'subagent';
  const durableTask = useMemo(
    () =>
      isSubagent && task.threadId != null
        ? {
            threadId: task.threadId,
            taskId: task.taskId,
            subagentType: task.subagentType,
            settled: task.status !== 'running',
          }
        : null,
    [isSubagent, task.status, task.subagentType, task.taskId, task.threadId],
  );
  const {
    selection,
    open: openActivity,
    child,
  } = useSubagentTaskPanel(durableTask, conversationId);
  const parsedName = parseToolName(task.toolName, mcpServerNames);
  const serverName = parsedName.mcpServer;
  let title = getToolDisplayLabel(task.toolName, localize, mcpServerNames);
  if (serverName) {
    title = parsedName.toolName;
  }
  const subtitle = task.subagentType || serverName;
  const iconUrl = serverName ? mcpIconMap?.get(serverName) : undefined;
  const iconType = getToolIconType(task.toolName);
  const isCode = iconType === 'bash_tool' || iconType === 'execute_code';
  const state = STATUS[task.status];
  const failed =
    task.status === 'error' || task.status === 'failed' || task.status === 'interrupted';
  const result = task.result?.trim() ? task.result : undefined;
  const error = task.error?.trim() && task.error !== result ? task.error : undefined;
  const noteKey = task.note ? backgroundTaskNoteKey(task.note) : undefined;
  const messageKey = task.message ? backgroundTaskMessageKey(task.message) : undefined;
  let delivery: string | undefined;
  if (task.delivery === 'pending') {
    delivery = localize('com_ui_background_tasks_result_pending');
  } else if (task.delivery === 'failed') {
    delivery = localize('com_ui_background_tasks_result_undelivered');
  }
  const deliveryLine = delivery && (
    <div
      className={cn(
        'mt-0.5 text-xs',
        task.delivery === 'failed' ? 'text-status-warning' : 'text-text-secondary',
      )}
    >
      {delivery}
    </div>
  );
  const activityButton = selection != null && openActivity != null && (
    <Button
      type="button"
      variant="quiet"
      size="xs"
      className="shrink-0"
      onClick={openActivity}
      data-subagent-tool-call={selection.toolCallId}
      data-subagent-parent-message={selection.parentMessageId}
      data-subagent-part-index={selection.partIndex}
    >
      {localize('com_ui_wakeup_view_activity')}
      <ArrowUpRight className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
    </Button>
  );

  return (
    <div className="min-w-0" data-testid="background-task-card">
      {isSubagent ? (
        <SubagentHeader task={task} child={child} delivery={deliveryLine} action={activityButton} />
      ) : (
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="text-text-secondary flex size-5 shrink-0 items-center justify-center">
            <ToolIcon type={iconType} iconUrl={iconUrl} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-text-primary truncate text-sm font-semibold" title={title}>
              {title}
            </div>
            {subtitle && <div className="text-text-secondary truncate text-xs">{subtitle}</div>}
            {deliveryLine}
          </div>
          <span
            className={cn(
              'text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs',
              failed && 'text-status-error',
            )}
          >
            <span className={cn('size-1.5 rounded-full', state.dot)} aria-hidden="true" />
            {localize(state.label)}
          </span>
        </div>
      )}
      {task.activity != null && (
        <SubagentProgress
          digest={task.activity}
          serverNames={mcpServerNames}
          serverIcons={mcpIconMap}
          settled={task.status !== 'running' && task.status !== 'dispatched'}
        />
      )}
      {result && (
        <div className="mt-3">
          <div
            className={cn(
              'mb-1.5 text-xs font-medium',
              failed && !error ? 'text-status-error' : 'text-text-secondary',
            )}
          >
            {localize(failed && !error ? 'com_ui_error' : 'com_ui_output')}
          </div>
          <div className="border-border-light bg-surface-code min-w-0 rounded-lg border p-3">
            <OutputRenderer
              text={isCode ? formatBackgroundCodeOutput(result) : result}
              copyText={result}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <div className="text-status-error mb-1.5 text-xs font-medium">
            {localize('com_ui_error')}
          </div>
          <div className="border-border-light bg-surface-code min-w-0 rounded-lg border p-3">
            <OutputRenderer
              text={isCode ? formatBackgroundCodeOutput(error) : error}
              copyText={error}
            />
          </div>
        </div>
      )}
      {!result && !error && task.resultClaimed && task.status !== 'claimed' && (
        <p className="text-text-secondary mt-2 text-xs">
          {localize('com_ui_background_tasks_result_claimed')}
        </p>
      )}
      {!result && !error && task.resultAvailable && !task.resultClaimed && (
        <p className="text-text-secondary mt-2 text-xs">
          {localize('com_ui_background_tasks_result_available')}
        </p>
      )}
      {noteKey && <p className="text-text-secondary mt-2 text-xs">{localize(noteKey)}</p>}
      {messageKey && messageKey !== noteKey && (
        <p className="text-text-secondary mt-2 text-xs">{localize(messageKey)}</p>
      )}
      {!result &&
        !error &&
        !task.resultAvailable &&
        !task.resultClaimed &&
        task.result === '' &&
        !task.note &&
        !task.message && (
          <p className="text-text-secondary mt-2 text-xs">
            {localize('com_ui_background_tasks_no_output')}
          </p>
        )}
    </div>
  );
}
