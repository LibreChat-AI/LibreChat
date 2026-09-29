import React, { useState, useCallback } from 'react';
import { LockIcon, Trash } from 'lucide-react';
import { REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp';
import {
  InputOTPSeparator,
  OGDialogContent,
  OGDialogTrigger,
  OGDialogHeader,
  InputOTPGroup,
  OGDialogTitle,
  InputOTPSlot,
  OGDialog,
  InputOTP,
  Spinner,
  Button,
  Label,
  Input,
} from '@librechat/client';
import type { TDeleteUserRequest } from 'librechat-data-provider';
import { useDeleteUserMutation } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { LocalizeFunction } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const DeleteAccount = ({ disabled = false }: { title?: string; disabled?: boolean }) => {
  const localize = useLocalize();
  const { user, logout } = useAuthContext();
  const { mutate: deleteUser, isLoading: isDeleting } = useDeleteUserMutation({
    onSuccess: () => logout(),
  });

  const [isDialogOpen, setDialogOpen] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState(true);
  const [otpToken, setOtpToken] = useState('');
  const [useBackup, setUseBackup] = useState(false);

  const needs2FA = !!user?.twoFactorEnabled;

  const handleDeleteUser = () => {
    if (isLocked) {
      return;
    }

    let payload: TDeleteUserRequest | undefined;
    if (needs2FA && otpToken.trim()) {
      payload = useBackup ? { backupCode: otpToken.trim() } : { token: otpToken.trim() };
    }

    deleteUser(payload);
  };

  const handleInputChange = useCallback(
    (newEmailInput: string) => {
      const isEmailCorrect =
        newEmailInput.trim().toLowerCase() === user?.email.trim().toLowerCase();
      setIsLocked(!isEmailCorrect);
    },
    [user?.email],
  );

  const otpReady = !needs2FA || otpToken.length === (useBackup ? 8 : 6);

  return (
    <>
      <OGDialog open={isDialogOpen} onOpenChange={setDialogOpen}>
        <div className="flex items-center justify-between">
          <Label id="delete-account-label">{localize('com_nav_delete_account')}</Label>
          <OGDialogTrigger asChild>
            <Button
              aria-labelledby="delete-account-label"
              variant="destructive"
              onClick={() => setDialogOpen(true)}
              disabled={disabled}
            >
              {localize('com_ui_delete')}
            </Button>
          </OGDialogTrigger>
        </div>
        <OGDialogContent className="w-11/12 max-w-md">
          <OGDialogHeader>
            <OGDialogTitle className="text-lg font-medium leading-6">
              {localize('com_nav_delete_account_confirm')}
            </OGDialogTitle>
          </OGDialogHeader>
          <div className="mb-8 text-sm text-text-primary">
            <ul className="font-semibold text-text-warning">
              <li>{localize('com_nav_delete_warning')}</li>
              <li>{localize('com_nav_delete_data_info')}</li>
            </ul>
          </div>
          <div className="flex-col items-center justify-center">
            <div className="mb-4">
              {renderInput(
                localize('com_nav_delete_account_email_placeholder'),
                'email-confirm-input',
                user?.email ?? '',
                (e) => handleInputChange(e.target.value),
              )}
            </div>
            {needs2FA && (
              <div className="mb-4 space-y-3">
                <Label className="text-sm font-medium">
                  {localize('com_ui_2fa_verification_required')}
                </Label>
                <div className="flex justify-center">
                  <InputOTP
                    value={otpToken}
                    onChange={setOtpToken}
                    maxLength={useBackup ? 8 : 6}
                    pattern={useBackup ? REGEXP_ONLY_DIGITS_AND_CHARS : REGEXP_ONLY_DIGITS}
                    className="gap-2"
                  >
                    {useBackup ? (
                      <InputOTPGroup>
                        <InputOTPSlot index={0} />
                        <InputOTPSlot index={1} />
                        <InputOTPSlot index={2} />
                        <InputOTPSlot index={3} />
                        <InputOTPSlot index={4} />
                        <InputOTPSlot index={5} />
                        <InputOTPSlot index={6} />
                        <InputOTPSlot index={7} />
                      </InputOTPGroup>
                    ) : (
                      <>
                        <InputOTPGroup>
                          <InputOTPSlot index={0} />
                          <InputOTPSlot index={1} />
                          <InputOTPSlot index={2} />
                        </InputOTPGroup>
                        <InputOTPSeparator />
                        <InputOTPGroup>
                          <InputOTPSlot index={3} />
                          <InputOTPSlot index={4} />
                          <InputOTPSlot index={5} />
                        </InputOTPGroup>
                      </>
                    )}
                  </InputOTP>
                </div>
                <Button
                  type="button"
                  variant="link"
                  onClick={() => {
                    setUseBackup(!useBackup);
                    setOtpToken('');
                  }}
                  className="h-auto p-0 text-sm font-normal text-text-primary hover:underline"
                >
                  {useBackup ? localize('com_ui_use_2fa_code') : localize('com_ui_use_backup_code')}
                </Button>
              </div>
            )}
            {renderDeleteButton(handleDeleteUser, isDeleting, isLocked || !otpReady, localize)}
          </div>
        </OGDialogContent>
      </OGDialog>
    </>
  );
};

const renderInput = (
  label: string,
  id: string,
  value: string,
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void,
) => (
  <div className="mb-4">
    <Label className="mb-1 text-sm font-medium" htmlFor={id}>
      {label}
    </Label>
    <Input id={id} onChange={onChange} placeholder={value} />
  </div>
);

const renderDeleteButton = (
  handleDeleteUser: () => void,
  isDeleting: boolean,
  isLocked: boolean,
  localize: LocalizeFunction,
) => (
  <Button
    variant="destructive"
    className={cn(
      'mt-4 w-full gap-0 bg-surface-tertiary text-text-primary transition-all duration-200 hover:bg-surface-tertiary',
      isLocked
        ? 'cursor-not-allowed opacity-30 disabled:opacity-30'
        : 'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover disabled:opacity-100',
    )}
    onClick={handleDeleteUser}
    disabled={isDeleting || isLocked}
  >
    {isDeleting ? (
      <div className="flex h-6 justify-center">
        <Spinner className="icon-sm m-auto" />
      </div>
    ) : (
      <>
        {isLocked ? (
          <>
            <LockIcon className="size-5" aria-hidden="true" />
            <span className="ml-2">{localize('com_ui_locked')}</span>
          </>
        ) : (
          <>
            <Trash className="size-5" aria-hidden="true" />
            <span className="ml-2">{localize('com_nav_delete_account_button')}</span>
          </>
        )}
      </>
    )}
  </Button>
);

export default DeleteAccount;
