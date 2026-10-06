import { useMemo } from 'react';
import { Button } from '@librechat/client';
import type { BackgroundTaskStatus, BackgroundTaskView } from './Parts/background';
import type { TranslationKeys } from '~/hooks';
import { backgroundTaskMessageKey, backgroundTaskNoteKey } from './Parts/guidance';
import { ToolIcon, getToolIconType, OutputRenderer } from './ToolOutput';
import { useSubagentTaskPanel } from '~/components/Chat/Subagents/task';
import { formatBackgroundCodeOutput } from './Parts/background';
import { parseToolName } from '~/utils/toolLabels';
import { getToolDisplayLabel, cn } from '~/utils';
import SubagentProgress from './SubagentProgress';
import { useMessageContext } from '~/Providers';
import { useLocalize } from '~/hooks';

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

export default function BackgroundTaskCard({
  task,
  mcpIconMap,
  mcpServerNames,
}: {
  task: BackgroundTaskView;
  mcpIconMap?: Map<string, string>;
  mcpServerNames?: readonly string[];
}) {
  const localize = useLocalize();
  const { conversationId } = useMessageContext();
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
  const { selection, open: openActivity } = useSubagentTaskPanel(durableTask, conversationId);
  const parsedName = parseToolName(task.toolName, mcpServerNames);
  const serverName = parsedName.mcpServer;
  let title = getToolDisplayLabel(task.toolName, localize, mcpServerNames);
  if (isSubagent) {
    title = localize('com_ui_background_tasks_subagent');
  } else if (serverName) {
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

  return (
    <div
      className="border-border-light bg-surface-secondary/50 min-w-0 rounded-lg border p-3"
      data-testid="background-task-card"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="bg-surface-tertiary flex size-8 shrink-0 items-center justify-center rounded-md">
          <ToolIcon type={iconType} iconUrl={iconUrl} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-text-primary truncate text-sm font-semibold" title={title}>
            {title}
          </div>
          {subtitle && <div className="text-text-secondary truncate text-xs">{subtitle}</div>}
          {delivery && (
            <div
              className={cn(
                'mt-0.5 text-xs',
                task.delivery === 'failed' ? 'text-status-warning' : 'text-text-secondary',
              )}
            >
              {delivery}
            </div>
          )}
        </div>
        <span
          className={cn(
            'bg-surface-tertiary text-text-secondary inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs',
            failed && 'text-status-error',
          )}
        >
          <span className={cn('size-1.5 rounded-full', state.dot)} aria-hidden="true" />
          {localize(state.label)}
        </span>
      </div>
      {task.activity != null && (
        <SubagentProgress digest={task.activity} serverNames={mcpServerNames} />
      )}
      {selection != null && openActivity != null && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openActivity}
            data-subagent-tool-call={selection.toolCallId}
            data-subagent-parent-message={selection.parentMessageId}
            data-subagent-part-index={selection.partIndex}
          >
            {localize('com_ui_wakeup_view_activity')}
          </Button>
        </div>
      )}
      {result && (
        <div className="border-border-inset mt-3 border-t pt-2.5">
          <div
            className={cn(
              'mb-1.5 text-xs font-medium',
              failed && !error ? 'text-status-error' : 'text-text-secondary',
            )}
          >
            {localize(failed && !error ? 'com_ui_error' : 'com_ui_output')}
          </div>
          <div className="bg-surface-primary min-w-0 rounded-md p-2.5">
            <OutputRenderer
              text={isCode ? formatBackgroundCodeOutput(result) : result}
              copyText={result}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="border-border-inset mt-3 border-t pt-2.5">
          <div className="text-status-error mb-1.5 text-xs font-medium">
            {localize('com_ui_error')}
          </div>
          <div className="bg-surface-primary min-w-0 rounded-md p-2.5">
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
