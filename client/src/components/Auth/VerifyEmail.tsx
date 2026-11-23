import { useState, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Button, Spinner, ThemeSelector } from '@librechat/client';
import type { EmailChangeErrorCode } from 'librechat-data-provider';
import {
  useVerifyEmailMutation,
  useResendVerificationEmail,
  useConfirmEmailChangeMutation,
} from '~/data-provider';
import { getResponseErrorCode } from '~/utils';
import { useLocalize } from '~/hooks';

function RequestPasswordReset() {
  const navigate = useNavigate();
  const localize = useLocalize();
  const [params] = useSearchParams();

  const [countdown, setCountdown] = useState<number>(0);
  const [headerText, setHeaderText] = useState<string>('');
  const [showResendLink, setShowResendLink] = useState<boolean>(false);
  const [verificationStatus, setVerificationStatus] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const token = useMemo(() => params.get('token') || '', [params]);
  const email = useMemo(() => params.get('email') || '', [params]);
  const userId = useMemo(() => params.get('userId') || '', [params]);
  const isEmailChange = useMemo(() => params.get('type') === 'email-change', [params]);

  const countdownRedirect = useCallback(() => {
    setCountdown(3);
    const timer = setInterval(() => {
      setCountdown((prevCountdown) => {
        if (prevCountdown <= 1) {
          clearInterval(timer);
          navigate('/c/new', { replace: true });
          return 0;
        }
        return prevCountdown - 1;
      });
    }, 1000);
  }, [navigate]);

  const verifyEmailMutation = useVerifyEmailMutation({
    onSuccess: () => {
      setHeaderText(localize('com_auth_email_verification_success') + ' 🎉');
      setVerificationStatus(true);
      countdownRedirect();
    },
    onError: (_error: unknown) => {
      setHeaderText(localize('com_auth_email_verification_failed') + ' 😢');
      setShowResendLink(true);
      setVerificationStatus(true);
    },
  });

  const confirmEmailChangeMutation = useConfirmEmailChangeMutation({
    onSuccess: () => {
      setHeaderText(localize('com_auth_email_change_success') + ' 🎉');
      setVerificationStatus(true);
      countdownRedirect();
    },
    onError: (error) => {
      const code = getResponseErrorCode<EmailChangeErrorCode>(error);
      const messageKey =
        code === 'email_in_use'
          ? 'com_ui_email_change_error_in_use'
          : 'com_auth_email_change_failed';
      setHeaderText(localize(messageKey) + ' 😢');
      setShowResendLink(false);
      setVerificationStatus(true);
    },
  });

  const resendEmailMutation = useResendVerificationEmail({
    onSuccess: () => {
      setHeaderText(localize('com_auth_email_resent_success') + ' 📧');
      countdownRedirect();
    },
    onError: () => {
      setHeaderText(localize('com_auth_email_resent_failed') + ' 😢');
    },
    onMutate: () => setShowResendLink(false),
  });

  const handleResendEmail = () => {
    resendEmailMutation.mutate({ email });
  };

  const hasVerificationParams = isEmailChange ? !!(token && email && userId) : !!(token && email);

  const handleConfirm = () => {
    if (submitted || !hasVerificationParams) {
      return;
    }
    setSubmitted(true);
    if (isEmailChange) {
      confirmEmailChangeMutation.mutate({ email, token, userId });
    } else {
      verifyEmailMutation.mutate({ email, token });
    }
  };

  /**
   * A valid link waits for an explicit click so email security scanners that open links
   * (Defender Safe Links, Sophos, Hornetsecurity) do not consume the single-use token first.
   * A link missing its parameters resolves immediately, since there is nothing to submit.
   */
  const invalidLink = !hasVerificationParams;
  const resolved = verificationStatus || invalidLink;
  const awaitingConfirmation = !invalidLink && !submitted && !verificationStatus;
  const canResend = invalidLink ? !isEmailChange && resendEmailMutation.isIdle : showResendLink;

  let statusText = headerText;
  if (invalidLink && !headerText) {
    statusText = email
      ? localize('com_auth_email_verification_failed_token_missing') + ' 😢'
      : localize('com_auth_email_verification_invalid') + ' 🤨';
  } else if (awaitingConfirmation) {
    statusText = localize(
      isEmailChange
        ? 'com_auth_email_change_confirm_title'
        : 'com_auth_email_verification_confirm_title',
    );
  } else if (!resolved) {
    statusText = localize(
      isEmailChange
        ? 'com_auth_email_change_verification_in_progress'
        : 'com_auth_email_verification_in_progress',
    );
  }

  return (
    <div className="bg-surface-primary flex min-h-screen flex-col items-center justify-center pt-6 sm:pt-0">
      <div className="absolute inset-s-0 bottom-0 m-4">
        <ThemeSelector />
      </div>
      <div className="flex flex-col items-center justify-center">
        <h1
          aria-live="polite"
          aria-atomic="true"
          className="text-text-primary mb-4 text-center text-3xl font-semibold"
        >
          {statusText}
        </h1>
        {awaitingConfirmation && (
          <>
            <p className="text-text-secondary mb-6 max-w-md px-4 text-center text-lg">
              {localize('com_auth_email_verification_confirm_description', { 0: email })}
            </p>
            <Button type="button" onClick={handleConfirm}>
              {localize(
                isEmailChange
                  ? 'com_auth_email_change_confirm'
                  : 'com_auth_email_verification_confirm',
              )}
            </Button>
          </>
        )}
        {!awaitingConfirmation && !resolved && (
          <div className="text-accent-primary mt-4 flex justify-center">
            <Spinner className="h-8 w-8" />
          </div>
        )}
        {resolved && countdown > 0 && (
          <p className="text-text-secondary text-center text-lg">
            {localize('com_auth_email_verification_redirecting', { 0: countdown.toString() })}
          </p>
        )}
        {resolved && canResend && countdown === 0 && (
          <p className="text-text-secondary text-center text-lg">
            {localize('com_auth_email_verification_resend_prompt')}
            <Button
              type="button"
              variant="hyperlink"
              size="bare"
              className="ms-2 inline"
              onClick={handleResendEmail}
              disabled={resendEmailMutation.isLoading}
            >
              {localize('com_auth_email_resend_link')}
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}

export default RequestPasswordReset;
