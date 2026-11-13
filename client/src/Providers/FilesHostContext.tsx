import type { FilesHost, FileDeleteScope } from '@librechat/chat/react';
import { useDeleteFilesMutation } from '~/data-provider';
import { MinimalIcon } from '~/components/Endpoints';
import { logger, getCachedPreview } from '~/utils';
import { useFileDeletion } from '~/hooks/Files';

/** Deletes one file from the surface the scope names, as the attachment row always did. */
export function useDeleteFile({
  agent_id,
  assistant_id,
  tool_resource,
  index,
}: FileDeleteScope): ReturnType<FilesHost['useDeleteFile']> {
  const { mutateAsync } = useDeleteFilesMutation({
    onMutate: async () =>
      logger.log(
        'agents',
        'Deleting files: agent_id, assistant_id, tool_resource',
        agent_id,
        assistant_id,
        tool_resource,
      ),
    onSuccess: () => {
      console.log('Files deleted');
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
    },
  });

  const { deleteFile } = useFileDeletion({
    mutateAsync,
    agent_id,
    assistant_id,
    tool_resource,
    index,
  });

  return deleteFile;
}

/** The app's capabilities for the attachment components in `@librechat/chat`. */
export const appFilesHost: FilesHost = {
  renderEndpointIcon: (endpoint) => (
    <MinimalIcon endpoint={endpoint} size={14} isCreatedByUser={false} iconClassName="h-3 w-3" />
  ),
  useDeleteFile,
  getPreviewUrl: getCachedPreview,
};

export { FilesHostProvider, useFilesHost } from '@librechat/chat/react';
