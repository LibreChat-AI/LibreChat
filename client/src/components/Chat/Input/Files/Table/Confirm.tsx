import { useRef } from 'react';
import {
  Button,
  OGDialog,
  OGDialogClose,
  OGDialogContent,
  OGDialogDescription,
  OGDialogFooter,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export default function Confirm({
  files,
  triggerRef,
  onClose,
  onConfirm,
}: {
  files: TFile[];
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const localize = useLocalize();
  const submitted = useRef(false);
  return (
    <OGDialog open onOpenChange={(open) => !open && onClose()} triggerRef={triggerRef}>
      <OGDialogContent
        role="alertdialog"
        showCloseButton={false}
        className="w-11/12 max-w-md"
        onCloseAutoFocus={(event) => {
          if (submitted.current) {
            event.preventDefault();
            document.getElementById('my-files-list')?.focus({ preventScroll: true });
          }
        }}
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_delete')}</OGDialogTitle>
          <OGDialogDescription>
            {files.length === 1
              ? localize('com_files_confirm_delete_named', { 0: files[0].filename })
              : localize('com_files_confirm_delete_selection', { 0: String(files.length) })}
          </OGDialogDescription>
        </OGDialogHeader>
        <OGDialogFooter>
          <OGDialogClose asChild>
            <Button variant="outline">{localize('com_ui_cancel')}</Button>
          </OGDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              submitted.current = true;
              onConfirm();
              onClose();
            }}
          >
            {localize('com_ui_delete')}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
}
