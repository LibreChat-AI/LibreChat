import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import DeleteAccount from '../DeleteAccount';

const mockShowToast = jest.fn();
const mockLogout = jest.fn();
const mockDelete = jest.fn();
let mockOptions: { onSuccess?: () => void; onError?: (error: unknown) => void } = {};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/data-provider', () => ({
  useDeleteUserMutation: (options: typeof mockOptions) => {
    mockOptions = options;
    return { mutate: mockDelete, isLoading: false };
  },
}));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { email: 'owner@example.test' }, logout: mockLogout }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  cn: jest.requireActual('clsx').clsx,
  getErasureErrorKey: jest.requireActual('~/utils/errors').getErasureErrorKey,
}));

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'com_nav_delete_account' }));
  fireEvent.change(screen.getByLabelText('com_nav_delete_account_email_placeholder'), {
    target: { value: 'owner@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_nav_delete_account_button' }));
}

it('keeps the account open with retry guidance while erasure is pending', () => {
  render(<DeleteAccount />);
  submit();
  act(() =>
    mockOptions.onError?.({
      isAxiosError: true,
      response: { status: 503, data: { code: 'response_erasure_pending', message: 'private' } },
    }),
  );
  expect(mockShowToast).toHaveBeenCalledWith({
    message: 'com_ui_deletion_pending',
    status: 'error',
  });
  expect(mockLogout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_nav_delete_account_button' }));
  expect(mockDelete).toHaveBeenCalledTimes(2);
});

it('logs out only after successful account deletion', () => {
  render(<DeleteAccount />);
  submit();
  expect(mockLogout).not.toHaveBeenCalled();
  act(() => mockOptions.onSuccess?.());
  expect(mockLogout).toHaveBeenCalledTimes(1);
});
