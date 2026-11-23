import { useMemo } from 'react';
import { ArrowUpRight, ScrollText } from 'lucide-react';
import { cn, Button, useLocalize, TooltipAnchor } from '@librechat/client';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import type { CSSProperties } from 'react';
import { toolPanelSpacingClassName } from '../../react/parts/disclosure';
import { parseJsonField } from '../../core/parts/parseJsonField';
import { useToolCallIntent } from '../../react/parts/intent';
import { useMessagePartsHost } from '../../react/host';
import useToolCallState from './useToolCallState';
import { AttachmentGroup } from './Attachment';
import { TOOL_ROW_CLASSES } from './rows';
import ProgressText from './ProgressText';
import BareStatus from './BareStatus';
import Stdout from './Stdout';

/** The confirmation every successful load returns; anything else (a degraded
 *  file upload, a note from the host) is execution detail worth keeping. */
const LOAD_CONFIRMATION = /^Skill "[^"]*" loaded\. Follow the instructions below\.$/;

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
}): React.JSX.Element {
  const localize = useLocalize();
  const parsedSkillName = useMemo(() => parseJsonField(args, 'skillName'), [args]);
  const skillName = parsedSkillName || localize('com_ui_skill').toLowerCase();
  const intent = useToolCallIntent(args);
  const { useShare, useLoadedSkill } = useMessagePartsHost();
  const { isSharedConvo } = useShare();

  const { showCode, toggleCode, expandStyle, expandRef, phase, hasOutput, bare, rowRef } =
    useToolCallState({
      initialProgress,
      isSubmitting,
      output,
      hasInput: !!parsedSkillName,
      panelReady: output.length > 0,
      /** The row is the only place that names the skill that ran. */
      keepLabelRow: true,
      onExpand,
      runStepStatus,
    });

  /** The tool output only confirms the load, so the instructions come from the skill itself,
   *  when the host can name it. A shared transcript ran in its author's library, so a skill
   *  with the same name in the viewer's library is a different skill: the output is all the
   *  call can vouch for. */
  const skill = useLoadedSkill(
    parsedSkillName,
    showCode && phase === 'completed' && isSharedConvo !== true,
  );
  const instructions = skill?.instructions.trim();
  /** Beside the instructions, the output only adds the bare confirmation, so it
   *  shows only when it says something more. */
  const showOutput = !instructions || !LOAD_CONFIRMATION.test(output.trim());

  const finishedText =
    phase === 'cancelled'
      ? localize('com_ui_cancelled')
      : (intent ?? localize('com_ui_skill_finished', { 0: skillName }));

  return (
    <>
      <BareStatus phase={phase} active={bare} text={finishedText} />
      {!bare && (
        <div className={TOOL_ROW_CLASSES} ref={rowRef}>
          <ProgressText
            phase={phase}
            onClick={toggleCode}
            inProgressText={intent ?? localize('com_ui_skill_running', { 0: skillName })}
            finishedText={finishedText}
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
      )}
      <div
        className="tool-call-expand"
        style={
          {
            '--tool-expand-rows': expandStyle.gridTemplateRows,
            '--tool-expand-opacity': expandStyle.opacity,
            '--tool-expand-transition': expandStyle.transition,
          } as CSSProperties
        }
      >
        <div className="min-h-0 overflow-hidden" ref={expandRef}>
          {hasOutput && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'border-border-light bg-surface-secondary overflow-hidden rounded-lg border',
              )}
            >
              <div className="p-3 text-xs">
                <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2">
                  <span className="text-text-secondary text-3xs font-medium tracking-wide uppercase">
                    {/* The library's current record, which may have changed since the call ran. */}
                    {localize(instructions ? 'com_ui_skill_current_version' : 'com_ui_output')}
                  </span>
                  {skill && (
                    <TooltipAnchor
                      description={localize('com_ui_open_skill')}
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="-my-1 shrink-0"
                          aria-label={localize('com_ui_open_skill')}
                          onClick={skill.open}
                        >
                          <ArrowUpRight className="size-3.5" aria-hidden="true" />
                        </Button>
                      }
                    />
                  )}
                </div>
                {instructions && (
                  <div className="text-text-primary max-h-[18.75rem] overflow-auto text-sm leading-6 break-words whitespace-pre-wrap">
                    {instructions}
                  </div>
                )}
                {instructions && showOutput && (
                  <div className="border-border-inset text-text-secondary text-3xs mt-3 mb-1.5 border-t pt-3 font-medium tracking-wide uppercase">
                    {localize('com_ui_output')}
                  </div>
                )}
                {showOutput && (
                  <div className="text-text-primary max-h-[12.5rem] overflow-auto">
                    <Stdout output={output} />
                  </div>
                )}
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
