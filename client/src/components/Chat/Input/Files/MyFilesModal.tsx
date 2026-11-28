import { useCallback, useRef } from 'react';
import { FileSources, FileContext } from 'librechat-data-provider';
import {
  Alert,
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import { useGetFiles } from '~/data-provider';
import { DataTable, columns } from './Table';
import { useLocalize } from '~/hooks';

export function MyFilesModal({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const localize = useLocalize();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const captureReturnFocus = useCallback(() => {
    const activeElement = document.activeElement;
    const canRestoreShortcutFocus =
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      activeElement.closest('[inert]') == null &&
      activeElement.closest('[role="menu"]') == null;
    returnFocusRef.current = canRestoreShortcutFocus
      ? activeElement
      : (triggerRef?.current ?? null);
  }, [triggerRef]);

  const {
    data: files,
    isError,
    refetch,
  } = useGetFiles<TFile[]>({
    select: (files) =>
      files.map((file) => ({
        ...file,
        context: file.context ?? FileContext.unknown,
        filterSource: file.source === FileSources.firebase ? FileSources.local : file.source,
      })),
  });

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={returnFocusRef}>
      <OGDialogContent
        title={localize('com_nav_my_files')}
        onOpenAutoFocus={captureReturnFocus}
        className="text-text-primary w-11/12 shadow-2xl"
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_nav_my_files')}</OGDialogTitle>
        </OGDialogHeader>
        {files && <DataTable columns={columns} data={files} />}
        {!files && isError && (
          <Alert variant="error">
            {localize('com_files_load_error')}
            <Button variant="outline" onClick={() => void refetch()}>
              {localize('com_ui_retry')}
            </Button>
          </Alert>
        )}
        {!files && !isError && <p role="status">{localize('com_ui_loading')}</p>}
      </OGDialogContent>
    </OGDialog>
  );
}
