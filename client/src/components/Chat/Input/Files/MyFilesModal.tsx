import { useCallback, useRef } from 'react';
import { FileContext } from 'librechat-data-provider';
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
import { useLocalize } from '~/hooks';
import { DataTable } from './Table';

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

  const title = useRef<HTMLHeadingElement>(null);
  const captureReturnFocus = useCallback(
    (event: Event) => {
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
      const target = window.matchMedia('(max-width: 639px)').matches
        ? title.current
        : (title.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('#files-filter') ??
          title.current);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    },
    [triggerRef],
  );

  const {
    data: files,
    isError,
    refetch,
  } = useGetFiles<TFile[]>({
    select: (files) =>
      files.map((file) => ({
        ...file,
        context: file.context ?? FileContext.unknown,
      })),
  });

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={returnFocusRef}>
      <OGDialogContent
        title={localize('com_nav_my_files')}
        onOpenAutoFocus={captureReturnFocus}
        className="text-text-primary flex h-[84dvh] max-h-[84dvh] w-11/12 max-w-4xl flex-col overflow-hidden shadow-2xl"
      >
        <OGDialogHeader>
          <OGDialogTitle tabIndex={-1} ref={title}>
            {localize('com_nav_my_files')}
          </OGDialogTitle>
          {files && (
            <p className="text-text-secondary text-sm">
              {localize('com_files_total', { count: files.length })}
            </p>
          )}
        </OGDialogHeader>
        {files && <DataTable data={files} />}
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
