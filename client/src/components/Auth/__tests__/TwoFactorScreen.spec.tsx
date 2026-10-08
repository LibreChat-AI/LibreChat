import { MemoryRouter } from 'react-router-dom';
import { ErrorTypes } from 'librechat-data-provider';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import TwoFactorScreen from '../TwoFactorScreen';

const mockShowToast = jest.fn();
const mockVerify = jest.fn();
let mockVerifyOptions: { onError: (error: unknown) => void } | undefined;

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useVerifyTwoFactorTempMutation: (options: { onError: (error: unknown) => void }) => {
    mockVerifyOptions = options;
    return { mutate: mockVerify };
  },
}));

function renderScreen() {
  render(
    <MemoryRouter initialEntries={['/login/2fa?tempToken=temp-token']}>
      <TwoFactorScreen />
    </MemoryRouter>,
  );
}

describe('TwoFactorScreen verification errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyOptions = undefined;
  });

  it.each(['deadbeef', '0123456789abcdef0123456789abcdef'])(
    'submits the full legacy or new backup code: %s',
    async (code) => {
      renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_use_backup_code' }));
      const input = screen.getByRole('textbox', {
        name: 'com_ui_backup_code_verification_required',
      });
      expect(input).not.toHaveAttribute('maxlength');
      fireEvent.change(input, { target: { value: code } });
      fireEvent.click(screen.getByTestId('login-button'));
      await waitFor(() =>
        expect(mockVerify).toHaveBeenCalledWith({ tempToken: 'temp-token', backupCode: code }),
      );
    },
  );

  it('shows a localized message when the server rejects a cross-origin submission', () => {
    renderScreen();

    act(() => {
      mockVerifyOptions?.onError({
        response: {
          data: { message: 'Cross-site request rejected', code: ErrorTypes.AUTH_CROSS_ORIGIN },
        },
      });
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_auth_error_login_cross_origin',
      status: 'error',
    });
  });

  it('keeps showing the server message for other verification failures', () => {
    renderScreen();

    act(() => {
      mockVerifyOptions?.onError({
        response: { data: { message: 'Invalid 2FA code or backup code' } },
      });
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'Invalid 2FA code or backup code',
      status: 'error',
    });
  });
});
