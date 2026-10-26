import { useForm } from 'react-hook-form';
import { useOutletContext } from 'react-router-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spinner, Button, SecretInput, Alert } from '@librechat/client';
import { useResetPasswordMutation } from 'librechat-data-provider/react-query';
import type { TResetPassword } from 'librechat-data-provider';
import type { TLoginLayoutContext } from '~/common';
import { useLocalize } from '~/hooks';

function ResetPassword() {
  const localize = useLocalize();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<TResetPassword>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const password = watch('password');
  const resetPassword = useResetPasswordMutation();
  const { setError, setHeaderText, startupConfig } = useOutletContext<TLoginLayoutContext>();

  const onSubmit = (data: TResetPassword) => {
    resetPassword.mutate(data, {
      onError: () => {
        setError('com_auth_error_invalid_reset_token');
      },
      onSuccess: () => {
        setHeaderText('com_auth_reset_password_success');
      },
    });
  };

  if (resetPassword.isSuccess) {
    return (
      <>
        <Alert variant="success" icon={false} elevation="raised" size="roomy" className="mt-6">
          <div className="flex flex-col space-y-4">
            <p>{localize('com_auth_login_with_new_password')}</p>
            <Button
              onClick={() => navigate('/login')}
              aria-label={localize('com_auth_sign_in')}
              variant="submit"
              size="auth-action"
              shape="auth-action"
            >
              {localize('com_auth_continue')}
            </Button>
          </div>
        </Alert>
      </>
    );
  }

  return (
    <form
      className="mt-6"
      aria-label="Password reset form"
      method="POST"
      onSubmit={handleSubmit(onSubmit)}
    >
      <div className="mb-2">
        <div className="relative">
          <input
            type="hidden"
            id="token"
            value={params.get('token') ?? ''}
            {...register('token', { required: 'Unable to process: No valid reset token' })}
          />
          <input
            type="hidden"
            id="userId"
            value={params.get('userId') ?? ''}
            {...register('userId', { required: 'Unable to process: No valid user id' })}
          />
          <SecretInput
            colorTransition
            id="password"
            autoComplete="current-password"
            aria-label={localize('com_auth_password')}
            {...register('password', {
              required: localize('com_auth_password_required'),
              minLength: {
                value: startupConfig?.minPasswordLength || 8,
                message: localize('com_auth_password_min_length'),
              },
              maxLength: {
                value: 128,
                message: localize('com_auth_password_max_length'),
              },
            })}
            aria-invalid={!!errors.password}
            variant="floating"
            placeholder=" "
            label={localize('com_auth_password')}
          />
        </div>

        {errors.password && (
          <span role="alert" className="text-text-destructive mt-1 text-sm">
            {errors.password.message}
          </span>
        )}
      </div>
      <div className="mb-2">
        <div className="relative">
          <SecretInput
            colorTransition
            id="confirm_password"
            aria-label={localize('com_auth_password_confirm')}
            {...register('confirm_password', {
              validate: (value) => value === password || localize('com_auth_password_not_match'),
            })}
            aria-invalid={!!errors.confirm_password}
            variant="floating"
            placeholder=" "
            label={localize('com_auth_password_confirm')}
          />
        </div>
        {errors.confirm_password && (
          <span role="alert" className="text-text-destructive mt-1 text-sm">
            {errors.confirm_password.message}
          </span>
        )}
        {errors.token && (
          <span role="alert" className="text-text-destructive mt-1 text-sm">
            {errors.token.message}
          </span>
        )}
        {errors.userId && (
          <span role="alert" className="text-text-destructive mt-1 text-sm">
            {errors.userId.message}
          </span>
        )}
      </div>
      <div className="mt-6">
        <Button
          type="submit"
          aria-label={localize('com_auth_submit_registration')}
          disabled={!!errors.password || !!errors.confirm_password || isSubmitting}
          variant="submit"
          shape="soft"
          size="auth"
          className="w-full"
        >
          {isSubmitting ? <Spinner /> : localize('com_auth_continue')}
        </Button>
      </div>
    </form>
  );
}

export default ResetPassword;
