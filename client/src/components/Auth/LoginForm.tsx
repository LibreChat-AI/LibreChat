import React, { useState, useEffect, useContext } from 'react';
import { useForm } from 'react-hook-form';
import { Turnstile } from '@marsidev/react-turnstile';
import { ThemeContext, Spinner, Button, isDark } from '@librechat/client';
import type { TLoginUser, TStartupConfig } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { useResendVerificationEmail, useGetStartupConfig, useRequestVerificationMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import PasswordToggleButton from './PasswordToggleButton';

type TLoginFormProps = {
  onSubmit: (data: TLoginUser) => void;
  startupConfig: TStartupConfig;
  error: Pick<TAuthContext, 'error'>['error'];
  setError: Pick<TAuthContext, 'setError'>['setError'];
};

const LoginForm: React.FC<TLoginFormProps> = ({ onSubmit, startupConfig, error, setError }) => {
  const localize = useLocalize();
  const { theme } = useContext(ThemeContext);
  const {
    register,
    getValues,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TLoginUser>();
  const [showResendLink, setShowResendLink] = useState<boolean>(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [showRequestVerification, setShowRequestVerification] = useState<boolean>(false);
  const [verificationRequestSent, setVerificationRequestSent] = useState<boolean>(false);
  // Controls whether the password field is shown as plain text
  const [isPasswordVisible, setIsPasswordVisible] = useState<boolean>(false);

  const { data: config } = useGetStartupConfig();
  const useUsernameLogin = config?.ldap?.username;
  const validTheme = isDark(theme) ? 'dark' : 'light';
  const requireCaptcha = Boolean(startupConfig.turnstile?.siteKey);

  const requestVerificationMutation = useRequestVerificationMutation({
    onMutate: () => {
      setError(undefined);
      setShowRequestVerification(false);
    },
    onSuccess: () => {
      setVerificationRequestSent(true);
    },
    onError: (error) => {
      console.error('Failed to send verification request:', error);
      setError('Failed to send verification request. Please try again.');
    },
  });

  useEffect(() => {
    if (error && error.includes('422') && !showResendLink) {
      setShowResendLink(true);
    }
    if (error && error === 'ERR_ADMIN_VERIFICATION_PENDING' && !showRequestVerification && !verificationRequestSent) {
      setShowRequestVerification(true);
    }
  }, [error, showResendLink, showRequestVerification, verificationRequestSent]);

  const resendLinkMutation = useResendVerificationEmail({
    onMutate: () => {
      setError(undefined);
      setShowResendLink(false);
    },
  });

  if (!startupConfig) {
    return null;
  }

  const renderError = (fieldName: string) => {
    const errorMessage = errors[fieldName]?.message;
    return errorMessage ? (
      <span role="alert" className="mt-1 text-sm text-red-600 dark:text-red-500">
        {String(errorMessage)}
      </span>
    ) : null;
  };

  const handleResendEmail = () => {
    const email = getValues('email');
    if (!email) {
      return setShowResendLink(false);
    }
    resendLinkMutation.mutate({ email });
  };

  const handleRequestVerification = () => {
    const email = getValues('email');
    if (!email) {
      return setShowRequestVerification(false);
    }
    requestVerificationMutation.mutate({ identifier: email });
  };

  return (
    <>
      {showResendLink && (
        <div className="mt-2 rounded-md border border-green-500 bg-green-500/10 px-3 py-2 text-sm text-gray-600 dark:text-gray-200">
          {localize('com_auth_email_verification_resend_prompt')}
          <button
            type="button"
            className="ml-2 text-blue-600 hover:underline"
            onClick={handleResendEmail}
            disabled={resendLinkMutation.isLoading}
          >
            {localize('com_auth_email_resend_link')}
          </button>
        </div>
      )}
      {showRequestVerification && (
        <div className="mt-2 rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2 text-sm text-gray-600 dark:text-gray-200">
          Your account verification is pending.
          <button
            type="button"
            className="ml-2 text-blue-600 hover:underline"
            onClick={handleRequestVerification}
            disabled={requestVerificationMutation.isPending}
          >
            {requestVerificationMutation.isPending ? 'Requesting...' : 'Request Verification'}
          </button>
        </div>
      )}
      {verificationRequestSent && (
        <div className="mt-2 rounded-md border border-green-500 bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
          Verification request sent to administrators.
        </div>
      )}
      <form
        className="mt-6"
        aria-label="Login form"
        method="POST"
        onSubmit={handleSubmit((data) => onSubmit(data))}
      >
        <div className="mb-4">
          <div className="relative">
            <input
              type="text"
              id="email"
              autoComplete={useUsernameLogin ? 'username' : 'email'}
              aria-label={localize('com_auth_email')}
              {...register('email', {
                required: localize('com_auth_email_required'),
                maxLength: { value: 120, message: localize('com_auth_email_max_length') },
                pattern: {
                  value: useUsernameLogin ? /\S+/ : /\S+@\S+\.\S+/,
                  message: localize('com_auth_email_pattern'),
                },
              })}
              aria-invalid={!!errors.email}
              className="webkit-dark-styles transition-color peer w-full rounded-2xl border border-border-light bg-transparent px-3.5 pb-2.5 pt-3 text-text-primary duration-200 focus:border-green-500 focus:outline-none"
              placeholder=" "
            />
            <label
              htmlFor="email"
              className="absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-white px-2 text-sm dark:bg-gray-900 text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-green-600 dark:peer-focus:text-green-500 rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4"
            >
              {useUsernameLogin
                ? localize('com_auth_username').replace(/ \(.*$/, '')
                : localize('com_auth_email_address')}
            </label>
          </div>
          {renderError('email')}
        </div>
        <div className="mb-2">
          <div className="relative">
            <input
              type={isPasswordVisible ? 'text' : 'password'}
              id="password"
              autoComplete="current-password"
              aria-label={localize('com_auth_password')}
              {...register('password', {
                required: localize('com_auth_password_required'),
                minLength: {
                  value: startupConfig?.minPasswordLength || 8,
                  message: localize('com_auth_password_min_length'),
                },
                maxLength: { value: 128, message: localize('com_auth_password_max_length') },
              })}
              aria-invalid={!!errors.password}
              className="webkit-dark-styles transition-color peer w-full rounded-2xl border border-border-light bg-transparent pe-11 ps-3.5 pb-2.5 pt-3 text-text-primary duration-200 focus:border-green-500 focus:outline-none"
              placeholder=" "
            />
            <label
              htmlFor="password"
              className="absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-white px-2 text-sm dark:bg-gray-900 text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-green-600 dark:peer-focus:text-green-500 rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4"
            >
              {localize('com_auth_password')}
            </label>
            <PasswordToggleButton
              isVisible={isPasswordVisible}
              onToggle={() => setIsPasswordVisible((prev) => !prev)}
            />
          </div>
          {renderError('password')}
        </div>
        {startupConfig.passwordResetEnabled && (
          <a
            href="/forgot-password"
            className="inline-flex p-1 text-sm font-medium text-green-600 underline decoration-transparent transition-all duration-200 hover:text-green-700 hover:decoration-green-700 focus:text-green-700 focus:decoration-green-700 dark:text-green-500 dark:hover:text-green-400 dark:hover:decoration-green-400 dark:focus:text-green-400 dark:focus:decoration-green-400"
          >
            {localize('com_auth_password_forgot')}
          </a>
        )}

        {requireCaptcha && (
          <div className="my-4 flex justify-center">
            <Turnstile
              siteKey={startupConfig.turnstile!.siteKey}
              options={{
                ...startupConfig.turnstile!.options,
                theme: validTheme,
              }}
              onSuccess={setTurnstileToken}
              onError={() => setTurnstileToken(null)}
              onExpire={() => setTurnstileToken(null)}
            />
          </div>
        )}

        <div className="mt-6">
          <Button
            aria-label={localize('com_auth_continue')}
            data-testid="login-button"
            type="submit"
            disabled={(requireCaptcha && !turnstileToken) || isSubmitting}
            variant="submit"
            className="h-12 w-full rounded-2xl"
          >
            {isSubmitting ? <Spinner /> : localize('com_auth_continue')}
          </Button>
        </div>
      </form>
    </>
  );
};

export default LoginForm;
