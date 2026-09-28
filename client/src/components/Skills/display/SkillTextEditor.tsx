import { useState } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Textarea, useToastContext } from '@librechat/client';
import type { TSkillFileContentResponse } from 'librechat-data-provider';
import { useUploadSkillFileMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

interface SkillTextEditorProps {
  skillId: string;
  relativePath: string;
  file: TSkillFileContentResponse & { content: string };
  canEdit: boolean;
  onClose: () => void;
}

export default function SkillTextEditor({
  skillId,
  relativePath,
  file,
  canEdit,
  onClose,
}: SkillTextEditorProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const [content, setContent] = useState(file.content);
  const [conflict, setConflict] = useState(false);

  const upload = useUploadSkillFileMutation({
    onSuccess: (saved) => {
      queryClient.setQueryData<TSkillFileContentResponse | null>(
        [QueryKeys.skillFileContent, skillId, relativePath],
        {
          ...file,
          content,
          fileId: saved.file_id,
          bytes: new Blob([content]).size,
          filename: saved.filename,
          mimeType: saved.mimeType,
          isBinary: false,
        },
      );
      showToast({
        status: 'success',
        message: localize('com_ui_edited_file', { 0: file.filename }),
      });
      onClose();
    },
    onError: (error: unknown) => {
      const isConflict = (error as { response?: { status?: number } })?.response?.status === 409;
      setConflict(isConflict);
      if (isConflict) {
        queryClient.invalidateQueries([QueryKeys.skillFileContent, skillId, relativePath]);
      }
      showToast({
        status: 'error',
        message: localize(
          isConflict ? 'com_ui_skill_file_conflict' : 'com_ui_skill_file_save_error',
        ),
      });
    },
  });

  const save = () => {
    if (!canEdit || !file.fileId || conflict || upload.isLoading || content === file.content) {
      return;
    }
    const formData = new FormData();
    formData.append('relativePath', relativePath);
    formData.append('expectedFileId', file.fileId);
    formData.append('file', new File([content], file.filename, { type: file.mimeType }));
    upload.mutate({ skillId, formData });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            save();
          }
        }}
        disabled={upload.isLoading}
        spellCheck={false}
        aria-label={`${localize('com_ui_edit')} ${file.filename}`}
        className="min-h-0 flex-1 resize-none font-mono text-sm text-text-primary"
      />
      {upload.isError && (
        <p role="alert" className="text-sm text-text-destructive">
          {localize(conflict ? 'com_ui_skill_file_conflict' : 'com_ui_skill_file_save_error')}
        </p>
      )}
      {!canEdit && (
        <p role="note" className="text-sm text-text-secondary">
          {localize('com_ui_skill_no_edit_permission')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={upload.isLoading}>
          {localize('com_ui_cancel')}
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={
            !canEdit || !file.fileId || conflict || upload.isLoading || content === file.content
          }
        >
          {upload.isLoading ? localize('com_ui_saving') : localize('com_ui_save')}
        </Button>
      </div>
    </div>
  );
}
