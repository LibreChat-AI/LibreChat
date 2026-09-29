import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  readTwoFactorSetupToken,
  clearTwoFactorSetupToken,
  subscribeTwoFactorSetupToken,
} from 'librechat-data-provider';
import {
  useAcknowledgeTwoFactorSetupMutation,
  useConfirmTwoFactorSetupMutation,
  useEnableTwoFactorSetupMutation,
  useFinalizeTwoFactorSetupMutation,
} from '~/data-provider';
import {
  BackupPhase,
  QRPhase,
  SetupPhase,
  VerifyPhase,
} from '~/components/Nav/SettingsTabs/Account/TwoFactorPhases';
import { useAuthContext, useLocalize } from '~/hooks';
import { ErrorMessage } from './ErrorMessage';
import { isSafeRedirect } from '~/utils';

type SetupPhaseName = 'setup' | 'qr' | 'verify' | 'backup';

const getSecret = (otpauthUrl: string): string => {
  const value = otpauthUrl.match(/[?&]secret=([^&]+)/)?.[1];
  return value ? decodeURIComponent(value) : '';
};

const getResponseStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | undefined)?.response?.status;

/**
 * Every setup route gates on the enforcement policy and on the ban list before it reaches a
 * controller, and both answer 403. Either way the flow is retired rather than merely rejected, so
 * no phase can make progress and a reload would only replay it. Rate limiting answers 429 and a
 * wrong or spent code answers 400, so neither retryable state is caught here.
 */
const isRetiredSetupFlow = (error: unknown): boolean => getResponseStatus(error) === 403;

const isExpiredSetupCredential = (error: unknown): boolean =>
  getResponseStatus(error) === 401 || isRetiredSetupFlow(error);

/**
 * Acknowledgement and finalization nonces are single-use and answer 400 once consumed, so a lost
 * response leaves the screen replaying a credential the server can never accept again. Spent and
 * expired both have to land somewhere the user can act from rather than on an endless retry.
 */
const isSpentTransitionCredential = (error: unknown): boolean => {
  const status = getResponseStatus(error);
  return status === 400 || status === 401 || isRetiredSetupFlow(error);
};

