import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import * as reactQuery from 'librechat-data-provider/react-query';
import { MemoryRouter, Route, Routes, Outlet } from 'react-router-dom';
import { CREDENTIAL_RETIREMENT_INCOMPLETE_CODE } from 'librechat-data-provider';
import ResetPassword from '~/components/Auth/ResetPassword';

jest.mock('librechat-data-provider/react-query', () => ({
  useResetPasswordMutation: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const mockUseResetPasswordMutation = jest.mocked(reactQuery.useResetPasswordMutation);

function renderWithFailure(error: unknown) {
  const setError = jest.fn();
  const setHeaderText = jest.fn();
  mockUseResetPasswordMutation.mockReturnValue({
    isSuccess: false,
    mutate: jest.fn((_data, options) => options?.onError?.(error, _data, undefined)),
  } as unknown as ReturnType<typeof reactQuery.useResetPasswordMutation>);
  render(
    <MemoryRouter initialEntries={['/reset-password?token=t&userId=u']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{ setError, setHeaderText, startupConfig: { minPasswordLength: 8 } }}
            />
          }
        >
          <Route path="/reset-password" element={<ResetPassword />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { setError, setHeaderText };
}

async function submitNewPassword() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('com_auth_password'), 'new-password-1');
  await user.type(screen.getByLabelText('com_auth_password_confirm'), 'new-password-1');
  await user.click(screen.getByRole('button', { name: 'com_auth_submit_registration' }));
}

describe('ResetPassword', () => {
  it('tells the user the new password is active when other sessions could not be signed out', async () => {
    const { setError, setHeaderText } = renderWithFailure({
      response: { data: { code: CREDENTIAL_RETIREMENT_INCOMPLETE_CODE } },
    });

    await submitNewPassword();

    await waitFor(() =>
      expect(screen.getByText('com_auth_reset_password_incomplete')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'com_auth_sign_in' })).toBeInTheDocument();
    expect(setHeaderText).toHaveBeenCalledWith('com_auth_reset_password_success');
    expect(setError).not.toHaveBeenCalled();
  });

  it('keeps reporting an invalid link for any other failure', async () => {
    const { setError } = renderWithFailure({ response: { data: {} } });

    await submitNewPassword();

    await waitFor(() =>
      expect(setError).toHaveBeenCalledWith('com_auth_error_invalid_reset_token'),
    );
    expect(screen.queryByText('com_auth_reset_password_incomplete')).not.toBeInTheDocument();
  });
});
