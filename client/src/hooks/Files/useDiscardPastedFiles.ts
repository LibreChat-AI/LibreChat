import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileSources, QueryKeys } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  collectForeignAttachmentClaims,
  getComposerDraftId,
  isPasteSubmitted,
  retainFileDeletion,
} from '~/utils';
import { cancelUploads } from './useFileHandling';

/** Deletes an unsent original when its edited replacement is sent inline. */
export default function useDiscardPastedFiles(index: number, conversationId?: string | null) {
  const queryClient = useQueryClient();
  return useCallback(
    (fileIds: string[]) => {
      cancelUploads(fileIds);
      const ids = new Set(fileIds);
      const foreign = collectForeignAttachmentClaims(
        [
          getComposerDraftId(index, conversationId, false),
          getComposerDraftId(index, conversationId, true),
        ],
        index,
      );
      const files = queryClient.getQueryData<TFile[]>([QueryKeys.files]);
      for (const file of files ?? []) {
        if (!ids.has(file.file_id) && (!file.temp_file_id || !ids.has(file.temp_file_id))) continue;
        if (
          isPasteSubmitted(file.file_id) ||
          isPasteSubmitted(file.temp_file_id) ||
          foreign.has(file.file_id) ||
          (file.temp_file_id != null && foreign.has(file.temp_file_id))
        )
          continue;
        retainFileDeletion({
          file_id: file.file_id,
          filepath: file.filepath,
          source: file.source ?? FileSources.local,
          embedded: file.embedded ?? false,
        });
      }
    },
    [queryClient, index, conversationId],
  );
}
