import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { Permissions, PermissionTypes, dataService } from 'librechat-data-provider';
import type { PermissionConfig } from '../AdminSettingsDialog';
import AdminSettingsDialog from '../AdminSettingsDialog';
import { AuthContext } from '~/hooks/AuthContext';

/**
 * The dialog runs on the real role selector, role menu and translations. Only the roles list
 * request is answered here; each role's permissions come from the signed-in session, as in the app.
 */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, listRoles: jest.fn() } };
});

const mockMutate = jest.fn();

const permissions: PermissionConfig[] = [
  { permission: Permissions.USE, labelKey: 'com_ui_memories_allow_use' },
  { permission: Permissions.CREATE, labelKey: 'com_ui_memories_allow_create' },
];

/** ADMIN keeps USE but not CREATE, so picking ADMIN visibly resets the form from that role. */
const roles = {
  USER: { name: 'USER', permissions: { MEMORIES: { USE: true, CREATE: true } } },
  ADMIN: { name: 'ADMIN', permissions: { MEMORIES: { USE: true, CREATE: false } } },
};

const renderDialog = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = {
    user: { id: 'admin-id', role: 'ADMIN' },
    roles,
    isAuthenticated: true,
  } as unknown as React.ContextType<typeof AuthContext>;

  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <AuthContext.Provider value={auth}>
          <AdminSettingsDialog
            permissionType={PermissionTypes.MEMORIES}
            sectionKey="com_ui_memories"
            permissions={permissions}
            menuId="memory-role-dropdown"
            mutation={{ mutate: mockMutate, isLoading: false }}
          />
        </AuthContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Admin Settings' }));
  });
};

/** Picks a role from the dialog's own menu, which starts on USER. */
const pickRole = async (role: 'ADMIN' | 'USER') => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Role / }));
  });
  const menu = await screen.findByRole('menu');
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: role }));
  });
  expect(screen.getByRole('button', { name: `Role ${role}` })).toBeInTheDocument();
};

const toggle = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name }));
  });
};

const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
};

describe('AdminSettingsDialog admin lockout guard', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    jest.mocked(dataService.listRoles).mockResolvedValue({
      roles: [{ name: 'USER' }, { name: 'ADMIN' }],
      total: 2,
      limit: 50,
    });
  });

  it('loads the picked role and shows no warning while ADMIN keeps access', async () => {
    await renderDialog();
    expect(screen.getByRole('switch', { name: 'Allow creating Memories' })).toBeChecked();

    await pickRole('ADMIN');

    expect(screen.getByRole('switch', { name: 'Allow using Memories' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Allow creating Memories' })).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns inline and requires typing the role before revoking ADMIN access', async () => {
    await renderDialog();
    await pickRole('ADMIN');

    await toggle('Allow using Memories');
    expect(screen.getByRole('alert')).toHaveTextContent('turns off Memories for every admin');

    await save();
    expect(mockMutate).not.toHaveBeenCalled();

    const confirmDialog = screen.getByRole('alertdialog', {
      name: 'Turn off Memories for admins?',
    });
    const confirmButton = within(confirmDialog).getByRole('button', {
      name: 'Turn Off for Admins',
    });
    const input = within(confirmDialog).getByLabelText('Type ADMIN to confirm');
    expect(input).toHaveFocus();
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'admin' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'ADMIN' } });
    expect(confirmButton).toBeEnabled();
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'ADMIN',
      updates: { USE: false, CREATE: false },
    });
  });

  it('saves nothing when the confirmation is cancelled', async () => {
    await renderDialog();
    await pickRole('ADMIN');

    await toggle('Allow using Memories');
    await save();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('saves other ADMIN permission changes without the typed confirmation', async () => {
    await renderDialog();
    await pickRole('ADMIN');

    await toggle('Allow creating Memories');
    await save();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'ADMIN',
      updates: { USE: true, CREATE: true },
    });
  });

  it('saves a USE change for other roles without the typed confirmation', async () => {
    await renderDialog();

    await toggle('Allow using Memories');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await save();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockMutate).toHaveBeenCalledWith({
      roleName: 'USER',
      updates: { USE: false, CREATE: true },
    });
  });
});
