import { useCallback } from 'react';
import type { EModelEndpoint } from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { FileHandlingState } from './useFileHandling';
import useFileHandling, { useFileHandlingNoChatContext } from './useFileHandling';
import useSharePointDownload from './useSharePointDownload';

interface UseSharePointFileHandlingProps {
  fileSetter?: any;
  toolResource?: string;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  endpointOverride?: EModelEndpoint | string;
  endpointTypeOverride?: EModelEndpoint | string;
}

interface UseSharePointFileHandlingReturn {
  handleSharePointFiles: (files: SharePointFile[]) => Promise<void>;
  isProcessing: boolean;
  downloadProgress: any;
  error: string | null;
}

export default function useSharePointFileHandling(
  props?: UseSharePointFileHandlingProps,
): UseSharePointFileHandlingReturn {
  const { handleFiles, captureUploadLifecycle } = useFileHandling(props);
  const { downloadSharePointFiles, isDownloading, downloadProgress, error } = useSharePointDownload(
    {
      onError: (error) => {
        console.error('SharePoint download failed:', error);
      },
    },
  );

  const handleSharePointFiles = useCallback(
    async (sharePointFiles: SharePointFile[]) => {
      const toolResource = props?.toolResource;
      const lifecycle = captureUploadLifecycle(toolResource);
      try {
        const downloadedFiles = await downloadSharePointFiles(sharePointFiles);
        await handleFiles(downloadedFiles, toolResource, lifecycle);
      } catch (error) {
        console.error('SharePoint file handling error:', error);
        throw error;
      }
    },
    [downloadSharePointFiles, handleFiles, captureUploadLifecycle, props?.toolResource],
  );

  return {
    handleSharePointFiles,
    isProcessing: isDownloading,
    downloadProgress,
    error,
  };
}

export function useSharePointFileHandlingNoChatContext(
  props: UseSharePointFileHandlingProps | undefined,
  fileState: FileHandlingState,
): UseSharePointFileHandlingReturn {
  const { handleFiles, captureUploadLifecycle } = useFileHandlingNoChatContext(props, fileState);

  const { downloadSharePointFiles, isDownloading, downloadProgress, error } = useSharePointDownload(
    {
      onError: (error) => {
        console.error('SharePoint download failed:', error);
      },
    },
  );

  const handleSharePointFiles = useCallback(
    async (sharePointFiles: SharePointFile[]) => {
      const toolResource = props?.toolResource;
      const lifecycle = captureUploadLifecycle(toolResource);
      try {
        const downloadedFiles = await downloadSharePointFiles(sharePointFiles);
        await handleFiles(downloadedFiles, toolResource, lifecycle);
      } catch (error) {
        console.error('SharePoint file handling error:', error);
        throw error;
      }
    },
    [downloadSharePointFiles, handleFiles, captureUploadLifecycle, props?.toolResource],
  );

  return {
    handleSharePointFiles,
    isProcessing: isDownloading,
    downloadProgress,
    error,
  };
}
