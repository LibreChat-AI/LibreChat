import { useMemo, useState, useCallback } from 'react';
import type { PartMetadata, TAttachment } from 'librechat-data-provider';
import { backgroundListGuidanceKeys, backgroundTaskNoticeKey } from './guidance';
import { backgroundTaskOutcome, parseBackgroundTaskOutput } from './background';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { useLocalize, useLazyCollapseBody } from '~/hooks';
import { toolPanelSpacingClassName } from '../disclosure';
import { ToolIcon, OutputRenderer } from '../ToolOutput';
import { MCPAppViews } from '~/components/MCPUIResource';
import BackgroundTaskCard from '../BackgroundTaskCard';
import { useToolPreparation } from '../preparation';
import useToolCallState from './useToolCallState';
import { AttachmentGroup } from './Attachment';
import { useToolCallIntent } from './intent';
import ToolCallInfo from '../ToolCallInfo';
import { TOOL_ROW_CLASSES } from '../rows';
import { cn } from '~/utils';
import './BackgroundTaskCall.css';

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
  const preparationText = useToolPreparation();
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
  const outcome = backgroundTaskOutcome(display);
  const noticeText =
    display?.kind === 'notice'
      ? localize(backgroundTaskNoticeKey(display.status, display.message))
      : undefined;
  const listGuidance = useMemo(
    () => (display?.kind === 'list' ? backgroundListGuidanceKeys(display) : []),
    [display],
  );
  const { showCode, toggleCode, expandRef, phase, hasContent, bare, rowRef } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: hasParams || (attachments?.length ?? 0) > 0,
    panelReady: display != null,
    keepRow: intent != null,
    onExpand,
    runStepStatus,
    extraError: outcome === 'failed',
    extraCancelled: outcome === 'cancelled',
  });
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(showCode);
  const handleToggle = useCallback(() => {
    mountBody();
    toggleCode();
  }, [mountBody, toggleCode]);

  let finishedText = intent ?? localize('com_ui_background_tasks_checked');
  if (phase === 'cancelled') {
    finishedText =
      outcome === 'cancelled' && noticeText != null ? noticeText : localize('com_ui_cancelled');
  } else if (phase === 'failed' && outcome !== 'failed') {
    finishedText = intent ?? localize('com_ui_background_tasks_checked');
  } else if (noticeText != null) {
    finishedText = noticeText;
  } else if (display?.kind === 'list' && outcome === 'failed') {
    finishedText = localize('com_ui_background_tasks_incomplete');
  }

  let announcedText = finishedText;
  if (phase === 'running') {
    announcedText = preparationText ?? localize('com_ui_background_tasks_checking');
  } else if (phase === 'failed' && (noticeText == null || outcome !== 'failed')) {
    announcedText =
      display?.kind === 'list'
        ? localize('com_ui_background_tasks_incomplete')
        : localize('com_ui_failed_subject', { 0: localize('com_ui_background_tasks') });
  }

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcedText}
      </span>
      {!bare && (
        <div
          className={TOOL_ROW_CLASSES}
          ref={rowRef}
          data-testid="background-task-call"
          data-tool-call-id={toolCallId}
        >
          <ProgressText
            phase={phase}
            onClick={handleToggle}
            inProgressText={intent ?? localize('com_ui_background_tasks_checking')}
            finishedText={finishedText}
            durationMs={runStepDurationMs}
            icon={<ToolIcon type="background_tasks" isAnimating={phase === 'running'} />}
            hasInput={hasContent}
            isExpanded={showCode}
          />
        </div>
      )}
      <div
        data-background-task-fold
        data-expanded={showCode}
        onTransitionEnd={handleTransitionEnd}
        data-tool-call-output-id={toolCallId}
      >
        <div className="overflow-hidden" ref={expandRef}>
          {hasContent && shouldRenderBody && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'border-border-light bg-surface-secondary overflow-hidden rounded-lg border',
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
                  <div className="text-text-secondary mb-2 flex items-center gap-2 text-xs font-medium">
                    {localize('com_ui_background_tasks')}
                    <span className="bg-surface-tertiary rounded-full px-1.5 tabular-nums">
                      {display.tasks.length}
                    </span>
                  </div>
                  {display.tasks.length > 0 ? (
                    <ul
                      tabIndex={0}
                      aria-label={localize('com_ui_background_tasks')}
                      className="focus-visible:ring-border-heavy flex max-h-96 flex-col gap-2 overflow-y-auto pr-1 focus-visible:ring-2 focus-visible:outline-none"
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
                    <p className="text-text-secondary text-sm">
                      {localize('com_ui_background_tasks_empty')}
                    </p>
                  )}
                  {(display.partial || display.warning) && (
                    <p role="alert" className="text-status-warning mt-2 text-xs">
                      {localize('com_ui_background_tasks_incomplete')}
                    </p>
                  )}
                  {listGuidance.map((key) => (
                    <p key={key} className="text-text-secondary mt-2 text-xs">
                      {localize(key)}
                    </p>
                  ))}
                </div>
              )}
              {display?.kind === 'notice' && (
                <p
                  className={cn(
                    'p-3 text-sm',
                    outcome === 'failed' || display.status === 'result_persisting'
                      ? 'text-status-warning'
                      : 'text-text-secondary',
                  )}
                >
                  {noticeText}
                </p>
              )}
              {(display == null || hasParams) && (
                <div className={cn(display != null && 'border-border-light border-t')}>
                  <ToolCallInfo input={input} output={display == null ? output : undefined} />
                </div>
              )}
              {display != null && (
                <details
                  className="border-border-light border-t px-3 py-2"
                  onToggle={(event) => setShowRaw(event.currentTarget.open)}
                >
                  <summary className="text-text-secondary hover:text-text-primary focus-visible:ring-border-heavy cursor-pointer rounded text-xs focus-visible:ring-2 focus-visible:outline-none">
                    {localize('com_ui_background_tasks_raw_details')}
                  </summary>
                  {showRaw && (
                    <div className="bg-surface-primary mt-2 rounded-md p-2.5">
                      <OutputRenderer text={output} copyText={output} />
                    </div>
                  )}
                </details>
              )}
            </div>
          )}
        </div>
      </div>
      {!hideAttachments && attachments && attachments.length > 0 && (
        <>
          <AttachmentGroup attachments={attachments} />
          <MCPAppViews attachments={attachments} />
        </>
      )}
    </>
  );
}
