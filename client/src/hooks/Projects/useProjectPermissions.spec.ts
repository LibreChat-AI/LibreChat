import { renderHook } from '@testing-library/react';
import useProjectPermissions from './useProjectPermissions';

describe('useProjectPermissions', () => {
  it('gives the owner full control of their own project', () => {
    const { result } = renderHook(() => useProjectPermissions({}));
    expect(result.current).toEqual({
      isOwner: true,
      isShared: false,
      canEdit: true,
      canManageFiles: true,
      canManage: true,
    });
  });

  it('lets a viewer only read a shared project', () => {
    const { result } = renderHook(() => useProjectPermissions({ isShared: true, permissions: 1 }));
    expect(result.current).toMatchObject({
      isOwner: false,
      isShared: true,
      canEdit: false,
      canManageFiles: false,
      canManage: false,
    });
  });

  it('lets an editor edit, but not manage files, sharing, or deletion', () => {
    const { result } = renderHook(() => useProjectPermissions({ isShared: true, permissions: 3 }));
    expect(result.current).toMatchObject({
      canEdit: true,
      canManageFiles: false,
      canManage: false,
    });
  });

  it('grants nothing while the project is still loading', () => {
    const { result } = renderHook(() => useProjectPermissions(undefined));
    expect(result.current).toMatchObject({ canEdit: false, canManage: false });
  });
});
