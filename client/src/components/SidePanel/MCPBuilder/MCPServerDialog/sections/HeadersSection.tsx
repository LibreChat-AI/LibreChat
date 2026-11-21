import { Plus } from 'lucide-react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { Label, Input, Button, TrashIcon, SecretInput } from '@librechat/client';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import { useLocalize } from '~/hooks';

/** RFC 7230 token characters most servers accept in a header name. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

interface HeadersSectionProps {
  isEditMode: boolean;
}

export default function HeadersSection({ isEditMode }: HeadersSectionProps) {
  const localize = useLocalize();
  const {
    control,
    register,
    getValues,
    formState: { errors },
  } = useFormContext<MCPServerFormData>();
  const { fields, append, remove } = useFieldArray({ control, name: 'headers' });
  const type = useWatch<MCPServerFormData, 'type'>({ name: 'type' });

  if (type !== 'streamable-http' && type !== 'sse') {
    return null;
  }

  const validateName = (value: string, index: number) => {
    const name = value.trim();
    if (!name) {
      return localize('com_ui_field_required');
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      return localize('com_ui_header_name_invalid');
    }
    const lower = name.toLowerCase();
    const duplicate = (getValues('headers') ?? []).some(
      (row, i) => i !== index && row.name.trim().toLowerCase() === lower,
    );
    return duplicate ? localize('com_ui_header_name_duplicate') : true;
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{localize('com_ui_custom_headers')}</legend>
      <p className="text-text-secondary text-xs">{localize('com_ui_custom_headers_description')}</p>
      {fields.length > 0 && (
        <ul className="space-y-2" aria-label={localize('com_ui_custom_headers')}>
          {fields.map((field, index) => {
            const nameError = errors.headers?.[index]?.name;
            const nameId = `header-name-${field.id}`;
            const valueId = `header-value-${field.id}`;
            const errorId = `header-name-error-${field.id}`;
            return (
              <li key={field.id} className="space-y-1" data-testid="mcp-header-row">
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={nameId} className="text-xs font-medium">
                      {localize('com_ui_header_name')}
                    </Label>
                    <Input
                      id={nameId}
                      autoComplete="off"
                      placeholder="X-Client-Id"
                      aria-invalid={nameError ? 'true' : 'false'}
                      aria-describedby={nameError ? errorId : undefined}
                      {...register(`headers.${index}.name` as const, {
                        validate: (value) => validateName(value, index),
                      })}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={valueId} className="text-xs font-medium">
                      {localize('com_ui_header_value')}
                    </Label>
                    <SecretInput
                      id={valueId}
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      controlsOnHover
                      placeholder={
                        isEditMode && field.stored ? localize('com_ui_leave_blank_to_keep') : ''
                      }
                      {...register(`headers.${index}.value` as const)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={localize('com_ui_remove_header', {
                      0: getValues(`headers.${index}.name`) || String(index + 1),
                    })}
                    onClick={() => remove(index)}
                  >
                    <TrashIcon aria-hidden="true" />
                  </Button>
                </div>
                {nameError && (
                  <p id={errorId} role="alert" className="text-text-destructive text-xs">
                    {nameError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ name: '', value: '', stored: false })}
      >
        <Plus className="size-4" aria-hidden="true" />
        {localize('com_ui_add_header')}
      </Button>
    </fieldset>
  );
}
