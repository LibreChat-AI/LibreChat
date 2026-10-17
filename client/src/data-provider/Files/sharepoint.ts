import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

export interface SharePointFile {
  id: string;
  name: string;
  size: number;
  webUrl: string;
  downloadUrl: string;
  driveId: string;
  itemId: string;
  sharePointItem: any;
}

export interface SharePointBatchProgress {
  completed: number;
  total: number;
  currentFile?: string;
  failed: string[];
}

export const useSharePointBatchDownload = (): UseMutationResult<
  File[],
  unknown,
  {
    files: SharePointFile[];
    accessToken: string;
    onProgress?: (progress: SharePointBatchProgress) => void;
  },
  unknown
> => {
  return useMutation({
    mutationFn: async ({ files, accessToken, onProgress }) => {
      const downloadedFiles: File[] = [];
      const failed: string[] = [];
      let completed = 0;

      const concurrencyLimit = 3;
      const chunks: SharePointFile[][] = [];
      for (let i = 0; i < files.length; i += concurrencyLimit) {
        chunks.push(files.slice(i, i + concurrencyLimit));
      }

      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (file) => {
          try {
            const downloadUrl =
              file.downloadUrl ||
              `https://graph.microsoft.com/v1.0/drives/${file.driveId}/items/${file.itemId}/content`;

            const response = await fetch(downloadUrl, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            });

            if (!response.ok) {
              throw new Error(`${response.status} ${response.statusText}`);
            }

            const blob = await response.blob();
            const contentType =
              response.headers.get('content-type') || getMimeTypeFromFileName(file.name);

            const downloadedFile = new File([blob], file.name, {
              type: contentType,
              lastModified: Date.now(),
            });

            completed++;
            onProgress?.({
              completed,
              total: files.length,
              currentFile: file.name,
              failed,
            });

            return downloadedFile;
          } catch (error) {
            console.error('SharePoint file download failed');
            failed.push(file.name);
            completed++;
            onProgress?.({
              completed,
              total: files.length,
              currentFile: `Error: ${file.name}`,
              failed,
            });
            throw error;
          }
        });

        const chunkResults = await Promise.allSettled(chunkPromises);

        chunkResults.forEach((result) => {
          if (result.status === 'fulfilled') {
            downloadedFiles.push(result.value);
          }
        });
      }

      if (failed.length > 0) {
        console.warn(`Failed to download ${failed.length} files`);
      }

      return downloadedFiles;
    },
    retry: 1,
  });
};

function getMimeTypeFromFileName(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    txt: 'text/plain',
    csv: 'text/csv',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    webp: 'image/webp',

    // Archives
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',

    // Media
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };

  return mimeTypes[extension || ''] || 'application/octet-stream';
}
