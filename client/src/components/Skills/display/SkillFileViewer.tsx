import React, { memo, useMemo, useState, useCallback, useRef } from 'react';
import { Copy, Check } from 'lucide';
import { useNavigate } from 'react-router-dom';
import { apiBaseUrl } from 'librechat-data-provider';
import { ArrowLeft, FileText, FileQuestion, Pencil } from 'lucide-react';
import { Button, Spinner, MorphIcon, TooltipAnchor, useToastContext } from '@librechat/client';
import type { TSkill, TSkillFileContentResponse } from 'librechat-data-provider';
import { useGetSkillFileContentQuery } from '~/data-provider';
import SkillMarkdownRenderer from './SkillMarkdownRenderer';
import { useLocalize, useSkillPermissions } from '~/hooks';
import SkillTextEditor from './SkillTextEditor';
import { parseFrontmatter } from '../utils';
import ViewToggle from './ViewToggle';

interface SkillFileViewerProps {
  skillId: string;
  relativePath: string;
  skill: TSkill | undefined;
}

const SKILL_MD_SKIP_KEYS = new Set(['name', 'description']);

function SkillFileViewer({ skillId, relativePath, skill }: SkillFileViewerProps) {
  const navigate = useNavigate();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data, isLoading, isError, isFetching, refetch } = useGetSkillFileContentQuery(
    skillId,
    relativePath,
  );
  const permissions = useSkillPermissions(skill);
  const [editingFile, setEditingFile] = useState<
    (TSkillFileContentResponse & { content: string }) | null
  >(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeout = useRef<NodeJS.Timeout | null>(null);

  const isMarkdown = relativePath.endsWith('.md');
  const isImage = data?.mimeType?.startsWith('image/') ?? false;
  const isSkillMd = relativePath === 'SKILL.md';
  const isText = data != null && !data.isBinary && data.content != null;
  const isEditing = editingFile != null;
  const canEdit = skill?.source === 'inline' && !permissions.isLoading && permissions.canEdit;
  // Older servers do not support conditional writes. Keep their sub-files read-only.
  const canEditFile = canEdit && data != null && (isSkillMd || !!data.fileId);

  const rawUrl = useMemo(
    () =>
      `${apiBaseUrl()}/api/skills/${skillId}/files/${encodeURIComponent(relativePath)}?raw=true`,
    [skillId, relativePath],
  );

  const parsed = useMemo(() => {
    if (!isMarkdown || !data?.content) {
      return null;
    }
    return parseFrontmatter(data.content, isSkillMd ? SKILL_MD_SKIP_KEYS : undefined);
  }, [isMarkdown, isSkillMd, data?.content]);

  const handleCopy = useCallback(async () => {
    if (isCopied || !data?.content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(data.content);
      setIsCopied(true);
      showToast({ message: localize('com_ui_copied_to_clipboard'), status: 'success' });
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
      copyTimeout.current = setTimeout(() => setIsCopied(false), 2000);
    } catch {
      showToast({ message: localize('com_ui_copy_failed'), status: 'error' });
    }
  }, [data?.content, isCopied, showToast, localize]);

  return (
    <div className="flex h-full flex-col">
      {/* Header — fixed h-10 prevents layout shift when toggle appears/disappears */}
      <div className="flex h-10 items-center gap-2 border-b border-border-medium px-4">
        <button
          type="button"
          onClick={() => navigate(`/skills/${skillId}`)}
          className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          aria-label={localize('com_ui_back')}
        >
          <ArrowLeft className="size-4" />
        </button>
        <FileText className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {data?.filename ?? relativePath}
        </span>

        {/* Actions — right side */}
        <div className="flex shrink-0 items-center gap-1">
          {canEditFile && !isEditing && !isLoading && (isSkillMd || isText) && (
            <TooltipAnchor
              description={localize('com_ui_edit')}
              render={
                <button
                  type="button"
                  onClick={() => {
                    if (isSkillMd) {
                      navigate(`/skills/${skillId}/edit`);
                    } else if (data?.content != null) {
                      setEditingFile({ ...data, content: data.content });
                    }
                  }}
                  className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  aria-label={localize('com_ui_edit')}
                >
                  <Pencil className="size-4" />
                </button>
              }
            />
          )}
          {/* Copy (text files only) */}
          {!isEditing && isText && (
            <TooltipAnchor
              description={isCopied ? localize('com_ui_copied') : localize('com_ui_copy')}
              render={
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  aria-label={localize('com_ui_copy_to_clipboard')}
                >
                  <MorphIcon icon={isCopied ? Check : Copy} className="size-4" />
                </button>
              }
            />
          )}

          {/* View toggle (markdown only) */}
          {!isEditing && isMarkdown && isText && (
            <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
          )}
        </div>
      </div>

      {/* Content — fills remaining space */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {editingFile ? (
          <SkillTextEditor
            skillId={skillId}
            relativePath={relativePath}
            file={editingFile}
            canEdit={canEditFile}
            onClose={() => setEditingFile(null)}
          />
        ) : (
          <>
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Spinner className="size-6 text-text-secondary" />
              </div>
            )}

            {(isError || data === null) && !data && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-secondary">
                <FileQuestion className="size-8" />
                <p className="text-sm">{localize('com_ui_skill_file_load_error')}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                >
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}

            {data && !isLoading && (
              <>
                {data.isBinary && isImage && (
                  <img
                    src={rawUrl}
                    alt={data.filename}
                    className="max-h-[600px] max-w-full rounded-lg object-contain"
                  />
                )}

                {data.isBinary && !isImage && (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-secondary">
                    <FileQuestion className="size-8" />
                    <p className="text-sm">{localize('com_ui_skill_file_binary')}</p>
                    <a
                      href={rawUrl}
                      download
                      className="text-sm text-text-primary underline hover:no-underline"
                    >
                      {localize('com_ui_skill_file_download')}
                    </a>
                  </div>
                )}

                {/* Markdown — frontmatter grid + rendered/source body */}
                {isText && isMarkdown && parsed && (
                  <>
                    {viewMode === 'rendered' && parsed.fields.length > 0 && (
                      <div className="mb-3 grid grid-cols-[max-content_1fr] items-baseline gap-x-8 gap-y-2">
                        {parsed.fields.map(({ key, value }) => (
                          <React.Fragment key={key}>
                            <span className="text-xs capitalize text-text-secondary">{key}</span>
                            <span className="text-sm text-text-primary">{value}</span>
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                    {viewMode === 'rendered' ? (
                      <SkillMarkdownRenderer
                        content={parsed.body}
                        skillId={skillId}
                        currentFilePath={relativePath}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-text-primary">
                        {data.content}
                      </pre>
                    )}
                  </>
                )}

                {/* Non-markdown text */}
                {isText && !isMarkdown && (
                  <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-text-primary">
                    {data.content}
                  </pre>
                )}

                {/* Text file too large for JSON response — offer download */}
                {!data.isBinary && data.content == null && (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-secondary">
                    <FileText className="size-8" />
                    <p className="text-sm">{localize('com_ui_skill_file_download')}</p>
                    <a
                      href={rawUrl}
                      download
                      className="text-sm text-text-primary underline hover:no-underline"
                    >
                      {localize('com_ui_skill_file_download')}
                    </a>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default memo(SkillFileViewer);
