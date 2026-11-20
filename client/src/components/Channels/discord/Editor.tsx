import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import {
  Alert,
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  SecretInput,
  Spinner,
} from '@librechat/client';
import type { DiscordApplication } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { FormEvent, ReactNode } from 'react';
import { useLocalize } from '~/hooks';
import { errorLabel } from './errors';
import Notice from './Notice';

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

/** Adds an application or rotates its credentials; secrets are write-only and never prefilled. */
export default function Editor({
  editor,
  form,
  disabled,
  busy,
  saving,
  error,
  alertRef,
  onSubmit,
  onClose,
  onRefresh,
}: {
  editor: DiscordApplication | 'new' | null;
  form: UseFormReturn<Fields>;
  disabled: boolean;
  busy: boolean;
  saving: boolean;
  error: unknown;
  alertRef: (node: HTMLDivElement | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const { errors } = form.formState;
  const editing = editor !== null && editor !== 'new';
  let body: ReactNode = null;
  if (editor) {
    body = (
      <div className="space-y-3">
        <form
          id={`${id}-form`}
          className="space-y-3"
          onSubmit={(event) => {
            event.stopPropagation();
            onSubmit(event);
          }}
        >
          <p className="text-text-secondary text-sm">{localize('com_ui_discord_credentials')}</p>
          {order.map((field) => {
            const secret = field === 'botToken' || field === 'clientSecret';
            const props = {
              id: `${id}-${field}`,
              autoComplete: secret ? 'new-password' : 'off',
              disabled: disabled || (field === 'applicationId' && editing),
              'aria-invalid': Boolean(errors[field]),
              'aria-describedby': errors[field] ? `${id}-${field}-error` : undefined,
              ...form.register(field, {
                required: field === 'applicationId' || (secret && editor === 'new'),
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
                      <span className="text-text-secondary text-xs">
                        {localize('com_ui_optional')}
                      </span>
                    </>
                  )}
                </Label>
                {secret ? (
                  <SecretInput
                    {...props}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    controlsOnHover
                  />
                ) : (
                  <Input {...props} />
                )}
                {secret && editing && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_discord_rotation')}
                  </p>
                )}
                {errors[field] && (
                  <p
                    id={`${id}-${field}-error`}
                    role="alert"
                    className="text-text-destructive text-sm"
                  >
                    {localize('com_ui_discord_invalid')}
                  </p>
                )}
              </div>
            );
          })}
          {errors.root && <Alert variant="error">{errors.root.message}</Alert>}
          <Button asChild variant="inline-link" className="w-fit">
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noopener noreferrer"
            >
              {localize('com_ui_discord_developer_portal')}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
        </form>
        {Boolean(error) && (
          <Notice
            ref={alertRef}
            message={localize(errorLabel(error))}
            action={localize('com_ui_refresh')}
            disabled={busy}
            onAction={onRefresh}
          />
        )}
      </div>
    );
  }
  return (
    <OGDialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <OGDialogTemplate
        title={localize(editing ? 'com_ui_discord_app_rotate' : 'com_ui_discord_app_create')}
        className="max-w-md"
        cancelDisabled={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          form.setFocus(editing ? 'botToken' : 'applicationId');
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        main={body}
        selection={
          <Button type="submit" variant="submit" form={`${id}-form`} disabled={disabled}>
            {saving && <Spinner className="size-4" aria-hidden="true" />}
            {localize('com_ui_save')}
          </Button>
        }
      />
    </OGDialog>
  );
}
