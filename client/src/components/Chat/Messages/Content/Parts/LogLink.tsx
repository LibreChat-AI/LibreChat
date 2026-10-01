import React from 'react';
import { FileSources, sharedFileDownload } from 'librechat-data-provider';
import { getDownloadFilename, isHttpDownloadTarget, triggerDownload } from '~/utils';
import { useCodeOutputDownload, useFileDownload } from '~/data-provider';
import { useMessagePartsHost } from '~/hooks/Chat/parts';
import useLocalize from '~/hooks/useLocalize';
import { useShareContext } from '~/Providers';

interface LogLinkProps {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
  children: React.ReactNode;
}

interface AttachmentLinkOptions {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
}

/**
 * Determines if a file is stored locally (not an external API URL).
 * Files with these sources are stored on the LibreChat server and should
 * use the /api/files/download endpoint instead of direct URL access.
 */
export const isLocallyStoredSource = (source?: string): boolean => {
  if (!source) {
    return false;
  }
  return [
    FileSources.local,
    FileSources.firebase,
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.text,
  ].includes(source as FileSources);
};

/**
 * True when a `filePath` points at a code-interpreter output that has no
 * persisted `TFile` record to fetch through the owner/share file-ACL path —
 * only a session-scoped download URL (e.g.
 * `/api/files/code/download/:session_id/:fileId`), as produced by the
 * backend's download-fallback path (oversized output, or no storage
 * strategy) which carries no `source`/`file_id`/`type`/`bytes` at all.
 *
 * Mirrors `useAttachmentLink`'s own download branch above: a real,
 * locally-stored file (`file_id` + local/s3/etc. `source`) always prefers
 * that path, and an absolute http(s) URL is left to the browser/anchor tag
 * rather than fetched here (may be cross-origin, e.g. a presigned link).
 */
export const isCodeOutputAttachment = (
  filePath?: string,
  fileId?: string,
  source?: string,
): boolean =>
  !!filePath && !isHttpDownloadTarget(filePath) && !(!!fileId && isLocallyStoredSource(source));

export const useAttachmentLink = ({
  href,
  filename,
  file_id,
  user,
  source,
}: AttachmentLinkOptions) => {
  const localize = useLocalize();
  const { useToast } = useMessagePartsHost();
  const showToast = useToast();
  const { shareId } = useShareContext();

  const useLocalDownload = isLocallyStoredSource(source) && !!file_id && !!user;
  const { refetch: downloadFromApi } = useFileDownload(user, file_id, { source });
  const { refetch: downloadFromUrl } = useCodeOutputDownload(href);
  const downloadFilename = getDownloadFilename(filename, file_id, source);

  /**
   * Triggers the download and reports whether a file was actually
   * delivered: `true` once a download is initiated, `false` on a fetch
   * error or an empty/denied response (e.g. an expired code-output URL or
   * a 404 share download). Callers that show success feedback should gate
   * it on this result rather than on the promise merely resolving.
   *
   * Every `false` is announced here, by the layer that knows the cause, so
   * a caller can report the failure in its own live region without racing
   * this toast — one press never raises two notifications.
   */
  const handleDownload = async (event: React.MouseEvent<HTMLElement>): Promise<boolean> => {
    event.preventDefault();
    try {
      // In a shared view, a snapshotted file's href is rewritten to the share
      // route; download it through the share-scoped path (authorized by share
      // permission, not owner ACL). Non-snapshotted files fall through so the
      // original href / code-output path still works when snapshots are disabled.
      if (shareId && file_id && href.startsWith('/api/share/')) {
        triggerDownload(sharedFileDownload(shareId, file_id), downloadFilename);
        return true;
      }

      if (!useLocalDownload && isHttpDownloadTarget(href)) {
        triggerDownload(href, downloadFilename);
        return true;
      }

      const stream = useLocalDownload ? await downloadFromApi() : await downloadFromUrl();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({ status: 'error', message: localize('com_ui_download_error') });
        return false;
      }
      triggerDownload(stream.data, downloadFilename);
      return true;
    } catch (error) {
      console.error('Error downloading file:', error);
      showToast({ status: 'error', message: localize('com_ui_download_error') });
      return false;
    }
  };

  return { handleDownload };
};

const LogLink: React.FC<LogLinkProps> = ({ href, filename, file_id, user, source, children }) => {
  const { handleDownload } = useAttachmentLink({ href, filename, file_id, user, source });
  return (
    <a
      href={href}
      onClick={handleDownload}
      target="_blank"
      rel="noopener noreferrer"
      className="!text-link visited:!text-link-visited hover:underline"
    >
      {children}
    </a>
  );
};

export default LogLink;
