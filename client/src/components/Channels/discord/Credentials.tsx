import { Input, Label, SecretInput } from '@librechat/client';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import { useLocalize } from '~/hooks';

export const empty = { applicationId: '', name: '', botToken: '', clientSecret: '' };
export type Fields = typeof empty;

const labels = {
  applicationId: 'com_ui_discord_application_id',
  name: 'com_ui_name',
  botToken: 'com_ui_discord_bot_token',
  clientSecret: 'com_ui_discord_client_secret',
} as const;
const limits = { applicationId: 20, name: 100, botToken: 512, clientSecret: 512 };
const order = ['name', 'applicationId', 'botToken', 'clientSecret'] as const;

/** The application's credential inputs, shared by the editor dialog and the first-run wizard. */
export default function Credentials({
  id,
  form,
  disabled,
  editing,
  requireSecrets,
}: {
  id: string;
  form: UseFormReturn<Fields>;
  disabled: boolean;
  /** An existing application: its ID is fixed and the secrets rotate. */
  editing: boolean;
  requireSecrets: boolean;
}) {
  const localize = useLocalize();
  const { errors } = form.formState;
  return (
    <>
      {order.map((field) => {
        const secret = field === 'botToken' || field === 'clientSecret';
        const props = {
          id: `${id}-${field}`,
          autoComplete: secret ? 'new-password' : 'off',
          disabled: disabled || (field === 'applicationId' && editing),
          'aria-invalid': Boolean(errors[field]),
          'aria-describedby': errors[field] ? `${id}-${field}-error` : undefined,
          ...form.register(field, {
            required: field === 'applicationId' || (secret && requireSecrets),
            maxLength: limits[field],
            ...(field === 'applicationId'
              ? { validate: (value) => channelSnowflakeSchema.safeParse(value.trim()).success }
              : {}),
          }),
        };
        return (
          <div key={field} className="space-y-1">
            <Label htmlFor={`${id}-${field}`}>
              {localize(labels[field])}
              {field === 'name' && (
                <>
                  {' '}
                  <span className="text-text-secondary text-xs">{localize('com_ui_optional')}</span>
                </>
              )}
            </Label>
            {secret ? (
              <SecretInput {...props} data-lpignore="true" data-1p-ignore="true" controlsOnHover />
            ) : (
              <Input {...props} />
            )}
            {secret && editing && (
              <p className="text-text-secondary text-xs">{localize('com_ui_discord_rotation')}</p>
            )}
            {errors[field] && (
              <p id={`${id}-${field}-error`} role="alert" className="text-text-destructive text-sm">
                {localize('com_ui_discord_invalid')}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
