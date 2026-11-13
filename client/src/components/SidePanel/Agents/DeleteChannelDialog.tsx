import {
  Alert,
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { ComponentProps, RefObject } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

interface DeleteChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  loading: boolean;
  disabled?: boolean;
  /** Already-localized text for a failed attempt, shown inside the dialog. */
  error?: string;
  triggerRef?: RefObject<HTMLElement | null>;
  /** Defaults to the delete wording; the disable confirmation passes its own. */
  title?: TranslationKeys;
  description?: TranslationKeys;
  confirmLabel?: TranslationKeys;
  /** Where focus lands on close, for callers whose trigger can disappear with the action. */
  onCloseAutoFocus?: ComponentProps<typeof OGDialogContent>['onCloseAutoFocus'];
}

/** Confirms a destructive connection action, shaped like the dialog for deleting a chat. Deleting by default. */
export default function DeleteChannelDialog({
  open,
  onOpenChange,
  onConfirm,
  loading,
  disabled = false,
  error,
  triggerRef,
  title = 'com_ui_channels_delete_title',
  description = 'com_ui_channels_delete_confirm',
  confirmLabel = 'com_ui_delete',
  onCloseAutoFocus,
}: DeleteChannelDialogProps) {
  const localize = useLocalize();
  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent
        className="w-11/12 max-w-md"
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize(title)}</OGDialogTitle>
          <OGDialogDescription>{localize(description)}</OGDialogDescription>
        </OGDialogHeader>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex justify-end gap-4 pt-4">
          <OGDialogClose asChild>
            <Button variant="outline" disabled={loading}>
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
          <Button
            variant="destructive"
            disabled={disabled || loading}
            aria-busy={loading}
            onClick={onConfirm}
          >
            {loading ? <Spinner /> : localize(confirmLabel)}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
