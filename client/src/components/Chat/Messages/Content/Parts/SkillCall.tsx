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
                'text-text-secondary size-4 shrink-0',
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
                'border-border-light bg-surface-secondary overflow-hidden rounded-lg border',
              )}
            >
              <div className="p-4 text-xs">
                <div className="text-text-secondary mb-1.5 text-[10px] font-medium tracking-wide uppercase">
                  {localize('com_ui_output')}
                </div>
                <div className="text-text-primary max-h-[12.5rem] overflow-auto">
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
