import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { PermissionConfig } from '../AdminSettingsDialog';
import AdminSettingsDialog from '../AdminSettingsDialog';

const mockMutate = jest.fn();
let mockSelectedRole = 'ADMIN';

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock('~/hooks', () => {
  const defaultValues = { USE: true, CREATE: true };

  return {
    useLocalize: () => (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key,
    useAuthContext: () => ({ user: { role: 'ADMIN' } }),
    useRoleSelector: () => ({
      selectedRole: mockSelectedRole,
      isSelectedCustomRole: false,
      isCustomRoleLoading: false,
      isCustomRoleError: false,
      defaultValues,
      roleDropdownItems: [],
    }),
  };
});

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_memories_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_memories_allow_create' },
];

const renderDialog = () => {
  render(
    <AdminSettingsDialog
      permissionType={PermissionTypes.MEMORIES}
      sectionKey="com_ui_memories"
      permissions={permissions}
      menuId="memory-role-dropdown"
      mutation={{ mutate: mockMutate, isLoading: false }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_admin_settings' }));
};

const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  });
};

describe('AdminSettingsDialog admin lockout guard', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockSelectedRole = 'ADMIN';
  });

  it('shows no lockout warning while the ADMIN role keeps access', () => {
    renderDialog();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns inline and requires typing the role before revoking ADMIN access', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_memories_allow_use' }));
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_admin_lockout_warning');

    await save();
    expect(mockMutate).not.toHaveBeenCalled();

    const confirmDialog = screen.getByRole('alertdialog');
    expect(confirmDialog).toHaveTextContent('com_ui_admin_lockout_title com_ui_memories');

    const confirmButton = screen.getByRole('button', { name: 'com_ui_admin_lockout_confirm' });
    const input = screen.getByLabelText('com_ui_admin_lockout_confirm_label ADMIN');
    expect(input).toHaveFocus();
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'admin' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'ADMIN' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'ADMIN',
      updates: { USE: false, CREATE: true },
    });
  });

  it('saves nothing when the confirmation is cancelled', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_memories_allow_use' }));
    await save();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('saves other ADMIN permission changes without the typed confirmation', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_memories_allow_create' }));
    await save();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'ADMIN',
      updates: { USE: true, CREATE: false },
    });
  });

  it('saves a USE change for other roles without the typed confirmation', async () => {
    mockSelectedRole = 'USER';
    renderDialog();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_memories_allow_use' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await save();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'USER',
      updates: { USE: false, CREATE: true },
    });
  });
});