const TwoFactorSetupScreen: React.FC = React.memo(() => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const localize = useLocalize();
  const { completeAuthentication } = useAuthContext();
  const phaseRef = useRef<HTMLDivElement>(null);
  /**
   * Read at mount and adopted later only while empty: the credential arrives out of band rather
   * than in the query string, a refresh on this route can hand one off after the screen rendered,
   * and consuming it on completion must not flip the screen to the expired state mid-navigation.
   */
  const [tempToken, setTempToken] = useState(readTwoFactorSetupToken);
  const [phase, setPhase] = useState<SetupPhaseName>('setup');
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verificationToken, setVerificationToken] = useState('');
  const [acknowledgementToken, setAcknowledgementToken] = useState('');
  const [finalizationToken, setFinalizationToken] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutate: enableSetup, isLoading: isGenerating } = useEnableTwoFactorSetupMutation();
  const { mutate: confirmSetup, isLoading: isVerifying } = useConfirmTwoFactorSetupMutation();
  const { mutate: acknowledgeSetup, isLoading: isAcknowledging } =
    useAcknowledgeTwoFactorSetupMutation();
  const { mutate: finalizeSetup, isLoading: isFinalizing } = useFinalizeTwoFactorSetupMutation();
  const redirectTo = searchParams.get('redirect_to');
  const restartLoginPath =
    redirectTo && isSafeRedirect(redirectTo)
      ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
      : '/login';

  useEffect(() => {
    phaseRef.current?.focus();
  }, [phase]);

  useEffect(
    () =>
      subscribeTwoFactorSetupToken(() =>
        setTempToken((current) => current || readTwoFactorSetupToken()),
      ),
    [],
  );

  const restartLogin = useCallback(() => {
    clearTwoFactorSetupToken();
    navigate(restartLoginPath, { replace: true });
  }, [navigate, restartLoginPath]);

  const restartLoginWhenExpired = useCallback(
    (mutationError: unknown): boolean => {
      if (!isExpiredSetupCredential(mutationError)) {
        return false;
      }
      restartLogin();
      return true;
    },
    [restartLogin],
  );

  const restartLoginWhenSpent = useCallback(
    (mutationError: unknown): boolean => {
      if (!isSpentTransitionCredential(mutationError)) {
        return false;
      }
      restartLogin();
      return true;
    },
    [restartLogin],
  );

  const handleGenerate = useCallback(() => {
    setError(null);
    enableSetup(
      { tempToken },
      {
        onSuccess: (data) => {
          setOtpauthUrl(data.otpauthUrl);
          setSecret(getSecret(data.otpauthUrl));
          setBackupCodes(data.backupCodes);
          setPhase('qr');
        },
        onError: (mutationError) => {
          if (!restartLoginWhenExpired(mutationError)) {
            setError(localize('com_auth_two_factor_setup_expired'));
          }
        },
      },
    );
  }, [enableSetup, localize, restartLoginWhenExpired, tempToken]);

  const handleVerify = useCallback(() => {
    if (verificationToken.length !== 6) {
      return;
    }

    setError(null);
    confirmSetup(
      { tempToken, token: verificationToken },
      {
        onSuccess: (data) => {
          if (!data.acknowledgementToken || !data.backupCodes.length) {
            setError(localize('com_ui_2fa_invalid'));
            return;
          }
          setBackupCodes(data.backupCodes);
          setAcknowledgementToken(data.acknowledgementToken);
          /** Confirming again rotates the codes server-side, retiring any earlier credential. */
          setFinalizationToken('');
          setDownloaded(false);
          setPhase('backup');
        },
        onError: (mutationError) => {
          if (!restartLoginWhenExpired(mutationError)) {
            setError(localize('com_ui_2fa_invalid'));
          }
        },
      },
    );
  }, [confirmSetup, localize, restartLoginWhenExpired, tempToken, verificationToken]);

  const handleDownload = useCallback(() => {
    if (!backupCodes.length) {
      return;
    }

    const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'backup-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }, [backupCodes]);

  const runFinalize = useCallback(
    (token: string) => {
      finalizeSetup(
        { finalizationToken: token },
        {
          onSuccess: ({ token: authToken, user }) => completeAuthentication(authToken, user),
          onError: (mutationError) => {
            if (!restartLoginWhenSpent(mutationError)) {
              setError(localize('com_auth_two_factor_setup_finalize_error'));
            }
          },
        },
      );
    },
    [completeAuthentication, finalizeSetup, localize, restartLoginWhenSpent],
  );

  const handleComplete = useCallback(() => {
    setError(null);
    /** Acknowledgement nonces are single-use, so a retry reuses the finalization credential. */
    if (finalizationToken) {
      runFinalize(finalizationToken);
      return;
    }
    if (!acknowledgementToken) {
      return;
    }

    acknowledgeSetup(
      { acknowledgementToken },
      {
        onSuccess: ({ finalizationToken: issuedToken }) => {
          setFinalizationToken(issuedToken);
          runFinalize(issuedToken);
        },
        onError: (mutationError) => {
          if (!restartLoginWhenSpent(mutationError)) {
            setError(localize('com_auth_two_factor_setup_finalize_error'));
          }
        },
      },
    );
  }, [
    acknowledgementToken,
    acknowledgeSetup,
    finalizationToken,
    localize,
    restartLoginWhenSpent,
    runFinalize,
  ]);

  /**
   * The layout hides the sign-in controls on every setup path, so without this action a screen that
   * lost its credential has nowhere to go: the message tells the user to return to sign in and the
   * page offers no way to do it. Reloading only replays the same empty state.
   */
  if (!tempToken) {
    return (
      <div>
        <ErrorMessage>{localize('com_auth_two_factor_setup_expired')}</ErrorMessage>
        <Button variant="link" onClick={restartLogin} className="mt-4 w-full">
          {localize('com_auth_back_to_login')}
        </Button>
      </div>
    );
  }

  return (
    <div className="text-text-primary mt-4 space-y-6">
      <p className="text-text-primary text-center text-sm">
        {localize('com_auth_two_factor_setup_required_description')}
      </p>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div
        ref={phaseRef}
        tabIndex={-1}
        aria-live="polite"
        data-testid="two-factor-setup-phase"
        className="focus:outline-none"
      >
        {phase === 'setup' && (
          <SetupPhase
            isGenerating={isGenerating}
            onGenerate={handleGenerate}
            onNext={() => setPhase('qr')}
            onError={() => setError(localize('com_auth_two_factor_setup_expired'))}
          />
        )}
        {phase === 'qr' && (
          <QRPhase
            secret={secret}
            otpauthUrl={otpauthUrl}
            onNext={() => setPhase('verify')}
            onError={() => setError(localize('com_auth_two_factor_setup_expired'))}
          />
        )}
        {phase === 'verify' && (
          <VerifyPhase
            token={verificationToken}
            onTokenChange={setVerificationToken}
            isVerifying={isVerifying}
            onNext={handleVerify}
            onError={() => setError(localize('com_ui_2fa_invalid'))}
          />
        )}
        {phase === 'backup' && (
          <BackupPhase
            backupCodes={backupCodes}
            onDownload={handleDownload}
            downloaded={downloaded}
            isCompleting={isAcknowledging || isFinalizing}
            onNext={handleComplete}
            onError={() => setError(localize('com_ui_2fa_invalid'))}
          />
        )}
      </div>
    </div>
  );
});

export default TwoFactorSetupScreen;
