import React, { useState, useCallback } from 'react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { useSearchParams } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { ErrorTypes } from 'librechat-data-provider';
import { useForm, Controller } from 'react-hook-form';
import {
  Label,
  Button,
  InputOTP,
  InputOTPSlot,
  InputOTPGroup,
  InputOTPSeparator,
} from '@librechat/client';
import { useVerifyTwoFactorTempMutation } from '~/data-provider';
import BackupCodeInput from './BackupCodeInput';
import { useLocalize } from '~/hooks';

interface VerifyPayload {
  tempToken: string;
  token?: string;
  backupCode?: string;
}

type TwoFactorFormInputs = {
  token?: string;
  backupCode?: string;
};

const TwoFactorScreen: React.FC = React.memo(() => {
  const [searchParams] = useSearchParams();
  const tempTokenRaw = searchParams.get('tempToken');
  const tempToken = tempTokenRaw !== null && tempTokenRaw !== '' ? tempTokenRaw : '';

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<TwoFactorFormInputs>();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [useBackup, setUseBackup] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const { mutate: verifyTempMutate } = useVerifyTwoFactorTempMutation({
    onSuccess: (result) => {
      if (result.token != null && result.token !== '') {
        window.location.href = '/';
      }
    },
    onMutate: () => {
      setIsLoading(true);
    },
    onError: (error: unknown) => {
      setIsLoading(false);
      const data = (error as { response?: { data?: { message?: unknown; code?: unknown } } })
        .response?.data;
      if (data?.code === ErrorTypes.AUTH_CROSS_ORIGIN) {
        showToast({ message: localize('com_auth_error_login_cross_origin'), status: 'error' });
        return;
      }
      const errorMsg = typeof data?.message === 'string' ? data.message : 'Error verifying 2FA';
      showToast({ message: errorMsg, status: 'error' });
    },
  });

  const onSubmit = useCallback(
    (data: TwoFactorFormInputs) => {
      const payload: VerifyPayload = { tempToken };
      if (useBackup && data.backupCode != null && data.backupCode !== '') {
        payload.backupCode = data.backupCode;
      } else if (data.token != null && data.token !== '') {
        payload.token = data.token;
      }
      verifyTempMutate(payload);
    },
    [tempToken, useBackup, verifyTempMutate],
  );

  const toggleBackupOn = useCallback(() => {
    setUseBackup(true);
  }, []);

  const toggleBackupOff = useCallback(() => {
    setUseBackup(false);
  }, []);

  return (
    <div className="mt-4">
      <form onSubmit={handleSubmit(onSubmit)}>
        <Label className="text-text-primary flex justify-center text-center text-sm break-keep">
          {localize('com_auth_two_factor')}
        </Label>
        {!useBackup && (
          <div className="text-text-primary my-4 flex justify-center">
            <Controller
              name="token"
              control={control}
              render={({ field: { onChange, value } }) => (
                <InputOTP
                  maxLength={6}
                  value={value != null ? value : ''}
                  onChange={onChange}
                  pattern={REGEXP_ONLY_DIGITS}
                  aria-label={localize('com_ui_2fa_verification_required')}
                >
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
                </InputOTP>
              )}
            />
            {errors.token && (
              <span className="text-text-destructive text-sm">{errors.token.message}</span>
            )}
          </div>
        )}
        {useBackup && (
          <div className="text-text-primary my-4 flex justify-center">
            <Controller
              name="backupCode"
              control={control}
              render={({ field: { onChange, value } }) => (
                <BackupCodeInput value={value ?? ''} onChange={onChange} />
              )}
            />
            {errors.backupCode && (
              <span className="text-text-destructive text-sm">{errors.backupCode.message}</span>
            )}
          </div>
        )}
        <div className="flex items-center justify-between">
          <Button
            type="submit"
            variant="submit"
            data-testid="login-button"
            disabled={isLoading}
            className="w-full rounded-2xl px-4 py-3 text-sm font-medium disabled:opacity-80"
          >
            {isLoading ? localize('com_auth_email_verifying_ellipsis') : localize('com_ui_verify')}
          </Button>
        </div>
        <div className="mt-4 flex justify-center">
          {!useBackup ? (
            <Button
              type="button"
              variant="link"
              onClick={toggleBackupOn}
              className="text-accent-primary hover:text-accent-primary-hover inline-flex p-1 text-sm font-medium transition-colors"
            >
              {localize('com_ui_use_backup_code')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="link"
              onClick={toggleBackupOff}
              className="text-accent-primary hover:text-accent-primary-hover inline-flex p-1 text-sm font-medium transition-colors"
            >
              {localize('com_ui_use_2fa_code')}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
});

export default TwoFactorScreen;
