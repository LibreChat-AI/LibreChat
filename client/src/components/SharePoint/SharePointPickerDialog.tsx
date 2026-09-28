import React, { useState, useEffect } from 'react';
import { OGDialog, OGDialogTitle, OGDialogContent } from '@librechat/client';
import type { SharePointBatchProgress } from '~/data-provider/Files/sharepoint';
import { useSharePointPicker, useLocalize } from '~/hooks';

interface SharePointPickerDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onFilesSelected?: (files: any[]) => void;
  disabled?: boolean;
  isDownloading?: boolean;
  downloadProgress?: SharePointBatchProgress | null;
  maxSelectionCount?: number;
}

export default function SharePointPickerDialog({
  isOpen,
  onOpenChange,
  onFilesSelected,
  disabled = false,
  isDownloading = false,
  downloadProgress = null,
  maxSelectionCount,
}: SharePointPickerDialogProps) {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const localize = useLocalize();

  const { openSharePointPicker, closeSharePointPicker, cleanup } = useSharePointPicker({
    containerNode,
    onFilesSelected,
    disabled,
    onClose: () => handleOpenChange(false),
    maxSelectionCount,
  });
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeSharePointPicker();
    }
    onOpenChange(open);
  };
  // Use callback ref to trigger SharePoint picker when container is attached
  const containerCallbackRef = React.useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);

  useEffect(() => {
    if (containerNode && isOpen) {
      openSharePointPicker();
    }
    return () => {
      if (!isOpen) {
        cleanup();
      }
    };
    // we need to run this effect only when the containerNode or isOpen changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerNode, isOpen]);
  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      {/** The content portals the app's scrim itself. This dialog used to render
       *  a second overlay beside it asking for a lighter black, which the
       *  primitive's own overlay painted over — same depth, mounted later — so
       *  it never reached the screen. The dialog is opaque, so nothing here
       *  needed a scrim of its own: it takes the theme's. */}
      <OGDialogContent
        className="sharepoint-picker-bg fixed left-1/2 top-1/2 z-50 h-[680px] max-h-[90vh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-surface-dialog p-2 shadow-lg focus:outline-none"
        showCloseButton={true}
      >
        <OGDialogTitle className="sr-only">
          {localize('com_files_sharepoint_picker_title')}
        </OGDialogTitle>
        <div ref={containerCallbackRef} className="sharepoint-picker-bg relative flex p-2">
          {/* SharePoint iframe will be injected here by the hook */}

          {isDownloading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/30 backdrop-blur-sm">
              <div className="mx-4 w-full max-w-sm rounded-lg bg-surface-primary p-6 shadow-lg">
                <div className="text-center">
                  <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
                  <h3 className="mb-2 text-lg font-semibold text-text-primary">
                    {localize('com_files_downloading')}
                  </h3>
                  {downloadProgress && (
                    <div className="space-y-2">
                      <p className="text-sm text-text-secondary">
                        {localize('com_files_download_progress', {
                          0: downloadProgress.completed,
                          1: downloadProgress.total,
                        })}
                      </p>
                      {downloadProgress.currentFile && (
                        <p className="truncate text-xs text-text-tertiary">
                          {downloadProgress.currentFile}
                        </p>
                      )}
                      <div className="h-2 w-full rounded-full bg-surface-tertiary">
                        <div
                          className="h-2 rounded-full bg-blue-600 transition-all duration-300"
                          style={{
                            width: `${Math.round((downloadProgress.completed / downloadProgress.total) * 100)}%`,
                          }}
                        ></div>
                      </div>
                      <p className="text-xs text-text-tertiary">
                        {localize('com_files_download_percent_complete', {
                          0: Math.round(
                            (downloadProgress.completed / downloadProgress.total) * 100,
                          ),
                        })}
                      </p>
                      {downloadProgress.failed.length > 0 && (
                        <p className="text-xs text-text-destructive">
                          {localize('com_files_download_failed', {
                            0: downloadProgress.failed.length,
                          })}
                        </p>
                      )}
                    </div>
                  )}
                  {!downloadProgress && (
                    <p className="text-sm text-text-secondary">
                      {localize('com_files_preparing_download')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
