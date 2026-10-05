import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import copy from 'copy-to-clipboard';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import { toolPanelSpacingClassName, useToolContentPending } from '../disclosure';
import { parseBackgroundHandle, splitBackgroundAttachments } from './handle';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import parseJsonField, { areToolCallArgsComplete } from './parseJsonField';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import CopyButton from '~/components/Messages/Content/CopyButton';
import LangIcon from '~/components/Messages/Content/LangIcon';
import { PANE_COPY_REVEAL, TOOL_ROW_CLASSES } from '../rows';
import useToolCallState from './useToolCallState';
import useLazyHighlight from './useLazyHighlight';
import useFollowScroll from './useFollowScroll';
import { OutputRenderer } from '../ToolOutput';
import { ERROR_PATTERNS } from './ExecuteCode';
import { AttachmentGroup } from './Attachment';
import { parseCommandOutput } from './command';
import { useToolCallIntent } from './intent';
import PtcToolTrace from './PtcToolTrace';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** The SDK's sandbox executors emit this line in place of empty stdout. */
const SANDBOX_EMPTY_OUTPUT = "stdout: Empty. Ensure you're writing output explicitly.";

export default function BashCall({
  isSubmitting,
  runStepStatus,
  runStepDurationMs,
  backgrounded,
  backgroundCancelled = false,
  executor,
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
  executor?: PartMetadata['executor'];
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
  const { useSandboxStarting } = useMessagePartsHost();
  const sandboxStarting = useSandboxStarting(toolCallId ?? '');

  /** Only a call the server stamped as attached-workspace carries an exit
   *  status trailer; sandbox output keeps the text heuristic even when it
   *  prints something that looks like one. */
  const result = useMemo(
    () => (executor === 'attached_workspace' ? parseCommandOutput(output) : null),
    [executor, output],
  );
  const outputHasError = useMemo(() => ERROR_PATTERNS.test(output), [output]);
  const outputIsEmpty = output.trim() === SANDBOX_EMPTY_OUTPUT;
  const verdict = (() => {
    if (result?.timedOut === true) {
      return localize('com_ui_command_timed_out');
    }
    if (result?.signal != null) {
      return localize('com_ui_command_terminated', { 0: result.signal });
    }
    if (result?.failed === true && result.exitCode != null) {
      return localize('com_ui_command_exit_code', { 0: String(result.exitCode) });
    }
    return undefined;
  })();
  const outputSegments = useMemo(
    () =>
      result == null
        ? undefined
        : [
            { text: result.head },
            {
              text: result.stderr,
              className: result.failed ? 'text-status-error' : 'text-text-secondary',
            },
            { text: result.trailer, className: 'text-text-tertiary' },
          ],
    [result],
  );
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
    extraError: backgroundFailed || result?.failed === true,
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

  const contentPending = useToolContentPending();
  const handleCopy = useCallback(() => {
    if (contentPending) {
      return;
    }
    setIsCopied(true);
    copy(command, { format: 'text/plain' });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsCopied(false), 3000);
  }, [command, contentPending]);

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
                'text-text-secondary size-4 shrink-0',
                phase === 'running' && 'animate-pulse',
              )}
            />
          }
          hasInput={!!command || hasOutput}
          isExpanded={showCode}
          verdict={verdict}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          <div
            className={cn(
              toolPanelSpacingClassName,
              'border-border-light overflow-hidden rounded-lg border',
            )}
          >
            {command && (
              // The command is a code surface, so it takes the role every other one takes
              // (`DiffView`, the user-turn code bars) instead of a palette shade a theme
              // cannot reach: the previous dark-only gray-950 fill was Tailwind's blue-black,
              // outside this palette entirely.
              <div className="bg-surface-code group/copy relative">
                <CopyButton
                  iconOnly
                  isCopied={isCopied}
                  onClick={handleCopy}
                  disabled={contentPending}
                  className={cn('bg-surface-code absolute top-1 right-1.5 z-[1]', PANE_COPY_REVEAL)}
                  label={localize('com_ui_copy_code')}
                />
                <div
                  ref={commandPaneRef}
                  onScroll={onCommandPaneScroll}
                  className="max-h-[18.75rem] overflow-auto"
                >
                  <pre className="px-3 py-2.5 font-mono text-xs break-words whitespace-pre-wrap">
                    <span className="text-text-tertiary select-none" aria-hidden="true">
                      {'$ '}
                    </span>
                    {/* `code.hljs` in style.css sets `white-space: pre`, `word-wrap: normal`
                        and 0.85rem, which would stop long commands wrapping and size the
                        command larger than the `$` prompt. */}
                    <code className="hljs language-bash !text-xs !break-words !whitespace-pre-wrap">
                      {highlighted ?? command}
                    </code>
                  </pre>
                </div>
              </div>
            )}
            <PtcToolTrace
              toolCallId={toolCallId}
              expanded={showCode}
              className={cn(command && 'border-border-light border-t')}
            />
            {hasOutput && backgroundHandle == null && (
              <div className={cn('px-3 py-2.5', command && 'border-border-light border-t')}>
                {outputIsEmpty ? (
                  <p className="text-text-secondary text-xs italic">
                    {localize('com_ui_no_output')}
                  </p>
                ) : (
                  <OutputRenderer
                    text={output}
                    copyText={output}
                    error={result == null && outputHasError}
                    segments={outputSegments}
                    variant="terminal"
                  />
                )}
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
