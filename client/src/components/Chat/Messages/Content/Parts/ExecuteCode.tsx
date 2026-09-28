import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { SquareTerminal } from 'lucide-react';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import { parseBackgroundHandle, splitBackgroundAttachments } from './handle';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { toolPanelSpacingClassName } from '../disclosure';
import { sandboxStartingByToolCallId } from '~/store';
import useLazyHighlight from './useLazyHighlight';
import useToolCallState from './useToolCallState';
import CodeWindowHeader from './CodeWindowHeader';
import useFollowScroll from './useFollowScroll';
import { AttachmentGroup } from './Attachment';
import { useToolCallIntent } from './intent';
import { TOOL_ROW_CLASSES } from '../rows';
import PtcToolTrace from './PtcToolTrace';
import { useLocalize } from '~/hooks';
import Stdout from './Stdout';
import { cn } from '~/utils';

interface ParsedArgs {
  lang?: string;
  code?: string;
}

export function useParseArgs(args?: string | Record<string, unknown>): ParsedArgs | null {
  return useMemo(() => {
    if (typeof args === 'object' && args !== null) {
      return { lang: String(args.lang ?? ''), code: String(args.code ?? '') };
    }
    let parsedArgs: ParsedArgs | string | undefined | null = args;
    try {
      parsedArgs = JSON.parse(args || '');
    } catch {
      // console.error('Failed to parse args:', e);
    }
    if (typeof parsedArgs === 'object') {
      return parsedArgs;
    }
    const langMatch = args?.match(/"lang"\s*:\s*"(\w+)"/);
    const codeMatch = args?.match(/"code"\s*:\s*"(.+?)(?="\s*,\s*"(session_id|args)"|"\s*})/s);

    let code = '';
    if (codeMatch) {
      code = codeMatch[1];
      if (code.endsWith('"}')) {
        code = code.slice(0, -2);
      }
      code = code.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    return {
      lang: langMatch ? langMatch[1] : '',
      code,
    };
  }, [args]);
}

export const ERROR_PATTERNS = /^(Traceback|Error:|Exception:|.*Error:)/m;

export default function ExecuteCode({
  isSubmitting,
  runStepStatus,
  runStepDurationMs,
  backgrounded,
  backgroundCancelled = false,
  initialProgress = 0.1,
  args,
  output = '',
  attachments,
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
  hideAttachments?: boolean;
  onExpand?: () => void;
  toolCallId?: string;
}) {
  const localize = useLocalize();
  const { lang = 'py', code } = useParseArgs(args) ?? ({} as ParsedArgs);
  /** Model-authored live label, streamed as the first args key; persists as
   *  the settled label (completion is a UI state, not a tense change). */
  const intent = useToolCallIntent(args);
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
    hasInput: !!code,
    onExpand,
    runStepStatus,
    extraError: backgroundFailed,
    extraCancelled: cancelledInBackground,
  });

  const highlighted = useLazyHighlight(showCode ? code : undefined, lang);
  const { ref: codePaneRef, onScroll: onCodePaneScroll } = useFollowScroll<HTMLPreElement>(
    highlighted ?? code ?? '',
    phase === 'running',
    showCode,
  );

  return (
    <>
      <div className={TOOL_ROW_CLASSES}>
        <ProgressText
          phase={phase}
          onClick={toggleCode}
          inProgressText={
            intent ??
            (sandboxStarting ? localize('com_ui_sandbox_starting') : localize('com_ui_analyzing'))
          }
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (backgroundFinishedText ?? intent ?? localize('com_ui_analyzing_finished'))
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
            <SquareTerminal
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
          hasInput={!!code?.length}
          isExpanded={showCode}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          <div
            className={cn(
              toolPanelSpacingClassName,
              'overflow-hidden rounded-lg border border-border-light bg-surface-secondary',
            )}
          >
            {code && <CodeWindowHeader language={lang} code={code} />}
            {code && (
              <pre
                ref={codePaneRef}
                onScroll={onCodePaneScroll}
                className="max-h-[300px] overflow-auto bg-surface-chat p-4 font-mono text-xs dark:bg-surface-primary-alt"
              >
                <code className={`hljs language-${lang} !whitespace-pre`}>
                  {highlighted ?? code}
                </code>
              </pre>
            )}
            <PtcToolTrace
              toolCallId={toolCallId}
              expanded={showCode}
              className={cn(code && 'border-t border-border-light')}
            />
            {hasOutput && backgroundHandle == null && (
              <div
                className={cn(
                  'bg-surface-primary-alt p-4 text-xs dark:bg-transparent',
                  code && 'border-t border-border-light',
                )}
              >
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  {localize('com_ui_output')}
                </div>
                <div
                  className={cn(
                    'max-h-[200px] overflow-auto',
                    outputHasError ? 'text-status-error' : 'text-text-primary',
                  )}
                >
                  <Stdout output={output} />
                </div>
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
