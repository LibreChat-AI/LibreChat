import React, { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Button, Input, Label, SecretInput, OGDialog, OGDialogTemplate } from '@librechat/client';
import type { ConfigFieldDetail } from '~/common';
import {
  CONFIG_HTML_BLOCK_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useLocalize } from '~/hooks';

interface MCPConfigDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  fieldsSchema: Record<string, ConfigFieldDetail>;
  initialValues: Record<string, string>;
  onSave: (updatedValues: Record<string, string>) => void;
  isSubmitting?: boolean;
  onRevoke?: () => void;
  serverName: string;
}

export default function MCPConfigDialog({
  isOpen,
  onOpenChange,
  fieldsSchema,
  initialValues,
  onSave,
  isSubmitting = false,
  onRevoke,
  serverName,
}: MCPConfigDialogProps) {
  const localize = useLocalize();
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Record<string, string>>({
    defaultValues: initialValues,
  });

  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_BLOCK_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  useEffect(() => {
    if (isOpen) {
      reset(initialValues);
    }
  }, [isOpen, initialValues, reset]);

  const onFormSubmit = (data: Record<string, string>) => {
    onSave(data);
  };

  const handleRevoke = () => {
    if (onRevoke) {
      onRevoke();
    }
  };

  const dialogTitle = localize('com_ui_configure_mcp_variables_for', { 0: serverName });

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        className="sm:max-w-lg"
        title={dialogTitle}
        headerClassName="px-6 pt-6 pb-4"
        main={
          <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4 px-6 pb-2">
            {Object.entries(fieldsSchema).map(([key, details]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key} className="text-sm font-medium">
                  {details.title}
                </Label>
                <Controller
                  name={key}
                  control={control}
                  defaultValue={initialValues[key] || ''}
                  render={({ field }) => {
                    const placeholder = localize('com_ui_mcp_enter_var', { 0: details.title });
                    const className =
                      'w-full rounded-md border-border-medium shadow-sm focus:border-border-heavy focus:ring-ring-primary sm:text-sm';
                    if (details.sensitive === false) {
                      return (
                        <Input
                          id={key}
                          {...field}
                          type="text"
                          placeholder={placeholder}
                          className={className}
                        />
                      );
                    }
                    return (
                      <SecretInput
                        id={key}
                        {...field}
                        autoComplete="new-password"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        controlsOnHover
                        placeholder={placeholder}
                        className={className}
                      />
                    );
                  }}
                />
                {details.description && (
                  <p
                    className="text-xs text-text-secondary [&_a]:text-link [&_a]:underline [&_a]:hover:text-link-hover"
                    dangerouslySetInnerHTML={{ __html: sanitize(details.description) }}
                  />
                )}
                {errors[key] && (
                  <p className="text-xs text-text-destructive">{errors[key]?.message}</p>
                )}
              </div>
            ))}
          </form>
        }
        selection={{
          selectHandler: handleSubmit(onFormSubmit),
          selectClasses: 'bg-surface-submit text-text-on-status hover:bg-surface-submit-hover',
          selectText: isSubmitting ? localize('com_ui_saving') : localize('com_ui_save'),
        }}
        buttons={
          onRevoke && (
            <Button variant="destructive" onClick={handleRevoke} disabled={isSubmitting}>
              {localize('com_ui_revoke')}
            </Button>
          )
        }
        footerClassName="flex justify-end gap-2 px-6 pb-6 pt-2"
        showCancelButton={true}
      />
    </OGDialog>
  );
}
