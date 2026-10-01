import React, { useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { motion, AnimatePresence } from 'framer-motion';
import { REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp';
import {
  InputOTPSeparator,
  InputOTPGroup,
  InputOTPSlot,
  OGDialogContent,
  OGDialogTitle,
  OGDialogTrigger,
  OGDialog,
  InputOTP,
  Button,
  Label,
  Spinner,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import type {
  TRegenerateBackupCodesResponse,
  TRegenerateBackupCodesRequest,
  TBackupCode,
  TUser,
} from 'librechat-data-provider';
import { useRegenerateBackupCodesMutation } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { useTwoFactorError } from './errors';
import store from '~/store';

const BackupCodesItem: React.FC = () => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const showError = useTwoFactorError();
  const setUser = useSetRecoilState(store.user);
  const [isDialogOpen, setDialogOpen] = useState<boolean>(false);
  const [otpToken, setOtpToken] = useState('');
  const [useBackup, setUseBackup] = useState(false);

  const { mutate: regenerateBackupCodes, isLoading } = useRegenerateBackupCodesMutation();

  const needs2FA = !!user?.twoFactorEnabled;

  const fetchBackupCodes = (auto: boolean = false) => {
    let payload: TRegenerateBackupCodesRequest | undefined;
    if (needs2FA && otpToken.trim()) {
      payload = useBackup ? { backupCode: otpToken.trim() } : { token: otpToken.trim() };
    }

    regenerateBackupCodes(payload, {
      onSuccess: (data: TRegenerateBackupCodesResponse) => {
        const newBackupCodes: TBackupCode[] = data.backupCodesHash;

        setUser((prev) => ({ ...prev, backupCodes: newBackupCodes }) as TUser);
        setOtpToken('');
        showToast({
          message: localize('com_ui_backup_codes_regenerated'),
          status: 'success',
        });

        if (!auto && newBackupCodes.length) {
          const codesString = data.backupCodes.join('\n');
          const blob = new Blob([codesString], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'backup-codes.txt';
          a.click();
          URL.revokeObjectURL(url);
        }
      },
      onError: (error) => showError(error, 'com_ui_backup_codes_regenerate_error'),
    });
  };

  const handleRegenerate = () => {
    fetchBackupCodes(false);
  };

  const otpReady = !needs2FA || otpToken.length === (useBackup ? 8 : 6);

  return (
    <OGDialog open={isDialogOpen} onOpenChange={setDialogOpen}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Label className="font-light">{localize('com_ui_backup_codes')}</Label>
        </div>
        <OGDialogTrigger asChild>
          <Button aria-label="Manage Backup Codes" variant="outline">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>
      </div>

      <OGDialogContent className="w-11/12 max-w-lg">
        <OGDialogTitle className="mb-6 text-2xl font-semibold">
          {localize('com_ui_backup_codes')}
        </OGDialogTitle>

        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mt-4"
          >
            {Array.isArray(user?.backupCodes) && user?.backupCodes.length > 0 ? (
              <>
                <div className="mb-6 rounded-lg border border-status-warning-border bg-status-warning-subtle p-4">
                  <p className="text-sm text-text-secondary">
                    {localize('com_ui_backup_codes_security_info')}
                  </p>
                </div>

                <h3 className="mb-4 text-lg font-medium">
                  {localize('com_ui_backup_codes_status')}
                </h3>

                <div className="grid grid-cols-2 gap-4">
                  {user?.backupCodes.map((code, index) => {
                    const isUsed = code.used;
                    const description = `Backup code number ${index + 1}, ${
                      isUsed
                        ? `used on ${code.usedAt ? new Date(code.usedAt).toLocaleDateString() : 'an unknown date'}`
                        : 'not used yet'
                    }`;

                    return (
                      <motion.div
                        key={code.codeHash}
                        role="listitem"
                        tabIndex={0}
                        aria-label={description}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        onFocus={() => {
                          const announcement = new CustomEvent('announce', {
                            detail: { message: description },
                          });
                          document.dispatchEvent(announcement);
                        }}
                        className={`flex flex-col rounded-xl border p-4 backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary ${
                          isUsed
                            ? 'border-status-error-border bg-status-error-subtle'
                            : 'border-status-success-border bg-status-success-subtle'
                        } `}
                      >
                        <div className="flex items-center justify-between" aria-hidden="true">
                          <span className="text-sm font-medium text-text-secondary">
                            {localize('com_ui_backup_code_number', { number: index + 1 })}
                          </span>
                          <TooltipAnchor
                            description={
                              code.usedAt ? new Date(code.usedAt).toLocaleDateString() : ''
                            }
                            disabled={!isUsed}
                            focusable={false}
                            className={isUsed ? 'cursor-pointer' : 'cursor-default'}
                            render={
                              <span
                                className={`rounded-full px-3 py-1 text-sm font-medium ${
                                  isUsed
                                    ? 'bg-status-error-subtle text-status-error'
                                    : 'bg-status-success-subtle text-status-success'
                                }`}
                              >
                                {isUsed ? localize('com_ui_used') : localize('com_ui_not_used')}
                              </span>
                            }
                          />
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
                <div className="mt-6 flex justify-center">
                  <Button
                    onClick={handleRegenerate}
                    disabled={isLoading || !otpReady}
                    variant="default"
                    className="px-8 py-3 transition-all disabled:opacity-50"
                  >
                    {isLoading ? (
                      <Spinner className="mr-2" />
                    ) : (
                      <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                    )}
                    {isLoading
                      ? localize('com_ui_regenerating')
                      : localize('com_ui_regenerate_backup')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 p-6 text-center">
                <Button
                  onClick={handleRegenerate}
                  disabled={isLoading || !otpReady}
                  variant="default"
                  className="px-8 py-3 transition-all disabled:opacity-50"
                >
                  {isLoading && <Spinner className="mr-2" />}
                  {localize('com_ui_regenerate_backup')}
                </Button>
              </div>
            )}
            {needs2FA && (
              <div className="mt-6 space-y-3">
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
                  className="h-auto p-0 text-sm text-text-primary hover:underline"
                >
                  {useBackup ? localize('com_ui_use_2fa_code') : localize('com_ui_use_backup_code')}
                </Button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </OGDialogContent>
    </OGDialog>
  );
};

export default React.memo(BackupCodesItem);
