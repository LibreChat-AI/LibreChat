import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import copy from 'copy-to-clipboard';
import { useAtomValue } from 'jotai';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import { parseBackgroundHandle, splitBackgroundAttachments } from './handle';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import parseJsonField, { areToolCallArgsComplete } from './parseJsonField';
import CopyButton from '~/components/Messages/Content/CopyButton';
import LangIcon from '~/components/Messages/Content/LangIcon';
import { toolPanelSpacingClassName } from '../disclosure';
import { sandboxStartingByToolCallId } from '~/store';
import useToolCallState from './useToolCallState';
import useLazyHighlight from './useLazyHighlight';
import useFollowScroll from './useFollowScroll';
import { ERROR_PATTERNS } from './ExecuteCode';
import { AttachmentGroup } from './Attachment';
import { useToolCallIntent } from './intent';
import { TOOL_ROW_CLASSES } from '../rows';
import PtcToolTrace from './PtcToolTrace';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function BashCall({
  isSubmitting,
  runStepStatus,
  runStepDurationMs,
  backgrounded,
  backgroundCancelled = false,
  initialProgress = 0.1,
  args,
  output = '',
  attachments,
  commandField = 'command',
  hideAttachments = false,
  onExpand,
  toolCallId,
}: {
  initialProgress: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  runStepDurationMs?: PartMetadata['runStepDurationMs'];
  backgrounded?: PartMetadata['backgrounded'];
  backgroundCancelled?: boolean;
  args?: string | Record<string, unknown>;
  output?: string;
  attachments?: TAttachment[];
  commandField?: string;
  hideAttachments?: boolean;
  onExpand?: () => void;
  toolCallId?: string;
}) {
  const localize = useLocalize();
  const command = useMemo(() => parseJsonField(args, commandField), [args, commandField]);
  const isWritingCommand = !command || !areToolCallArgsComplete(args);
  const sandboxStarting = useAtomValue(sandboxStartingByToolCallId(toolCallId ?? ''));

  const outputHasError = useMemo(() => ERROR_PATTERNS.test(output), [output]);
  /** A backgrounded call's persisted output stays the dispatch handle until
   *  the detached run settles and patches it; render a background state
   *  instead of the handle JSON. Completion arrives live as the status marker
   *  attachment (also covers stdout-only runs) or as harvested files.
   *
   *  Resolved before the phase, which folds `backgroundFailed` in: the
   *  detached task's outcome is this card's outcome, and the dispatch step's
   *  own output cannot express it. */
  const backgroundHandle = useMemo(() => parseBackgroundHandle(output), [output]);
  const { fileAttachments, backgroundStatus } = useMemo(
    () => splitBackgroundAttachments(attachments, toolCallId),
    [attachments, toolCallId],
  );
  const backgroundFailed = backgroundHandle != null && backgroundStatus === 'error';
  const cancelledInBackground =
    backgroundCancelled || (backgroundHandle != null && backgroundStatus === 'cancelled');
  const backgroundFinishedText = backgroundHandle
    ? localize(
        backgroundStatus != null || (fileAttachments?.length ?? 0) > 0
          ? 'com_ui_background_finished'
          : 'com_ui_background_running',
      )
    : null;

  const { showCode, toggleCode, expandStyle, expandRef, phase, hasOutput } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: !!command,
    onExpand,
    runStepStatus,
    extraError: backgroundFailed,
    extraCancelled: cancelledInBackground,
  });

  const highlighted = useLazyHighlight(showCode ? command || undefined : undefined, 'bash');
  const { ref: commandPaneRef, onScroll: onCommandPaneScroll } = useFollowScroll<HTMLDivElement>(
    highlighted ?? command,
    phase === 'running',
    showCode,
  );

  const [isCopied, setIsCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(command, { format: 'text/plain' });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsCopied(false), 3000);
  }, [command]);

  /** The model-authored `intent` streams as the FIRST args key, so it is the
   *  live label from the earliest delta — before the command exists and while
   *  it runs. It persists as the settled label too (completion is a UI state,
   *  not a tense change); the generic texts are the no-intent fallback. */
  const intent = useToolCallIntent(args);
  const inProgressText = (() => {
    if (intent != null) {
      return intent;
    }
    if (isWritingCommand) {
      return localize('com_ui_writing_command');
    }
    if (sandboxStarting) {
      return localize('com_ui_sandbox_starting');
    }
    return localize('com_ui_running_command');
  })();

  return (
    <>
      <div className={TOOL_ROW_CLASSES}>
        <ProgressText
          phase={phase}
          onClick={toggleCode}
          inProgressText={inProgressText}
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (backgroundFinishedText ?? intent ?? localize('com_ui_command_finished'))
          }
          /** A backgrounded call's run step closes when dispatch returns the
           *  handle, so its duration is the dispatch time — showing it would
           *  misstate a detached task's runtime as seconds. The handle check
           *  covers the live card; the persisted `backgrounded` marker covers
           *  the card after harvest replaces the handle with real stdout
           *  (and after any reload), when no transient signal survives. */
          durationMs={
            backgroundHandle == null && backgrounded !== true ? runStepDurationMs : undefined
          }
          icon={
            <LangIcon
              lang="bash"
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
            />
          }
          hasInput={!!command || hasOutput}
          isExpanded={showCode}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          <div
            className={cn(
              toolPanelSpacingClassName,
              'overflow-hidden rounded-lg border border-border-light',
            )}
          >
            {command && (
              <div className="relative bg-surface-tertiary dark:bg-gray-950">
                <CopyButton
                  iconOnly
                  isCopied={isCopied}
                  onClick={handleCopy}
                  className="absolute right-1.5 top-1"
                  label={localize('com_ui_copy_code')}
                />
                <div
                  ref={commandPaneRef}
                  onScroll={onCommandPaneScroll}
                  className="max-h-[300px] overflow-auto"
                >
                  <pre className="whitespace-pre-wrap break-words px-3 py-2.5 pr-10 font-mono text-xs">
                    <span className="select-none text-text-tertiary" aria-hidden="true">
                      {'$ '}
                    </span>
                    <code className="hljs language-bash">{highlighted ?? command}</code>
                  </pre>
                </div>
              </div>
            )}
            <PtcToolTrace
              toolCallId={toolCallId}
              expanded={showCode}
              className={cn(command && 'border-t border-border-light')}
            />
            {hasOutput && backgroundHandle == null && (
              <div className={cn(command && 'border-t border-border-light')}>
                <pre
                  className={cn(
                    'max-h-[300px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs',
                    outputHasError ? 'text-status-error' : 'text-text-primary',
                  )}
                >
                  {output}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
      {!hideAttachments && fileAttachments && fileAttachments.length > 0 && (
        <AttachmentGroup attachments={fileAttachments} />
      )}
    </>
  );
}
