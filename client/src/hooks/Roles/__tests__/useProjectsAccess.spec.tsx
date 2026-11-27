import { renderHook } from '@testing-library/react';
import { Permissions, PermissionTypes, roleDefaults } from 'librechat-data-provider';
import type { TRole } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import useProjectsAccess from '../useProjectsAccess';
import { AuthContext } from '~/hooks/AuthContext';

const context = (role: TRole | undefined, isAuthenticated = true): TAuthContext =>
  ({
    user: { id: 'user-1', role: 'member' },
    roles: role ? { member: role } : {},
    isAuthenticated,
  }) as unknown as TAuthContext;

const withPermissions = (permissions: Record<string, unknown>): TRole =>
  ({ ...roleDefaults.USER, name: 'member', permissions }) as unknown as TRole;

const render = (value: TAuthContext) =>
  renderHook(() => useProjectsAccess(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    ),
  }).result.current;

describe('useProjectsAccess', () => {
  it('allows nothing, and has not refused yet, before the role loads', () => {
    expect(render(context(undefined))).toEqual({
      loaded: false,
      canUse: false,
      canCreate: false,
    });
  });

  it('allows nothing when signed out', () => {
    expect(render(context(roleDefaults.USER as TRole, false)).canUse).toBe(false);
  });

  it('allows a seeded role to use and create projects', () => {
    expect(render(context(roleDefaults.USER as TRole))).toEqual({
      loaded: true,
      canUse: true,
      canCreate: true,
    });
  });

  it('keeps projects for a role stored before the permission existed', () => {
    const access = render(context(withPermissions({ BOOKMARKS: { USE: true } })));
    expect(access).toMatchObject({ canUse: true, canCreate: true });
  });

  it('honors a refused USE, which also refuses CREATE', () => {
    const access = render(
      context(
        withPermissions({
          [PermissionTypes.PROJECTS]: { [Permissions.USE]: false, [Permissions.CREATE]: true },
        }),
      ),
    );
    expect(access).toEqual({ loaded: true, canUse: false, canCreate: false });
  });

  it('honors a refused CREATE alone', () => {
    const access = render(
      context(
        withPermissions({
          [PermissionTypes.PROJECTS]: { [Permissions.USE]: true, [Permissions.CREATE]: false },
        }),
      ),
    );
    expect(access).toEqual({ loaded: true, canUse: true, canCreate: false });
  });
});
