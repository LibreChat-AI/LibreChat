import { useState, useEffect, useCallback, useMemo } from 'react';
import copy from 'copy-to-clipboard';
import { Download } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import {
  getFileExtension,
  getPreviewKind,
  isExtractedTextPreviewLoading,
  shouldUseExtractedTextPreview,
  shouldUseSharedFileDownload,
} from './preview';
import {
  useFilePreview,
  useFilePreviewBlob,
  useFileDownload,
  useSharedFileDownload,
} from '~/data-provider';
import { getDownloadFilename, logger, sortPagesByRelevance, triggerDownload } from '~/utils';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useFileMapContext, useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface FilePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  fileId?: string;
  filePath?: string;
  relevance?: number;
  pages?: number[];
  pageRelevance?: Record<number, number>;
  fileType?: string;
  fileSource?: string;
  fileSize?: number;
  deliveryPath?: TFile['llmDeliveryPath'];
}

/** Formats bytes with unit suffix (differs from ~/utils/formatBytes which returns a raw number). */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function getDisplayType(fileType?: string, fileName?: string): string {
  if (fileType) {
    if (fileType.includes('pdf')) {
      return 'PDF';
    }
    if (fileType.includes('word') || fileType.includes('document')) {
      return 'Document';
    }
    if (fileType.includes('spreadsheet') || fileType.includes('excel')) {
      return 'Spreadsheet';
    }
    if (fileType.includes('presentation') || fileType.includes('powerpoint')) {
      return 'Presentation';
    }
    if (fileType.includes('image')) {
      return 'Image';
    }
    if (fileType.startsWith('text/')) {
      return fileType.split('/')[1]?.toUpperCase() || 'Text';
    }
    if (fileType.includes('json')) {
      return 'JSON';
    }
    if (fileType.includes('xml')) {
      return 'XML';
    }
  }
  const ext = fileName ? getFileExtension(fileName) : '';
  return ext ? ext.toUpperCase() : 'File';
}

