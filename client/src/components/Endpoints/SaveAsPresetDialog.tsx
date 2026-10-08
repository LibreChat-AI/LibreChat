import React, { useEffect, useId, useState } from 'react';
import { useCreatePresetMutation } from 'librechat-data-provider/react-query';
import {
  OGDialogTemplate,
  OGDialog,
  Button,
  Input,
  Label,
  useToastContext,
} from '@librechat/client';
import type { TEditPresetProps } from '~/common';
import { NotificationSeverity } from '~/common';
import { cleanupPreset } from '~/utils';
import { useLocalize } from '~/hooks';

const SaveAsPresetDialog = ({ open, onOpenChange, preset }: TEditPresetProps) => {
  const localize = useLocalize();
  const formId = useId();
  const inputId = `${formId}-name`;
  const [title, setTitle] = useState<string>(preset.title ?? localize('com_endpoint_my_preset'));
  const createPresetMutation = useCreatePresetMutation();
  const { showToast } = useToastContext();

  const submitPreset = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const _preset = cleanupPreset({
      preset: {
        ...preset,
        title,
      },
    });

    const toastTitle =
      (_preset.title ?? '') ? `\`${_preset.title}\`` : localize('com_endpoint_preset_title');

    createPresetMutation.mutate(_preset, {
      onSuccess: () => {
        showToast({
          message: `${toastTitle} ${localize('com_ui_saved')}`,
        });
        onOpenChange(false); // Close the dialog on success
      },
      onError: () => {
        showToast({
          message: localize('com_endpoint_preset_save_error'),
          severity: NotificationSeverity.ERROR,
        });
      },
    });
  };

  useEffect(() => {
    if (open) {
      setTitle(preset.title ?? localize('com_endpoint_my_preset'));
    }
  }, [localize, open, preset.title]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_endpoint_save_as_preset')}
        className="z-[90] w-11/12 max-w-md"
        overlayClassName="z-[80]"
        showCloseButton={false}
        main={
          <form
            id={formId}
            onSubmit={submitPreset}
            className="flex w-full flex-col items-center gap-2"
          >
            <div className="grid w-full items-center gap-2">
              <Label htmlFor={inputId} className="text-left text-sm font-medium">
                {localize('com_endpoint_preset_name')}
              </Label>
              <Input
                id={inputId}
                value={title || ''}
                onChange={(e) => setTitle(e.target.value || '')}
                placeholder={localize('com_endpoint_preset_custom_name_placeholder')}
                className="flex h-10 max-h-10 w-full resize-none rounded-theme-control border-border-medium px-3 py-2"
              />
            </div>
          </form>
        }
        buttons={
          <Button
            type="submit"
            form={formId}
            variant="submit"
            disabled={createPresetMutation.isLoading}
          >
            {localize('com_ui_save')}
          </Button>
        }
      />
    </OGDialog>
  );
};

export default SaveAsPresetDialog;
