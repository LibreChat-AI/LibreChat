import type {
  FilesHost,
  FileDeleteScope,
  KnownFilesQuery,
  AttachmentPreview,
  AttachmentDownloadTarget,
} from '@librechat/chat/react';
import type { TAttachment, TFile } from 'librechat-data-provider';
import {
  classifyAttachment,
  renderAttachmentArtifact,
} from '~/components/Chat/Messages/Content/Parts/attachmentHost';
import { useAttachmentLink } from '~/components/Chat/Messages/Content/Parts/LogLink';
import useAttachmentPreviewSync from '~/hooks/Files/useAttachmentPreviewSync';
import { useDeleteFilesMutation, useGetFiles } from '~/data-provider';
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

function useAttachmentDownload(target: AttachmentDownloadTarget) {
  const { handleDownload } = useAttachmentLink({
    href: target.href,
    filename: target.filename,
    file_id: target.fileId,
    user: target.user,
    source: target.source,
  });
  return handleDownload;
}

function useAttachmentPreview(attachment: TAttachment | undefined): AttachmentPreview {
  const { status, previewError } = useAttachmentPreviewSync(attachment);
  return { status, previewError };
}

function useKnownFiles({ enabled, fileIds }: KnownFilesQuery): TFile[] {
  const { data = [] } = useGetFiles<TFile[]>({
    enabled,
    select: (files) => files.filter((file) => fileIds.has(file.file_id)),
  });
  return data;
}

/** The app's capabilities for the attachment components in `@librechat/chat`. */
export const appFilesHost: FilesHost = {
  renderEndpointIcon: (endpoint) => (
    <MinimalIcon endpoint={endpoint} size={14} isCreatedByUser={false} iconClassName="h-3 w-3" />
  ),
  useDeleteFile,
  getPreviewUrl: getCachedPreview,
  useAttachmentDownload,
  useAttachmentPreview,
  useKnownFiles,
  classifyAttachment,
  renderAttachmentArtifact,
};

export { FilesHostProvider, useFilesHost } from '@librechat/chat/react';
