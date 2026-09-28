import { useMemo } from 'react';
import { FilePenLine, FilePlus2 } from 'lucide-react';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import DiffView, {
  parseUnifiedDiff,
  buildEditPreviewDiff,
  diffPreviewText,
  type TextEditPreview,
} from './DiffView';
import parseJsonField, { parseJsonFieldOccurrences } from './parseJsonField';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { toolPanelSpacingClassName } from '../disclosure';
import useToolCallState from './useToolCallState';
import useLazyHighlight from './useLazyHighlight';
import CodeWindowHeader from './CodeWindowHeader';
import useFollowScroll from './useFollowScroll';
import { AttachmentGroup } from './Attachment';
import { langFromPath } from './ReadFileCall';
import { useToolCallIntent } from './intent';
import { TOOL_ROW_CLASSES } from '../rows';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type FileAuthoringToolName = 'create_file' | 'edit_file';

type ToolCallArgs = string | Record<string, unknown> | undefined;

function hasDiff(output: string): boolean {
  return /\n@@\s/.test(output) || output.includes('\n--- ') || output.includes('\n+++ ');
}

function parseArgsObject(args: ToolCallArgs): Record<string, unknown> | undefined {
  if (typeof args === 'object' && args !== null) {
    return args;
  }
  if (typeof args !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coerceJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Structured edits for the args preview. Never formatted into diff text:
 *  `buildEditPreviewDiff` renders them directly, so no separator has to be
 *  invented and later told apart from real content. */
function buildEditArgsPreview(args: ToolCallArgs): TextEditPreview[] {
  const parsed = parseArgsObject(args);
  const edits = coerceJsonValue(parsed?.edits);
  if (Array.isArray(edits) && edits.length > 0) {
    return edits
      .map((edit): TextEditPreview | undefined => {
        const coercedEdit = coerceJsonValue(edit);
        if (typeof coercedEdit !== 'object' || coercedEdit === null || Array.isArray(coercedEdit)) {
          return undefined;
        }
        const entry = coercedEdit as Record<string, unknown>;
        const oldText = textValue(entry.old_text);
        const newText = textValue(entry.new_text);
        return oldText || newText ? { oldText, newText } : undefined;
      })
      .filter((edit): edit is TextEditPreview => !!edit);
  }

  if (parsed) {
    const oldText = textValue(parsed.old_text);
    const newText = textValue(parsed.new_text);
    return oldText || newText ? [{ oldText, newText }] : [];
  }

  /** Partial JSON during streaming: pair up field occurrences in document order, covering both single-replacement and batched `edits` args */
  const oldTexts = parseJsonFieldOccurrences(args, 'old_text');
  const newTexts = parseJsonFieldOccurrences(args, 'new_text');
  const editCount = Math.max(oldTexts.length, newTexts.length);
  return Array.from({ length: editCount }, (_, index) => ({
    oldText: oldTexts[index] ?? '',
    newText: newTexts[index] ?? '',
  })).filter((edit) => edit.oldText || edit.newText);
}

export default function FileAuthoringCall({
  toolName,
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
  toolName: FileAuthoringToolName;
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
  const isCreate = toolName === 'create_file';
  /** `create_file` can overwrite an existing file (sandbox `overwrite: true`,
   *  or skill SKILL.md updates). The host-authored summary always opens with
   *  `Created`/`Updated`, so key the finished label off it for truthfulness. */
  const overwrote = isCreate && output.startsWith('Updated ');
  const filePath = useMemo(
    () => parseJsonField(args, 'path') || parseJsonField(args, 'file_path'),
    [args],
  );
  const intent = useToolCallIntent(args);
  const authoredContent = useMemo(() => parseJsonField(args, 'content'), [args]);
  const editArgs = useMemo(() => buildEditArgsPreview(args), [args]);
  const fileName = filePath.split('/').pop() || filePath || localize('com_ui_file').toLowerCase();
  const fileLang = useMemo(() => langFromPath(filePath), [filePath]);
  const outputIsDiff = hasDiff(output);
  /** A diff in the output supersedes the args preview: it carries the input
   *  with real file context. Only the output is ever PARSED; the args preview
   *  is built from structured edits, so it never round-trips through diff text
   *  where a separator could be confused with a real changed line. */
  const parsedDiff = useMemo(() => {
    if (outputIsDiff) {
      return parseUnifiedDiff(output);
    }
    return !isCreate && editArgs.length > 0 ? buildEditPreviewDiff(editArgs) : null;
  }, [outputIsDiff, output, isCreate, editArgs]);
  /** Plain text for the non-diff pane, and the copy payload either way. A diff
   *  in the output supersedes everything, including a create's authored
   *  content: `create_file` overwriting an existing file returns a summary plus
   *  a unified diff, and preferring the authored content there rendered that
   *  diff twice, once through `DiffView` and again verbatim as the raw output
   *  section. */
  const preview = useMemo(() => {
    if (outputIsDiff) {
      return output;
    }
    if (isCreate) {
      return authoredContent || output;
    }
    return parsedDiff ? diffPreviewText(parsedDiff) : output;
  }, [isCreate, authoredContent, outputIsDiff, output, parsedDiff]);
  const showOutputSection = !!output && preview !== output;
  let previewLang = 'plaintext';
  if (isCreate && authoredContent && preview === authoredContent) {
    previewLang = fileLang;
  }

  const { showCode, toggleCode, expandStyle, expandRef, phase } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: !!filePath || !!preview,
    onExpand,
    runStepStatus,
  });

  const highlighted = useLazyHighlight(
    showCode && !parsedDiff && preview ? preview : undefined,
    previewLang,
  );
  const { ref: previewPaneRef, onScroll: onPreviewPaneScroll } = useFollowScroll<HTMLPreElement>(
    highlighted ?? preview,
    phase === 'running',
    showCode,
  );
  const Icon = isCreate && !overwrote ? FilePlus2 : FilePenLine;
  let finishedKey: 'com_ui_created_file' | 'com_ui_updated_file' | 'com_ui_edited_file' =
    'com_ui_edited_file';
  if (isCreate) {
    finishedKey = overwrote ? 'com_ui_updated_file' : 'com_ui_created_file';
  }

  return (
    <>
      <div className={TOOL_ROW_CLASSES}>
        <ProgressText
          phase={phase}
          onClick={toggleCode}
          inProgressText={
            intent ??
            localize(isCreate ? 'com_ui_creating_file' : 'com_ui_editing_file', {
              0: fileName,
            })
          }
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (intent ?? localize(finishedKey, { 0: fileName }))
          }
          durationMs={runStepDurationMs}
          icon={
            <Icon
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
          hasInput={!!filePath || !!preview}
          isExpanded={showCode}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          {!!preview && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'overflow-hidden rounded-lg border border-border-light bg-surface-secondary',
              )}
            >
              <CodeWindowHeader
                language={fileName}
                code={preview}
                diffStats={
                  parsedDiff
                    ? { additions: parsedDiff.additions, deletions: parsedDiff.deletions }
                    : undefined
                }
              />
              {parsedDiff ? (
                <DiffView parsed={parsedDiff} />
              ) : (
                <pre
                  ref={previewPaneRef}
                  onScroll={onPreviewPaneScroll}
                  className="max-h-[300px] overflow-auto bg-surface-chat p-4 font-mono text-xs dark:bg-surface-primary-alt"
                >
                  <code className={`hljs language-${previewLang} !whitespace-pre`}>
                    {highlighted ?? preview}
                  </code>
                </pre>
              )}
              {showOutputSection && (
                <pre
                  className={cn(
                    'max-h-[300px] overflow-auto whitespace-pre-wrap break-words border-t border-border-light px-3 py-2 font-mono text-xs',
                    phase === 'failed' ? 'text-status-error' : 'text-text-secondary',
                  )}
                >
                  {output}
                </pre>
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
