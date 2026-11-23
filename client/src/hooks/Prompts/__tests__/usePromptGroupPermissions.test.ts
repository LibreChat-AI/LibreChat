import { renderHook } from '@testing-library/react';
import { PermissionBits } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import usePromptGroupPermissions from '../usePromptGroupPermissions';

jest.mock('~/hooks/useResourcePermissions', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import useResourcePermissions from '~/hooks/useResourcePermissions';

const useResourcePermissionsMock = useResourcePermissions as unknown as jest.Mock;

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    author: 'user-owner',
    authorName: 'Owner',
    source: 'native',
    ...overrides,
  } as TPromptGroup;
}

function mockPermissions(bits: number, isLoading = false) {
  useResourcePermissionsMock.mockReturnValue({
    hasPermission: (required: number) => (bits & required) === required,
    isLoading,
    permissionBits: bits,
  });
}

const ALL_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

describe('usePromptGroupPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('grants full control for a native group with full ACL bits', () => {
    mockPermissions(ALL_BITS);
    const { result } = renderHook(() => usePromptGroupPermissions(makeGroup()));
    expect(result.current.isExternal).toBe(false);
    expect(result.current.canView).toBe(true);
    expect(result.current.canEdit).toBe(true);
    expect(result.current.canDelete).toBe(true);
  });

  it('denies edit and delete for an external (Langfuse) group even with full ACL bits', () => {
    mockPermissions(ALL_BITS);
    const { result } = renderHook(() =>
      usePromptGroupPermissions(makeGroup({ source: 'langfuse' })),
    );
    expect(result.current.isExternal).toBe(true);
    expect(result.current.canEdit).toBe(false);
    expect(result.current.canDelete).toBe(false);
    // Viewing stays governed by ACL bits, not the external flag.
    expect(result.current.canView).toBe(true);
  });

  it('grants view-only when the ACL only carries VIEW bits', () => {
    mockPermissions(PermissionBits.VIEW);
    const { result } = renderHook(() => usePromptGroupPermissions(makeGroup()));
    expect(result.current.canView).toBe(true);
    expect(result.current.canEdit).toBe(false);
    expect(result.current.canDelete).toBe(false);
  });

  it('returns denied permissions while the ACL query is still loading', () => {
    mockPermissions(0, /* isLoading */ true);
    const { result } = renderHook(() => usePromptGroupPermissions(makeGroup()));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.canEdit).toBe(false);
    expect(result.current.canDelete).toBe(false);
  });

  it('handles an undefined group gracefully', () => {
    mockPermissions(0);
    const { result } = renderHook(() => usePromptGroupPermissions(undefined));
    expect(result.current.isExternal).toBe(false);
    expect(result.current.canEdit).toBe(false);
    expect(result.current.canDelete).toBe(false);
  });
});
