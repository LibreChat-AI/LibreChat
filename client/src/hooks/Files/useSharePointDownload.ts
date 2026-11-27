import { useCallback, useState } from 'react';
import { useToastContext } from '@librechat/client';
import type { SharePointFile, SharePointBatchProgress } from '~/data-provider/Files';
import { useSharePointBatchDownload } from '~/data-provider/Files';
import useSharePointToken from './useSharePointToken';

interface UseSharePointDownloadProps {
  onFilesDownloaded?: (files: File[]) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface UseSharePointDownloadReturn {
  downloadSharePointFiles: (files: SharePointFile[]) => Promise<File[]>;
  isDownloading: boolean;
  downloadProgress: SharePointBatchProgress | null;
  error: string | null;
}

export default function useSharePointDownload({
  onFilesDownloaded,
  onError,
}: UseSharePointDownloadProps = {}): UseSharePointDownloadReturn {
  const { showToast } = useToastContext();
  const [downloadProgress, setDownloadProgress] = useState<SharePointBatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { getToken } = useSharePointToken({
    enabled: false,
    purpose: 'Download',
  });

  const batchDownloadMutation = useSharePointBatchDownload();

  const downloadSharePointFiles = useCallback(
    async (files: SharePointFile[]): Promise<File[]> => {
      if (!files || files.length === 0) {
        throw new Error('No files provided for download');
      }

      setError(null);
      setDownloadProgress({ completed: 0, total: files.length, failed: [] });

      try {
        const accessToken = (await getToken())?.access_token;
        if (!accessToken) {
          throw new Error('Failed to obtain SharePoint access token');
        }

        showToast({
          message: `Downloading ${files.length} file(s) from SharePoint...`,
          status: 'info',
          duration: 3000,
        });

        const downloadedFiles = await batchDownloadMutation.mutateAsync({
          files,
          accessToken,
          onProgress: (progress) => {
            setDownloadProgress(progress);

            if (files.length > 5 && progress.completed % 3 === 0) {
              showToast({
                message: `Downloaded ${progress.completed}/${progress.total} files...`,
                status: 'info',
                duration: 1000,
              });
            }
          },
        });

        if (downloadedFiles.length > 0) {
          const failedCount = files.length - downloadedFiles.length;
          const successMessage =
            failedCount > 0
              ? `Downloaded ${downloadedFiles.length}/${files.length} files from SharePoint (${failedCount} failed)`
              : `Successfully downloaded ${downloadedFiles.length} file(s) from SharePoint`;

          showToast({
            message: successMessage,
            status: failedCount > 0 ? 'warning' : 'success',
            duration: 4000,
          });

          if (onFilesDownloaded) {
            await onFilesDownloaded(downloadedFiles);
          }
        }

        setDownloadProgress(null);
        return downloadedFiles;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown download error';
        setError(errorMessage);

        showToast({
          message: `SharePoint download failed: ${errorMessage}`,
          status: 'error',
          duration: 5000,
        });

        if (onError) {
          onError(error instanceof Error ? error : new Error(errorMessage));
        }

        setDownloadProgress(null);
        throw error;
      }
    },
    [getToken, showToast, batchDownloadMutation, onFilesDownloaded, onError],
  );

  return {
    downloadSharePointFiles,
    isDownloading: batchDownloadMutation.isLoading,
    downloadProgress,
    error,
  };
}
