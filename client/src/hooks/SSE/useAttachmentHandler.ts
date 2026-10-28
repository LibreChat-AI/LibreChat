import { useCallback } from 'react';
import { QueryKeys, Tools } from 'librechat-data-provider';
import { useAttachmentHandler as useStreamAttachments } from '@librechat/chat/react';
import type { TFile, TAttachment, MemoriesResponse } from 'librechat-data-provider';
import type { AttachmentHandler } from '@librechat/chat/react';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateRecentFiles } from '~/utils/files';
import { handleMemoryArtifact } from '~/utils/memory';

/** Keeps the app's file, memory and preview caches in step with a streamed attachment. */
function updateAttachmentCaches(queryClient: QueryClient, data: TAttachment): void {
  const fileId = (data as Partial<TFile>).file_id;
  const fileData = data as TFile;
  if (fileData?.file_id && fileData?.filepath && !fileData.filepath.includes('/api/files')) {
    queryClient.setQueryData([QueryKeys.files], (oldData: TFile[] | undefined) => {
      if (!oldData) {
        return [fileData];
      }
      const existingIndex = oldData.findIndex((file) => file.file_id === fileData.file_id);
      if (existingIndex > -1) {
        const updated = [...oldData];
        updated[existingIndex] = { ...oldData[existingIndex], ...fileData };
        return updated;
      }
      return [fileData, ...oldData];
    });
    invalidateRecentFiles(queryClient);
  }

  if (data.type === Tools.memory && data[Tools.memory]) {
    const memoryArtifact = data[Tools.memory];
    queryClient.setQueryData([QueryKeys.memories], (oldData: MemoriesResponse | undefined) => {
      if (!oldData) {
        return oldData;
      }
      return handleMemoryArtifact({ memoryArtifact, currentData: oldData }) || oldData;
    });
  }

  /* Cross-turn filename reuse keeps the same `file_id` across runs. If a prior turn left
   * `[QueryKeys.filePreview, file_id]` cached at `status: 'ready'`, a new pending attachment
   * would mount against that stale cache and `useFilePreview`'s `refetchInterval` (which only
   * polls on `pending`) would never start. Removing the entry, rather than invalidating it,
   * leaves a fresh mount nothing to read, so it must fetch. */
  if (fileId) {
    queryClient.removeQueries([QueryKeys.filePreview, fileId]);
  }
}

/** The package's streamed attachment handler, with the app's caches kept in step. */
export default function useAttachmentHandler(queryClient?: QueryClient): AttachmentHandler {
  const onAttachment = useCallback(
    (data: TAttachment) => queryClient && updateAttachmentCaches(queryClient, data),
    [queryClient],
  );
  return useStreamAttachments(onAttachment);
}
