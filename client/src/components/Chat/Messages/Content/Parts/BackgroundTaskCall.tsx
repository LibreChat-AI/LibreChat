import { useMemo, useState, useCallback } from 'react';
import type { PartMetadata, TAttachment } from 'librechat-data-provider';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { useLocalize, useLazyCollapseBody } from '~/hooks';
import { toolPanelSpacingClassName } from '../disclosure';
import { parseBackgroundTaskOutput } from './background';
import { ToolIcon, OutputRenderer } from '../ToolOutput';
import BackgroundTaskCard from '../BackgroundTaskCard';
import useToolCallState from './useToolCallState';
import { AttachmentGroup } from './Attachment';
import { useToolCallIntent } from './intent';
import ToolCallInfo from '../ToolCallInfo';
import { TOOL_ROW_CLASSES } from '../rows';
import { cn } from '~/utils';

const WARNING_NOTICES = new Set([
  'error',
  'invalid',
  'not_found',
  'outcome_unknown',
  'rejected',
  'result_unavailable',
  'unavailable',
]);

export default function BackgroundTaskCall({
  args,
  output = '',
  initialProgress = 0.1,
  isSubmitting,
  runStepStatus,
  runStepDurationMs,
  attachments,
  hideAttachments = false,
  onExpand,
  toolCallId,
}: {
  args?: string | Record<string, unknown>;
  output?: string;
  initialProgress?: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  runStepDurationMs?: PartMetadata['runStepDurationMs'];
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onExpand?: () => void;
  toolCallId?: string;
}) {
  const localize = useLocalize();
  const [showRaw, setShowRaw] = useState(false);
  const mcpIconMap = useMCPIconMap();
  const mcpServerNames = useMCPServerNames();
  const intent = useToolCallIntent(args);
  const display = useMemo(() => parseBackgroundTaskOutput(output), [output]);
  const input = useMemo(() => {
    if (typeof args === 'string') {
      return args;
    }
    try {
      return JSON.stringify(args ?? {}) ?? '';
    } catch {
      return '';
    }
  }, [args]);
  const hasParams = input.trim() !== '' && input.trim() !== '{}';
  const taskStatus = display?.kind === 'task' ? display.task.status : undefined;
  const { showCode, toggleCode, expandStyle, expandRef, phase, hasContent } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: hasParams || (attachments?.length ?? 0) > 0,
    onExpand,
    runStepStatus,
    extraError: taskStatus === 'error' || taskStatus === 'failed',
    extraCancelled: taskStatus === 'cancelled',
  });
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(showCode);
  const handleToggle = useCallback(() => {
    mountBody();
    toggleCode();
  }, [mountBody, toggleCode]);

  return (
    <>
      <div
        className={TOOL_ROW_CLASSES}
        data-testid="background-task-call"
        data-tool-call-id={toolCallId}
      >
        <ProgressText
          phase={phase}
          onClick={handleToggle}
          inProgressText={intent ?? localize('com_ui_background_tasks_checking')}
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (intent ?? localize('com_ui_background_tasks_checked'))
          }
          durationMs={runStepDurationMs}
          icon={<ToolIcon type="background_tasks" />}
          hasInput={hasContent}
          isExpanded={showCode}
        />
      </div>
      <div
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        data-tool-call-output-id={toolCallId}
      >
        <div className="overflow-hidden" ref={expandRef}>
          {hasContent && shouldRenderBody && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'overflow-hidden rounded-lg border border-border-light bg-surface-secondary',
              )}
            >
              {display?.kind === 'task' && (
                <div className="p-2.5">
                  <BackgroundTaskCard
                    task={display.task}
                    mcpIconMap={mcpIconMap}
                    mcpServerNames={mcpServerNames}
                  />
                </div>
              )}
              {display?.kind === 'list' && (
                <div className="p-2.5">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
                    {localize('com_ui_background_tasks')}
                    <span className="rounded-full bg-surface-tertiary px-1.5 tabular-nums">
                      {display.tasks.length}
                    </span>
                  </div>
                  {display.tasks.length > 0 ? (
                    <ul
                      tabIndex={0}
                      aria-label={localize('com_ui_background_tasks')}
                      className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                    >
                      {display.tasks.map((task) => (
                        <li key={task.taskId}>
                          <BackgroundTaskCard
                            task={task}
                            mcpIconMap={mcpIconMap}
                            mcpServerNames={mcpServerNames}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-text-secondary">
                      {localize('com_ui_background_tasks_empty')}
                    </p>
                  )}
                  {display.partial && (
                    <p role="alert" className="mt-2 text-xs text-status-warning">
                      {localize('com_ui_background_tasks_incomplete')}
                    </p>
                  )}
                  {display.warning && (
                    <p className="mt-2 text-xs text-status-warning">{display.warning}</p>
                  )}
                  {display.message && (
                    <p className="mt-2 text-xs text-text-secondary">{display.message}</p>
                  )}
                </div>
              )}
              {display?.kind === 'notice' && (
                <p
                  className={cn(
                    'p-3 text-sm',
                    WARNING_NOTICES.has(display.status)
                      ? 'text-status-warning'
                      : 'text-text-secondary',
                  )}
                >
                  {display.message}
                </p>
              )}
              {(display == null || hasParams) && (
                <div className={cn(display != null && 'border-t border-border-light')}>
                  <ToolCallInfo
                    input={input}
                    output={display == null ? output : undefined}
                    attachments={attachments}
                  />
                </div>
              )}
              {display != null && (
                <details
                  className="border-t border-border-light px-3 py-2"
                  onToggle={(event) => setShowRaw(event.currentTarget.open)}
                >
                  <summary className="cursor-pointer rounded text-xs text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy">
                    {localize('com_ui_background_tasks_raw_details')}
                  </summary>
                  {showRaw && (
                    <div className="mt-2 rounded-md bg-surface-primary p-2.5">
                      <OutputRenderer text={output} />
                    </div>
                  )}
                </details>
              )}
            </div>
          )}
        </div>
      </div>
      {!hideAttachments && attachments && attachments.length > 0 && (
        <AttachmentGroup attachments={attachments} />
      )}
    </>
  );
}