export default function FilePreviewDialog({
  open,
  onOpenChange,
  fileName,
  fileId,
  relevance,
  pages,
  pageRelevance,
  fileType,
  fileSource,
  fileSize,
  deliveryPath,
}: FilePreviewDialogProps) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { shareId } = useShareContext();
  const fileMap = useFileMapContext();
  const showExtractedText = shouldUseExtractedTextPreview(
    deliveryPath ?? (!shareId && fileId ? fileMap?.[fileId]?.llmDeliveryPath : undefined),
  );
  const {
    data: extractedPreview,
    isInitialLoading: extractedTextLoading,
    isFetching: extractedTextFetching,
    isError: extractedTextError,
    refetch: refetchExtractedPreview,
  } = useFilePreview(
    fileId,
    {
      enabled: open && showExtractedText && !!fileId,
    },
    shareId,
  );
  // Downloads own URLs; previews share bytes and create only their display URL.
  const { refetch: downloadOwned } = useFileDownload(user?.id ?? '', fileId, { direct: false });
  const { refetch: downloadShared } = useSharedFileDownload(shareId, fileId);
  const { refetch: previewFile } = useFilePreviewBlob(user?.id, fileId, shareId);
  // A shared viewer must stay inside the share-scoped authorization boundary;
  // citation and retrieval previews do not carry a rewritten filepath signal.
  const useShared = shouldUseSharedFileDownload(shareId, fileId);
  const downloadFile = useShared ? downloadShared : downloadOwned;

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const previewKind = showExtractedText ? false : getPreviewKind(fileName, fileType, fileSource);
  const downloadFilename = getDownloadFilename(fileName, fileId, fileSource);
  const displayedText = showExtractedText ? (extractedPreview?.text ?? null) : fileContent;
  const isLoading =
    (!showExtractedText && loading) ||
    (showExtractedText &&
      isExtractedTextPreviewLoading(
        extractedPreview?.status,
        extractedTextLoading,
        extractedTextError,
      ));
  const hasPreviewError =
    (!showExtractedText && previewError) ||
    (showExtractedText &&
      (extractedTextError ||
        extractedPreview?.status === 'failed' ||
        (extractedPreview?.status === 'ready' && extractedPreview.text == null)));

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setFileContent(null);
    setFileBlobUrl(null);
    setPreviewError(false);
    setLoading(false);
    if (!open || !fileId || !previewKind) {
      return;
    }

    setLoading(true);
    const load = async () => {
      try {
        const { data: blob } = await previewFile();
        if (!blob) {
          throw new Error('Preview download unavailable');
        }
        if (cancelled) {
          return;
        }
        if (previewKind === 'text') {
          const text = await blob.text();
          if (!cancelled) {
            setFileContent(text);
          }
        } else {
          objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
          setFileBlobUrl(objectUrl);
        }
      } catch {
        if (!cancelled) {
          setPreviewError(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [open, fileId, previewKind, previewFile, shareId, user?.id]);

  const handleDownload = useCallback(async () => {
    if (!fileId) {
      return;
    }
    try {
      const result = await downloadFile();
      if (!result.data) {
        return;
      }
      triggerDownload(result.data, downloadFilename);
    } catch (err) {
      logger.error('[FilePreviewDialog] Download failed:', err);
    }
  }, [downloadFile, downloadFilename, fileId]);

  useEffect(() => {
    if (!open) {
      setIsCopied(false);
    }
  }, [open]);

  const handleCopy = useCallback(() => {
    if (!displayedText) {
      return;
    }
    copy(displayedText, { format: 'text/plain' });
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 3000);
  }, [displayedText]);

  const displayType = useMemo(() => getDisplayType(fileType, fileName), [fileType, fileName]);
  const sortedPages = useMemo(
    () => (pages && pageRelevance ? sortPagesByRelevance(pages, pageRelevance) : pages),
    [pages, pageRelevance],
  );

  const metaParts: string[] = [displayType];
  if (relevance != null && relevance > 0) {
    metaParts.push(`${localize('com_ui_relevance')}: ${Math.round(relevance * 100)}%`);
  }
  if (fileSize != null && fileSize > 0) {
    metaParts.push(formatBytes(fileSize));
  }
  if (sortedPages && sortedPages.length > 0) {
    metaParts.push(localize('com_file_pages', { pages: sortedPages.join(', ') }));
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="flex w-full max-w-4xl flex-col !overflow-hidden p-0"
        showCloseButton={true}
      >
        <div className="shrink-0 px-6 pr-12 pt-6">
          <OGDialogTitle className="truncate text-base">{fileName}</OGDialogTitle>
          <div className="mt-0.5 flex items-center gap-3">
            <OGDialogDescription className="min-w-0 truncate">
              {metaParts.join(' · ')}
            </OGDialogDescription>
            {fileId && (
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                aria-label={`${localize('com_ui_download')} ${fileName}`}
              >
                <Download className="size-3" aria-hidden="true" />
                {localize('com_ui_download')}
              </button>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
          {isLoading && (
            <div className="flex h-60 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="shimmer text-sm text-text-secondary">
                {localize('com_ui_loading')}
              </span>
            </div>
          )}
          {hasPreviewError && !isLoading && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
              {showExtractedText && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={extractedTextFetching}
                  onClick={() => void refetchExtractedPreview()}
                >
                  {localize('com_ui_retry')}
                </Button>
              )}
            </div>
          )}
          {fileBlobUrl && !showExtractedText && (
            <iframe
              src={fileBlobUrl}
              title={`${localize('com_ui_preview')}: ${fileName}`}
              className="h-[70vh] w-full rounded-lg border border-border-light"
            />
          )}
          {displayedText !== null && !isLoading && !hasPreviewError && (
            <>
              <div className="pointer-events-none sticky top-0 z-10 flex justify-end pr-1">
                <CopyButton
                  isCopied={isCopied}
                  onClick={handleCopy}
                  iconOnly
                  label={localize('com_ui_copy')}
                  className="pointer-events-auto rounded-lg bg-surface-secondary"
                />
              </div>
              <div className="-mt-8 rounded-lg bg-surface-secondary p-4">
                <pre className="whitespace-pre-wrap break-words pr-8 font-mono text-sm leading-6 text-text-primary">
                  {displayedText}
                </pre>
              </div>
            </>
          )}
          {!previewKind && !showExtractedText && !isLoading && (
            <div className="flex h-32 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
