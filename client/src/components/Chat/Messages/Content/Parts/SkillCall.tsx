import { useMemo } from 'react';
import { ScrollText } from 'lucide-react';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { toolPanelSpacingClassName } from '../disclosure';
import useToolCallState from './useToolCallState';
import { AttachmentGroup } from './Attachment';
import parseJsonField from './parseJsonField';
import { useToolCallIntent } from './intent';
import { TOOL_ROW_CLASSES } from '../rows';
import { useLocalize } from '~/hooks';
import Stdout from './Stdout';
import { cn } from '~/utils';

export default function SkillCall({
  isSubmitting,
  runStepStatus,
  runStepDurationMs,
  initialProgress = 0.1,
  args,
  output = '',
  attachments,
  hideAttachments = false,
  onExpand,
}: {
  initialProgress: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  runStepDurationMs?: PartMetadata['runStepDurationMs'];
  args?: string | Record<string, unknown>;
  output?: string;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const parsedSkillName = useMemo(() => parseJsonField(args, 'skillName'), [args]);
  const skillName = parsedSkillName || localize('com_ui_skill').toLowerCase();
  const intent = useToolCallIntent(args);

  const { showCode, toggleCode, expandStyle, expandRef, phase, hasOutput } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: !!parsedSkillName,
    onExpand,
    runStepStatus,
  });

  return (
    <>
      <div className={TOOL_ROW_CLASSES}>
        <ProgressText
          phase={phase}
          onClick={toggleCode}
          inProgressText={intent ?? localize('com_ui_skill_running', { 0: skillName })}
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (intent ?? localize('com_ui_skill_finished', { 0: skillName }))
          }
          durationMs={runStepDurationMs}
          icon={
            <ScrollText
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
          hasInput={!!parsedSkillName || hasOutput}
          isExpanded={showCode}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          {hasOutput && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'overflow-hidden rounded-lg border border-border-light bg-surface-secondary',
              )}
            >
              <div className="bg-surface-primary-alt p-4 text-xs dark:bg-transparent">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  {localize('com_ui_output')}
                </div>
                <div className="max-h-[200px] overflow-auto text-text-primary">
                  <Stdout output={output} />
                </div>
              </div>
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
