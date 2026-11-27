import { useState } from 'react';
import {
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogClose,
  OGDialogContent,
  OGDialogDescription,
  OGDialogFooter,
  OGDialogHeader,
  OGDialogTitle,
  OGDialogTrigger,
  SecretInput,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type { EmailChangeErrorCode } from 'librechat-data-provider';
import type { FormEvent } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useRequestEmailChangeMutation } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { getResponseErrorCode } from '~/utils';

const errorKeys: Partial<Record<EmailChangeErrorCode, TranslationKeys>> = {
  current_password_invalid: 'com_ui_email_change_error_password',
  email_change_disabled: 'com_ui_email_change_error_disabled',
  email_delivery_failed: 'com_ui_email_change_error_delivery',
  email_domain_not_allowed: 'com_ui_email_change_error_domain',
  email_in_use: 'com_ui_email_change_error_in_use',
  email_service_unavailable: 'com_ui_email_change_error_unavailable',
  invalid_request: 'com_ui_email_change_error_invalid',
  local_account_required: 'com_ui_email_change_error_local',
  request_in_progress: 'com_ui_email_change_error_in_progress',
  same_email: 'com_ui_email_change_error_same',
};

export default function ChangeEmail() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [isOpen, setIsOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKeys>();
  const mutation = useRequestEmailChangeMutation({
    onSuccess: () => {
      showToast({ message: localize('com_ui_email_change_verification_sent') });
      setIsOpen(false);
      setNewEmail('');
      setCurrentPassword('');
      setErrorKey(undefined);
    },
    onError: (error) => {
      const code = getResponseErrorCode<EmailChangeErrorCode>(error);
      setErrorKey((code ? errorKeys[code] : undefined) ?? 'com_ui_email_change_error_unexpected');
    },
  });

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    setErrorKey(undefined);
    if (!open) {
      setNewEmail('');
      setCurrentPassword('');
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorKey(undefined);
    if (newEmail.trim().toLowerCase() === user?.email.trim().toLowerCase()) {
      setErrorKey('com_ui_email_change_error_same');
      return;
    }
    mutation.mutate({ newEmail, currentPassword });
  };

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label id="change-email-label">{localize('com_ui_settings_label_change_email')}</Label>
          <p className="text-text-secondary truncate text-xs">{user?.email}</p>
        </div>
        <OGDialogTrigger asChild>
          <Button aria-label={localize('com_ui_email_change_title')} variant="outline">
            {localize('com_ui_email_change_button')}
          </Button>
        </OGDialogTrigger>
      </div>
      <OGDialogContent
        id="change-email-dialog"
        className="w-11/12 max-w-md"
        showCloseButton={false}
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_email_change_title')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_ui_email_change_description')}</OGDialogDescription>
        </OGDialogHeader>
        <form id="change-email-form" className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="new-email" className="font-medium">
              {localize('com_ui_email_change_new_email')}
            </Label>
            <Input
              id="new-email"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              disabled={mutation.isLoading}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="current-password" className="font-medium">
              {localize('com_ui_email_change_current_password')}
            </Label>
            <SecretInput
              id="current-password"
              autoComplete="current-password"
              maxLength={128}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={mutation.isLoading}
              required
            />
          </div>
          {errorKey && (
            <p id="change-email-error" className="text-text-destructive text-sm" role="alert">
              {localize(errorKey)}
            </p>
          )}
        </form>
        <OGDialogFooter>
          <OGDialogClose asChild>
            <Button type="button" variant="outline">
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
          <Button
            type="submit"
            form="change-email-form"
            variant="submit"
            disabled={!newEmail.trim() || !currentPassword || mutation.isLoading}
          >
            {mutation.isLoading && <Spinner className="size-4" aria-hidden="true" />}
            {localize(
              mutation.isLoading
                ? 'com_ui_email_change_sending_verification'
                : 'com_ui_email_change_send_verification',
            )}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
}
