import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import PeoplePickerAdminSettings from '../PeoplePickerAdminSettings';

const mockMutate = jest.fn();

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock('~/hooks', () => {
  const defaultValues = {};

  return {
    useLocalize: () => (key: string) => key,
    useAuthContext: () => ({ user: { role: 'ADMIN' } }),
    useRoleSelector: () => ({
      selectedRole: 'USER',
      isSelectedCustomRole: false,
      isCustomRoleLoading: false,
      isCustomRoleError: false,
      defaultValues,
      roleDropdownItems: [],
    }),
  };
});

jest.mock('~/data-provider', () => ({
  useUpdatePeoplePickerPermissionsMutation: () => ({
    mutate: mockMutate,
    isLoading: false,
  }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) => trigger,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

describe('PeoplePickerAdminSettings', () => {
  beforeEach(() => {
    mockMutate.mockReset();
  });

  it('uses the responsive dialog width and a native submit action', () => {
    render(<PeoplePickerAdminSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_admin_settings' }));

    const dialog = screen.getByRole('dialog');
    const saveButton = screen.getByRole('button', { name: 'com_ui_save' });

    expect(dialog).toHaveClass('w-11/12', 'max-w-2xl');
    expect(dialog).not.toHaveClass('w-full', 'lg:w-1/4');
    expect(screen.getByText('com_ui_people_picker_admin_description')).toHaveClass('sr-only');
    expect(
      screen.getByRole('switch', { name: 'com_ui_people_picker_allow_view_users' }),
    ).toBeInTheDocument();
    expect(saveButton).toHaveAttribute('type', 'submit');
    expect(saveButton).not.toHaveClass('min-w-[7.5rem]');
    expect(dialog.firstElementChild).not.toHaveClass('border-b');
    expect(saveButton.parentElement).toHaveClass('bg-transparent');
    expect(saveButton.parentElement).not.toHaveClass('border-t');
    expect(
      screen.getByRole('button', { name: 'com_ui_role_select USER' }).parentElement,
    ).toHaveClass('sm:grid-cols-[minmax(0,1fr)_9rem]');
  });
});
