import React, { useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Label, Input, Button, SecretInput } from '@librechat/client';
import type { Control, FieldErrors } from 'react-hook-form';
import {
  CONFIG_HTML_INLINE_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useMCPAuthValuesQuery } from '~/data-provider/Tools/queries';
import { useLocalize } from '~/hooks';

export interface CustomUserVarConfig {
  title: string;
  description?: string;
  /** Whether the field holds a secret and should be masked (defaults to masked when omitted). */
  sensitive?: boolean;
}

interface CustomUserVarsSectionProps {
  serverName: string;
  fields: Record<string, CustomUserVarConfig>;
  onSave: (authData: Record<string, string>) => void;
  onRevoke: () => void;
  isSubmitting?: boolean;
}
interface AuthFieldProps {
  name: string;
  config: CustomUserVarConfig;
  hasValue: boolean;
  control: Control<Record<string, string>>;
  errors: FieldErrors<Record<string, string>>;
  autoFocus?: boolean;
}

function AuthField({ name, config, hasValue, control, errors, autoFocus }: AuthFieldProps) {
  const localize = useLocalize();
  const statusText = hasValue ? localize('com_ui_set') : localize('com_ui_unset');
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_INLINE_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  const sanitizedDescription = useMemo(() => {
    return sanitize(config.description);
  }, [config.description, sanitize]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={name} className="text-sm font-medium">
          {config.title} <span className="sr-only">({statusText})</span>
        </Label>
        <div aria-hidden="true">
          {hasValue ? (
            <div className="border-border-light text-text-secondary flex min-w-fit items-center gap-2 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
              <div className="bg-status-success h-1.5 w-1.5 rounded-full" />
              <span>{localize('com_ui_set')}</span>
            </div>
          ) : (
            <div className="border-border-light text-text-secondary flex min-w-fit items-center gap-2 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
              <div className="border-border-medium h-1.5 w-1.5 rounded-full border" />
              <span>{localize('com_ui_unset')}</span>
            </div>
          )}
        </div>
      </div>
      <Controller
        name={name}
        control={control}
        defaultValue=""
        render={({ field }) => {
          const placeholder = hasValue
            ? localize('com_ui_mcp_update_var', { 0: config.title })
            : localize('com_ui_mcp_enter_var', { 0: config.title });
          const className =
            'w-full rounded border border-border-medium bg-transparent px-2 py-1 text-text-primary placeholder:text-text-secondary sm:text-sm';
          // Prevent autofill: browser DOM mutations bypass React's synthetic
          // onChange, silently emptying react-hook-form state on submit.
          const sharedProps = {
            id: name,
            'data-lpignore': 'true',
            'data-1p-ignore': 'true',
            /* autoFocus is generally disorienting, but here the required field is navigated to
             * anyway, and the section emulates a modal opening where users expect focus to shift. */
            autoFocus,
            ...field,
            placeholder,
            className,
          };
          if (config.sensitive === false) {
            return <Input {...sharedProps} type="text" autoComplete="off" />;
          }
          return <SecretInput {...sharedProps} autoComplete="new-password" controlsOnHover />;
        }}
      />
      {sanitizedDescription && (
        <p
          className="text-text-secondary [&_a]:text-link text-xs [&_a]:hover:underline"
          dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
        />
      )}
      {errors[name] && <p className="text-text-destructive text-xs">{errors[name]?.message}</p>}
    </div>
  );
}

export default function CustomUserVarsSection({
  fields,
  onSave,
  onRevoke,
  serverName,
  isSubmitting = false,
}: CustomUserVarsSectionProps) {
  const localize = useLocalize();

  const { data: authValuesData } = useMCPAuthValuesQuery(serverName, {
    enabled: !!serverName,
  });

  const {
    reset,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Record<string, string>>({
    defaultValues: useMemo(() => {
      const initial: Record<string, string> = {};
      Object.keys(fields).forEach((key) => {
        initial[key] = '';
      });
      return initial;
    }, [fields]),
  });

  const onFormSubmit = (data: Record<string, string>) => {
    onSave(data);
  };

  const handleRevokeClick = () => {
    onRevoke();
    reset();
  };

  if (!fields || Object.keys(fields).length === 0) {
    return null;
  }

  return (
    <div className="flex-1 space-y-4">
      <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
        {Object.entries(fields).map(([key, config], index) => {
          const hasValue = authValuesData?.authValueFlags?.[key] || false;

          return (
            <AuthField
              key={key}
              name={key}
              config={config}
              hasValue={hasValue}
              control={control}
              errors={errors}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- See AuthField autoFocus comment for more details
              autoFocus={index === 0}
            />
          );
        })}
      </form>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={isSubmitting}
          onClick={handleRevokeClick}
        >
          {localize('com_ui_revoke')}
        </Button>
        <Button
          type="button"
          variant="submit"
          disabled={isSubmitting}
          onClick={handleSubmit(onFormSubmit)}
        >
          {isSubmitting ? localize('com_ui_saving') : localize('com_ui_save')}
        </Button>
      </div>
    </div>
  );
}
