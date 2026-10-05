import { memo, useCallback, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import type { WakeupDisplay, WakeupTask } from './Parts/wakeup';
import type { TranslationKeys } from '~/hooks';
import SystemEventHeader, {
  SystemEventIcon,
  systemEventHeaderClasses,
} from '~/components/Chat/Messages/ui/SystemEvent';
import { subagentStatusIcon, subagentStatusLabelKey } from '~/components/Chat/Subagents/status';
import { useLocalize, useExpandCollapse, useLazyCollapseBody } from '~/hooks';
import { useSubagentTaskPanel } from '~/components/Chat/Subagents/task';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import BackgroundTaskCard from './BackgroundTaskCard';
import { cn, getToolDisplayLabel } from '~/utils';
import { StackedToolIcons } from './ToolOutput';
import MarkdownLite from './MarkdownLite';
import store from '~/store';

const SUBAGENT_HEADER_KEYS = {
  completed: 'com_ui_wakeup_subagent_completed',
  error: 'com_ui_wakeup_subagent_errored',
  cancelled: 'com_ui_wakeup_subagent_cancelled',
} as const satisfies Record<WakeupTask['status'], TranslationKeys>;

const threadStatus = (status: WakeupTask['status']) =>
  status === 'error' ? ('failed' as const) : status;

function WakeupTaskCard({
  task,
  conversationId,
}: {
  task: WakeupTask;
  conversationId?: string | null;
}) {
  const localize = useLocalize();
  const durableTask = useMemo(
    () => ({
      threadId: task.threadId,
      taskId: task.taskId,
      subagentType: task.subagentType,
      settled: task.status === 'completed',
    }),
    [task.status, task.subagentType, task.taskId, task.threadId],
  );
  const { selection, open: openActivity } = useSubagentTaskPanel(durableTask, conversationId);
  const status = threadStatus(task.status);
  const StatusIcon = subagentStatusIcon(status);
  const title = task.subagentType ?? '';
  const hasResult = task.result.trim() !== '';

  return (
    <div className="border-border-light bg-surface-secondary/40 my-1.5 rounded-lg border p-3">
      <div className="text-text-secondary flex min-h-6 items-center gap-1.5 text-xs">
        <StatusIcon
          size={13}
          aria-hidden
          className={cn('shrink-0', status === 'failed' && 'text-status-error')}
        />
        {title !== '' && <span className="min-w-0 truncate font-medium">{title}</span>}
        <span className="shrink-0">{localize(subagentStatusLabelKey(status))}</span>
        {selection != null && openActivity != null && (
          /** The trigger identity attributes let the panel's close handler
           *  return keyboard focus to this button. */
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openActivity}
            data-subagent-tool-call={selection.toolCallId}
            data-subagent-parent-message={selection.parentMessageId}
            data-subagent-part-index={selection.partIndex}
            className="ml-auto h-6 shrink-0 px-2 text-xs"
          >
            {localize('com_ui_wakeup_view_activity')}
          </Button>
        )}
      </div>
      {hasResult && (
        <div className="markdown prose prose-sm message-content light dark:prose-invert text-text-primary mt-2 max-h-96 w-full max-w-none overflow-y-auto pr-1 break-words">
          <MarkdownLite content={task.result} codeExecution={false} />
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible task card for a host-authored wake-up continuation: the durable
 * result that woke this agent, rendered in the tool-call visual family instead
 * of the raw model-facing prompt.
 */
const Wakeup = memo(function Wakeup({
  display,
  conversationId,
}: {
  display: WakeupDisplay;
  conversationId?: string | null;
}) {
  const localize = useLocalize();
  const mcpIconMap = useMCPIconMap();
  const mcpServerNames = useMCPServerNames();
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const [isExpanded, setIsExpanded] = useState(autoExpand);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(isExpanded);

  const handleToggle = useCallback(() => {
    mountBody();
    setIsExpanded((previous) => !previous);
  }, [mountBody]);

  const anyFailed = display.tasks.some((task) => task.status !== 'completed');
  const headerLabel = useMemo(() => {
    if (display.kind === 'subagent') {
      const status = display.tasks[0]?.status ?? 'completed';
      return localize(SUBAGENT_HEADER_KEYS[status]);
    }
    if (display.tasks.length > 1) {
      return localize('com_ui_wakeup_tasks_finished', { 0: String(display.tasks.length) });
    }
    if (display.tasks[0]?.status === 'cancelled') {
      return localize('com_ui_wakeup_task_cancelled');
    }
    if (display.tasks[0]?.status === 'error') {
      return localize('com_ui_wakeup_task_errored');
    }
    return localize('com_ui_wakeup_task_finished');
  }, [display.kind, display.tasks, localize]);

  const nameSummary = useMemo(() => {
    if (display.kind === 'subagent') {
      return display.tasks[0]?.subagentType ?? '';
    }
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const task of display.tasks) {
      if (task.toolName == null || task.toolName === '') continue;
      const label = getToolDisplayLabel(task.toolName, localize, mcpServerNames);
      if (seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    if (labels.length > 3) {
      return `${labels.slice(0, 3).join(', ')}, +${labels.length - 3}`;
    }
    return labels.join(', ');
  }, [display.kind, display.tasks, localize, mcpServerNames]);

  const toolIconNames = useMemo(
    () => display.tasks.map((task) => task.toolName ?? ''),
    [display.tasks],
  );

  return (
    <div className={cn('max-w-full', isExpanded && 'w-[36rem]')}>
      <Button
        variant="ghost"
        type="button"
        className={systemEventHeaderClasses}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={headerLabel}
      >
        <SystemEventHeader
          live
          icon={
            display.kind === 'subagent' ? (
              <SystemEventIcon>
                <Users size={14} />
              </SystemEventIcon>
            ) : (
              <StackedToolIcons toolNames={toolIconNames} mcpIconMap={mcpIconMap} maxIcons={4} />
            )
          }
          label={headerLabel}
          detail={nameSummary}
          expanded={isExpanded}
          warning={anyFailed}
        />
      </Button>
      <div
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        aria-hidden={!isExpanded}
        data-testid="wakeup-panel"
      >
        {shouldRenderBody && (
          <div className="overflow-hidden" ref={expandRef}>
            <div className="pb-1">
              {display.kind === 'subagent' && (
                <div className="text-text-secondary mt-1 text-xs">
                  {localize('com_ui_wakeup_explainer')}
                </div>
              )}
              {display.tasks.map((task) =>
                display.kind === 'background_tool' ? (
                  <div key={task.taskId} className="my-2">
                    <BackgroundTaskCard
                      task={{
                        taskId: task.taskId,
                        toolName: task.toolName ?? '',
                        status: task.status,
                        result: task.result,
                      }}
                      mcpIconMap={mcpIconMap}
                      mcpServerNames={mcpServerNames}
                    />
                  </div>
                ) : (
                  <WakeupTaskCard key={task.taskId} task={task} conversationId={conversationId} />
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default Wakeup;
