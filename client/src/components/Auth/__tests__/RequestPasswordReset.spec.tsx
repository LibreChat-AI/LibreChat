import * as router from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { useRequestPasswordResetMutation } from 'librechat-data-provider/react-query';
import RequestPasswordReset from '../RequestPasswordReset';

jest.mock('librechat-data-provider/react-query');
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useOutletContext: jest.fn(),
}));
jest.mock('~/hooks', () => ({
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
}));

const mockSetHeaderText = jest.fn();
const mockMutate = jest.fn();
const mockUseRequestPasswordReset = jest.mocked(useRequestPasswordResetMutation);

function setup(emailEnabled: boolean | null = true, isLoading = false) {
  jest.mocked(router.useOutletContext).mockReturnValue({
    startupConfig: emailEnabled === null ? null : { emailEnabled },
    setHeaderText: mockSetHeaderText,
  });
  mockUseRequestPasswordReset.mockReturnValue({
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isError: false,
    ...(isLoading
      ? { isIdle: false, isLoading: true, status: 'loading' as const }
      : { isIdle: true, isLoading: false, status: 'idle' as const }),
    isPaused: false,
    isSuccess: false,
    variables: undefined,
    reset: jest.fn(),
    mutate: mockMutate,
    mutateAsync: jest.fn(),
  });
  return render(<RequestPasswordReset />);
}

describe('RequestPasswordReset', () => {
  beforeEach(() => mockMutate.mockReset());

  it('offers administrator recovery without accepting an address when email is disabled', () => {
    setup(false);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Email delivery is not configured. Contact your administrator to reset your password.',
    );
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Login' })).toHaveAttribute('href', '/login');
    expect(screen.queryByText(/instructions has been sent/)).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockSetHeaderText).not.toHaveBeenCalled();
  });

  it('does not offer the reset form before deployment configuration has loaded', () => {
    setup(null);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'])(
    'uses the same generic emailed outcome after %s',
    async (outcome) => {
      mockMutate.mockImplementation((_data, options) => {
        if (outcome === 'success') {
          options.onSuccess({ link: 'https://example.com/reset-password?token=legacy-secret' });
        } else {
          options.onError(new Error('network failed'));
        }
      });
      setup();
      await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'user@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Continue with password reset' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'If an account with that email exists, an email with password reset instructions has been sent.',
      );
      expect(mockMutate).toHaveBeenCalledWith({ email: 'user@example.com' }, expect.any(Object));
      expect(mockSetHeaderText).toHaveBeenCalledWith('com_auth_reset_password_link_sent');
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
      expect(screen.getAllByRole('link')).toHaveLength(1);
      expect(screen.getByRole('link', { name: 'Back to Login' })).toHaveAttribute('href', '/login');
    },
  );

  it('disables submission while recovery is pending', () => {
    setup(true, true);
    expect(screen.getByRole('button', { name: 'Continue with password reset' })).toBeDisabled();
  });
});
