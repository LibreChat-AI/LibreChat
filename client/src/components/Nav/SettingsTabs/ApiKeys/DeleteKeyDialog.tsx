import { useDeleteAgentApiKeyMutation } from 'librechat-data-provider/react-query';
import { Spinner, OGDialog, OGDialogTemplate, useToastContext } from '@librechat/client';
import type { RefObject } from 'react';
import { useLocalize } from '~/hooks';

type DeleteKeyDialogProps = {
  id: string;
  name: string;
  keyPrefix: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

export default function DeleteKeyDialog({
  id,
  name,
  keyPrefix,
  open,
  onOpenChange,
  triggerRef,
}: DeleteKeyDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const deleteMutation = useDeleteAgentApiKeyMutation();

  const handleDelete = () => {
    deleteMutation.mutate(id, {
      onSuccess: () => {
        showToast({ message: localize('com_ui_api_key_deleted'), status: 'success' });
        onOpenChange(false);
      },
      onError: () => {
        showToast({ message: localize('com_ui_api_key_delete_error'), status: 'error' });
      },
    });
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_delete_api_key')}
        className="max-w-[450px]"
        main={
          <div className="space-y-3 text-left">
            <p className="text-sm text-text-primary">
              {localize('com_ui_api_key_delete_confirm', { 0: name })}
            </p>
            <div className="flex items-center rounded-lg border border-border-light bg-surface-secondary px-3 py-2">
              <code className="break-all font-mono text-xs text-text-secondary">{keyPrefix}…</code>
            </div>
            <p className="text-sm text-text-secondary">
              {localize('com_ui_api_key_delete_warning')}
            </p>
          </div>
        }
        selection={{
          selectHandler: handleDelete,
          selectClasses:
            'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
          selectText: deleteMutation.isLoading ? <Spinner /> : localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  );
}
