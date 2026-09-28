import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import ProgressText from '~/components/Chat/Messages/Content/ProgressText';
import { toolPanelSpacingClassName } from '../disclosure';
import useToolCallState from './useToolCallState';
import useLazyHighlight from './useLazyHighlight';
import CodeWindowHeader from './CodeWindowHeader';
import { AttachmentGroup } from './Attachment';
import parseJsonField from './parseJsonField';
import { useToolCallIntent } from './intent';
import { TOOL_ROW_CLASSES } from '../rows';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const LANG_MAP: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  r: 'r',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

const FILENAME_MAP: Record<string, string> = {
  makefile: 'makefile',
  dockerfile: 'dockerfile',
};

export function langFromPath(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  const byName = FILENAME_MAP[name];
  if (byName) {
    return byName;
  }
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';
  return LANG_MAP[ext] ?? 'plaintext';
}

export default function ReadFileCall({
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
  const filePath = useMemo(
    () => parseJsonField(args, 'path') || parseJsonField(args, 'file_path'),
    [args],
  );
  const intent = useToolCallIntent(args);
  const fileName = filePath.split('/').pop() || filePath;
  const lang = useMemo(() => langFromPath(filePath), [filePath]);

  const { showCode, toggleCode, expandStyle, expandRef, phase, hasOutput } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: !!filePath,
    onExpand,
    runStepStatus,
  });

  const highlighted = useLazyHighlight(showCode && hasOutput ? output : undefined, lang);

  return (
    <>
      <div className={TOOL_ROW_CLASSES}>
        <ProgressText
          phase={phase}
          onClick={toggleCode}
          inProgressText={intent ?? localize('com_ui_reading_file', { 0: fileName })}
          finishedText={
            phase === 'cancelled'
              ? localize('com_ui_cancelled')
              : (intent ?? localize('com_ui_read_file', { 0: fileName }))
          }
          durationMs={runStepDurationMs}
          icon={
            <FileText
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
          hasInput={!!filePath || hasOutput}
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
              <CodeWindowHeader language={fileName} code={output} />
              <pre className="max-h-[300px] overflow-auto bg-surface-chat p-4 font-mono text-xs dark:bg-surface-primary-alt">
                <code className={`hljs language-${lang} !whitespace-pre`}>
                  {highlighted ?? output}
                </code>
              </pre>
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
