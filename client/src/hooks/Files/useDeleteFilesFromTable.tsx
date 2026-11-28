import { useSetAtom } from 'jotai';
import { filesFamily } from '@librechat/chat/react';
import { useQueryClient } from '@tanstack/react-query';
import { FileSources, QueryKeys } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { deletePreview, failedFileIdsFrom, removeTabAttachmentPresence } from '~/utils';
import { useDeleteFilesMutation } from '~/data-provider';
import { clearUploadRecovery } from './useFileHandling';
import useSetFilesToDelete from './useSetFilesToDelete';

export default function useDeleteFilesFromTable() {
  const queryClient = useQueryClient();
  const setFiles = useSetAtom(filesFamily(0));
  const setFilesToDelete = useSetFilesToDelete();
  const mutation = useDeleteFilesMutation();

  async function deleteFiles(files: TFile[]) {
    let failed: Set<string>;
    try {
      const result = await mutation.mutateAsync({
        files: files.map(({ file_id, filepath, source, embedded, temp_file_id }) => ({
          file_id,
          filepath: filepath ?? '',
          source: source ?? FileSources.local,
          embedded: embedded ?? false,
          temp_file_id,
        })),
      });
      failed = new Set(failedFileIdsFrom(result));
    } catch {
      failed = new Set(files.map((file) => file.file_id));
    }
    const removed = files
      .filter((file) => !failed.has(file.file_id))
      .flatMap((file) => (file.temp_file_id ? [file.file_id, file.temp_file_id] : [file.file_id]));
    if (removed.length) {
      for (const id of removed) {
        clearUploadRecovery(id);
        deletePreview(id);
      }
      removeTabAttachmentPresence(removed, 0);
      setFiles((current) => {
        const updated = new Map(current);
        for (const id of removed) {
          updated.delete(id);
        }
        setFilesToDelete(Object.fromEntries(updated));
        return updated;
      });
    }
    if (failed.size) {
      await queryClient.invalidateQueries({ queryKey: [QueryKeys.files], exact: true });
    }
    return failed;
  }

  return { deleteFiles };
}
