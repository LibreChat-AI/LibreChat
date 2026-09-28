import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastContext } from '@librechat/client';
import type { Artifact } from '~/common';
import {
  getArtifactDownloadFilename,
  getOriginalArtifactFilename,
  isPreviewOnlyArtifact,
} from '~/utils/artifacts';
import {
  useAttachmentLink,
  isLocallyStoredSource,
} from '~/components/Chat/Messages/Content/Parts/LogLink';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useCodeState } from '~/Providers/EditorContext';
import useLocalize from '~/hooks/useLocalize';

export interface ArtifactDownload {
  /** Briefly true after a file actually reached the user, for the check-mark swap. */
  isDownloaded: boolean;
  /**
   * Resolves to whether bytes actually reached the user, and every `false`
   * has already been reported to them: the attachment route swallows fetch
   * errors and toasts them itself, and the blob path below does the same,
   * so a caller that announces completion (the mermaid export menu) gates
   * it on this result and only has to speak in its own live region.
   */
  handleDownload: (event: React.MouseEvent<HTMLElement>) => Promise<boolean>;
}

/**
 * Saves an artifact to disk, picking between the original file and the
 * (possibly edited) panel content.
 *
 * A hook rather than logic inside the download button because mermaid
 * artifacts expose the same action as an item in their export menu instead
 * of a second icon beside it — two entry points, one decision about what the
 * bytes should be.
 */
export default function useArtifactDownload(artifact: Artifact): ArtifactDownload {
  const { currentCode } = useCodeState();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [isDownloaded, setIsDownloaded] = useState(false);
  const { fileKey: fileName } = useArtifactProps({ artifact });
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  /* Unedited file-backed artifacts download the original: cached extraction
   * can be truncated or transformed. Edited content is exported as a blob. */
  const { download } = artifact;
  /* Only take the original-file branch when `useAttachmentLink` can
   * actually fetch something: a usable `filepath` (http target, share
   * route, or code-output URL) OR enough metadata for the local-file
   * API path (`isLocallyStoredSource` + file_id + user). A shared link
   * to a non-snapshotted code-execution artifact strips source/user and
   * deletes filepath while keeping file_id; without this guard that lone
   * file_id would route to an empty fetch and download nothing instead
   * of falling back to the preview-content blob. */
  const hasUsableRoute =
    (download?.filepath != null && download.filepath !== '') ||
    (download?.file_id != null &&
      download?.user != null &&
      isLocallyStoredSource(download?.source));
  const hasEdits = currentCode != null && currentCode !== artifact.content;
  /**
   * Mermaid is no exception, even though the panel renders the diagram
   * straight from `content`: that content is the cached extraction, and
   * `extractUtf8` keeps only the first 512 KB plus a truncation marker, so
   * a stored `.mmd` above that cap would otherwise be saved corrupt. When
   * the route is missing (a share that dropped it) or the panel holds
   * edits, the content blob below is still the right bytes.
   */
  const downloadOriginalFile =
    hasUsableRoute && (isPreviewOnlyArtifact(artifact.type) || !hasEdits);
  const { handleDownload: downloadAttachment } = useAttachmentLink({
    href: download?.filepath ?? '',
    filename: getOriginalArtifactFilename(artifact, fileName),
    file_id: download?.file_id,
    user: download?.user,
    source: download?.source,
  });

  const markDownloaded = useCallback(() => {
    setIsDownloaded(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setIsDownloaded(false), 3000);
  }, []);

  const handleDownload = useCallback(
    async (event: React.MouseEvent<HTMLElement>): Promise<boolean> => {
      try {
        if (downloadOriginalFile) {
          // Only flag success when a file was actually delivered; the
          // attachment helper swallows fetch errors (e.g. an expired
          // code-output URL or a 404 share download) and resolves either way.
          const downloaded = await downloadAttachment(event);
          if (downloaded) {
            markDownloaded();
          }
          return downloaded;
        }
        const content = currentCode ?? artifact.content;
        if (content == null) {
          /* Nothing to serialize and no route to fetch: the press has to
           * say something, or it looks like the download worked. */
          showToast({ status: 'error', message: localize('com_ui_download_error') });
          return false;
        }
        const blob = new Blob([content], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getArtifactDownloadFilename(artifact, fileName, content);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        markDownloaded();
        return true;
      } catch (error) {
        console.error('Download failed:', error);
        showToast({ status: 'error', message: localize('com_ui_download_error') });
        return false;
      }
    },
    [
      artifact,
      currentCode,
      downloadAttachment,
      downloadOriginalFile,
      fileName,
      localize,
      markDownloaded,
      showToast,
    ],
  );

  return { isDownloaded, handleDownload };
}
