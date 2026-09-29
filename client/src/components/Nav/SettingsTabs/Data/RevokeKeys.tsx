import React, { useState } from 'react';
import { useRevokeAllUserKeysMutation } from 'librechat-data-provider/react-query';
import {
  OGDialogTemplate,
  Button,
  Label,
  OGDialog,
  OGDialogTrigger,
  Spinner,
} from '@librechat/client';
import { useLocalize } from '~/hooks';

export const RevokeKeys = ({
  disabled = false,
  setDialogOpen,
}: {
  disabled?: boolean;
  setDialogOpen?: (open: boolean) => void;
}) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const revokeKeysMutation = useRevokeAllUserKeysMutation();

  const handleSuccess = () => {
    if (!setDialogOpen) {
      return;
    }

    setDialogOpen(false);
  };

  const onClick = () => {
    revokeKeysMutation.mutate({}, { onSuccess: handleSuccess });
  };

  const isLoading = revokeKeysMutation.isLoading;

  return (
    <div className="flex items-center justify-between">
      <Label id="revoke-info-label">{localize('com_ui_revoke_info')}</Label>

      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            onClick={() => setOpen(true)}
            disabled={disabled}
            aria-labelledby="revoke-info-label"
          >
            {localize('com_ui_revoke')}
          </Button>
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_revoke_keys')}
          className="max-w-[450px]"
          main={
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_revoke_keys_confirm')}
            </Label>
          }
          selection={{
            selectHandler: onClick,
            selectClasses:
              'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
            selectText: isLoading ? <Spinner /> : localize('com_ui_revoke'),
          }}
        />
      </OGDialog>
    </div>
  );
};
