import type { BackgroundTaskStatus, BackgroundTaskView } from './Parts/background';
import type { TranslationKeys } from '~/hooks';
import { ToolIcon, getToolIconType, getMCPServerName, OutputRenderer } from './ToolOutput';
import { getToolDisplayLabel, cn } from '~/utils';
import { useLocalize } from '~/hooks';

const STATUS: Record<BackgroundTaskStatus, { label: TranslationKeys; dot: string }> = {
  dispatched: { label: 'com_ui_subagent_thread_status_dispatched', dot: 'bg-text-tertiary' },
  running: { label: 'com_ui_background_tasks_running', dot: 'bg-status-info' },
  stopping: { label: 'com_ui_background_tasks_stopping', dot: 'bg-status-warning' },
  completed: { label: 'com_ui_background_tasks_completed', dot: 'bg-status-success' },
  error: { label: 'com_ui_failed', dot: 'bg-status-error' },
  failed: { label: 'com_ui_failed', dot: 'bg-status-error' },
  interrupted: { label: 'com_ui_subagent_thread_status_interrupted', dot: 'bg-status-warning' },
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
  const title = isSubagent
    ? localize('com_ui_background_tasks_subagent')
    : getToolDisplayLabel(task.toolName, localize, mcpServerNames);
  const serverName = getMCPServerName(task.toolName, mcpServerNames);
  const iconUrl = serverName ? mcpIconMap?.get(serverName) : undefined;
  const state = STATUS[task.status];
  const result = task.result?.trim() ? task.result : undefined;
  const error = task.error?.trim() && task.error !== result ? task.error : undefined;
  const delivery =
    task.delivery === 'pending'
      ? localize('com_ui_background_tasks_result_pending')
      : task.delivery === 'failed'
        ? localize('com_ui_background_tasks_result_undelivered')
        : undefined;

  return (
    <div
      className="min-w-0 rounded-lg border border-border-light bg-surface-secondary/50 p-3"
      data-testid="background-task-card"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-tertiary">
          <ToolIcon
            type={getToolIconType(task.toolName)}
            iconUrl={iconUrl}
            className="text-text-primary"
          />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-sm font-semibold text-text-primary" title={title}>
            {title}
          </div>
          {task.subagentType && (
            <div className="truncate text-xs text-text-secondary">{task.subagentType}</div>
          )}
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
            (task.status === 'error' || task.status === 'failed') && 'text-status-error',
          )}
        >
          <span className={cn('size-1.5 rounded-full', state.dot)} aria-hidden="true" />
          {localize(state.label)}
        </span>
      </div>
      {result && (
        <div className="mt-3 border-t border-border-light pt-2.5">
          <div className="mb-1.5 text-xs font-medium text-text-secondary">
            {localize('com_ui_output')}
          </div>
          <div className="min-w-0 rounded-md bg-surface-primary p-2.5">
            <OutputRenderer text={result} />
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3 border-t border-border-light pt-2.5">
          <div className="mb-1.5 text-xs font-medium text-status-error">
            {localize('com_ui_error')}
          </div>
          <div className="min-w-0 rounded-md bg-surface-primary p-2.5">
            <OutputRenderer text={error} />
          </div>
        </div>
      )}
      {!result && !error && task.resultAvailable && (
        <p className="mt-2 text-xs text-text-secondary">
          {localize('com_ui_background_tasks_result_available')}
        </p>
      )}
      {task.note && <p className="mt-2 text-xs text-text-secondary">{task.note}</p>}
      {task.message && <p className="mt-2 text-xs text-text-secondary">{task.message}</p>}
      {!result &&
        !error &&
        !task.resultAvailable &&
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
