import React, { useCallback, useState, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
import { SmartphoneIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  isTwoFactorPolicyProvider,
  type TUser,
  type TVerify2FARequest,
} from 'librechat-data-provider';
import {
  OGDialog,
  useToastContext,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Progress,
} from '@librechat/client';
import type { Variants } from 'framer-motion';
import {
  useConfirmTwoFactorMutation,
  useDisableTwoFactorMutation,
  useEnableTwoFactorMutation,
  useGetStartupConfig,
  useVerifyTwoFactorMutation,
} from '~/data-provider';
import { SetupPhase, QRPhase, VerifyPhase, BackupPhase, DisablePhase } from './TwoFactorPhases';
import { DisableTwoFactorToggle } from './DisableTwoFactorToggle';
import { useAuthContext, useLocalize } from '~/hooks';
import { useTwoFactorError } from './errors';
import store from '~/store';

export type Phase = 'setup' | 'qr' | 'verify' | 'backup' | 'disable';

const phaseVariants: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: 'easeOut' } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.3, ease: 'easeIn' } },
};

const TwoFactorAuthentication: React.FC = () => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const setUser = useSetRecoilState(store.user);
  const { showToast } = useToastContext();
  const showError = useTwoFactorError();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const [secret, setSecret] = useState<string>('');
  const [otpauthUrl, setOtpauthUrl] = useState<string>('');
  const [downloaded, setDownloaded] = useState<boolean>(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [_disableToken, setDisableToken] = useState<string>('');
  const [isDialogOpen, setDialogOpen] = useState<boolean>(false);
  const [verificationToken, setVerificationToken] = useState<string>('');
  const [phase, setPhase] = useState<Phase>(user?.twoFactorEnabled ? 'disable' : 'setup');

  const { mutate: confirm2FAMutate } = useConfirmTwoFactorMutation();
  const { mutate: enable2FAMutate, isLoading: isGenerating } = useEnableTwoFactorMutation();
  const { mutate: verify2FAMutate, isLoading: isVerifying } = useVerifyTwoFactorMutation();
  const { mutate: disable2FAMutate, isLoading: isDisabling } = useDisableTwoFactorMutation();

  const steps = [
    localize('com_ui_2fa_setup'),
    localize('com_ui_2fa_scan_qr'),
    localize('com_ui_verify'),
    localize('com_ui_backup_codes'),
  ];
  const phaseIndex: Record<Phase, number> = {
    setup: 0,
    qr: 1,
    verify: 2,
    backup: 3,
    disable: -1,
  };
  const currentStep = phaseIndex[phase];
  const isTwoFactorRequired =
    startupConfig?.twoFactorAuthenticationRequired === true &&
    isTwoFactorPolicyProvider(user?.provider);

  const resetState = useCallback(() => {
    if (user?.twoFactorEnabled && otpauthUrl) {
      disable2FAMutate(undefined, {
        onError: (error) => showError(error, 'com_ui_2fa_disable_error'),
      });
    }

    setOtpauthUrl('');
    setSecret('');
    setBackupCodes([]);
    setVerificationToken('');
    setDisableToken('');
    setPhase(user?.twoFactorEnabled ? 'disable' : 'setup');
    setDownloaded(false);
  }, [user, otpauthUrl, disable2FAMutate, showError]);

  const handleGenerateQRCode = useCallback(() => {
    enable2FAMutate(undefined, {
      onSuccess: ({ otpauthUrl, backupCodes }) => {
        setOtpauthUrl(otpauthUrl);
        setSecret(otpauthUrl.split('secret=')[1].split('&')[0]);
        setBackupCodes(backupCodes);
        setPhase('qr');
      },
      onError: (error) => showError(error, 'com_ui_2fa_generate_error'),
    });
  }, [enable2FAMutate, showError]);

  const handleVerify = useCallback(() => {
    if (!verificationToken) {
      return;
    }

    verify2FAMutate(
      { token: verificationToken },
      {
        onSuccess: () => {
          showToast({ message: localize('com_ui_2fa_verified') });
          confirm2FAMutate(
            { token: verificationToken },
            {
              onSuccess: () => setPhase('backup'),
              onError: (error) => showError(error, 'com_ui_2fa_invalid'),
            },
          );
        },
        onError: (error) => showError(error, 'com_ui_2fa_invalid'),
      },
    );
  }, [verificationToken, verify2FAMutate, confirm2FAMutate, localize, showToast, showError]);

  const handleDownload = useCallback(() => {
    if (!backupCodes.length) {
      return;
    }
    const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }, [backupCodes]);

  const handleConfirm = useCallback(() => {
    setDialogOpen(false);
    setPhase('disable');
    showToast({ message: localize('com_ui_2fa_enabled') });
    setUser(
      (prev) =>
        ({
          ...prev,
          backupCodes: backupCodes.map((code) => ({
            code,
            codeHash: code,
            used: false,
            usedAt: null,
          })),
          twoFactorEnabled: true,
        }) as TUser,
    );
  }, [setUser, localize, showToast, backupCodes]);

  const handleDisableVerify = useCallback(
    (token: string, useBackup: boolean) => {
      // Validate: if not using backup, ensure token has at least 6 digits;
      // if using backup, ensure backup code has at least 8 characters.
      if (!useBackup && token.trim().length < 6) {
        return;
      }

      if (useBackup && token.trim().length < 8) {
        return;
      }

      const payload: TVerify2FARequest = {};
      if (useBackup) {
        payload.backupCode = token.trim();
      } else {
        payload.token = token.trim();
      }

      disable2FAMutate(payload, {
        onSuccess: () => {
          showToast({ message: localize('com_ui_2fa_disabled') });
          setDialogOpen(false);
          setUser(
            (prev) =>
              ({
                ...prev,
                totpSecret: '',
                backupCodes: [],
                twoFactorEnabled: false,
              }) as TUser,
          );
          setPhase('setup');
          setOtpauthUrl('');
        },
        onError: (error) => showError(error, 'com_ui_2fa_invalid'),
      });
    },
    [disable2FAMutate, showToast, localize, setUser, showError],
  );

  return (
    <OGDialog
      open={isDialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          resetState();
        }
      }}
      triggerRef={buttonRef}
    >
      <DisableTwoFactorToggle
        enabled={!!user?.twoFactorEnabled}
        required={isTwoFactorRequired}
        onChange={() => setDialogOpen(true)}
        disabled={isVerifying || isDisabling || isGenerating}
        buttonRef={buttonRef}
      />

      <OGDialogContent className="w-11/12 max-w-lg p-6">
        <AnimatePresence mode="wait">
          <motion.div
            id="two-factor-authentication-dialog"
            key={phase}
            variants={phaseVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="space-y-6"
          >
            <OGDialogHeader>
              <OGDialogTitle className="mb-2 flex items-center gap-3 text-2xl font-bold">
                <SmartphoneIcon className="text-text-primary h-6 w-6" aria-hidden="true" />
                {user?.twoFactorEnabled
                  ? localize('com_ui_2fa_disable')
                  : localize('com_ui_2fa_setup')}
              </OGDialogTitle>
              {phase !== 'disable' && (
                <div className="mt-4 space-y-3">
                  <Progress
                    value={(currentStep / (steps.length - 1)) * 100}
                    className="h-2 rounded-full"
                  />
                  <div className="text-text-primary flex justify-between text-sm">
                    {steps.map((step, index) => (
                      <motion.span
                        key={step}
                        animate={{ opacity: currentStep >= index ? 1 : 0.7 }}
                        className="text-text-primary font-medium"
                      >
                        {step}
                      </motion.span>
                    ))}
                  </div>
                </div>
              )}
            </OGDialogHeader>

            <AnimatePresence mode="wait">
              {phase === 'setup' && (
                <SetupPhase
                  isGenerating={isGenerating}
                  onGenerate={handleGenerateQRCode}
                  onNext={() => setPhase('qr')}
                  onError={(error) => showToast({ message: error.message, status: 'error' })}
                />
              )}

              {phase === 'qr' && (
                <QRPhase
                  secret={secret}
                  otpauthUrl={otpauthUrl}
                  onNext={() => setPhase('verify')}
                  onError={(error) => showToast({ message: error.message, status: 'error' })}
                />
              )}

              {phase === 'verify' && (
                <VerifyPhase
                  token={verificationToken}
                  onTokenChange={setVerificationToken}
                  isVerifying={isVerifying}
                  onNext={handleVerify}
                  onError={(error) => showToast({ message: error.message, status: 'error' })}
                />
              )}

              {phase === 'backup' && (
                <BackupPhase
                  backupCodes={backupCodes}
                  onDownload={handleDownload}
                  downloaded={downloaded}
                  onNext={handleConfirm}
                  onError={(error) => showToast({ message: error.message, status: 'error' })}
                />
              )}

              {phase === 'disable' && (
                <DisablePhase
                  onDisable={handleDisableVerify}
                  isDisabling={isDisabling}
                  onError={(error) => showToast({ message: error.message, status: 'error' })}
                />
              )}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
      </OGDialogContent>
    </OGDialog>
  );
};

export default React.memo(TwoFactorAuthentication);
