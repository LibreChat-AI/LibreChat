import React from 'react';
import { useToastContext } from '@librechat/client';
import { FileSources, sharedFileDownload } from 'librechat-data-provider';
import { getDownloadFilename, isHttpDownloadTarget, triggerDownload } from '~/utils';
import { useCodeOutputDownload, useFileDownload } from '~/data-provider';
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

export const useAttachmentLink = ({
  href,
  filename,
  file_id,
  user,
  source,
}: AttachmentLinkOptions) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
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
