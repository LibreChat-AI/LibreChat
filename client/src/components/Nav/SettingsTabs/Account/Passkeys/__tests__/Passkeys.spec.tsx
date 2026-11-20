import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import Passkeys from '../Passkeys';

const mockClearPasswordError = jest.fn();
const mockRegisterPasskey = jest.fn();
const mockRefetchStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { maxPasskeysPerUser: 20 },
    refetch: mockRefetchStartupConfig,
  }),
  usePasskeysQuery: () => ({ data: { passkeys: [] }, isLoading: false, isError: false }),
  useRenamePasskeyMutation: () => ({ mutate: jest.fn() }),
  useDeletePasskeyMutation: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('~/hooks/Auth/usePasskey', () => ({
  isPasswordRejection: () => false,
  usePasskeyRegistration: () => ({
    registerPasskey: mockRegisterPasskey,
    isRegistering: false,
    passwordErrorKey: null,
    clearPasswordError: mockClearPasswordError,
  }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { provider: 'local' } }),
  useLocalize: () => (key: string) =>
    ({
      com_ui_passkeys: 'Passkeys',
      com_ui_passkeys_description: 'Passkeys description',
      com_ui_manage: 'Manage',
      com_ui_passkey_empty: 'No passkeys',
      com_ui_passkey_add: 'Add passkey',
      com_ui_passkey_confirm_password: 'Confirm your password',
      com_ui_passkey_confirm_password_description: 'Confirm before adding a passkey',
      com_ui_passkey_limit_reached: 'Passkey limit reached',
      com_ui_cancel: 'Cancel',
      com_ui_confirm: 'Confirm',
    })[key] ?? key,
}));

describe('Passkeys enrollment dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes startup configuration on each management dialog open', async () => {
    const user = userEvent.setup();
    render(<Passkeys />);
    expect(mockRefetchStartupConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Passkeys' }));
    expect(mockRefetchStartupConfig).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Passkeys' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Passkeys' }));
    expect(mockRefetchStartupConfig).toHaveBeenCalledTimes(2);
  });

  it('opens password confirmation in a separate dialog and restores focus on cancel', async () => {
    const user = userEvent.setup();
    render(<Passkeys />);

    await user.click(screen.getByRole('button', { name: 'Passkeys' }));
    const manageDialog = screen.getByRole('dialog', { name: 'Passkeys' });
    const addButton = screen.getByRole('button', { name: 'Add passkey' });

    await user.click(addButton);

    const addDialog = screen.getByRole('dialog', { name: 'Add passkey' });
    expect(addDialog).not.toBe(manageDialog);
    expect(manageDialog).not.toContainElement(addDialog);
    expect(within(addDialog).getByLabelText('Confirm your password')).toHaveFocus();
    expect(within(addDialog).getByRole('button', { name: 'Show secret' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(addButton).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'Add passkey' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Passkeys' })).toBeInTheDocument();
  });
});
