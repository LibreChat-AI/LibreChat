import type { BackgroundTaskStatus, BackgroundTaskView } from './Parts/background';
import type { TranslationKeys } from '~/hooks';
import { backgroundTaskMessageKey, backgroundTaskNoteKey } from './Parts/guidance';
import { ToolIcon, getToolIconType, OutputRenderer } from './ToolOutput';
import { formatBackgroundCodeOutput } from './Parts/background';
import { parseToolName } from '~/utils/toolLabels';
import { getToolDisplayLabel, cn } from '~/utils';
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
  const isSubagent = task.toolName === 'subagent';
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
      className="min-w-0 rounded-lg border border-border-light bg-surface-secondary/50 p-3"
      data-testid="background-task-card"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-tertiary">
          <ToolIcon type={iconType} iconUrl={iconUrl} className="text-text-primary" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-sm font-semibold text-text-primary" title={title}>
            {title}
          </div>
          {subtitle && <div className="truncate text-xs text-text-secondary">{subtitle}</div>}
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
            'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-tertiary px-2 py-1 text-xs text-text-secondary',
            failed && 'text-status-error',
          )}
        >
          <span className={cn('size-1.5 rounded-full', state.dot)} aria-hidden="true" />
          {localize(state.label)}
        </span>
      </div>
      {result && (
        <div className="mt-3 border-t border-border-light pt-2.5">
          <div
            className={cn(
              'mb-1.5 text-xs font-medium',
              failed && !error ? 'text-status-error' : 'text-text-secondary',
            )}
          >
            {localize(failed && !error ? 'com_ui_error' : 'com_ui_output')}
          </div>
          <div className="min-w-0 rounded-md bg-surface-primary p-2.5">
            <OutputRenderer
              text={isCode ? formatBackgroundCodeOutput(result) : result}
              copyText={result}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3 border-t border-border-light pt-2.5">
          <div className="mb-1.5 text-xs font-medium text-status-error">
            {localize('com_ui_error')}
          </div>
          <div className="min-w-0 rounded-md bg-surface-primary p-2.5">
            <OutputRenderer
              text={isCode ? formatBackgroundCodeOutput(error) : error}
              copyText={error}
            />
          </div>
        </div>
      )}
      {!result && !error && task.resultClaimed && task.status !== 'claimed' && (
        <p className="mt-2 text-xs text-text-secondary">
          {localize('com_ui_background_tasks_result_claimed')}
        </p>
      )}
      {!result && !error && task.resultAvailable && !task.resultClaimed && (
        <p className="mt-2 text-xs text-text-secondary">
          {localize('com_ui_background_tasks_result_available')}
        </p>
      )}
      {noteKey && <p className="mt-2 text-xs text-text-secondary">{localize(noteKey)}</p>}
      {messageKey && messageKey !== noteKey && (
        <p className="mt-2 text-xs text-text-secondary">{localize(messageKey)}</p>
      )}
      {!result &&
        !error &&
        !task.resultAvailable &&
        !task.resultClaimed &&
        task.result === '' &&
        !task.note &&
        !task.message && (
          <p className="mt-2 text-xs text-text-secondary">
            {localize('com_ui_background_tasks_no_output')}
          </p>
        )}
    </div>
  );
}
