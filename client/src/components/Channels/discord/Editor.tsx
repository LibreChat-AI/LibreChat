import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import { Alert, Button, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import type { DiscordApplication } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { FormEvent, ReactNode } from 'react';
import type { Fields } from './Credentials';
import Credentials from './Credentials';
import { useLocalize } from '~/hooks';
import { errorLabel } from './errors';
import Notice from '../Notice';

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
          <Credentials
            id={id}
            form={form}
            disabled={disabled}
            editing={editing}
            requireSecrets={editor === 'new'}
          />
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
